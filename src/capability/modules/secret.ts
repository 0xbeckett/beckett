/**
 * Beckett v5 — the secret capability module (`src/capability/modules/secret.ts`)
 * =======================================================================================
 * The `beckett secret …` surface (one-time secret intake, `src/secret/intake.ts`: token mint
 * + a tiny HTTP endpoint behind the existing tunnel), normalized onto the common factory
 * shape (V5 Phase 2). Handler bodies — including the systemd unit that keeps the intake
 * endpoint alive across sessions — are the former `cli/beckett.ts` code moved verbatim; the
 * CLI characterization suite pins the observable behavior byte-for-byte.
 */

import { join } from "node:path";
import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { CfDns } from "../../agency/cloudflare.ts";
import { TunnelDeployer } from "../../shell/deploy.ts";
import { mintSecretRequest, parseSecretTtlMinutes, serveSecretIntake, validateSecretEnvName } from "../../secret/intake.ts";
import { fail, out, parse, parsePort } from "../../cli/io.ts";
import type { Paths } from "../../types.ts";

const SECRET_TUNNEL_NAME = "secret";
const DEFAULT_SECRET_PORT = 8799;

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
  const unit = `[Unit]\nDescription=Beckett one-time secret intake\n\n[Service]\nType=simple\nWorkingDirectory=${repoRoot}\nExecStart=${process.execPath} ${cliPath} secret serve --port ${port}\nRestart=on-failure\nRestartSec=2\n${envLines.join("\n")}\n\n[Install]\nWantedBy=default.target\n`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit, { mode: 0o600 });
  await runQuiet(["systemctl", "--user", "daemon-reload"]);
  await runQuiet(["systemctl", "--user", "enable", "--now", "beckett-secret.service"]);
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
      if (typeof flags.name !== "string" || !flags.name.trim()) fail("usage: beckett secret request --name <ENV_KEY> [--ttl <minutes>]");
      const name = validateSecretEnvName(flags.name);
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
      const minted = mintSecretRequest({ paths, name, ttlMinutes, baseUrl: deployed.url });
      out(minted.url);
    }
    fail("usage: beckett secret request --name <ENV_KEY> [--ttl <minutes>] | secret serve --port <port>");
  }

  return {
    id: "secret",
    summary: "one-time secret intake: token mint + tiny HTTP endpoint behind the tunnel",
    actionClass: ActionClass.FREE,
    cliHelp: "secret request",
    cliVerbs: [
      {
        name: "secret",
        summary: "mint a one-time secret-intake URL (serve runs the endpoint)",
        usage: "beckett secret request --name <ENV_KEY> [--ttl <minutes>] | secret serve --port <port>",
        run: runSecret,
      },
    ],
    busCommands: [],
  };
}
