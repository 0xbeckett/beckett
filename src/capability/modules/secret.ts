/**
 * Beckett v6 — the secret extension (`src/capability/modules/secret.ts`)
 * =======================================================================================
 * The second organ on the v6 extension contract (Phase 1, docs/v6-architecture.md §6): the
 * secret-link intake surface (`src/secret/intake.ts`: token mint + a tiny HTTP endpoint behind
 * the existing tunnel). One generated link collects a batch of named fields, routes the
 * submitted values to either the jingle keychain (default, reusable for browser/computer-use
 * logins) or `.env`, and can DM the link to the requester with an ephemeral fallback. The
 * endpoint is kept alive across sessions by the systemd unit below.
 *
 * Two entrypoints share the same throwing cores (`resolveRequestSpec` + `mintAndDeliver`):
 *   - the CLI verb keeps its historical flag parse + `out`/`fail` contract byte-for-byte
 *     (thrown core errors reach stderr through `main().catch(fail)` exactly as the old inline
 *     `fail` calls did — the CLI characterization suite pins it), and
 *   - `secret.request` is the v6 capability: zod-validated structured args in, an
 *     {@link ExtensionResult} out — never `out`/`fail` (those exit the process), so the
 *     concierge can dispatch it in-daemon once its call site cuts over (Phase 2+).
 * `secret serve` stays CLI-only: it IS the long-running endpoint process (the systemd unit's
 * ExecStart), not something the concierge dispatches.
 *
 * `createSecretCapability` remains for the v5 factory table: it is the {@link asCapability}
 * projection of this extension, and retires with the table in Phase 4.
 */

import { join } from "node:path";
import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { CfDns } from "../../agency/cloudflare.ts";
import { TunnelDeployer } from "../../shell/deploy.ts";
import {
  mintSecretRequest,
  parseSecretFieldSpecs,
  parseSecretTtlMinutes,
  serveSecretIntake,
  validateJingleEntry,
  validateSecretEnvName,
  type SecretDestination,
  type SecretFieldSpec,
} from "../../secret/intake.ts";
import { deliverSecretLink, discordDmSender, isDiscordUserId } from "../../secret/delivery.ts";
import { fail, out, parse, parsePort } from "../../cli/io.ts";
import type { Logger, Paths } from "../../types.ts";

const SECRET_TUNNEL_NAME = "secret";
const DEFAULT_SECRET_PORT = 8799;

const USAGE =
  "beckett secret request (--name <ENV_KEY> | --fields <a,b:text>) [--dest keychain|env] [--entry <name>] [--service <domain>] [--requester <userId>] [--message <text>] [--ttl <minutes>] | secret serve --port <port>";

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function runQuiet(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) {
    const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-8).join("\n");
    // Throw, don't fail(): the CLI's main() turns this into the identical `error: …` exit,
    // and the invoke path must never exit the daemon.
    throw new Error(`${cmd.join(" ")} failed (${code})${tail ? `:\n${tail}` : ""}`);
  }
}

async function ensureSecretService(port: number, paths: Paths): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = process.env.HOME ?? paths.home;
  const unitDir = join(home, ".config", "systemd", "user");
  const unitPath = join(unitDir, "beckett-secret.service");
  // The unit must exec the CLI entry (src/cli/beckett.ts), NOT this module — this file lives
  // three levels below the repo root, so resolve both paths from there.
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const cliPath = join(repoRoot, "src", "cli", "beckett.ts");
  const envLines = [
    `Environment=${systemdQuote(`BECKETT_SECRET_PORT=${String(port)}`)}`,
    ...(process.env.BECKETT_DIR ? [`Environment=${systemdQuote(`BECKETT_DIR=${process.env.BECKETT_DIR}`)}`] : []),
    ...(process.env.BECKETT_HOME ? [`Environment=${systemdQuote(`BECKETT_HOME=${process.env.BECKETT_HOME}`)}`] : []),
  ];
  const unit = `[Unit]\nDescription=Beckett secret-link intake\n\n[Service]\nType=simple\nWorkingDirectory=${repoRoot}\nExecStart=${process.execPath} ${cliPath} secret serve --port ${port}\nRestart=on-failure\nRestartSec=2\n${envLines.join("\n")}\n\n[Install]\nWantedBy=default.target\n`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit, { mode: 0o600 });
  await runQuiet(["systemctl", "--user", "daemon-reload"]);
  await runQuiet(["systemctl", "--user", "enable", "--now", "beckett-secret.service"]);
}

/** The structured request shape both surfaces resolve (CLI flags map onto it 1:1). */
interface SecretRequestSpec {
  name?: string;
  fields?: string;
  dest?: string;
  entry?: string;
  service?: string;
}

