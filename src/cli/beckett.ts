#!/usr/bin/env bun
/**
 * Beckett v2 — the `beckett` CLI (`src/cli/beckett.ts`)
 * =======================================================================================
 * The small command surface the PARENT agent drives via Bash (Spec 05). Stateful commands
 * (worker control, discord reply, integrate, inject, status) forward to the shell over the
 * control bus (unix socket); memory commands run in-process over the markdown graph.
 *
 * Output is JSON on stdout (the parent reads it); errors go to stderr with a non-zero exit.
 * Install a PATH shim so the parent can call `beckett ...`:
 *   exec bun /home/beckett/beckett/src/cli/beckett.ts "$@"
 */

import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { callBus } from "../shell/control-bus.ts";
import { createMemory } from "../memory/index.ts";
import { GitHubCli, loadIdentity } from "../agency/index.ts";
import { CfDns } from "../agency/cloudflare.ts";
import { CodexImageGen } from "../agency/imagegen.ts";
import { TunnelDeployer } from "../shell/deploy.ts";
import { loadAccess, grantAccess, revokeAccess, ACCESS_CAP } from "../discord/access.ts";
import { loadIdentities, getIdentity, upsertIdentity, ensureSeeded } from "../discord/identity.ts";
import type { RememberIntent, NodeType, Logger, MergeStrategy, ReviewParams } from "../types.ts";
import type { Ticket, TicketState } from "../plane/types.ts";
import { projectSlug } from "../plane/cast.ts";

const config = loadConfig();
const paths = buildPaths(config);
const SOCK = join(paths.beckettDir, "control.sock");

function out(data: unknown): never {
  process.stdout.write(typeof data === "string" ? data + "\n" : JSON.stringify(data, null, 2) + "\n");
  process.exit(0);
}
function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/**
 * The one code-project slug that targets Beckett's OWN source repo (`0xbeckett/beckett`). Filing work
 * here is RESTRICTED: unrelated tickets have been mis-routed onto it (e.g. a "probabilities" model-list
 * ticket read as "improve Beckett" → edited Beckett's own code), polluting the codebase. Overridable
 * for a differently-named self-repo via env.
 */
const RESTRICTED_PROJECT = (process.env.BECKETT_SELF_PROJECT?.trim() || "beckett").toLowerCase();

/**
 * Refuse to file a ticket against the restricted self-repo unless `confirmed` (the `--confirm-beckett`
 * flag). The message is aimed at the Concierge: it must re-confirm with the user that the work really
 * belongs in Beckett's codebase before re-filing with the flag. A speed bump against mis-routing, not
 * a cryptographic gate — the Concierge is instructed to add the flag ONLY after the user says yes.
 */
function guardRestrictedProject(project: string | undefined, confirmed: boolean): void {
  if (!project) return; // no project → per-ticket sandbox, never the self-repo
  if (projectSlug(project) !== RESTRICTED_PROJECT) return;
  if (confirmed) return;
  fail(
    `"--project ${project}" targets Beckett's OWN source repo (${RESTRICTED_PROJECT}) — a RESTRICTED ` +
      `project. Most work should build in its own repo, NOT edit Beckett itself. Confirm with the user ` +
      `once more that this genuinely belongs in the beckett codebase; if they say yes, re-file the exact ` +
      `same command with --confirm-beckett.`,
  );
}

/** Minimal flag parser: returns { _: positional[], flags: {k:v|true} }. */
function parse(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(t);
  }
  return { _, flags };
}

/** A no-op logger: CLI invocations are short-lived and emit JSON, not log lines. */
const quietLogger = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as unknown as Logger;
})();

async function bus(cmd: string, args: Record<string, unknown>): Promise<never> {
  try {
    const res = await callBus(SOCK, cmd, args);
    if (!res.ok) fail(res.error ?? "command failed");
    out(res.data ?? { ok: true });
  } catch (err) {
    fail((err as Error).message);
  }
}

/**
 * Fire a NON-fatal notification at the control bus and return regardless of outcome. Unlike
 * {@link bus}, this never exits or fails the command: it exists so `ticket create`/`plan` can tell
 * the running Concierge "I just filed OPS-N for channel X" (so it opens a progress thread) WITHOUT
 * that being load-bearing — the same commands run by a human or in tests have no daemon socket, and
 * the ticket must still be created and printed. A short timeout keeps a dead socket from stalling.
 */
async function notifyBus(cmd: string, args: Record<string, unknown>): Promise<void> {
  try {
    await callBus(SOCK, cmd, args, 5_000);
  } catch {
    /* best-effort: no daemon / busy bus — the ticket is already filed, so just move on */
  }
}

