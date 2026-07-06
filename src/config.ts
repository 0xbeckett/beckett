/**
 * Beckett — config loading & validation (`src/config.ts`)
 * =======================================================================================
 * Loads `~/.beckett/.env` (KEY=VALUE, no external dep) into `process.env`, parses
 * `~/.beckett/config.toml` (smol-toml), and validates the result against the FULL schema
 * from Spec 01 §4 with zod. Every key has a default, so a near-empty (or missing) config
 * boots. Invalid or out-of-range values are a LOUD refuse-to-start (Spec 01 §4) — config
 * errors surface at boot, never mid-task.
 *
 * Subscription auth ONLY (Spec 00 §4): the `.env` loader deliberately REFUSES to import
 * API-auth/endpoint overrides (`ANTHROPIC_*` / `OPENAI_*` / `CLAUDE_CODE_*` — src/env.ts)
 * into the environment — Beckett drives `claude` / `codex` through their `~/.claude` /
 * `~/.codex` subscription logins, never an API key.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Config } from "./types.ts";
import { resolveBeckettDir, bootFiles, type PathEnv } from "./paths.ts";
import { isForbiddenEnvKey } from "./env.ts";

export type { Config } from "./types.ts";

/**
 * Flags `ClaudeDriver.buildArgs` composes itself — an extra_flags entry naming one of these
 * would inject a conflicting duplicate (the driver's dedup is exact-token only). Each has a
 * real config key or spec field; `--max-turns` is banned because envelopes are estimates,
 * never hard caps (Spec 02 §7).
 */
const CLAUDE_DRIVER_OWNED_FLAGS = new Set([
  "-p",
  "--print",
  "--input-format",
  "--output-format",
  "--permission-mode",
  "--model",
  "--effort",
  "--session-id",
  "--resume",
  "--append-system-prompt",
  "--mcp-config",
  "--settings",
  "--json-schema",
  "--max-turns",
]);

// =======================================================================================
// .env parsing (dependency-free)
// =======================================================================================

/**
 * Parse a `.env` body into key/value pairs. Supports `KEY=VALUE`, optional `export `
 * prefix, `#` comments (full-line and trailing on unquoted values), and single/double
 * quoted values (quotes stripped, no interpolation). Forbidden keys are dropped.
 */
