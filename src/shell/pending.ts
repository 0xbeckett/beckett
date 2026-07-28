import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../types.ts";
import { buildPaths } from "../paths.ts";
import { serveBus, type BusRequest, type BusResponse } from "./control-bus.ts";

/**
 * A fresh install has intentionally not collected secrets or browser-based subscription logins.
 * Keep the user service alive in this state so `beckett status` gives the operator an honest,
 * actionable answer instead of systemd repeatedly restarting a daemon that cannot log in.
 */
export function pendingConfigurationProblems(
  config: Config,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string[] {
  const problems: string[] = [];
  for (const key of ["DISCORD_TOKEN", "DISCORD_OWNER_ID", "GITHUB_PAT"]) {
    if (!env[key]?.trim()) problems.push(`missing ${key} in ~/.beckett/.env`);
  }
  const ownerId = env.DISCORD_OWNER_ID?.trim();
  if (ownerId && !/^\d{17,20}$/.test(ownerId)) {
    problems.push("DISCORD_OWNER_ID must be a Discord numeric user id");
  }
  if (!Bun.file(join(home, ".claude", ".credentials.json")).size) {
    problems.push("Claude is not logged in");
  }
  if (config.harness.pi.enabled && !Bun.file(join(home, ".pi", "agent", "auth.json")).size) {
    problems.push("Pi is enabled but not logged in");
  }
  if (config.harness.codex.enabled && !Bun.file(join(home, ".codex", "auth.json")).size) {
    problems.push("Codex is enabled but not logged in");
  }
  if (config.identity.github_user === "CHANGE_ME") {
    problems.push("GitHub username is still CHANGE_ME in ~/.beckett/config.toml");
  }
  return problems;
}

export interface PendingConfigurationDaemonOptions {
  config: Config;
  version: string;
  problems: string[];
  /** Injectable only for the focused control-socket check. */
  socketPath?: string;
}

/** Start the tiny control-socket daemon used while first-run configuration is incomplete. */
export function startPendingConfigurationDaemon(opts: PendingConfigurationDaemonOptions): () => void {
  const socketPath = opts.socketPath ?? join(buildPaths(opts.config).beckettDir, "control.sock");
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  return serveBus(socketPath, (req: BusRequest): BusResponse => {
    if (req.cmd !== "status") {
      return { ok: false, error: "Beckett is waiting for first-run configuration; only status is available" };
    }
    return {
      ok: true,
      data: {
        version: opts.version,
        commit: "configuration-pending",
        pid: process.pid,
        uptimeSecs: Math.round((Date.now() - startedAt) / 1_000),
        state: "healthy-pending-configuration",
        configuration: { pending: true, problems: opts.problems },
      },
    };
  });
}
