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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { callBus } from "../shell/control-bus.ts";
import { createMemory } from "../memory/index.ts";
import { GitHubCli, loadIdentity } from "../agency/index.ts";
import { CfDns } from "../agency/cloudflare.ts";
import { CodexImageGen } from "../agency/imagegen.ts";
import { TunnelDeployer } from "../shell/deploy.ts";
import { loadAccess, grantAccess, revokeAccess, ACCESS_CAP } from "../discord/access.ts";
import type { RememberIntent, NodeType, Logger, MergeStrategy, ReviewParams } from "../types.ts";
import type { Ticket, TicketState } from "../plane/types.ts";

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

  // ── worker (control bus) ─────────────────────────────────────────────────────────────────
  if (group === "worker") {
    const { _, flags } = parse(rest);
    if (sub === "spawn") {
      if (!flags.task || !flags.repo) fail("usage: beckett worker spawn --task <t> --repo <path> --owned <g1,g2> --desc <d> [--system <s>] [--model <m>] [--base <ref>] [--turn-cap N] [--wall-s N] [--network] [--effort e]");
      await bus("worker.spawn", {
        task: String(flags.task),
        repoRoot: String(flags.repo),
        baseRef: flags.base ? String(flags.base) : undefined,
        systemAppend: flags.system ? String(flags.system) : undefined,
        model: flags.model ? String(flags.model) : undefined,
        scope: {
          ownedGlobs: flags.owned ? String(flags.owned).split(",") : ["**"],
          readGlobs: null,
          description: flags.desc ? String(flags.desc) : "",
        },
        envelope: {
          effort: flags.effort ? String(flags.effort) : undefined,
          turnCap: flags["turn-cap"] ? Number(flags["turn-cap"]) : undefined,
          wallClockS: flags["wall-s"] ? Number(flags["wall-s"]) : undefined,
          network: Boolean(flags.network),
        },
      });
    }
    if (sub === "status") await bus("worker.status", { workerId: _[0] });
    if (sub === "log") await bus("worker.log", { workerId: _[0], lastN: flags.last ? Number(flags.last) : undefined });
    if (sub === "nudge") await bus("worker.nudge", { workerId: _[0], text: _.slice(1).join(" ") });
    if (sub === "abort") await bus("worker.abort", { workerId: _[0], reason: flags.reason ? String(flags.reason) : undefined });
    if (sub === "checkin")
      await bus("worker.checkin", {
        workerId: _[0],
        afterTurns: flags["after-turns"] ? Number(flags["after-turns"]) : undefined,
        afterSecs: flags["after-secs"] ? Number(flags["after-secs"]) : undefined,
        reason: flags.reason ? String(flags.reason) : undefined,
      });
    fail(`unknown: beckett worker ${sub ?? ""}`);
  }

  // ── work (in-process: the on-disk worker ledger — survives shell restarts) ────────────────
  // `worker ...` is LIVE control over the running shell's registry; `work ...` reads the durable
  // ~/.beckett/workers/<id>/ records straight off disk, so it answers "what was I doing / did any
  // work get interrupted?" even after a restart, with the shell down, before spinning up anything.
  if (group === "work") {
    const dir = join(paths.beckettDir, "workers");
    if (sub === "ls" || sub === undefined) {
      if (!existsSync(dir)) out([]);
      const now = Date.now();
      const rows = readdirSync(dir)
        .map((id) => join(dir, id, "status.json"))
        .filter((f) => existsSync(f))
        .map((f) => {
          let d: Record<string, unknown> = {};
          try { d = JSON.parse(readFileSync(f, "utf8")); } catch { /* skip corrupt */ }
          const ageMs = now - statSync(f).mtimeMs;
          // A "running" record that hasn't been touched in minutes is an orphan from a prior shell.
          const interrupted = d.state === "running" && ageMs > 120_000;
          return { ...d, ageMs, interrupted };
        })
        .sort((a, b) => (a.ageMs as number) - (b.ageMs as number));
      out(rows);
    }
    if (sub === "show") {
      const id = rest[0];
      if (!id) fail("usage: beckett work show <workerId> [--last N]");
      const wdir = join(dir, id);
      if (!existsSync(wdir)) fail(`no worker record: ${id}`);
      const { flags } = parse(rest.slice(1));
      const lastN = flags.last ? Number(flags.last) : 40;
      let status: unknown = null;
      try { status = JSON.parse(readFileSync(join(wdir, "status.json"), "utf8")); } catch { /* none */ }
      const evFile = join(wdir, "events.jsonl");
      const events = existsSync(evFile)
        ? readFileSync(evFile, "utf8").trim().split("\n").filter(Boolean).slice(-lastN).map((l) => {
            try { return JSON.parse(l); } catch { return { raw: l }; }
          })
        : [];
      out({ status, events });
    }
    fail("usage: beckett work ls | work show <workerId> [--last N]");
  }

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
      if (action === "status") {
        if (!repo || !n) fail("usage: beckett gh pr status <num> --repo <owner/name>");
        out({ repo, number: n, green: await gh.isGreen(repo, n) });
      }
      if (action === "review") {
        if (!repo || !n) fail("usage: beckett gh pr review <num> --repo <r> --event APPROVE|REQUEST_CHANGES|COMMENT --body <b>");
        await gh.reviewPR(repo, n, { event: String(flags.event ?? "COMMENT") as ReviewParams["event"], body: String(flags.body ?? "") });
        out({ reviewed: true, repo, number: n });
      }
      fail("usage: beckett gh pr create|merge|status|review <num> --repo <owner/name> ...");
    }

    if (sub === "push") {
      if (!flags.repo || !flags.branch) fail("usage: beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref <localRef>] [--dir <d>]");
      await gh.pushBranch(String(flags.repo), flags.ref ? String(flags.ref) : "HEAD", String(flags.branch));
      out({ pushed: true, repo: String(flags.repo), branch: String(flags.branch) });
    }

    fail("usage: beckett gh repo create | pr create|merge|status|review | push");
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

    if (sub === "create") {
      if (!flags.title) {
        fail(
          'usage: beckett ticket create --title <t> [--body <b>|--body-stdin] [--state backlog|todo|in_progress|in_review|done|cancelled] [--cast <json>] [--criteria "a;b;c"]',
        );
      }
      const casting = flags.cast ? parseCastJson(String(flags.cast)) : {};
      const criteria = flags.criteria
        ? String(flags.criteria).split(";").map((s) => s.trim()).filter(Boolean)
        : [];
      const ticket = await client.createIssue({
        title: String(flags.title),
        body: await readBody(),
        casting,
        criteria,
        state: flags.state ? (String(flags.state) as TicketState) : undefined,
      });
      out({ id: ticket.id, identifier: ticket.identifier, url: ticket.url, state: ticket.state });
    }
    if (sub === "comment") {
      const id = _[0];
      if (!id) fail("usage: beckett ticket comment <id> <text> | --body <b> | --body-stdin");
      // Accept the body as positional text (per the v3 §8 shorthand) or via --body/--body-stdin.
      const positional = _.slice(1).join(" ").trim();
      const body = positional || (await readBody());
      if (!body) fail("beckett ticket comment: empty body");
      out(await client.addComment(id, body));
    }
    if (sub === "state") {
      const id = _[0];
      const state = _[1];
      if (!id || !state) {
        fail("usage: beckett ticket state <id> <backlog|todo|in_progress|in_review|done|cancelled>");
      }
      await client.setState(id, state as TicketState);
      out({ id, state });
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
      const ticket = await client.getIssue(id);
      if (!ticket) fail(`no such ticket: ${id}`);
      out(ticket);
    }
    fail("usage: beckett ticket create|comment|state|list|show <...>");
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
  // ── flow (control bus: heavy-path scripts the parent writes) ─────────────────────────────
  if (group === "flow") {
    const { _, flags } = parse(rest);
    const argsJson = flags.args ? JSON.parse(String(flags.args)) : undefined;
    if (sub === "run") {
      if (!_[0]) fail("usage: beckett flow run <file.js> [--args <json>]");
      const script = resolve(_[0]);
      if (!existsSync(script)) fail(`no such flow script: ${script}`);
      await bus("flow.run", { script, args: argsJson });
    }
    if (sub === "resume") {
      const runId = _[0];
      const file = _[1] ?? (flags.script ? String(flags.script) : undefined);
      if (!runId || !file) fail("usage: beckett flow resume <runId> <file.js> [--args <json>]");
      const script = resolve(file);
      if (!existsSync(script)) fail(`no such flow script: ${script}`);
      await bus("flow.resume", { runId, script, args: argsJson });
    }
    if (sub === "ls") await bus("flow.ls", {});
    if (sub === "show") {
      if (!_[0]) fail("usage: beckett flow show <runId>");
      await bus("flow.show", { runId: _[0] });
    }
    fail("usage: beckett flow run <file> | resume <runId> <file> | ls | show <runId>");
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

  if (group === "inject") await bus("inject", { text: [sub, ...rest].filter(Boolean).join(" ") });
  if (group === "integrate") {
    const { _, flags } = parse([sub, ...rest].filter(Boolean) as string[]);
    await bus("integrate", { workerIds: _, targetBranch: flags.target ? String(flags.target) : undefined });
  }
  if (group === "status") await bus("status", {});
  // Self-improvement: apply edits to your persona/doctrine/skills WITHOUT a service restart.
  if (group === "reload") await bus("reload", {}); // re-spawn the parent (resume) with the new self
  if (group === "persona") await bus("persona", {}); // print the persona path + current contents

  fail(`unknown command: beckett ${group ?? ""} ${sub ?? ""}\n` +
    "commands: inject | status | reload | persona | access ls|grant|revoke | discord reply | image | site deploy | ticket create|comment|state|list|show | worker spawn|status|log|nudge|abort|checkin | work ls|show | flow run|resume|ls|show | integrate | gh repo|pr|push | dns ls|add|rm | deploy <name>|ls|rm | memory recall|remember");
}

main().catch((err) => fail((err as Error).message));
