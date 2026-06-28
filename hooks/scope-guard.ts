#!/usr/bin/env bun
/**
 * Beckett — PreToolUse scope guard (`hooks/scope-guard.ts`)
 * =======================================================================================
 * A STANDALONE PreToolUse hook script that `claude` runs as a subprocess. It reads a hook
 * event JSON on stdin and writes an allow/deny decision on stdout. `--permission-mode
 * bypassPermissions` still honours hook denies, so this is the hard boundary.
 *
 * Salvaged from the original (TS) Beckett and extended for the ambient single-session model:
 *   1. WRITE confinement — Edit/Write/MultiEdit/NotebookEdit targets, and best-effort Bash
 *      redirection targets, must stay inside --root (the box: /home/beckett). Escapes are
 *      denied. Symlink-escape and shell-expansion targets fail closed.
 *   2. SECRET denylist — any tool that touches a path under one of --deny (the vault:
 *      ~/.beckett/.env, ~/.ssh, ~/.git-credentials) is denied, INCLUDING Read, and including
 *      a Bash command that merely names the path (cat/less/python/etc). The agent's gh
 *      credential is in its env; it never needs to read the vault files.
 *
 * Config (CLI args preferred; env fallback):
 *   --root <abs>            | env BECKETT_WORKTREE     (the writable box root)
 *   --deny "p1:p2:..."      | env BECKETT_DENY_PATHS   (colon-separated abs paths, denied for ALL access)
 */

import { resolve, relative, isAbsolute, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";

export const WORKTREE_ENV = "BECKETT_WORKTREE";
export const DENY_ENV = "BECKETT_DENY_PATHS";
export const SEP = ":";

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  [k: string]: unknown;
}

export interface ScopeGuardConfig {
  /** Absolute writable root (the box). Writes may not escape it. */
  root: string;
  /** Absolute paths denied for ANY access (read or write). */
  deny: string[];
}

export type HookDecision =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
      };
    };

/** Tools whose path arg is a WRITE target (confined to root). */
const PATH_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools whose path arg is a READ target (only the deny list applies). */
const PATH_READ_TOOLS = new Set(["Read"]);

const ALLOWED_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
function isAllowedSink(absPath: string): boolean {
  return ALLOWED_SINKS.has(absPath) || absPath.startsWith("/dev/fd/");
}

const SHELL_META = /[$~`]/;
export function hasShellMeta(target: string): boolean {
  return SHELL_META.test(target);
}

/** Best-effort extraction of Bash write-redirection targets. Never throws. */
export function extractBashTargets(cmd: string): string[] {
  const targets: string[] = [];
  const re = /(?:&>>|&>|>>|>\||>|(?:^|\s)-o\s|--output[=\s]|\btee\b\s+)\s*['"]?([^\s'">|;&)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const t = m[1];
    if (t && !t.startsWith("&") && t !== "-") targets.push(t);
  }
  return targets;
}

function toAbs(root: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(root, target);
}

/** Realpath the nearest existing ancestor, re-appending the not-yet-existing suffix. */
function realResolve(absPath: string): string {
  let existing = absPath;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return suffix.length ? join(real, ...suffix) : real;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absPath;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** True if realpath(absPath) is, or is under, any denied path. */
function isDenied(absPath: string, deny: string[]): string | null {
  if (deny.length === 0) return null;
  const real = realResolve(absPath);
  for (const d of deny) {
    const realDeny = realResolve(resolve(d));
    const rel = relative(realDeny, real);
    const under = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (under) {
      return `${absPath} is inside your protected vault (${d}). That path is off limits — you don't need it.`;
    }
  }
  return null;
}

function escapesRoot(absPath: string, realRoot: string): boolean {
  const realTarget = realResolve(absPath);
  const rel = relative(realRoot, realTarget);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel);
}

