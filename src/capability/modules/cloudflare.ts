/**
 * Beckett v5 — the dns+deploy capability modules (`src/capability/modules/cloudflare.ts`)
 * =======================================================================================
 * The two Cloudflare-backed surfaces — `beckett dns …` (zone-scoped records via
 * `agency/cloudflare.ts::CfDns`) and `beckett deploy …` (cloudflared named-tunnel ingress +
 * a CNAME via `shell/deploy.ts::TunnelDeployer`) — normalized onto the common factory shape
 * (V5 Phase 2). They stay two registered capabilities (two ids, two help tokens, exactly the
 * command list the CLI has always advertised) but live together here because they share the
 * credential gate and the CfDns client, the same pairing as their implementations. Handler
 * bodies are the former `cli/beckett.ts::runDns`/`runDeploy` moved verbatim; the CLI
 * characterization suite pins their observable behavior byte-for-byte.
 */

import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { CfDns, DEFAULT_APEX_DOMAIN, apexDomain } from "../../agency/cloudflare.ts";
import { TunnelDeployer } from "../../shell/deploy.ts";
import { fail, out, parse } from "../../cli/io.ts";

export function createDnsCapability({ logger }: CapabilityDeps): Capability {
  // Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID from ~/.beckett/.env (via loadConfig). DNS
  // is FREE: a record is a reversible proposal you can delete. Short names expand to the zone
  // apex (e.g. `x-tool` → `x-tool.<zone apex>`). Output is JSON. (See the `deploy` skill.)
  async function runDns(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
    if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare DNS is unavailable");
    if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to your Cloudflare zone id");
    const dns = new CfDns({ token, zoneId, logger });
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

  return {
    id: "dns",
    summary: "zone-scoped Cloudflare DNS, token from env (see the deploy skill)",
    actionClass: ActionClass.FREE,
    cliHelp: "dns ls|add|rm",
    cliVerbs: [
      {
        name: "dns",
        summary: "list/upsert/remove records on the configured Cloudflare zone",
        usage: "beckett dns ls [--name N] [--type T] | add <name> --content <c> [...] | rm <name> [--type T]",
        run: runDns,
      },
    ],
    busCommands: [],
    skillDoc: ".claude/skills/deploy/SKILL.md",
  };
}

export function createDeployCapability({ logger }: CapabilityDeps): Capability {
  // Throws a locally-running app up at <name>.<zone apex>. Reversible/FREE (a record + ingress
  // rule you can delete) but outward — announce the URL in voice. Requires CLOUDFLARE_TUNNEL_ID
  // (a one-time human prereq); fails clearly if absent. (See the `deploy` skill.)
  async function runDeploy(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
    if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
    if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to your Cloudflare zone id");
    const dns = new CfDns({ token, zoneId, logger });
    const deployer = new TunnelDeployer({
      tunnelId: process.env.CLOUDFLARE_TUNNEL_ID,
      dns,
      logger,
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

  return {
    id: "deploy",
    summary: "cloudflared named-tunnel ingress + a CNAME via CfDns (see the deploy skill)",
    actionClass: ActionClass.FREE,
    cliHelp: "deploy <name>|ls|rm",
    cliVerbs: [
      {
        name: "deploy",
        summary: "throw a locally-running app up at <name>.0xbeckett.me",
        usage: "beckett deploy <name> --port <p> | deploy ls | deploy rm <name>",
        run: runDeploy,
      },
    ],
    busCommands: [],
    skillDoc: ".claude/skills/deploy/SKILL.md",
    // The deploy-durability recipe in a worker persona (Phase 4: composed into the system
    // append by `stages.ts::workerSystemAppend`). Priority 30 keeps the historical persona
    // order: github guidance (10) → stage extras (20) → this recipe last.
    promptBlock: {
      id: "deploy",
      priority: 30,
      render: ({ ticket, slug }) =>
        ticket && slug && ticketMentionsDeploy(ticket) ? deployDurabilityNote(slug) : "",
    },
  };
}

/**
 * Durable-deploy guidance baked into every implement worker's system prompt (v3.1 robustness).
 * The recurring footgun (OPS-15, OPS-17, OPS-19): workers improvise their own deploy — a
 * foreground server that dies on session end, a server bound somewhere the tunnel can't reach, or
 * a hand-edited ingress with no DNS record — so the URL 404s / never resolves and burns review
 * cycles. The fix is to give ONE exact path and forbid every improvised alternative, then make the
 * worker prove the public URL responds before it may call the ticket done. Slug-parameterized so
 * the recipe names the worker's real hostname (`<slug>.0xbeckett.me`).
 */
export function deployDurabilityNote(slug: string): string {
  return (
    `DEPLOY DURABLY (only if the ticket needs a public URL): there is exactly ONE supported path, ` +
    `and improvising your own is the #1 cause of dead links here. Do these three steps, nothing else:\n` +
    `  1. Serve the build on a local port with a server that SURVIVES your session: write a ` +
    `\`systemd --user\` unit and \`systemctl --user enable --now <unit>\`. Bind it to 127.0.0.1 (the ` +
    `tunnel reaches localhost). A foreground process (\`python -m http.server\`, \`vite\`, ` +
    `\`bun run dev\`) or a bare \`&\`/\`nohup\` job is FORBIDDEN — it dies when you exit and the link 404s.\n` +
    `  2. Run \`beckett deploy ${slug} --port <thePort>\`. That command (and ONLY that command) ` +
    `creates BOTH the Cloudflare tunnel ingress AND the public DNS record for ` +
    `\`${slug}.0xbeckett.me\`. NEVER hand-edit \`~/.cloudflared/config.yml\` or touch DNS yourself — ` +
    `that leaves a half-deploy with an ingress but no DNS, which never resolves.\n` +
    `  3. VERIFY before you call the ticket done: ` +
    `\`curl -fsS -o /dev/null -w '%{http_code}' https://${slug}.0xbeckett.me\` must print 200. If it ` +
    `can't resolve or returns 502, the deploy is NOT done (your unit isn't running, or ` +
    `\`beckett deploy\` didn't run) — fix it and re-check. Never report a URL you haven't curled.`
  );
}

/**
 * True when the ticket's text suggests it needs a public URL/deploy — gates the ~300-token
 * deploy-durability recipe so pure-code tickets don't carry it in every brief (issue #25).
 */
export function ticketMentionsDeploy(ticket: { title: string; body: string; criteria: string[] }): boolean {
  const text = `${ticket.title}\n${ticket.body}\n${ticket.criteria.join("\n")}`;
  return /deploy|url|site|website|host|serve|public|page|frontend|dashboard|http|tunnel|dns/i.test(text);
}
