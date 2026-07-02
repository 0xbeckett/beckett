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

const ConfigSchema = z
  .object({
    concurrency: z
      .object({
        // v3.1: ONE worktree per ticket (its own branch) isolates concurrent tickets, so the cap
        // can stay >1 and `beckett plan` DAG nodes run in parallel. The waste v3.1 removed was a
        // fresh worktree per STAGE, not isolation itself (Spec 12 §1.7 — "headroom of 2").
        max_workers: posInt.default(2),
        queue_max: posInt.default(256),
        per_task_soft: posInt.default(4),
      })
      .default({}),
    retry: z
      .object({
        max_redispatch: nonNegInt.max(10).default(3),
        backoff_base_ms: posInt.default(2000),
        backoff_max_ms: posInt.default(300000),
      })
      .default({}),
    supervise: z
      .object({
        drift_no_progress_turns: posInt.default(3),
        repeated_tool_calls_n: posInt.default(4),
        overrun_factor: z.number().positive().default(1.5),
        checkin_default_s: posInt.default(600),
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
        tail_mode: z.enum(["stream", "disk", "stream+disk"]).default("stream+disk"),
      })
      .default({}),
    models: z
      .object({
        front_door: z.string().min(1).default("claude-haiku-4-5"),
        judgment: z.string().min(1).default("claude-opus-4-8"),
        reviewer: z.string().min(1).default("claude-opus-4-8"),
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
    discord: z
      .object({
        reply_channel_mode: z.literal("same").default("same"),
        escalate_after_s: posInt.default(1800),
        chattiness: z.enum(["sparse", "normal"]).default("sparse"),
      })
      .default({}),
    identity: z
      .object({
        github_user: z.string().default("0xbeckett"),
        gmail_address: z.string().default(""),
        poll_inbox_s: nonNegInt.default(120),
        auto_merge: z.boolean().default(false),
      })
      .default({}),
    features: z
      .object({
        codex_failover: z.boolean().default(false),
        // v0 seed: self-review only; the fresh adversarial reviewer is inert/unbuilt in v0
        // (Spec 12 §1.7 — "turn on for v1 critical nodes").
        fresh_reviewer: z.boolean().default(false),
        learned_staffing: z.boolean().default(false),
        multiplayer: z.boolean().default(false),
        email_agency: z.boolean().default(false),
        app_server_codex: z.boolean().default(false),
      })
      .default({}),
    events: z
      .object({
        max_file_mb: posInt.default(256),
        retain_days: posInt.default(90),
        archive_retain_days: posInt.default(365),
      })
      .default({}),
    retention: z
      .object({
        task_days: posInt.default(30),
        db_backups: nonNegInt.default(3),
        outcomes_max_rows: nonNegInt.default(0),
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
    // v3 — the Concierge (long-lived `claude -p` Opus agent that owns Discord, files tickets).
    concierge: z
      .object({
        model: z.string().min(1).default("claude-opus-4-8"),
        // Context-size ceiling (summed input tokens) at which the session auto-compacts by rotating
        // to a fresh session seeded with a handoff summary (issue #5). Configurable so it can be
        // driven low in tests/harnesses to exercise a real rotation without burning ~190k tokens.
        rotate_at_tokens: z.number().int().positive().default(190_000),
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

export interface LoadConfigOptions {
  /** Override env source (for tests). Defaults to process.env. */
  env?: PathEnv;
  /** Explicit config.toml path (else derived from beckettDir). */
  configFile?: string;
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

  // 3. validate + apply defaults (loud refuse-to-start on invalid).
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
