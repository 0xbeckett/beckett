/**
 * Beckett v5 — the secret capability module (`src/capability/modules/secret.ts`)
 * =======================================================================================
 * The `beckett secret …` surface (secret-link intake, `src/secret/intake.ts`: token mint + a
 * tiny HTTP endpoint behind the existing tunnel). One generated link can now collect a whole
 * batch of named fields, route the submitted values to either the jingle keychain (default,
 * reusable for browser/computer-use logins) or `.env`, and DM the link to the requester with an
 * ephemeral fallback. The endpoint is kept alive across sessions by the systemd unit below.
 */

import { join } from "node:path";
import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
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
    fail(`${cmd.join(" ")} failed (${code})${tail ? `:\n${tail}` : ""}`);
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

/** Resolve the field set + destination from the request flags. */
function resolveRequest(flags: Record<string, string | boolean>): {
  fields: SecretFieldSpec[];
  destination: SecretDestination;
} {
  const hasName = typeof flags.name === "string" && flags.name.trim() !== "";
  const hasFields = typeof flags.fields === "string" && flags.fields.trim() !== "";
  if (hasName && hasFields) fail("secret request: use either --name (single env key) or --fields, not both");
  if (!hasName && !hasFields) fail(`usage: ${USAGE}`);

  // Legacy shorthand: --name is one masked env field.
  if (hasName) {
    const name = validateSecretEnvName(flags.name as string);
    return { fields: [{ name, secret: true }], destination: { kind: "env" } };
  }

  const fields = parseSecretFieldSpecs(flags.fields as string);
  const destKind = flags.dest === undefined || flags.dest === "keychain" ? "keychain" : flags.dest === "env" ? "env" : null;
  if (destKind === null) fail("secret request --dest must be 'keychain' or 'env'");
  if (destKind === "env") return { fields, destination: { kind: "env" } };

  // keychain (default): needs an entry handle to attach the fields to.
  if (typeof flags.entry !== "string" || !flags.entry.trim()) {
    fail("secret request --dest keychain needs --entry <jingle entry handle>");
  }
  const entry = validateJingleEntry(flags.entry as string);
  const service = typeof flags.service === "string" && flags.service.trim() ? flags.service.trim() : undefined;
  return { fields, destination: { kind: "keychain", entry, ...(service ? { service } : {}) } };
}

async function deliverOrPrint(
  minted: { url: string },
  flags: Record<string, string | boolean>,
  logger: Logger,
): Promise<void> {
  // No requester → keep the legacy contract: print the URL for the caller to deliver.
  if (flags.requester === undefined) {
    out(minted.url);
  }
  const requesterId = String(flags.requester);
  if (!isDiscordUserId(requesterId)) fail("secret request --requester must be a Discord user id");
  const token = process.env.DISCORD_TOKEN;
  if (!token) fail("no DISCORD_TOKEN in ~/.beckett/.env — cannot DM the requester");
  const message = typeof flags.message === "string" ? flags.message : "Here's your one-time secret link — open it and fill in the fields:";

  const result = await deliverSecretLink({
    requesterId,
    url: minted.url,
    message,
    sendDm: discordDmSender({ token }),
    logger,
  });
  // On DM success the URL stays in the DM and out of the transcript. On fallback, hand the URL
  // back with the ephemeral flag so the caller posts it visible only to the requester.
  if (result.via === "dm") out({ delivered: "dm" });
  out({ delivered: "ephemeral", ephemeral: true, url: result.url });
}

export function createSecretCapability({ paths, logger }: CapabilityDeps): Capability {
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
      const { fields, destination } = resolveRequest(flags);
      const ttlMinutes = parseSecretTtlMinutes(flags.ttl);
      const port = parsePort(flags.port ?? process.env.BECKETT_SECRET_PORT, DEFAULT_SECRET_PORT);
      const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
      const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
      if (!token) fail("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
      if (!zoneId) fail("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to your Cloudflare zone id");
      if (!process.env.CLOUDFLARE_TUNNEL_ID) fail("no CLOUDFLARE_TUNNEL_ID in ~/.beckett/.env — the existing named tunnel is unavailable");

      await ensureSecretService(port, paths);
      const dns = new CfDns({ token, zoneId, logger });
      const deployer = new TunnelDeployer({
        tunnelId: process.env.CLOUDFLARE_TUNNEL_ID,
        dns,
        logger,
      });
      const deployed = await deployer.deploy({ name: SECRET_TUNNEL_NAME, service: `http://localhost:${port}` });
      const minted = mintSecretRequest({ paths, fields, destination, ttlMinutes, baseUrl: deployed.url });
      await deliverOrPrint(minted, flags, logger);
    }
    fail(`usage: ${USAGE}`);
  }

  return {
    id: "secret",
    summary: "secret-link intake: batch fields → keychain/env, DM'd to the requester",
    actionClass: ActionClass.FREE,
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
}