/**
 * Resolve the field set + destination from a request spec. Throws (never exits) with the
 * exact messages the CLI has always printed; callers guarantee `name` XOR `fields` is present
 * (the CLI pre-checks for its usage line, the capability schema refines it).
 */
function resolveRequestSpec(spec: SecretRequestSpec): {
  fields: SecretFieldSpec[];
  destination: SecretDestination;
} {
  const hasName = typeof spec.name === "string" && spec.name.trim() !== "";
  const hasFields = typeof spec.fields === "string" && spec.fields.trim() !== "";
  if (hasName && hasFields) throw new Error("secret request: use either --name (single env key) or --fields, not both");
  if (!hasName && !hasFields) throw new Error("secret request needs --name or --fields");

  // Legacy shorthand: --name is one masked env field.
  if (hasName) {
    const name = validateSecretEnvName(spec.name!);
    return { fields: [{ name, secret: true }], destination: { kind: "env" } };
  }

  const fields = parseSecretFieldSpecs(spec.fields!);
  const destKind = spec.dest === undefined || spec.dest === "keychain" ? "keychain" : spec.dest === "env" ? "env" : null;
  if (destKind === null) throw new Error("secret request --dest must be 'keychain' or 'env'");
  if (destKind === "env") return { fields, destination: { kind: "env" } };

  // keychain (default): needs an entry handle to attach the fields to.
  if (typeof spec.entry !== "string" || !spec.entry.trim()) {
    throw new Error("secret request --dest keychain needs --entry <jingle entry handle>");
  }
  const entry = validateJingleEntry(spec.entry);
  const service = typeof spec.service === "string" && spec.service.trim() ? spec.service.trim() : undefined;
  return { fields, destination: { kind: "keychain", entry, ...(service ? { service } : {}) } };
}

/** The mint outcome: the link, and how it reached the requester (undefined = caller's job). */
interface SecretLinkResult {
  url: string;
  delivered?: "dm" | "ephemeral";
}

/**
 * The one request core both surfaces call: env preflight → intake service → tunnel → mint →
 * optional DM delivery. Throws (never exits) with the exact messages the CLI has always
 * printed; env checks run FIRST so a creds-less box refuses before touching systemd.
 */
async function mintAndDeliver(p: {
  fields: SecretFieldSpec[];
  destination: SecretDestination;
  ttlMinutes: number;
  port: number;
  requester?: string;
  message?: string;
  paths: Paths;
  logger: Logger;
}): Promise<SecretLinkResult> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
  if (!token) throw new Error("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
  if (!zoneId) throw new Error("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to your Cloudflare zone id");
  if (!process.env.CLOUDFLARE_TUNNEL_ID) throw new Error("no CLOUDFLARE_TUNNEL_ID in ~/.beckett/.env — the existing named tunnel is unavailable");

  await ensureSecretService(p.port, p.paths);
  const dns = new CfDns({ token, zoneId, logger: p.logger });
  const deployer = new TunnelDeployer({
    tunnelId: process.env.CLOUDFLARE_TUNNEL_ID,
    dns,
    logger: p.logger,
  });
  const deployed = await deployer.deploy({ name: SECRET_TUNNEL_NAME, service: `http://localhost:${p.port}` });
  const minted = mintSecretRequest({
    paths: p.paths,
    fields: p.fields,
    destination: p.destination,
    ttlMinutes: p.ttlMinutes,
    baseUrl: deployed.url,
  });

  // No requester → keep the legacy contract: hand the URL back for the caller to deliver.
  if (p.requester === undefined) return { url: minted.url };
  if (!isDiscordUserId(p.requester)) throw new Error("secret request --requester must be a Discord user id");
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) throw new Error("no DISCORD_TOKEN in ~/.beckett/.env — cannot DM the requester");
  const message = p.message ?? "Here's your one-time secret link — open it and fill in the fields:";

  const result = await deliverSecretLink({
    requesterId: p.requester,
    url: minted.url,
    message,
    sendDm: discordDmSender({ token: discordToken }),
    logger: p.logger,
  });
  // On DM success the URL stays in the DM and out of the transcript. On fallback, hand the URL
  // back with the ephemeral flag so the caller posts it visible only to the requester.
  if (result.via === "dm") return { url: minted.url, delivered: "dm" };
  return { url: result.url, delivered: "ephemeral" };
}