async function main(): Promise<void> {
  const [group, sub, ...rest] = process.argv.slice(2);

  // ── memory (in-process) ────────────────────────────────────────────────────────────────
  if (group === "memory") {
    const memory = createMemory({ memoryDir: paths.memoryDir, logger: undefined, git: sub === "remember" });
    if (sub === "recall") {
      const { _, flags } = parse(rest);
      const text = _.join(" ");
      if (!text) fail("usage: beckett memory recall \"<query>\" [--k N] [--hops N]");
      const r = await memory.recall({
        text,
        k: flags.k ? Number(flags.k) : undefined,
        hops: flags.hops ? Number(flags.hops) : undefined,
      });
      const lines: string[] = ["# index"];
      for (const il of r.index) lines.push(`- ${il.name}: ${il.description}`);
      lines.push("\n# hits");
      for (const h of r.hits) lines.push(`\n## ${h.node.name} (${h.node.type}, score ${h.score.toFixed(2)})\n${h.node.body}`);
      if (r.expanded.length) lines.push("\n# related (1-hop)\n" + r.expanded.map((e) => `- ${e.node.name}: ${e.node.description}`).join("\n"));
      if (r.phantoms.length) lines.push("\n# phantoms: " + r.phantoms.join(", "));
      if (r.notes.length) lines.push("\n# notes: " + r.notes.join("; "));
      out(lines.join("\n"));
    }
    if (sub === "remember") {
      const { flags } = parse(rest);
      const op = (flags.op as RememberIntent["op"]) ?? "create";
      const name = flags.name as string;
      if (!name) fail("usage: beckett memory remember --name <n> [--op create] [--type t] [--desc d] [--reason r] [--body <text>] [--link to:field,...]");
      let body = flags.body as string | undefined;
      if (flags["body-stdin"]) body = await Bun.stdin.text();
      const links = flags.link
        ? String(flags.link).split(",").map((s) => {
            const [to, field] = s.split(":");
            return { to: to!, field: field ?? "body" };
          })
        : undefined;
      const node = await memory.remember({
        op,
        name,
        type: flags.type ? (String(flags.type) as NodeType) : undefined,
        description: flags.desc ? String(flags.desc) : undefined,
        body,
        links,
        source: (flags.source as RememberIntent["source"]) ?? "conversation",
        reason: flags.reason ? String(flags.reason) : "remember via CLI",
      });
      out({ remembered: node.name, type: node.type });
    }
    fail(`unknown: beckett memory ${sub ?? ""}`);
  }

  // ── identity (in-process: per-user Discord name map, ~/.beckett/identities.json) ───────────
  // How Beckett records "call me X" durably against a Discord user id, and reads back who an id
  // is. Keyed on the user id from the turn stamp `[user:<id> ...]`. Addressing only — never store
  // contact info (email/phone) here; that must never surface in channel (OPS-42 privacy rule).
  if (group === "identity") {
    const file = paths.identitiesFile;
    // Guarantee the day-one entries exist however this map is first touched (the daemon also
    // seeds at startup) — additive + idempotent, binds the owner to DISCORD_OWNER_ID if set.
    ensureSeeded(file, process.env.DISCORD_OWNER_ID?.trim());
    if (sub === "set") {
      const { flags } = parse(rest);
      const id = flags.user ? String(flags.user).trim() : "";
      if (!id) fail('usage: beckett identity set --user <discordId> [--name "X"] [--known "Y"] [--notes "..."] [--clear-name]');
      const patch: Parameters<typeof upsertIdentity>[2] = {};
      // --name is the "call me X" case → preferred_address (what they want to be called).
      if (flags.name !== undefined) patch.preferred_address = String(flags.name);
      if (flags["clear-name"]) patch.preferred_address = "";
      if (flags.known !== undefined) patch.known_name = String(flags.known);
      if (flags.notes !== undefined) patch.notes = String(flags.notes);
      if (flags.display !== undefined) patch.display_name = String(flags.display);
      if (Object.keys(patch).length === 0) fail("nothing to set — pass --name, --known, --notes, or --display");
      let rec;
      try {
        rec = upsertIdentity(file, id, patch);
      } catch (err) {
        fail((err as Error).message);
      }
      out({ ok: true, userId: id, identity: rec });
    }
    if (sub === "show") {
      const { flags, _ } = parse(rest);
      const id = (flags.user ? String(flags.user) : _[0] ?? "").trim();
      if (!id) fail("usage: beckett identity show --user <discordId>");
      out({ userId: id, identity: getIdentity(file, id) ?? null });
    }
    if (sub === "list") {
      out({ identities: loadIdentities(file) });
    }
    fail(`unknown: beckett identity ${sub ?? ""} (use set|show|list)`);
  }

  // ── work (in-process: the on-disk worker ledger — survives shell restarts) ────────────────
  // `worker ...` is LIVE control over the running shell's registry; `work ...` reads the durable
  // ~/.beckett/workers/<id>/ records straight off disk, so it answers "what was I doing / did any
  // work get interrupted?" even after a restart, with the shell down, before spinning up anything.

  // ── gh (in-process: stateless `gh`/`git` subprocesses, token from env) ────────────────────
  // The token rides GH_TOKEN/the git credential helper per-invocation, so the parent NEVER
  // needs `gh auth login`/`gh auth status` — it just calls `beckett gh ...`. (Spec 07 §3.2)
  if (group === "gh") {
    const identity = loadIdentity(config);
    if (!identity.github.pat) fail("no GITHUB_PAT in ~/.beckett/.env — GitHub is unavailable");
    const { _, flags } = parse(rest);
    const dir = flags.dir ? String(flags.dir) : process.cwd();
    const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
    const gh = new GitHubCli({
      pat: identity.github.pat,
      account: identity.github.account,
      apiBase: identity.github.apiBase,
      resolveRepoDir: () => dir,
      logger: quiet,
    });

    if (sub === "repo" && _[0] === "create") {
      const name = _[1];
      if (!name) fail("usage: beckett gh repo create <name> [--public] [--desc <d>] [--source <dir>] [--push]");
      out(await gh.createRepo({
        name,
        private: !flags.public,
        description: flags.desc ? String(flags.desc) : undefined,
        sourceDir: flags.source ? String(flags.source) : undefined,
        push: Boolean(flags.push),
      }));
    }

    if (sub === "pr") {
      const action = _[0];
      const repo = flags.repo ? String(flags.repo) : "";
      const n = Number(_[1]);
      if (action === "create") {
        for (const k of ["repo", "base", "head", "title", "body"]) if (!flags[k]) fail(`gh pr create needs --${k}`);
        out(await gh.openPR({
          repo, base: String(flags.base), head: String(flags.head),
          title: String(flags.title), body: String(flags.body), draft: Boolean(flags.draft),
        }));
      }
      if (action === "merge") {
        if (!repo || !n) fail("usage: beckett gh pr merge <num> --repo <owner/name> [--strategy squash|merge|rebase]");
        const strategy = (flags.strategy ? String(flags.strategy) : "squash") as MergeStrategy;
        await gh.mergePR(repo, n, strategy);
        out({ merged: true, repo, number: n, strategy });
      }
      if (action === "close") {
        if (!n) fail("usage: beckett gh pr close <num> [--repo <owner/name>]");
        out(await gh.closePR(repo, n));
      }
      if (action === "status") {
        if (!repo || !n) fail("usage: beckett gh pr status <num> --repo <owner/name>");
        out({ repo, number: n, green: await gh.isGreen(repo, n) });
      }
      if (action === "review") {
        if (!repo || !n) fail("usage: beckett gh pr review <num> --repo <r> --event APPROVE|REQUEST_CHANGES|COMMENT --body <b>");
        await gh.reviewPR(repo, n, { event: String(flags.event ?? "COMMENT") as ReviewParams["event"], body: String(flags.body ?? "") });
        out({ reviewed: true, repo, number: n });
      }
      fail("usage: beckett gh pr create|merge|close|status|review <num> --repo <owner/name> ...");
    }

    if (sub === "push") {
      if (!flags.repo || !flags.branch) fail("usage: beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref <localRef>] [--dir <d>]");
      await gh.pushBranch(String(flags.repo), flags.ref ? String(flags.ref) : "HEAD", String(flags.branch));
      out({ pushed: true, repo: String(flags.repo), branch: String(flags.branch) });
    }

    fail("usage: beckett gh repo create | pr create|merge|close|status|review | push");
  }

  // ── dns (in-process: zone-scoped Cloudflare DNS, token from env) ──────────────────────────
  // Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID from ~/.beckett/.env (via loadConfig). DNS
  // is FREE: a record is a reversible proposal you can delete. Short names expand to the zone
  // apex (e.g. `x-tool` → `x-tool.0xbeckett.me`). Output is JSON. (See the `deploy` skill.)
  if (group === "dns") {
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
    if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare DNS is unavailable");
    if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to the 0xbeckett.me zone id");
    const dns = new CfDns({ token, zoneId, logger: quietLogger });
    const { _, flags } = parse(rest);

    if (sub === "ls") {
      out(await dns.list({
        name: flags.name ? String(flags.name) : undefined,
        type: flags.type ? String(flags.type) : undefined,
      }));
    }
    if (sub === "add") {
      const name = _[0];
      if (!name || !flags.content) {
        fail("usage: beckett dns add <name> --content <c> [--type CNAME] [--proxied|--no-proxied] [--ttl N]");
      }
      // proxied defaults to true; --no-proxied or --proxied=false turns it off.
      const proxied = flags["no-proxied"] ? false : flags.proxied === "false" ? false : true;
      out(await dns.upsert({
        name,
        type: flags.type ? String(flags.type) : "CNAME",
        content: String(flags.content),
        proxied,
        ttl: flags.ttl ? Number(flags.ttl) : undefined,
      }));
    }
    if (sub === "rm") {
      const name = _[0];
      if (!name) fail("usage: beckett dns rm <name> [--type T]");
      out(await dns.remove(name, flags.type ? String(flags.type) : undefined));
    }
    fail("usage: beckett dns ls [--name N] [--type T] | add <name> --content <c> [...] | rm <name> [--type T]");
  }

  // ── deploy (in-process: cloudflared named-tunnel ingress + a CNAME via CfDns) ──────────────
  // Throws a locally-running app up at <name>.0xbeckett.me. Reversible/FREE (a record + ingress
  // rule you can delete) but outward — announce the URL in voice. Requires CLOUDFLARE_TUNNEL_ID
  // (a one-time human prereq); fails clearly if absent. (See the `deploy` skill.)
  if (group === "deploy") {
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
    if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
    if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to the 0xbeckett.me zone id");
    const dns = new CfDns({ token, zoneId, logger: quietLogger });
    const deployer = new TunnelDeployer({
      tunnelId: process.env.CLOUDFLARE_TUNNEL_ID,
      dns,
      logger: quietLogger,
    });
    const { _, flags } = parse(rest);

    if (sub === "ls") {
      out(deployer.list());
    }
    if (sub === "rm") {
      const name = _[0];
      if (!name) fail("usage: beckett deploy rm <name>");
      out(await deployer.remove(name));
    }
    // `beckett deploy <name> --port <p>` | `--service <url>`  (sub is the name here)
    if (sub && sub !== "ls" && sub !== "rm") {
      const name = sub;
      const service = flags.service
        ? String(flags.service)
        : flags.port
          ? `http://localhost:${Number(flags.port)}`
          : "";
      if (!service) fail("usage: beckett deploy <name> --port <p> | --service http://localhost:<p>");
      out(await deployer.deploy({ name, service }));
    }
    fail("usage: beckett deploy <name> --port <p> | deploy ls | deploy rm <name>");
  }

  // ── image (in-process: wraps the Codex image_gen tool into one deterministic command) ─────
  if (group === "image") {
    const { _, flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    const prompt = _.join(" ").trim();
    if (!prompt)
      fail(
        'usage: beckett image "<prompt>" [--out <path>] [--size 1024x1024|1536x1024|1024x1536|auto] [--ref <file[,file]>] [--transparent] [--model <m>]',
      );
    const refs = flags.ref ? String(flags.ref).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const gen = new CodexImageGen({ imagesDir: paths.imagesDir, logger: quietLogger });
    out(
      await gen.generate({
        prompt,
        out: flags.out ? String(flags.out) : undefined,
        size: flags.size ? String(flags.size) : undefined,
        refs,
        transparent: flags.transparent === true || flags.transparent === "true",
        model: flags.model ? String(flags.model) : undefined,
      }),
    );
  }

  // ── site (in-process: deploy Beckett's own edge site via wrangler, token from env) ────────
  if (group === "site") {
    const { flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    const repoRoot = join(import.meta.dir, "..", "..");
    const dir = flags.dir ? resolve(String(flags.dir)) : join(repoRoot, "web");
    if (sub === "deploy") {
      if (!process.env.CLOUDFLARE_API_TOKEN)
        fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
      if (!existsSync(join(dir, "wrangler.jsonc")) && !existsSync(join(dir, "wrangler.toml")))
        fail(`no wrangler config in ${dir}`);
      // wrangler reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from env → never needs
      // `wrangler login`. Ensure the toolchain bins are on PATH for the spawned process.
      const home = process.env.HOME ?? "";
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
      env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
      const proc = Bun.spawn(["wrangler", "deploy"], {
        cwd: dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const [so, se] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      const text = `${so}\n${se}`;
      if (code !== 0)
        fail(`wrangler deploy failed (${code}):\n${text.trim().split("\n").slice(-20).join("\n")}`);
      const urls = [...text.matchAll(/https?:\/\/[^\s]+/g)].map((m) => m[0]);
      out({ deployed: true, dir, urls, log: text.trim().split("\n").slice(-12).join("\n") });
    }
    fail("usage: beckett site deploy [--dir <path>]");
  }

  // ── access (in-process: whitelist manipulation, no control bus) ──────────────────────────
  if (group === "access") {
    const ownerId = process.env.DISCORD_OWNER_ID;
    if (sub === "ls" || sub === "status") {
      const access = loadAccess(paths.accessFile);
      out({
        ids: Array.from(access.ids),
        count: access.ids.size,
        locked: access.locked,
        cap: ACCESS_CAP,
        remaining: access.locked ? 0 : Math.max(0, ACCESS_CAP - access.ids.size),
      });
    }
    if (sub === "grant") {
      const id = rest[0];
      if (!id) fail("usage: beckett access grant <discord-user-id>");
      const r = grantAccess(paths.accessFile, id, ownerId);
      out({
        ok: r.ok,
        status: r.status,
        id,
        count: r.count,
        locked: r.locked,
        cap: ACCESS_CAP,
        remaining: r.locked ? 0 : Math.max(0, ACCESS_CAP - r.count),
      });
    }
    if (sub === "revoke") {
      const id = rest[0];
      if (!id) fail("usage: beckett access revoke <discord-user-id>");
      const r = revokeAccess(paths.accessFile, id);
      out({
        ok: r.ok,
        status: r.status,
        id,
        count: r.count,
        locked: r.locked,
      });
    }
    fail("usage: beckett access ls | grant <id> | revoke <id>");
  }

  // ── ticket (in-process: PlaneClient — the Concierge's door to Plane, v3 §8) ───────────────
  // The Concierge shells these from its Bash tool to file/inspect/steer tickets. Output is
  // JSON on stdout (the Concierge reads it). PlaneClient speaks HTTP to Plane; the secret
  // PLANE_API_TOKEN rides process.env, never config. Imported dynamically so the rest of the
  // CLI keeps working while `src/plane/client.ts` is built in parallel.
  if (group === "ticket") {
    const { createPlaneClient } = await import("../plane/client.ts");
    const { parseCastJson } = await import("../plane/cast.ts");
    const { _, flags } = parse(rest);
    const client = createPlaneClient({ config, logger: quietLogger });

    /** Read --body, or --body-stdin (piped). */
    const readBody = async (): Promise<string> => {
      if (flags["body-stdin"]) return (await Bun.stdin.text()).trim();
      return flags.body ? String(flags.body) : "";
    };
    /** A hydrated ticket → the slim row the Concierge needs to reason about progress. */
    const slim = (t: Ticket) => ({
      id: t.id,
      identifier: t.identifier,
      title: t.title,
      state: t.state,
      assignees: t.assignees,
      url: t.url,
      updatedAt: t.updatedAt,
    });
    /**
     * Accept a Plane uuid OR a human identifier ("OPS-42") everywhere a ticket id is expected —
     * the Concierge reasons in identifiers, and forcing uuids produced spurious "no such ticket"
     * dead ends when it stepped in (issue #21).
     */
    const resolveTicketId = async (key: string): Promise<string> => {
      if (/^[0-9a-f-]{32,}$/i.test(key)) return key;
      const all = await client.listIssues();
      const t = all.find((x) => x.identifier.toLowerCase() === key.toLowerCase());
      if (!t) fail(`no such ticket: ${key}`);
      return t.id;
    };

    if (sub === "create") {
      if (!flags.title) {
        fail(
          'usage: beckett ticket create --title <t> [--body <b>|--body-stdin] [--project <slug>] [--state backlog|todo|in_progress|in_review|done|cancelled] [--cast <json>] [--criteria "a;b;c"] [--channel <discord-channel-id>]',
        );
      }
      const casting = flags.cast ? parseCastJson(String(flags.cast)) : {};
      const criteria = flags.criteria
        ? String(flags.criteria).split(";").map((s) => s.trim()).filter(Boolean)
        : [];
      // Restricted self-repo gate — bounce back to the Concierge to re-confirm with the user before
      // any ticket can build against 0xbeckett/beckett (mis-routing polluted the codebase).
      guardRestrictedProject(flags.project ? String(flags.project) : undefined, !!flags["confirm-beckett"]);
      const ticket = await client.createIssue({
        title: String(flags.title),
        body: await readBody(),
        casting,
        criteria,
        // The code project this ticket builds → its own repo at ~/Projects/<slug>, pushed to
        // 0xbeckett/<slug>. Decoupled from Beckett's own source repo.
        project: flags.project ? String(flags.project) : undefined,
        state: flags.state ? (String(flags.state) as TicketState) : undefined,
        // Stamp the originating Discord channel so updates route back to the conversation (closed loop).
        originChannel: flags.channel ? String(flags.channel) : undefined,
      });
      // Tell the Concierge (if running) so it anchors a progress thread to this turn's ack. Gated on
      // --channel: only the Concierge path stamps a channel, and it's the only place a thread can go.
      if (flags.channel) {
        await notifyBus("ticket.filed", {
          identifier: ticket.identifier,
          channelId: String(flags.channel),
          title: String(flags.title),
        });
      }
      out({ id: ticket.id, identifier: ticket.identifier, url: ticket.url, state: ticket.state });
    }
    if (sub === "comment") {
      const id = _[0];
      if (!id) fail("usage: beckett ticket comment <id> <text> | --body <b> | --body-stdin");
      // Accept the body as positional text (per the v3 §8 shorthand) or via --body/--body-stdin.
      const positional = _.slice(1).join(" ").trim();
      const body = positional || (await readBody());
      if (!body) fail("beckett ticket comment: empty body");
      out(await client.addComment(await resolveTicketId(id), body));
    }
    if (sub === "state") {
      const id = _[0];
      const state = _[1];
      if (!id || !state) {
        fail("usage: beckett ticket state <id> <backlog|todo|in_progress|in_review|done|cancelled>");
      }
      await client.setState(await resolveTicketId(id), state as TicketState);
      out({ id, state });
    }
    if (sub === "restaff") {
      // Operator lever (issue #21): routed over the control bus to the live dispatcher, which
      // aborts the ticket's worker (committing WIP) and spawns a fresh one — optionally on a
      // different harness. Only works while the v3 daemon is running (it owns the workers).
      const id = _[0];
      if (!id) fail("usage: beckett ticket restaff <id> [--harness claude|codex|pi]");
      await bus("ticket.restaff", { id, harness: flags.harness ? String(flags.harness) : undefined });
    }
    if (sub === "list") {
      const tickets = await client.listIssues();
      const wanted = flags.state ? String(flags.state) : undefined;
      const rows = (wanted ? tickets.filter((t) => t.state === wanted) : tickets).map(slim);
      out(rows);
    }
    if (sub === "show" || sub === "get") {
      const id = _[0];
      if (!id) fail(`usage: beckett ticket ${sub} <id>`);
      const ticket = await client.getIssue(await resolveTicketId(id));
      if (!ticket) fail(`no such ticket: ${id}`);
      out(ticket);
    }
    fail("usage: beckett ticket create|comment|state|list|show|restaff <...>");
  }

  // ── plan (in-process: file a whole dependency DAG at once) ───────────────────────────────
  // For BIG, multi-part work only. Reads a JSON DAG on stdin (or --file), validates it (unique
  // keys, known edges, no cycles), then files the tickets in dependency order: roots (no `needs`)
  // start NOW (in_progress), dependents wait in `backlog` with a blocked-by edge. The dispatcher
  // promotes each dependent to in_progress once all its blockers reach `done`. For anything that
  // is one cohesive unit, DON'T plan — file a single `beckett ticket create`.
  if (group === "plan") {
    const { flags } = parse([sub, ...rest].filter((x) => x !== undefined) as string[]);
    const raw = flags.file
      ? await Bun.file(String(flags.file)).text()
      : await Bun.stdin.text();
    let spec: any;
    try {
      spec = JSON.parse(raw);
    } catch (err) {
      fail(`plan: input is not valid JSON (${(err as Error).message})`);
    }
    const tickets: any[] = Array.isArray(spec?.tickets) ? spec.tickets : [];
    if (tickets.length === 0) {
      fail(
        'usage: beckett plan [--file <f>] < dag.json\n' +
          '  dag.json = { "channel"?: "<id>", "tickets": [ { "key", "title", "body"?, ' +
          '"criteria"?: string[], "cast"?: {...}, "needs"?: ["key", ...] }, ... ] }',
      );
    }

    // 1. validate keys + edges
    const keys = new Set<string>();
    for (const t of tickets) {
      if (!t.key || typeof t.key !== "string") fail(`plan: every ticket needs a string "key" (got ${JSON.stringify(t.key)})`);
      if (keys.has(t.key)) fail(`plan: duplicate key "${t.key}"`);
      if (!t.title || typeof t.title !== "string") fail(`plan: ticket "${t.key}" needs a "title"`);
      keys.add(t.key);
    }
    const byKey = new Map<string, any>(tickets.map((t) => [t.key, t]));
    for (const t of tickets) {
      for (const need of (t.needs ?? [])) {
        if (!keys.has(need)) fail(`plan: ticket "${t.key}" needs unknown key "${need}"`);
        if (need === t.key) fail(`plan: ticket "${t.key}" cannot depend on itself`);
      }
    }

    // Restricted self-repo gate — fail the WHOLE plan (before filing any node) if a node targets the
    // beckett source repo without --confirm-beckett, so a mis-routed node can't slip in mid-DAG.
    for (const t of tickets) {
      guardRestrictedProject(t.project ? String(t.project) : undefined, !!flags["confirm-beckett"]);
    }

    // 2. topological order (Kahn) — also the cycle detector
    const indeg = new Map<string, number>(tickets.map((t) => [t.key, (t.needs ?? []).length]));
    const dependents = new Map<string, string[]>(); // need → [keys that need it]
    for (const t of tickets) {
      for (const need of (t.needs ?? [])) {
        if (!dependents.has(need)) dependents.set(need, []);
        dependents.get(need)!.push(t.key);
      }
    }
    let queue = tickets.filter((t) => (indeg.get(t.key) ?? 0) === 0).map((t) => t.key);
    const order: string[] = [];
    const levels: string[][] = [];
    while (queue.length > 0) {
      const level = queue;
      levels.push(level);
      const next: string[] = [];
      for (const k of level) {
        order.push(k);
        for (const dep of dependents.get(k) ?? []) {
          indeg.set(dep, (indeg.get(dep) ?? 1) - 1);
          if (indeg.get(dep) === 0) next.push(dep);
        }
      }
      queue = next;
    }
    if (order.length !== tickets.length) {
      const cyclic = tickets.map((t) => t.key).filter((k) => !order.includes(k));
      fail(`plan: dependency cycle among [${cyclic.join(", ")}] — a plan must be a DAG`);
    }

    // 3. file in order, mapping each key → its created identifier so dependents can reference it
    const { createPlaneClient } = await import("../plane/client.ts");
    const client = createPlaneClient({ config, logger: quietLogger });
    const channel = spec.channel ? String(spec.channel) : undefined;
    const identForKey = new Map<string, string>();
    const filed: any[] = [];
    for (const level of levels) {
      const createdLevel = await Promise.all(
        level.map(async (key) => {
          const t = byKey.get(key)!;
          const needs: string[] = t.needs ?? [];
          const blockedBy = needs.map((n) => identForKey.get(n)!).filter(Boolean);
          // roots start immediately; anything with a blocker waits in backlog until promoted.
          const state = blockedBy.length === 0 ? "in_progress" : "backlog";
          const created = await client.createIssue({
            title: String(t.title),
            body: t.body ? String(t.body) : "",
            casting: t.cast ?? {},
            criteria: Array.isArray(t.criteria) ? t.criteria.map(String) : [],
            blockedBy,
            // Per-node code project (its own repo). Sibling nodes may share one project or each get
            // their own; defaults at dispatch to the ticket id when unset.
            project: t.project ? String(t.project) : undefined,
            state: state as TicketState,
            originChannel: channel,
          });
          return {
            key,
            identifier: created.identifier,
            filed: { key, id: created.id, identifier: created.identifier, state, blockedBy, url: created.url },
          };
        }),
      );
      for (const row of createdLevel) {
        identForKey.set(row.key, row.identifier);
        filed.push(row.filed);
      }
    }
    // A plan files N tickets under ONE ack — notify the Concierge for each so they all map onto the
    // single progress thread (the hub keys threads by anchor, tickets by identifier). Best-effort.
    if (channel) {
      for (const row of filed) {
        await notifyBus("ticket.filed", {
          identifier: row.identifier,
          channelId: channel,
          title: String(byKey.get(row.key)?.title ?? row.identifier),
        });
      }
    }
    out({ planned: filed.length, tickets: filed });
  }

  // ── status (control bus → the live daemon; issue #30) ─────────────────────────────────────
  // One command answering "is prod healthy and what is it doing right now". From the Mac:
  //   ssh beckett@loom-desk 'cd beckett && bun src/cli/beckett.ts status --pretty'
  if (group === "status") {
    const { flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    let res;
    try {
      res = await callBus(SOCK, "status", {}, 5_000);
    } catch (err) {
      fail(`daemon not answering on control.sock (${(err as Error).message}) — is beckett-v3.service running?`);
    }
    if (!res.ok) fail(res.error ?? "status failed");
    const data = (res.data ?? {}) as Record<string, any>;
    if (!flags.pretty) out(data);
    const lines: string[] = [];
    lines.push(`beckett v${data.version} @ ${data.commit} — pid ${data.pid}, up ${fmtSecs(data.uptimeSecs)}`);
    lines.push(`discord:   ${data.discord?.connected ? "connected" : "DISCONNECTED"}`);
    const p = data.poller ?? {};
    lines.push(
      `poller:    last poll ${p.lastPollAgeMs != null ? `${Math.round(p.lastPollAgeMs / 1000)}s ago` : "never"}` +
        (p.consecutiveFailures ? `, ${p.consecutiveFailures} CONSECUTIVE FAILURES` : ""),
    );
    const pl = data.plane ?? {};
    lines.push(`plane:     last HTTP ${pl.lastHttpStatus ?? "-"}${pl.lastError ? ` (last error: ${pl.lastError})` : ""}`);
    const c = data.concierge ?? {};
    lines.push(
      `concierge: ${c.contextTokens ?? "?"} ctx tokens (ceiling ${c.rotateAtTokens ?? "?"}), ` +
        `${c.rotations ?? 0} rotations, queue ${c.queueDepth ?? 0}, crashes ${c.consecutiveCrashes ?? 0}`,
    );
    const workers = Array.isArray(data.workers) ? data.workers : [];
    lines.push(`workers:   ${workers.length === 0 ? "none" : workers.length}`);
    for (const w of workers) {
      lines.push(
        w.state === "live"
          ? `  ${w.ticket} · ${w.stage} on ${w.harness} (pid ${w.pid ?? "?"}) — up ${fmtSecs(w.elapsedSecs)}, last event ${w.lastEventAgeSecs != null ? `${w.lastEventAgeSecs}s ago` : "never"} [${w.workerState}]`
          : `  ${w.ticket} · ${w.stage} QUEUED (waiting for ${w.waitingFor})`,
      );
    }
    out(lines.join("\n"));
  }

  // ── doctor (in-process health probe; works with the daemon down; issue #30) ────────────────
  if (group === "doctor") {
    const { flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    const { runDoctor, renderReport, daemonPath } = await import("../ops/doctor.ts");
    const { homedir } = await import("node:os");
    // Probe under the DAEMON's PATH, not this login shell's — the login shell hides exactly the
    // failures that only bite under systemd (the node-18 pi crash).
    process.env.PATH = daemonPath(homedir());
    const report = await runDoctor({ config });
    process.stdout.write((flags.json ? JSON.stringify(report, null, 2) : renderReport(report)) + "\n");
    process.exit(report.ok ? 0 : 1);
  }

  // ── config (in-process; issue #34) ─────────────────────────────────────────────────────────
  if (group === "config") {
    if (sub === "print-default") {
      const { defaultConfigToml } = await import("../config.ts");
      process.stdout.write(defaultConfigToml());
      process.exit(0);
    }
    fail("usage: beckett config print-default  (regenerates deploy/config.toml.example)");
  }

  // ── top-level (control bus) ──────────────────────────────────────────────────────────────
  if (group === "discord" && sub === "reply") {
    const { _, flags } = parse(rest);
    const files = flags.file
      ? (Array.isArray(flags.file) ? flags.file.map(String) : [String(flags.file)])
      : undefined;
    await bus("discord.reply", {
      channelId: flags.channel ? String(flags.channel) : undefined,
      text: _.join(" "),
      files,
    });
  }

  // ── proactivity (control bus: ambient-interjection posture) ─────────────────────────────
  // Beckett's own "chill out in here" / "you can jump in here" lever, routed to the running
  // Concierge over the control bus (§4.6). `set … auto` is owner-gated in the bus handler.
  if (group === "proactivity") {
    if (sub === "status") {
      await bus("proactivity.status", {});
    }
    if (sub === "set") {
      const { _ } = parse(rest);
      const channelId = _[0]?.trim();
      const mode = _[1]?.trim();
      if (!channelId || (mode !== "off" && mode !== "suggest" && mode !== "auto")) {
        fail("usage: beckett proactivity set <channel-id> off|suggest|auto");
      }
      await bus("proactivity.set", { channelId, mode });
    }
    if (sub === "off") {
      await bus("proactivity.off", {});
    }
    fail("usage: beckett proactivity status | set <channel-id> off|suggest|auto | off");
  }

  // ── rpc (in-process: write status file for the RPC daemon) ──────────────────────────────
  if (group === "rpc") {
    const { _, flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    if (sub === "status") {
      const details = _[0] ?? flags.details ?? "on standby";
      const state = _[1] ?? String(flags.state ?? "loom-desk");
      const statusFile = join(paths.beckettDir, "rpc-status.json");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(paths.beckettDir, { recursive: true });
      writeFileSync(statusFile, JSON.stringify({ details, state, updatedAt: Date.now() }, null, 2));
      out({ updated: true, details, state });
    }
    fail("usage: beckett rpc status \"<details>\" [<state>]");
  }
  // Self-improvement: apply edits to your persona/doctrine/skills WITHOUT a service restart.
  if (group === "reload") await bus("reload", {}); // re-spawn the parent (resume) with the new self
  if (group === "persona") await bus("persona", {}); // print the persona path + current contents

  fail(`unknown command: beckett ${group ?? ""} ${sub ?? ""}\n` +
    "commands: status [--pretty] | doctor [--json] | reload | persona | access ls|grant|revoke | identity set|show|list | discord reply | proactivity status|set|off | image | site deploy | ticket create|comment|state|list|show | plan | gh repo|pr|push | dns ls|add|rm | deploy <name>|ls|rm | memory recall|remember");
}

/** "3742" → "1h 2m 22s" (status rendering only). */
function fmtSecs(secs: unknown): string {
  const n = typeof secs === "number" && Number.isFinite(secs) ? Math.max(0, Math.round(secs)) : null;
  if (n === null) return "?";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

main().catch((err) => fail((err as Error).message));
