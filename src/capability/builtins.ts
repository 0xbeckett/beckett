/**
 * Beckett v5 — builtin capability config fragments (`src/capability/builtins.ts`)
 * =======================================================================================
 * Phase 1c (#N.4) of the extensibility refactor: the monolithic zod block that lived in
 * `src/config.ts` is now COMPOSED from per-capability fragments. Each builtin capability
 * declares its own config-schema slice ({@link Capability.configSchema}) mounted at its
 * `configKey`; `src/config.ts` asks the registry for {@link CapabilityRegistry.configFragments}
 * and assembles the strict top-level schema from them. Adding a capability with config means
 * registering one fragment here (or, after Phase 2, in the capability's own module) — never
 * editing a central schema literal again.
 *
 * Two contracts hold this together:
 *   - COMPILE TIME: the `satisfies` clause on {@link configFragments} proves every fragment's
 *     parsed output matches its slice of the frozen {@link Config} type (and that no key is
 *     missing or invented) — the same guarantee the old monolith's `z.infer` assert gave.
 *   - RUNTIME: the CLI/bus characterization suites snapshot the full default config TOML, so
 *     an unchanged config.toml provably validates to an identical config object.
 *
 * Phase 0 defined these capability stubs' shape; Phase 2 fleshes them out (CLI verbs, bus
 * commands, prompt blocks) and may relocate a fragment into its feature module — the mount
 * key, not the file, is the contract.
 */

import { z } from "zod";
import type { Config } from "../types.ts";
import { ActionClass, CapabilityRegistry, type Capability } from "./index.ts";

// =======================================================================================
// Shared schema helpers
// =======================================================================================

const int = z.number().int();
const posInt = int.min(1);
const browserOutputChars = int.min(4_096).max(1_000_000);
const nonNegInt = int.min(0);

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function cloneRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? { ...v } : {};
}

// =======================================================================================
// harness — driver/CLI launch configuration
// =======================================================================================

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

const HarnessConfigSchema = z
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
    // ChatGPT/Codex OAuth via the "openai-codex" provider (see ~/.pi/agent/auth.json), which
    // runs the model through codex (0.144). Model + reasoning default to gpt-5.6-terra @ high;
    // a cast can override the model per ticket (e.g. "gpt-5.6-luna" for cheap/mechanical grind).
    // terra is ~5.5-parity on coding at roughly half the price — a straight drop-in upgrade over
    // the old gpt-5.5 default. NOTE: SOL and bare gpt-5.6 are hard-blocked on the ChatGPT-account
    // tier ("not supported with a ChatGPT account") — don't cast those.
    pi: z
      .object({
        enabled: z.boolean().default(true),
        bin: z.string().min(1).default("pi"),
        default_provider: z.string().min(1).default("openai-codex"),
        default_model: z.string().min(1).default("gpt-5.6-terra"),
        thinking: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
      })
      .default({}),
  })
  .default({});

// =======================================================================================
// tracker — the bored ticket queue (OPS-190/191)
// =======================================================================================

/**
 * The stock board-name set. Boards are just names now: bored serves one managed board per
 * instance and keeps its own workflow, so a board carries no per-board config. `[tracker]`
 * `boards = [...]` in config.toml overrides or extends the list.
 */
const DEFAULT_BOARDS = ["ops", "int", "vid", "vidpip"] as const;

/** The board the legacy shapes (and default_board's default) normalize into. */
const LEGACY_FLAT_BOARD = "ops";

/**
 * Accept the retired Plane-era board TABLE (`boards.<name> = { project_slug, state_map }`)
 * by collapsing it to its names — the per-board keys were Plane-only and bored needs none of
 * them. (The top-level `[plane]` → `[tracker]` fold happens in `src/config.ts` before this
 * fragment ever sees the object.)
 */
function normalizeTrackerConfig(rawTracker: unknown): unknown {
  const raw = cloneRecord(rawTracker);
  const boards = Array.isArray(raw.boards)
    ? raw.boards
    : isRecord(raw.boards)
      ? [...new Set([...DEFAULT_BOARDS, ...Object.keys(raw.boards)])]
      : [...DEFAULT_BOARDS];
  const out: Record<string, unknown> = { ...raw, boards };
  // Plane-only keys a legacy section may still carry — dropped, never validated against.
  delete out.base_url;
  delete out.workspace_slug;
  delete out.project_slug;
  delete out.state_map;
  if (!Object.prototype.hasOwnProperty.call(out, "default_board")) {
    out.default_board = LEGACY_FLAT_BOARD;
  }
  return out;
}