/** The validated shape of a `secret.request` call — the registry checks args against this. */
const RequestArgs = z
  .object({
    /** Legacy shorthand: one masked env key (destination becomes .env). */
    name: z.string().optional(),
    /** Field spec list, same syntax as the CLI: "username,password" or "user:text,key:secret". */
    fields: z.string().optional(),
    dest: z.enum(["keychain", "env"]).optional(),
    /** The jingle entry handle the keychain fields attach to (required for dest keychain). */
    entry: z.string().optional(),
    /** The service domain recorded on the keychain entry. */
    service: z.string().optional(),
    /** Discord user id to DM the link to; omitted → the URL is returned to the caller. */
    requester: z.string().optional(),
    /** The DM text accompanying the link. */
    message: z.string().optional(),
    ttlMinutes: z.number().int().min(1).max(1440).optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .refine((a) => Boolean(a.name?.trim()) !== Boolean(a.fields?.trim()), {
    message: 'secret.request needs exactly one of `name` (a single env key) or `fields` (e.g. "username,password")',
  });

export const createSecretExtension: ExtensionFactory = ({ paths, logger }): Extension => {
  // The former `cli/beckett.ts::runSecret`, byte-identical in observable behavior: flag
  // parsing + usage failures stay here; thrown core errors surface via main().catch(fail).
  async function runSecret(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const { flags } = parse(rest);
    if (sub === "serve") {
      const port = parsePort(flags.port ?? process.env.BECKETT_SECRET_PORT, DEFAULT_SECRET_PORT);
      serveSecretIntake({ paths, port, hostname: "127.0.0.1" });
      process.stderr.write(`beckett secret intake listening on 127.0.0.1:${port}\n`);
      await new Promise(() => {});
      return;
    }
    if (sub === "request") {
      const hasName = typeof flags.name === "string" && flags.name.trim() !== "";
      const hasFields = typeof flags.fields === "string" && flags.fields.trim() !== "";
      if (!hasName && !hasFields) fail(`usage: ${USAGE}`);
      const { fields, destination } = resolveRequestSpec({
        name: hasName ? (flags.name as string) : undefined,
        fields: hasFields ? (flags.fields as string) : undefined,
        dest: flags.dest === undefined ? undefined : String(flags.dest),
        entry: typeof flags.entry === "string" ? flags.entry : undefined,
        service: typeof flags.service === "string" ? flags.service : undefined,
      });
      const result = await mintAndDeliver({
        fields,
        destination,
        ttlMinutes: parseSecretTtlMinutes(flags.ttl),
        port: parsePort(flags.port ?? process.env.BECKETT_SECRET_PORT, DEFAULT_SECRET_PORT),
        requester: flags.requester === undefined ? undefined : String(flags.requester),
        message: typeof flags.message === "string" ? flags.message : undefined,
        paths,
        logger,
      });
      if (result.delivered === undefined) out(result.url);
      if (result.delivered === "dm") out({ delivered: "dm" });
      out({ delivered: "ephemeral", ephemeral: true, url: result.url });
    }
    fail(`usage: ${USAGE}`);
  }

  return {
    manifest: {
      id: "secret",
      version: "1.0.0",
      summary: "secret-link intake: batch fields → keychain/env, DM'd to the requester",
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch ---
    capabilities: [
      {
        id: "secret.request",
        description:
          "Mint a one-time secret-intake link so a person can hand over credentials, API keys, " +
          "or logins without pasting them in chat. Submitted values land in the jingle keychain " +
          "(default; give an `entry` handle) or ~/.beckett/.env — never in a transcript. Reach " +
          "for it whenever a task needs a credential you don't have. Pass `requester` to DM the " +
          "link straight to them; otherwise the URL comes back for you to deliver.",
        input: RequestArgs,
        examples: [
          "I need your Cloudflare API token — send me a secret link",
          "collect a username and password for the staging login and keep them in the keychain",
        ],
      },
    ],
    invoke: async (call) => {
      if (call.capabilityId !== "secret.request") {
        return { ok: false, error: `secret: unknown capability "${call.capabilityId}"` };
      }
      // Args are already validated by the registry against RequestArgs.
      const a = call.args as z.infer<typeof RequestArgs>;
      try {
        const { fields, destination } = resolveRequestSpec(a);
        const envPort = Number(process.env.BECKETT_SECRET_PORT);
        const result = await mintAndDeliver({
          fields,
          destination,
          ttlMinutes: a.ttlMinutes ?? parseSecretTtlMinutes(undefined),
          port: a.port ?? (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : DEFAULT_SECRET_PORT),
          requester: a.requester,
          message: a.message,
          paths,
          logger,
        });
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    // --- v5 facets, carried through unchanged ---
    cliHelp: "secret request",
    cliVerbs: [
      {
        name: "secret",
        summary: "mint a secret-intake URL for a batch of fields (serve runs the endpoint)",
        usage: USAGE,
        run: runSecret,
      },
    ],
    busCommands: [],
  };
};

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createSecretCapability(deps: CapabilityDeps): Capability {
  return asCapability(createSecretExtension(deps));
}
