/**
 * The `beckett browser` passthrough — the Concierge's own hands on a real browser.
 *
 * Beckett drives the shared persistent browser directly through the agent-browser CLI
 * (https://github.com/vercel-labs/agent-browser, Apache-2.0): a native daemon keeps the
 * browser alive between invocations, so state survives across Concierge turns and anyone
 * can ask "how is that browser job going" and get a live answer from the same session.
 *
 * This module only builds the invocation. It injects the default session and a per-session
 * persistent profile directory via agent-browser's documented environment variables, so an
 * explicit `--session`/`--profile` flag from the caller always wins over the injected default.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPaths } from "../paths.ts";
import type { Config } from "../types.ts";

export interface BrowserInvocation {
  cmd: string[];
  env: Record<string, string | undefined>;
  /** The session the command will address after flag/env resolution. */
  session: string;
  /** The persistent profile directory injected for that session (unless the caller overrode it). */
  profileDir: string;
  /** Wall-clock ceiling for this one command; the caller kills the child past it. */
  timeoutMs: number;
}

/** Read the value of a `--flag value` pair anywhere in the argv tail. */
function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  const value = argv[index + 1]!;
  return value.startsWith("-") ? null : value;
}

/** Session names become profile directory names; refuse anything that could escape the tree. */
function safeSessionName(session: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(session)) {
    throw new Error(`browser session name "${session}" must be alphanumeric with ._- (max 64 chars)`);
  }
  return session;
}

/** Prefer the repo-pinned agent-browser binary; fall back to PATH for global installs. */
export function resolveAgentBrowserBin(config: Config): string {
  const configured = config.browser.bin.trim();
  if (configured) return configured;
  const pinned = resolve(import.meta.dir, "..", "..", "node_modules", ".bin", "agent-browser");
  return existsSync(pinned) ? pinned : "agent-browser";
}

/** The jingle credential-provider plugin shipped next to this module (see jingle-plugin.ts). */
export function jinglePluginRegistry(): string | null {
  const script = resolve(import.meta.dir, "jingle-plugin.ts");
  if (!existsSync(script)) return null;
  return JSON.stringify([{ name: "jingle", command: script, capabilities: ["credential.read"] }]);
}

export function buildBrowserInvocation(
  config: Config,
  argv: readonly string[],
  baseEnv: Record<string, string | undefined> = process.env,
): BrowserInvocation {
  if (!config.browser.enabled) {
    throw new Error("the browser is disabled ([browser] enabled=false)");
  }
  if (argv.length === 0) {
    throw new Error('usage: beckett browser <agent-browser command...> (try "beckett browser skills get core")');
  }
  const session = safeSessionName(flagValue(argv, "--session") ?? config.browser.session);
  // One persistent profile per session: cookies and signed-in state survive daemon restarts,
  // while parallel sessions never share a live Chrome profile (which would conflict).
  const profileDir = join(buildPaths(config).beckettDir, "browser", "profiles", session);
  if (flagValue(argv, "--profile") === null) {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  }
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_PROFILE: profileDir,
    // An abandoned daemon (and its Chrome) shuts itself down instead of idling forever.
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(config.browser.idle_timeout_secs * 1000),
    // A giant page must not flood the calling turn's context; explicit --max-output wins.
    AGENT_BROWSER_MAX_OUTPUT: baseEnv.AGENT_BROWSER_MAX_OUTPUT ?? String(config.browser.max_output_chars),
  };
  // Credentials resolve just-in-time from the jingle vault:
  //   beckett browser auth login <entry> --credential-provider jingle --item <entry>
  const plugins = jinglePluginRegistry();
  if (plugins && !baseEnv.AGENT_BROWSER_PLUGINS) env.AGENT_BROWSER_PLUGINS = plugins;
  const cmd = [resolveAgentBrowserBin(config)];
  const executablePath = config.browser.executable_path.trim();
  if (executablePath && flagValue(argv, "--executable-path") === null) {
    cmd.push("--executable-path", executablePath);
  }
  cmd.push(...argv);
  return { cmd, env, session, profileDir, timeoutMs: config.browser.command_timeout_secs * 1000 };
}