const TrackerConfigSchema = z
  .preprocess(
    normalizeTrackerConfig,
    z
      .object({
        // Perf: pickup/review/relay latency is bounded by this poll. The poller avoids
        // unchanged-ticket comment reads, so a 5s default cuts average wait cheaply (bored is
        // a loopback service — polls never leave the box).
        poll_secs: posInt.default(5),
        default_board: z.string().min(1).default(LEGACY_FLAT_BOARD),
        boards: z.array(z.string().min(1)).default([...DEFAULT_BOARDS]),
      })
      .strict()
      .superRefine((tracker, ctx) => {
        if (!tracker.boards.includes(tracker.default_board)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default_board"],
            message: `unknown default_board "${tracker.default_board}" (have: ${tracker.boards.join(", ") || "none"})`,
          });
        }
      }),
  )
  .default({});

// =======================================================================================
// proactivity — ambient interjection policy
// =======================================================================================

const ProactivityModeSchema = z.enum(["off", "suggest", "auto"]);
const CLAUDE_TRIAGE_MODEL = "claude-haiku-4-5";
const CEREBRAS_TRIAGE_MODEL = "gemma-4-31b";

function triageModelForProvider(provider: "claude" | "cerebras", model?: string): string {
  if (provider === "cerebras") {
    return !model || model === CLAUDE_TRIAGE_MODEL ? CEREBRAS_TRIAGE_MODEL : model;
  }
  return !model || model === CEREBRAS_TRIAGE_MODEL ? CLAUDE_TRIAGE_MODEL : model;
}

/**
 * The provider default when config.toml doesn't pick one: Cerebras whenever its key is on the
 * box (~1850 tok/s vs a multi-second `claude -p` spawn — ambient triage sits on the interjection
 * hot path), else the subscription CLI. Safe to read process.env here: this runs at PARSE time
 * (inside the schema transform), and `loadConfig()` loads `~/.beckett/.env` into process.env as
 * its first step, before validation. An explicit `triage_provider` always wins.
 */
function defaultTriageProvider(): "claude" | "cerebras" {
  return process.env.CEREBRAS_API_KEY?.trim() ? "cerebras" : "claude";
}

const ProactivityConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    default_mode: ProactivityModeSchema.default("off"),
    // Where the burst classifier runs. Unset, it resolves at parse time: `cerebras` (the
    // wire-speed API option) when CEREBRAS_API_KEY is in ~/.beckett/.env, else the subscription
    // `claude` CLI. An explicit value always wins. triage_model must name a model the chosen
    // provider serves.
    triage_provider: z
      .enum(["claude", "cerebras"])
      .optional()
      .transform((provider) => provider ?? defaultTriageProvider()),
    triage_model: z.string().min(1).optional(),
    // The cold-interjection bar. Set conservative on purpose: a cold coin-flip should stay
    // silent, so only a clear, welcome contribution (the classifier's `0.55-0.74` band and up)
    // gets Beckett to speak into chatter it isn't already part of. Live continuations — people
    // answering something Beckett just said — never pass through this gate (the engaged lane in
    // ambient.ts bypasses it), so raising the bar tightens over-interjection without ghosting them.
    triage_threshold: z.number().min(0).max(1).default(0.55),
    burst_quiet_secs: posInt.default(20),
    // Mid-conversation, waiting out the full cold debounce reads as wandering off — a short
    // lull IS a turn boundary when people are talking WITH Beckett (v4.1.2).
    engaged_quiet_secs: posInt.default(4),
    // Soft backstops only (v4.1.2): the CLASSIFIER is the gate that stops reply-to-everything;
    // these exist to break pathological loops, not to ration speech. They bound COLD
    // interjections only; engaged continuations bypass them. 0 = disabled.
    channel_cooldown_secs: nonNegInt.default(60),
    max_interjections_per_hour: nonNegInt.default(0),
    // How long after Beckett speaks in a channel to use the short-lull continuation lane. It
    // bypasses cold caps; native replies to known humans get a fast addressee recheck before the
    // session, while other turns let the session decide (it can PASS). 0 disables the lane.
    engaged_window_secs: nonNegInt.default(180),
    offer_ttl_secs: posInt.default(600),
    transcript_window: posInt.default(15),
    channels: z.record(ProactivityModeSchema).default({}),
  })
  .strict()
  .default({})
  .transform((proactivity) => ({
    ...proactivity,
    triage_model: triageModelForProvider(proactivity.triage_provider, proactivity.triage_model),
  }));

// =======================================================================================
// The fragment table — one config-schema slice per builtin capability
// =======================================================================================