function denyDecision(reason: string): HookDecision {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Out of scope: ${reason}`,
    },
  };
}

export function isGatedTool(tool: string): boolean {
  return PATH_WRITE_TOOLS.has(tool) || PATH_READ_TOOLS.has(tool) || tool === "Bash";
}

/**
 * Candidate literal needles for a denied path in a Bash command (abs, ~, $HOME
 * forms). The home base is the box root (`--root`), NOT the hook-runner's
 * homedir — the box IS the home, and the hook may run as a different user.
 */
function denyNeedles(deny: string[], root: string): string[] {
  const home = resolve(root);
  const out: string[] = [];
  for (const d of deny) {
    const abs = resolve(d);
    out.push(abs);
    if (abs === home || abs.startsWith(home + "/")) {
      const tail = abs.slice(home.length);
      out.push("~" + tail);
      out.push("$HOME" + tail);
      out.push("${HOME}" + tail);
    }
  }
  return out;
}

export function evaluateScopeGuard(input: HookInput, cfg: ScopeGuardConfig): HookDecision {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const realRoot = realResolve(cfg.root);

  if (PATH_READ_TOOLS.has(tool)) {
    const fp = ti.file_path;
    if (typeof fp === "string" && fp) {
      const reason = isDenied(toAbs(cfg.root, fp), cfg.deny);
      if (reason) return denyDecision(reason);
    }
    return {};
  }

  if (PATH_WRITE_TOOLS.has(tool)) {
    const fp = ti.file_path ?? ti.notebook_path;
    if (typeof fp === "string" && fp) {
      const abs = toAbs(cfg.root, fp);
      const denied = isDenied(abs, cfg.deny);
      if (denied) return denyDecision(denied);
      if (!isAllowedSink(abs) && escapesRoot(abs, realRoot)) {
        return denyDecision(
          `${fp} resolves outside your box (${realRoot}). You may only write inside it.`,
        );
      }
    }
    return {};
  }

  if (tool === "Bash") {
    const cmd = typeof ti.command === "string" ? ti.command : "";
    // Secret denylist: deny if the command names a protected path in any common form.
    for (const needle of denyNeedles(cfg.deny, cfg.root)) {
      if (cmd.includes(needle)) {
        return denyDecision(
          `that command touches your protected vault (${needle}). It's off limits — you don't need it.`,
        );
      }
    }
    // Write confinement on redirection targets.
    const targets = extractBashTargets(cmd);
    for (const t of targets) {
      if (hasShellMeta(t)) {
        return denyDecision(
          `Bash write target "${t}" uses shell expansion that can't be safely checked. ` +
            `Redirect to an explicit literal path inside your box.`,
        );
      }
      const abs = toAbs(cfg.root, t);
      const denied = isDenied(abs, cfg.deny);
      if (denied) return denyDecision(denied);
      if (!isAllowedSink(abs) && escapesRoot(abs, realRoot)) {
        return denyDecision(
          `Bash write "${t}" lands outside your box (${realRoot}). Write inside it.`,
        );
      }
    }
    return {};
  }

  return {}; // not a gated tool
}

export function resolveConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  eventCwd?: string,
): ScopeGuardConfig {
  let root = env[WORKTREE_ENV];
  let denyRaw = env[DENY_ENV];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i];
    else if (argv[i] === "--deny" && argv[i + 1] !== undefined) denyRaw = argv[++i];
  }
  root = root ?? eventCwd ?? process.cwd();
  const deny = (denyRaw ?? "").split(SEP).map((s) => s.trim()).filter(Boolean);
  return { root: resolve(root), deny };
}

if (import.meta.main) {
  let decision: HookDecision = {};
  let input: HookInput | null = null;
  try {
    input = (await Bun.stdin.json()) as HookInput;
    const cfg = resolveConfig(Bun.argv.slice(2), process.env, input.cwd);
    decision = evaluateScopeGuard(input, cfg);
  } catch (err) {
    const tool = typeof input?.tool_name === "string" ? input.tool_name : "";
    // Fail closed for gated tools; pass through anything we can't even parse.
    decision = isGatedTool(tool)
      ? denyDecision(
          `scope guard could not evaluate this safely (${
            (err as Error)?.message ?? "internal error"
          }) — denying to stay in scope.`,
        )
      : {};
  }
  process.stdout.write(JSON.stringify(decision));
}