export function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (isForbiddenEnvKey(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // strip a trailing inline comment on unquoted values
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` from `beckettDir` into `process.env` WITHOUT overwriting existing process
 * env vars (real environment wins over the file). Returns the parsed pairs. Missing file
 * is fine (returns {}).
 */
export function loadEnvFile(envFile: string): Record<string, string> {
  if (!existsSync(envFile)) return {};
  const pairs = parseEnv(readFileSync(envFile, "utf8"));
  for (const [k, v] of Object.entries(pairs)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return pairs;
}

// =======================================================================================
// zod schema — the FULL Spec 01 §4 config, every key defaulted
// =======================================================================================

const int = z.number().int();
const posInt = int.min(1);
const nonNegInt = int.min(0);
const ProactivityModeSchema = z.enum(["off", "suggest", "auto"]);

const ConfigSchema = z
  .object({
    concurrency: z
      .object({
        // v3.1: ONE worktree per ticket (its own branch) isolates concurrent tickets, so the cap
        // can stay >1 and `beckett plan` DAG nodes run in parallel. The waste v3.1 removed was a
        // fresh worktree per STAGE, not isolation itself (Spec 12 §1.7 — "headroom of 2").
        max_workers: posInt.default(2),
      })
      .default({}),
    supervise: z
      .object({
        // Generous, configurable backstop wall-clock cap (seconds) enforced by the per-worker
        // watchdog (drivers/proc.ts#hardCapSeconds). A runaway-worker safety net, NOT a normal work
        // limit — real tickets routinely need far more than the old tight per-effort caps. Floor of
        // 1800s (30min) so it can never be tightened back into the retired 600s guillotine (OPS-50);
        // default 3600s (60min).
        worker_hard_cap_s: int.min(1800).default(3600),
        // Stall window (issue #21): a worker with NO progress event for this many seconds gets a
        // `stalled` signal (driver watchdog) and the dispatcher escalates nudge → abort+retry,
        // instead of burning a slot until the hard cap. 0 disables stall detection.
        worker_stall_s: nonNegInt.default(300),
      })
      .default({}),
    models: z
      .object({
        // Default reviewer model (issue #27): Sonnet reads a diff against criteria extremely well
        // at a fraction of Opus cost/latency. Opus reviews remain one explicit cast away
        // (`review: {model: "claude-opus-4-8", effort: "xhigh"}`) for correctness-critical work.
        reviewer: z.string().min(1).default("claude-sonnet-5"),
      })
      .default({}),
    harness: z
      .object({
        // Substitution order when a cast harness fails preflight or dies on auth/rate-limit
        // (issue #17): the dispatcher walks this list for the first enabled + healthy harness.
        // A claude outage must not stall the fleet while a working pi/codex login sits idle.
        fallback_order: z
          .array(z.enum(["claude", "codex", "pi"]))
          .default(["claude", "pi", "codex"]),
        // No `enabled` switch for claude: it is the backbone harness and the fallback target
        // whenever a cast names a disabled harness, so it can never honestly be off. (codex/pi
        // `enabled` ARE real: Dispatcher#castFor falls back to claude when one is disabled.)
        claude: z
          .object({
            bin: z.string().min(1).default("claude"),
            default_model: z.string().min(1).default("claude-sonnet-5"),
            // Reasoning effort handed to every claude worker via `claude --effort` (verified on
            // claude 2.1.197). Sonnet 5 @ xhigh is the v3.1 worker default — fast cold boots with
            // full reasoning. A ticket may cast a lower effort per stage. Honored by
            // ClaudeDriver.buildArgs + dispatch/spawn#buildEnvelope.
            default_effort: z.enum(["low", "medium", "high", "xhigh"]).default("xhigh"),
            // v0 seed: bounded by the worktree + PreToolUse scope hook, so the worker runs
            // autonomously without per-edit prompts (Spec 12 §1.7; Spec 02 §8). Honored by
            // ClaudeDriver.buildArgs.
            permission_mode: z.string().min(1).default("bypassPermissions"),
            // Extra argv appended to every claude worker launch. Flags the driver already owns
            // are REFUSED at load (see CLAUDE_DRIVER_OWNED_FLAGS): the driver's dedup is
            // exact-token only, so `["--model","opus"]` would inject a second, conflicting
            // `--model` — a silent misconfig this validation turns into a loud boot failure.
            extra_flags: z
              .array(z.string())
              .default(["--verbose", "--replay-user-messages", "--include-hook-events"])
              .superRefine((flags, ctx) => {
                const conflicts = flags.filter((f) => CLAUDE_DRIVER_OWNED_FLAGS.has(f));
                if (conflicts.length) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                      `harness.claude.extra_flags may not override driver-owned flags: ` +
                      `${conflicts.join(", ")} (set the matching config key instead)`,
                  });
                }
              }),
          })
          .default({}),
        codex: z
          .object({
            enabled: z.boolean().default(false),
            bin: z.string().min(1).default("codex"),
            // Empty = defer to codex's own ~/.codex/config.toml model (account-appropriate).
            // The Concierge can still cast an explicit model per ticket.
            default_model: z.string().default(""),
            default_effort: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
            // Sandbox OFF by default: `workspace-write` blocks network unless explicitly enabled,
            // which silently broke every codex worker that needed to install a dep / curl / clone /
            // enumerate (it "yaps about a network sandbox issue" and stalls). `danger-full-access`
            // is codex's no-sandbox mode (full FS + network, no approval prompts) — the scope-guard
            // hook + per-ticket project repos are the real containment here, not codex's sandbox.
            // Dial back to "workspace-write" here (and flip network_default) to re-enable it.
            sandbox_mode: z.string().min(1).default("danger-full-access"),
            approval_policy: z.string().min(1).default("never"),
            // Belt-and-suspenders: even if sandbox_mode is dialed back to workspace-write, workers
            // get network by default. Nothing here should silently lose the network again.
            network_default: z.boolean().default(true),
          })
          .default({}),
        // pi (pi.dev / earendil-works) — the malleable, provider-agnostic coding agent that
        // replaces codex as Beckett's non-claude worker. No network sandbox to fight; auth is the
        // ChatGPT/Codex OAuth via the "openai-codex" provider (see ~/.pi/agent/auth.json). Model +
        // reasoning default to gpt-5.5 @ high; a cast can override per ticket.
        pi: z
          .object({
            enabled: z.boolean().default(true),
            bin: z.string().min(1).default("pi"),
            default_provider: z.string().min(1).default("openai-codex"),
            default_model: z.string().min(1).default("gpt-5.5"),
            thinking: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
          })
          .default({}),
      })
      .default({}),
    paths: z
      .object({
        home: z.string().min(1).default("/home/beckett"),
        beckett_dir: z.string().min(1).default("/home/beckett/.beckett"),
        projects: z.string().min(1).default("/home/beckett/projects"),
        db: z.string().min(1).default("/home/beckett/.beckett/beckett.db"),
        events_dir: z.string().min(1).default("/home/beckett/.beckett/events"),
        logs_dir: z.string().min(1).default("/home/beckett/.beckett/logs"),
        memory_dir: z.string().min(1).default("/home/beckett/.beckett/memory"),
        socket: z.string().min(1).default("/home/beckett/.beckett/beckett.sock"),
      })
      .default({}),
    identity: z
      .object({
        github_user: z.string().default("0xbeckett"),
        gmail_address: z.string().default(""),
      })
      .default({}),
    // v3 — Plane ticket-queue (Spec v3). base_url/slugs locate the self-hosted Plane; the
    // PLANE_API_TOKEN secret comes from .env, NOT here. `state_map` maps each Beckett
    // TicketState to the project's Plane workflow state NAME (the client resolves name→UUID).
    plane: z
      .object({
        base_url: z.string().min(1).default("https://plane.0xbeckett.me"),
        workspace_slug: z.string().min(1).default("beckett"),
        project_slug: z.string().min(1).default("beckett"),
        // Perf: pickup/review/relay latency is bounded by this poll. The poller now avoids
        // unchanged-ticket comment reads, so a 5s default cuts average wait without increasing the
        // old hot-path Plane load.
        poll_secs: posInt.default(5),
        state_map: z
          .object({
            backlog: z.string().min(1).default("Backlog"),
            todo: z.string().min(1).default("Todo"),
            in_progress: z.string().min(1).default("In Progress"),
            in_review: z.string().min(1).default("In Review"),
            done: z.string().min(1).default("Done"),
            cancelled: z.string().min(1).default("Cancelled"),
          })
          .default({}),
      })
      .default({}),
    proactivity: z
      .object({
        enabled: z.boolean().default(false),
        default_mode: ProactivityModeSchema.default("off"),
        triage_model: z.string().min(1).default("claude-haiku-4-5"),
        triage_threshold: z.number().min(0).max(1).default(0.7),
        burst_quiet_secs: posInt.default(20),
        channel_cooldown_secs: nonNegInt.default(900),
        max_interjections_per_hour: nonNegInt.default(4),
        offer_ttl_secs: posInt.default(600),
        transcript_window: posInt.default(15),
        channels: z.record(ProactivityModeSchema).default({}),
      })
      .strict()
      .default({}),
    // v3 — the Concierge (long-lived `claude -p` Opus agent that owns Discord, files tickets).
    concierge: z
      .object({
        model: z.string().min(1).default("claude-opus-4-8"),
        // Context-size ceiling (summed input tokens) at which the session auto-compacts by rotating
        // to a fresh session seeded with a handoff summary (issue #5). Configurable so it can be
        // driven low in tests/harnesses to exercise a real rotation without burning ~190k tokens.
        rotate_at_tokens: z.number().int().positive().default(190_000),
        // Reasoning effort for the chat seat (issue #25): acks/triage rarely need max reasoning.
        // Empty = the claude CLI's own default. A knob, not a hardcode — the voice is the product.
        effort: z.enum(["", "low", "medium", "high", "xhigh"]).default(""),
      })
      .default({}),
    // Restart "what's new" changelog. Instance-specific and OFF by default (empty channel) so a
    // fork stays silent until its owner opts in — this is a your-instance flourish, not a default.
    announce: z
      .object({
        // Post the changelog here on boot when the running commit advanced since last announce.
        // Empty = off. Set this in the BOX's config.toml, not in the repo (it's per-instance).
        changes_channel_id: z.string().default(""),
        // Bound the summarized commit count so a large deploy can't dump a wall.
        max_commits: posInt.default(20),
      })
      .default({}),
    // Federation — the fork ecosystem. Discord ignores bots by default and Beckett drops every
    // bot message to kill self-loops; a peer bot id listed here is exempted so sibling Becketts
    // can address each other. Ships INERT (empty peers = today's exact behavior). The talk
    // protocol on top is still open by design — this is only the gateway primitive.
    federation: z
      .object({
        // Discord bot user ids of trusted peer Becketts. The daemon's own id is always ignored
        // even if listed (self-loop guard); unlisted bots stay dropped. Snowflake ids are digit
        // strings — validate the shape so a fat-fingered entry is a loud boot failure, not a
        // silently-never-matching peer.
        peers: z
          .array(z.string().regex(/^\d{17,20}$/, "must be a Discord user id (17–20 digits)"))
          .default([]),
        // Runaway backstop: max peer-bot messages processed per channel per rolling minute, so two
        // auto-replying Becketts can't melt a channel before the protocol adds real loop control.
        peer_burst_per_min: posInt.default(5),
      })
      .default({}),
  })
  .strict();

// Compile-time guarantee that the zod output matches the frozen Config contract.
type SchemaOut = z.infer<typeof ConfigSchema>;
const _assertAssignable: (c: SchemaOut) => Config = (c) => c;
void _assertAssignable;

// =======================================================================================
// loadConfig
// =======================================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cloneRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? { ...v } : {};
}

/**
 * Runtime proactivity controls live outside config.toml so the daemon can later honor
 * "chill out in here" style commands without an edit+restart. The file is a partial
 * `[proactivity]` object and is merged over TOML before the strict schema validates it.
 */
function mergeProactivityOverride(rawConfig: unknown, overridePath: string): unknown {
  if (!existsSync(overridePath)) return rawConfig;

  let override: unknown;
  try {
    override = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (err) {
    throw new Error(
      `beckett: failed to parse ${overridePath} — ${(err as Error).message}`,
    );
  }
  if (!isRecord(override)) {
    throw new Error(`beckett: invalid ${overridePath} — expected a JSON object`);
  }

  const root = cloneRecord(rawConfig);
  const current = cloneRecord(root.proactivity);
  const merged: Record<string, unknown> = { ...current, ...override };
  if (Object.prototype.hasOwnProperty.call(override, "channels")) {
    merged.channels = isRecord(override.channels)
      ? { ...cloneRecord(current.channels), ...override.channels }
      : override.channels;
  } else if (isRecord(current.channels)) {
    merged.channels = { ...current.channels };
  }
  root.proactivity = merged;
  return root;
}

export interface LoadConfigOptions {
  /** Override env source (for tests). Defaults to process.env. */
  env?: PathEnv;
  /** Explicit config.toml path (else derived from beckettDir). */
  configFile?: string;
  /** Explicit proactivity runtime override path (else <beckettDir>/proactivity.json). */
  proactivityOverrideFile?: string;
}

/**
 * The boot entry point. Resolves `beckettDir`, loads `.env` (subscription-safe), parses
 * `config.toml` if present, validates against the schema, and returns a fully-defaulted
 * {@link Config}. Throws a single loud error (with all zod issues) on any invalid value.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const beckettDir = resolveBeckettDir(env);
  const files = bootFiles(beckettDir);

  // 1. .env → process.env (does not overwrite existing; forbidden keys dropped).
  loadEnvFile(files.envFile);

  // 2. config.toml → raw object (empty if absent — defaults will fill everything).
  const configPath = opts.configFile ?? files.configFile;
  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = parseToml(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(
        `beckett: failed to parse ${configPath} — ${(err as Error).message}`,
      );
    }
  }

  // 3. runtime proactivity overrides (partial [proactivity]) → raw object.
  raw = mergeProactivityOverride(raw, opts.proactivityOverrideFile ?? `${beckettDir}/proactivity.json`);

  // 4. validate + apply defaults (loud refuse-to-start on invalid).
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `beckett: invalid config at ${configPath} — refusing to start:\n${issues}`,
    );
  }
  return result.data;
}

/** Parse a config object directly (tests / in-memory). Same validation as loadConfig. */
export function validateConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`beckett: invalid config — refusing to start:\n${issues}`);
  }
  return result.data;
}

/** The fully-defaulted config (an empty TOML). Handy for tests + the v0 seed boot. */
export function defaultConfig(): Config {
  return validateConfig({});
}

// =======================================================================================
// Default-config TOML rendering (issue #34)
// =======================================================================================

/** Serialize one TOML value. Strings quoted; arrays inline; numbers/booleans literal. */
function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v); // TOML basic strings ≡ JSON string escaping
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  throw new Error(`configToToml: unsupported value ${JSON.stringify(v)}`);
}

/** Depth-first table writer: scalars first, then child tables as [a.b.c] sections. */
function tomlSection(out: string[], path: string[], obj: Record<string, unknown>): void {
  const scalars = Object.entries(obj).filter(([, v]) => typeof v !== "object" || Array.isArray(v));
  const tables = Object.entries(obj).filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v));
  if (path.length > 0 && scalars.length > 0) out.push(`[${path.join(".")}]`);
  for (const [k, v] of scalars) out.push(`${k} = ${tomlValue(v)}`);
  if (scalars.length > 0) out.push("");
  for (const [k, v] of tables) tomlSection(out, [...path, k], v as Record<string, unknown>);
}

/**
 * Render {@link defaultConfig} as TOML — the generator behind `beckett config print-default`
 * and the committed `deploy/config.toml.example` (issue #34). Generated from the live zod
 * schema, so the example CANNOT drift from the code: a schema change fails the drift test
 * until the example is regenerated.
 */
export function defaultConfigToml(): string {
  const out: string[] = [
    "# Beckett — every config key at its DEFAULT value (issue #34).",
    "# The live file is ~/.beckett/config.toml on the box; only put keys you're OVERRIDING there",
    "# (validation is strict: schema-pruned keys must be removed in the same deploy).",
    "# Regenerate after any schema change:  bun src/cli/beckett.ts config print-default",
    "",
  ];
  tomlSection(out, [], defaultConfig() as unknown as Record<string, unknown>);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