/**
 * Every top-level config key, each owned by one builtin capability, in the exact order the
 * old monolith declared them (the order is observable: `beckett config print-default` walks
 * it to render `deploy/config.toml.example`, which the characterization suite snapshots).
 *
 * The `satisfies` clause is the compile-time contract the monolith's `z.infer` assert used
 * to provide: every {@link Config} key must have a fragment, no fragment may invent a key,
 * and each fragment's parsed output must be assignable to its Config slice.
 */
export const configFragments = {
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
      // Checkpoint cadence (OPS-125): every this-many seconds the dispatcher commits each live
      // worker's worktree as a WIP checkpoint, so a HARD daemon crash (SIGKILL/OOM/power) — where
      // the graceful shutdown drain never runs — loses at most one checkpoint window of on-disk
      // work instead of the whole session. Best-effort and side-effect-free beyond the worktree
      // (never touches the tracker / the advance- or publish-outbox). 0 disables periodic checkpointing.
      worker_checkpoint_s: nonNegInt.default(120),
      // Dispatcher retry/rework bounds (OPS-180) — previously hardcoded dispatcher constants,
      // now real knobs. Defaults are the old constants exactly; see stages.ts#retryCapsFor.
      // Max implement↔review round-trips before auto-rework stops and waits for a human.
      max_rework_cycles: posInt.default(3),
      // Total design-completeness passes before the design escalates to its owner anyway.
      max_design_cycles: posInt.default(2),
      // Max auto-respawns of an implement worker that ended without a clean finish (OPS-50).
      max_implement_retries: posInt.default(3),
      // Max review infra/schema retries before the ticket is left in_review for a human.
      max_review_infra_retries: posInt.default(1),
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
  harness: HarnessConfigSchema,
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
      /** Append-only worker/review telemetry ledger (OPS-123). */
      spend: z.string().min(1).default("/home/beckett/.beckett/spend.jsonl"),
    })
    .default({}),
  identity: z
    .object({
      github_user: z.string().default("0xbeckett"),
      gmail_address: z.string().default(""),
    })
    .default({}),
  // The bored ticket queue (OPS-190/191). bored's loopback URL rides BECKETT_BORED_URL in env,
  // not here; boards are plain names. Beckett keeps the canonical TicketStates.
  tracker: TrackerConfigSchema,
  // OPS-124 — GitHub PR sense: the poller that watches the PRs Beckett opened on the 0xbeckett
  // org and relays review/CI/merge signal. The GITHUB_PAT secret lives in env, not here. Active
  // only when a PAT is configured. GitHub's REST API is rate-limited, so this polls far less
  // aggressively than the ticket tracker (60s default is ample for review/CI latency).
  github: z
    .object({
      poll_secs: posInt.default(60),
      // OPS-128 — external main/merge relay. Unlike the ticket-scoped PR sense above, this
      // watches Beckett's own repository and sends terse dev-feed lines to one configured room.
      activity: z
        .object({
          enabled: z.boolean().default(true),
          repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo").default("0xbeckett/beckett"),
          branch: z.string().min(1).default("main"),
          poll_secs: posInt.default(60),
          channel_id: z.string().regex(/^\d{17,20}$/, "must be a Discord channel id").default("1520658476974735490"),
          // The daemon account and deployment/bot identities are never external activity.
          ignored_authors: z.array(z.string().min(1)).default(["0xbeckett", "github-actions[bot]", "dependabot[bot]"]),
        })
        .strict()
        .default({}),
    })
    .strict()
    .default({}),
  proactivity: ProactivityConfigSchema,
  // OPS-80 — channel-scoped shared context (multiplayer): the per-channel attributed
  // transcript (JSONL under paths.channelsDir) injected into Concierge turns. Ships enabled;
  // `enabled = false` is the kill switch back to the old per-channel ring-buffer prefix path.
  shared_context: z
    .object({
      enabled: z.boolean().default(true),
      max_entries_per_channel: posInt.default(200),
      max_age_hours: posInt.default(72),
      inject_budget_tokens: posInt.default(3000),
      roster_max: posInt.default(12),
      // Server memory (v4.1): rolling per-channel profiles built by a one-shot small-model
      // call every N new entries, surfaced as the cross-channel awareness footer + search.
      profile_model: z.string().min(1).default("claude-haiku-4-5"),
      profile_update_messages: posInt.default(20),
      awareness_max_channels: posInt.default(5),
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
      // Multi-session concierge (OPS-80 §9.3): "channel" runs one session per Discord channel
      // (DMs included — a DM is its own channel), so conversations in different channels no
      // longer queue behind one global turn. "global" restores the single-session v4.0 behavior.
      session_scope: z.enum(["channel", "global"]).default("channel"),
      // Cap on turns EXECUTING at once across all sessions (each is a full claude turn — this is
      // a spend/QPS lever, not a correctness one; queued turns wait for a slot).
      max_concurrent_turns: posInt.default(3),
      // Cap on live `claude` child PROCESSES. Beyond it the least-recently-used idle session's
      // child is recycled (killed); its transcript survives — the next turn resumes it.
      max_live_sessions: posInt.default(6),
      // Recycle a session's child after this much idle time (same resume-on-demand semantics).
      idle_recycle_minutes: posInt.default(30),
    })
    .default({}),
  // Quick agents — the no-ticket lane. Sonnet at medium: these are errands where
  // wall-clock beats depth; the ticket pipeline keeps xhigh for real work.
  quick: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).default("claude-sonnet-5"),
      effort: z.enum(["", "low", "medium", "high", "xhigh"]).default("medium"),
      sync_wait_secs: posInt.default(240),
      hard_timeout_secs: posInt.default(900),
      max_concurrent: posInt.default(3),
      // Computer-use owns one persistent Chromium identity. Hosts serialize at the lease
      // boundary and stay warm for a task, while that task may drive many tabs concurrently.
      browser_profile_dir: z.string().min(1).default("browser/profile"),
      browser_headless: z.boolean().default(true),
      browser_viewport_width: posInt.default(1440),
      browser_viewport_height: posInt.default(900),
      browser_launch_timeout_ms: posInt.default(30_000),
      browser_action_timeout_ms: posInt.default(10_000),
      browser_navigation_timeout_ms: posInt.default(30_000),
      browser_eval_timeout_ms: posInt.default(60_000),
      browser_max_output_chars: browserOutputChars.default(24_000),
      browser_question_wait_secs: posInt.default(3_600),
    })
    .strict()
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
} satisfies { [K in keyof Config]: z.ZodType<Config[K], z.ZodTypeDef, unknown> };

