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
import { CfDns } from "../../agency/cloudflare.ts";
import { TunnelDeployer } from "../../shell/deploy.ts";
import { fail, out, parse } from "../../cli/io.ts";

export function createDnsCapability({ logger }: CapabilityDeps): Capability {
  // Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID from ~/.beckett/.env (via loadConfig). DNS
  // is FREE: a record is a reversible proposal you can delete. Short names expand to the zone
  // apex (e.g. `x-tool` → `x-tool.0xbeckett.me`). Output is JSON. (See the `deploy` skill.)
  async function runDns(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
    if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare DNS is unavailable");
    if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to the 0xbeckett.me zone id");
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
        summary: "list/upsert/remove records on the 0xbeckett.me zone",
        usage: "beckett dns ls [--name N] [--type T] | add <name> --content <c> [...] | rm <name> [--type T]",
        run: runDns,
      },
    ],
    busCommands: [],
    skillDoc: ".claude/skills/deploy/SKILL.md",
  };
}

export function createDeployCapability({ logger }: CapabilityDeps): Capability {
  // Throws a locally-running app up at <name>.0xbeckett.me. Reversible/FREE (a record + ingress
  // rule you can delete) but outward — announce the URL in voice. Requires CLOUDFLARE_TUNNEL_ID
  // (a one-time human prereq); fails clearly if absent. (See the `deploy` skill.)
  async function runDeploy(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
    if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
    if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to the 0xbeckett.me zone id");
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
  };
}