// =======================================================================================
// The builtin capabilities
// =======================================================================================

/**
 * Identity + summary for each fragment's owning capability. Keyed by config mount key (the
 * mapped type makes a missing or invented key a compile error); ids are the kebab-case
 * capability names Phase 2's full modules will claim.
 */
const BUILTIN_CAPABILITY_INFO: {
  [K in keyof typeof configFragments]: { id: string; summary: string };
} = {
  concurrency: { id: "concurrency", summary: "Worker-fleet sizing (parallel worktree slots)." },
  supervise: { id: "supervise", summary: "Worker watchdog: hard caps, stall detection, WIP checkpoints." },
  models: { id: "models", summary: "Cross-stage model defaults (reviewer seat)." },
  harness: { id: "harness", summary: "Coding-agent harnesses (claude/codex/pi): binaries, models, fallback order." },
  paths: { id: "paths", summary: "Filesystem layout: beckett dir, db, logs, events, socket." },
  identity: { id: "identity", summary: "Beckett's external identities (GitHub user, Gmail address)." },
  tracker: { id: "tracker", summary: "bored ticket-queue: board names, polling." },
  github: { id: "github", summary: "GitHub sense: PR review/CI/merge poller + external-activity relay." },
  proactivity: { id: "proactivity", summary: "Ambient interjection policy (burst triage, cooldowns, channel modes)." },
  shared_context: { id: "shared-context", summary: "Channel-scoped shared context: attributed transcripts + server memory." },
  concierge: { id: "concierge", summary: "The Concierge chat seat: model, effort, session pooling." },
  quick: { id: "quick", summary: "Quick agents (no-ticket lane) + the computer-use browser host." },
  announce: { id: "announce", summary: "Restart changelog announcements." },
  federation: { id: "federation", summary: "Peer-Beckett federation over Discord." },
};

/**
 * The builtin capability modules, in fragment order. Phase 1c ships them as config-only
 * stubs (no CLI verbs / bus commands yet — Phases 1a/1b/2 wire those); what matters here is
 * that every top-level config key is OWNED by a registered capability, so the top-level
 * schema is composed, never hand-edited.
 */
export function builtinCapabilities(): Capability[] {
  return (Object.keys(configFragments) as Array<keyof typeof configFragments>).map((key) => ({
    id: BUILTIN_CAPABILITY_INFO[key].id,
    summary: BUILTIN_CAPABILITY_INFO[key].summary,
    actionClass: ActionClass.FREE,
    cliVerbs: [],
    busCommands: [],
    configSchema: configFragments[key],
    configKey: key,
  }));
}

/** A registry pre-loaded with every builtin capability (loud on collisions, like all registration). */
export function builtinCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const capability of builtinCapabilities()) registry.register(capability);
  return registry;
}
