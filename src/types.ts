/**
 * Beckett — THE CONTRACT (`src/types.ts`)
 * =======================================================================================
 * This file is the **frozen contract** for the whole codebase. ~10 downstream modules
 * import their shared types and module interfaces from here. It is intentionally
 * implementation-free: types, interfaces, enums, and a few const unions only — NO logic.
 *
 * Anchored to the specs (see ./specs):
 *   - Spec 00 — canon & vocabulary
 *   - Spec 01 — architecture, config schema (§4), IPC (§7)
 *   - Spec 02 — Worker / HarnessDriver / WorkerEvent / WorkerSpend / scope / envelope
 *   - Spec 03 — SmokeAlarm / CheckIn / SuperviseDecision / nudge primitives
 *   - Spec 04 — TaskState / NodeState FSMs, Dag, Escalation, recovery
 *   - Spec 05 — Discord IncomingMessage / AwaitingReply
 *   - Spec 06 — Brain roles, HaikuClassification / ClarifyOutput / PlanOutput / StaffOutput
 *   - Spec 07 — Identity / ActionClass / PendingAction (agency gate)
 *   - Spec 08 — Memory knowledge graph (MemoryNode / RecallQuery / RememberIntent)
 *   - Spec 09 — persistence row types, EventRecord, learned-model outcome
 *   - Spec 10 — CLI id scheme, IPC command set, StatusReport
 *   - Spec 11 — AcceptanceCriteria / CheckResult / ReviewVerdict / GateResult
 *
 * Import style for the whole codebase: **explicit `.ts` extensions** (bun-native, enabled
 * by tsconfig `allowImportingTsExtensions`). e.g. `import { Task } from "./types.ts";`
 */

// =======================================================================================
// SECTION 1 — Primitive unions & enums (Spec 02 §2, Spec 04 §2)
// =======================================================================================

/** A coding-agent CLI Beckett drives as a subprocess (Spec 00 glossary). */
export type Harness = "claude" | "codex" | "pi";


/** Which concrete driver runs a harness process (Spec 02 §2). */
export type DriverKind = "claude-cli-stream" | "codex-exec-oneshot" | "pi-cli-stream";

/** Reasoning depth; mapped per-harness at spawn (Spec 02 §9.1). */
export type Effort = "low" | "medium" | "high" | "xhigh";

/** Worker runtime lifecycle (Spec 02 §2, §10.1). `done` is set by GATE, not the driver. */
export type WorkerState =
  | "spawning" // worktree + process being created; no session_id yet
  | "running" // process alive, a turn in flight or idle awaiting input
  | "nudging" // a steer message is queued/written, not yet acked at a turn boundary
  | "paused" // checkpointed: process killed/idle, session_id retained, diff inspectable
  | "review" // turn loop ended, handed to REVIEW/GATE (Spec 11)
  | "done" // terminal: criteria satisfied (set by GATE)
  | "failed" // terminal: harness error / max-turns / max-wall-clock without success
  | "aborted"; // terminal: deliberately hard-stopped (Spec 03 decision)


// =======================================================================================
// SECTION 2 — Worker, scope, envelope, control (Spec 02 §2)
// =======================================================================================

/** Owned, non-overlapping write scope for a worker (Spec 02 §2, §8). */
export interface FileScope {
  /** Paths this worker MAY write, relative to repo root (e.g. ["src/auth/**"]). */
  ownedGlobs: string[];
  /** Optional explicit read allowlist; null = read anywhere in the worktree. */
  readGlobs: string[] | null;
  /** NL scope for the criteria/reviewer ("the auth module only"). */
  description: string;
}

/** Bounds effort/turns/wall-clock/network — never dollars (Spec 00 §4; Spec 02 §9). */
export interface ResourceEnvelope {
  effort: Effort; // reasoning depth; mapped per harness (Spec 02 §9.1)
  turnCap: number; // SOFT turn estimate — drives supervisor drift signals, never a hard kill
  // SOFT wall-clock estimate (s) feeding supervisor drift signals — NOT a hard kill. The hard
  // backstop cap is config.supervise.worker_hard_cap_s (drivers/proc.ts#hardCapSeconds); the old
  // 600s guillotine that read this field is gone (OPS-50).
  wallClockS: number;
  network: boolean; // outbound network allowed? default false, opt-in per node
}

/** Cumulative token counts for one turn / run (Spec 02 §7). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Derived telemetry counters (Spec 02 §2/§7.3). Informational only — NEVER a budget gate
 * (Spec 00 §4 Economics: no USD ledger). `usdEstimate`: claude = stream cost, pi = accumulated
 * `usage.cost.total`, codex = static price-table estimate (null when the model isn't priced).
 */
export interface WorkerSpend {
  turns: number;
  toolCalls: number;
  tokens: TokenUsage;
  diffLines: { added: number; removed: number; files: number };
  usdEstimate: number | null;
}

/**
 * What actually happened to a steer (issue #19 — "queued" used to mean three different
 * things). `delivered` = acked into the live turn (claude echo). `queued` = written/buffered,
 * applies within THIS process's lifetime. `will-restart` = buffered by a one-shot harness and
 * will trigger a full relaunch after the current run. `dropped` = the worker already finished;
 * the text will never be applied (the dispatcher surfaces this on the ticket).
 */
export interface NudgeReceipt {
  accepted: "delivered" | "queued" | "will-restart" | "dropped";
  at: number; // epoch ms
}


// =======================================================================================
// SECTION 3 — WorkerEvent: normalized telemetry stream (Spec 02 §7)
// =======================================================================================

/** Why a harness failed (issue #17) — drives the dispatcher's per-class recovery policy. */
export type ErrorClass = "auth" | "rate_limit" | "crash" | "timeout" | "spawn";

/**
 * Both raw JSONL formats (claude stream-json / codex --json) normalize into this one
 * discriminated union (Spec 02 §7). The driver owns the raw parse; subscribers only see
 * WorkerEvent. CONTRACT: parsers MUST tolerate unknown raw types — switch on what you know,
 * map the rest to `kind:'unknown'`, never throw (Spec 02 §7.2; loom-desk Risk-A).
 */
export type WorkerEvent =
  | { kind: "session_started"; sessionId: string; model: string; ts: number }
  | { kind: "turn_started"; ts: number }
  | { kind: "assistant_text"; text: string; partial: boolean; ts: number }
  | { kind: "tool_call"; tool: string; input: unknown; toolId: string; ts: number }
  | { kind: "tool_result"; toolId: string; isError: boolean; ts: number }
  | {
      kind: "file_change";
      paths: { path: string; kind: "add" | "update" | "delete" }[];
      ts: number;
    }
  | { kind: "plan_update"; items: { text: string; done: boolean }[]; ts: number }
  | { kind: "user_echo"; text: string; ts: number } // claude --replay-user-messages ack
  | {
      kind: "hook_decision";
      decision: "allow" | "deny" | "ask" | "defer";
      reason?: string;
      ts: number;
    }
  | { kind: "turn_completed"; usage: TokenUsage; ts: number }
  | {
      kind: "finished";
      status: "success" | "error";
      subtype: string;
      structuredOutput: unknown | null;
      usage: TokenUsage;
      /**
       * Failure taxonomy (issue #17): WHY an error finish happened, so the dispatcher can pick
       * the right response — `auth` (hold for a human login), `rate_limit` (back off / fall
       * back), `timeout` (backstop cap), `spawn` (never became a process), `crash` (default
       * bounded retry). Absent on success.
       */
      errorClass?: ErrorClass;
      ts: number;
    }
  | { kind: "error"; message: string; ts: number }
  /**
   * Stall signal (issue #21): the driver watchdog saw NO progress event for
   * `supervise.worker_stall_s`. NON-terminal — the dispatcher escalates (nudge → abort+retry).
   * Emitted at most once per silent window; `idleMs` is time since the last progress event.
   */
  | { kind: "stalled"; idleMs: number; ts: number }
  /** Forward-compat fallthrough: any raw line we recognized but don't model (Spec 02 §7). */
  | { kind: "unknown"; raw: unknown; ts: number };

/** The structured "done-signal" both harnesses fill in when finished (Spec 02 §6). */
export interface DoneSignal {
  status: "complete" | "blocked" | "partial";
  summary: string;
  filesChanged: string[];
  checksRun?: string[];
  blockedReason?: string;
}

// =======================================================================================
// SECTION 4 — Acceptance criteria, checks, review, gate (Spec 11)
// =======================================================================================


// =======================================================================================
// SECTION 5 — Plan / DAG (Spec 04 §2, Spec 06 §4.3)
// =======================================================================================


// =======================================================================================
// SECTION 6 — Task & Node records (Spec 04 §2)
// =======================================================================================


// =======================================================================================
// SECTION 7 — Escalation, decisions, intake (Spec 04 §9, Spec 03 §4, Spec 06 §1)
// =======================================================================================


// =======================================================================================
// SECTION 8 — Supervise: smoke-alarms, check-ins, decisions (Spec 03)
// =======================================================================================


/** A paused worker's captured checkpoint (Spec 03 §5.2). */
export interface Checkpoint {
  workerId: string;
  at: number;
  sessionId: string;
  diff: string; // git diff (captured, not applied)
  diffStat: { files: number; bytes: number };
  lastTranscriptOffset: number;
  counters: WorkerSpend;
}


// =======================================================================================
// SECTION 9 — Brain outputs (Spec 06)
// =======================================================================================


// =======================================================================================
// SECTION 10 — Discord interface (Spec 05)
// =======================================================================================

/**
 * A file attached to an inbound Discord message (image / txt / pdf / md / anything).
 * Captured raw from the gateway; the shell downloads it locally so Beckett can `Read` it
 * (the parent loop is multimodal — image/pdf/text all go through the Read tool).
 */
export interface IncomingAttachment {
  id: string; // Discord attachment snowflake
  name: string; // original filename (e.g. "diagram.png")
  url: string; // CDN url to fetch the bytes
  contentType: string | null; // MIME from Discord (may be null for some uploads)
  size: number; // bytes, as reported by Discord
}

/** A captured inbound Discord message (Spec 05 §2.1). */
export interface IncomingMessage {
  messageId: string;
  userId: string;
  /** The speaker's live Discord display name (guild nick → global name → username), if known. */
  authorDisplayName?: string;
  channelId: string;
  guildId: string | null;
  content: string;
  repliedToId: string | null; // the strong correlation key
  mentionsBot: boolean;
  authorIsBot: boolean;
  createdAt: number;
  attachments: IncomingAttachment[]; // files dragged into the message (empty when none)
}


/** Options for posting a reply (ambient model — always the origin channel, Spec 05 §3). */
export interface ReplyOptions {
  replyToMessageId?: string; // native reply-to for correlation
  files?: string[]; // local file paths to attach (image-only posts OK)
}

// =======================================================================================
// SECTION 11 — Identity & Agency (Spec 07)
// =======================================================================================

/** Gmail auth — OAuth tokens or app-password fallback (Spec 07 §2.1). */
export type GmailAuth =
  | {
      kind: "oauth";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
    }
  | { kind: "app-password"; appPassword: string };

/** Beckett's own identity surface (Spec 07 §2.1). Read-mostly. */
export interface Identity {
  name: string;
  github: {
    account: string;
    pat: string; // NEVER logged
    apiBase: string;
    noreplyEmail: string;
  };
  gmail: {
    account: string;
    auth: GmailAuth;
  };
  discord: {
    botUser: string;
  };
  osUser: string; // "beckett" on loom-desk
}

/** Every action is exactly one class (Spec 07 §2.2). */
export enum ActionClass {
  FREE = "FREE", // reversible/internal → just do it, log it
  HANDSHAKE_GATED = "HANDSHAKE_GATED", // outward but expected → create PendingAction, ask once
  ALWAYS_ASK = "ALWAYS_ASK", // dangerous/irreversible-at-scale → never unattended
}

/** Action types the gate classifies (Spec 07 §3). Open-ended core. */
export type ActionType =
  | "gh.branch.push"
  | "gh.pr.open"
  | "gh.pr.update"
  | "gh.pr.review"
  | "gh.pr.merge"
  | "gh.branch.delete"
  | "gmail.draft"
  | "gmail.send"
  | "fs.write"
  | "memory.write"
  | (string & {});

/** Context for an action-class decision (Spec 07 §3). */
export interface ActionContext {
  ref?: string; // git ref / branch
  repo?: string;
  external?: boolean; // crosses an org boundary?
  [k: string]: unknown;
}

/** The irreversible class of a staged pending action (Spec 09 §2.11). */
export type PendingActionClass =
  | "merge_pr"
  | "send_email"
  | "force_push"
  | "external_post"
  | "other";

/** A staged irreversible action awaiting a handshake answer (Spec 07 §5; Spec 09 §2.11). */
export interface PendingAction {
  id: string;
  taskId: string;
  userId: string;
  actionClass: PendingActionClass;
  payload: Record<string, unknown>; // the staged op: {pr_url}|{draft_id,to}|…
  promptText: string; // the handshake question
  postedMsgId?: string;
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
  decidedBy?: string;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
}

/** The handshake question + classification for a gated action (Spec 07 §5). */
export interface HandshakeSpec {
  actionClass: PendingActionClass;
  promptText: string;
  payload: Record<string, unknown>;
  expiresAt?: number;
}

/** Result of a gate `perform` (Spec 07 §2.3). */
export type GateActionResult<T> =
  | { status: "done"; value: T }
  | { status: "pending"; pendingAction: PendingAction };

/** GitHub operations Beckett performs (Spec 07 §3.4). Most are FREE; merge is gated. */
export interface GitHubClient {
  pushBranch(repo: string, localRef: string, remoteBranch: string): Promise<void>;
  openPR(p: OpenPRParams): Promise<{ number: number; url: string }>;
  updatePR(repo: string, n: number, p: UpdatePRParams): Promise<void>;
  reviewPR(repo: string, n: number, r: ReviewParams): Promise<void>;
  mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void>;
  isGreen(repo: string, n: number): Promise<boolean>;
}

export interface OpenPRParams {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}
export interface UpdatePRParams {
  title?: string;
  body?: string;
  base?: string;
}
export interface ReviewParams {
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
}
export type MergeStrategy = "merge" | "squash" | "rebase";

// =======================================================================================
// SECTION 12 — Memory knowledge graph (Spec 08)
// =======================================================================================

/** Memory node kind — open enum with a known core (Spec 08 §1.3). */
export type NodeType =
  | "person"
  | "project"
  | "preference"
  | "env"
  | "worker-note"
  | "reference"
  | "decision"
  | (string & {});

/** One markdown memory file parsed into a node (Spec 08 §2). */
export interface MemoryNode {
  name: string; // kebab-case, unique == node id
  type: NodeType;
  description: string;
  metadata: Record<string, unknown>;
  body: string; // markdown sans frontmatter & generated Backlinks
  path: string; // absolute file path
  created: string;
  updated: string;
  source: "conversation" | "derived" | "env-scan" | "manual" | "import";
  confidence?: "high" | "medium" | "low";
  stale: boolean;
  phantom: boolean; // referenced but no file yet
  mtime: number;
}

/** A wikilink edge between memory files (Spec 08 §2). */
export interface MemoryEdge {
  from: string;
  to: string;
  field: string; // "body" | "members" | "owners" | ...
  alias?: string;
}

/** One line of the MEMORY.md index (Spec 08 §2.3). */
export interface IndexLine {
  name: string;
  type: NodeType;
  description: string;
}

/** The hydrated memory graph (Spec 08 §2). */
export interface MemoryGraph {
  nodes: Map<string, MemoryNode>;
  out: Map<string, MemoryEdge[]>;
  in: Map<string, MemoryEdge[]>;
  index: IndexLine[];
  builtAt: number;
}

/** A relevance-ranked node from recall (Spec 08 §3). */
export interface ScoredNode {
  node: MemoryNode;
  score: number;
  via: "match" | "link";
  reason: string;
}

/** A recall query against the graph (Spec 08 §3). */
export interface RecallQuery {
  text: string;
  hint?: { names?: string[]; types?: NodeType[] };
  k?: number; // seeds before expansion (default 6)
  hops?: number; // link expansion depth (default 1)
}

/** The bundle recall hands the brain (Spec 08 §3). */
export interface RecallResult {
  index: IndexLine[];
  hits: ScoredNode[];
  expanded: ScoredNode[];
  phantoms: string[];
  notes: string[];
}

/** A structured memory write intent (Spec 08 §4). Opus-gated, not a reflex. */
export interface RememberIntent {
  op: "create" | "update" | "append" | "link";
  name: string;
  type?: NodeType; // required for create
  description?: string;
  metadata?: Record<string, unknown>;
  body?: string;
  links?: { to: string; field: string }[];
  source: MemoryNode["source"];
  reason: string; // logged to the event log
}

// =======================================================================================
// SECTION 13 — Persistence: event log + row types (Spec 09)
// =======================================================================================


// ── SQLite row types (1:1 with the DDL; enums are the Spec 02/04 unions). Spec 09 §8 ──


// =======================================================================================
// SECTION 14 — Config & Paths (Spec 01 §4)
// =======================================================================================

/** Resolved filesystem paths (Spec 01 §4 [paths]; built from Config in paths.ts). */
export interface Paths {
  home: string;
  beckettDir: string;
  projects: string;
  db: string;
  eventsDir: string;
  logsDir: string;
  memoryDir: string;
  socket: string;
  configFile: string; // <beckettDir>/config.toml
  envFile: string; // <beckettDir>/.env
  personaFile: string; // <beckettDir>/persona.md
  attachmentsDir: string; // <beckettDir>/attachments — downloaded Discord attachments
  accessFile: string; // <beckettDir>/access.txt — Discord user whitelist (invite-only beta)
  imagesDir: string; // <beckettDir>/images — generated images (beckett image)
  identitiesFile: string; // <beckettDir>/identities.json — per-user known/preferred names (OPS-42)
  accessPendingFile: string; // <beckettDir>/access-pending.json — grant requests awaiting owner approval
}

/** The full validated config (Spec 01 §4). Every key has a default so an empty config boots. */
export type ProactivityMode = "off" | "suggest" | "auto";

export interface Config {
  concurrency: {
    max_workers: number;
  };
  supervise: {
    /** Generous backstop wall-clock cap (s) the per-worker watchdog enforces — a runaway safety
     *  net, not a work limit (drivers/proc.ts#hardCapSeconds). Floor 1800, default 3600. */
    worker_hard_cap_s: number;
    /** Stall window (s): no progress event for this long → the driver emits a `stalled` signal
     *  and the dispatcher escalates (nudge → abort+retry). 0 disables. Default 300 (issue #21). */
    worker_stall_s: number;
  };
  models: {
    /** Default review-stage model (issue #27); per-ticket casts override. */
    reviewer: string;
  };
  harness: {
    /** Substitution order when a cast harness is unhealthy (issue #17 fallback chain). */
    fallback_order: Harness[];
    // No `enabled` for claude: it is the backbone harness and the fallback for every disabled
    // cast — a switch that can't honestly be turned off is config theater (issue #31).
    claude: {
      bin: string;
      default_model: string;
      default_effort: Effort;
      permission_mode: string;
      extra_flags: string[];
    };
    codex: {
      enabled: boolean;
      bin: string;
      default_model: string;
      default_effort: Effort;
      sandbox_mode: string;
      approval_policy: string;
      network_default: boolean;
    };
    pi: {
      enabled: boolean;
      bin: string;
      /** Provider id (pi `--provider`). "openai-codex" = ChatGPT/Codex OAuth backend. */
      default_provider: string;
      /** Model id (pi `--model`). e.g. "gpt-5.5". */
      default_model: string;
      /** Reasoning depth (pi `--thinking`). */
      thinking: Effort;
    };
  };
  paths: {
    home: string;
    beckett_dir: string;
    projects: string;
    db: string;
    events_dir: string;
    logs_dir: string;
    memory_dir: string;
    socket: string;
  };
  identity: {
    github_user: string;
    gmail_address: string;
  };
  /** v3 — Plane ticket-queue config (Spec v3). Secret PLANE_API_TOKEN lives in env, not here. */
  plane: {
    base_url: string;
    workspace_slug: string;
    project_slug: string;
    poll_secs: number;
    /** Each Beckett TicketState → its Plane workflow state NAME (client resolves name→UUID). */
    state_map: {
      backlog: string;
      todo: string;
      in_progress: string;
      in_review: string;
      done: string;
      cancelled: string;
    };
  };
  /** Ambient interjection policy. Ships disabled; per-channel modes are opt-in. */
  proactivity: {
    enabled: boolean;
    default_mode: ProactivityMode;
    triage_model: string;
    triage_threshold: number;
    burst_quiet_secs: number;
    channel_cooldown_secs: number;
    max_interjections_per_hour: number;
    offer_ttl_secs: number;
    transcript_window: number;
    channels: Record<string, ProactivityMode>;
  };
  /** v3 — the Concierge agent that owns Discord and files tickets. */
  concierge: {
    model: string;
    /** Summed-input-token ceiling at which the Concierge session auto-compacts (rotates). */
    rotate_at_tokens: number;
    /** Reasoning effort for the chat seat ("" = the claude CLI default; issue #25). */
    effort: "" | "low" | "medium" | "high" | "xhigh";
  };
}

// =======================================================================================
// SECTION 15 — IPC envelope & command set (Spec 01 §7, Spec 10 §8)
// =======================================================================================


/** Daemon introspection reply for `status` (Spec 10 §7/§8.4). */
export interface StatusReport {
  pid: number;
  uptimeMs: number;
  bunVersion: string;
  liveWorkers: number;
  queuedNodes: number;
  activeTasks: number;
  discord: {
    connected: boolean;
    lastEventAgeMs: number | null;
  };
  recovery: {
    recovering: boolean;
    resumedWorkers: number;
  };
}

// =======================================================================================
// SECTION 16 — Module interfaces (dependency inversion; daemon wires concrete impls)
// =======================================================================================

/**
 * The two-implementation spawn/steer/abort surface (Spec 02 §3). The control plane and DAG
 * executor never touch a CLI directly — they hold a HarnessDriver and call these methods.
 */
export interface HarnessDriver {
  readonly kind: DriverKind;
  /** Create worktree (if needed), launch, return once sessionId is known. spawning→running. */
  spawn(spec: SpawnSpec): Promise<SpawnResult>;
  /** Soft steer. claude: stdin user line (next turn boundary). codex: queued for resume. */
  sendNudge(msg: string): Promise<NudgeReceipt>;
  /** Checkpoint (claude: quiesce; codex: stop auto-resume). */
  pause(): Promise<void>;
  /** Re-attach a paused/crashed worker via --resume / exec resume (same cwd). */
  resume(): Promise<void>;
  /** Hard stop: SIGTERM→SIGKILL the group, retain sessionId. */
  abort(reason: string): Promise<void>;
  /** Subscribe to the normalized event stream. Returns an unsubscribe fn. */
  onEvent(cb: (e: WorkerEvent) => void): () => void;
  /** Snapshot of derived counters (cheap; reads accumulators + git diff --stat). */
  getTelemetry(): WorkerSpend;
  /**
   * Drain any steering that was buffered but never reached the model (issue #22): claude buffers
   * while paused/dead; one-shot harnesses buffer for a resume a crash can pre-empt. Called by
   * the spawn glue at finish so unapplied user words are re-routed, never silently dropped.
   */
  drainUnappliedNudges?(): string[];
}

/** Inputs to spawn one harness process (Spec 02 §3). */
export interface SpawnSpec {
  workerId: string;
  prompt: string; // the node task (initial user turn)
  systemAppend: string; // criteria + scope + worker-persona (businesslike)
  workspace: string; // worktree path
  scope: FileScope;
  envelope: ResourceEnvelope;
  model: string;
  sessionId?: string; // optional caller-minted UUID (claude --session-id); else captured
  /**
   * Crash recovery (issue #20): when set, the driver LAUNCHES IN RESUME MODE against this
   * persisted session/thread id instead of starting fresh — `prompt` becomes the next user turn
   * of the restored transcript (claude `--resume`, pi `--session`, `codex exec resume`).
   * Takes precedence over {@link sessionId}.
   */
  resumeSessionId?: string;
  mcpConfigPath?: string;
  doneSchemaPath: string; // JSON-schema file for the structured done-signal
  // v3.1: external settings file (claude --settings) carrying the scope-guard hook. Used when the
  // worker runs IN the project checkout (no worktree) so we never clobber the project's own
  // .claude/settings.json — claude layers --settings on top rather than replacing it.
  settingsPath?: string;
}

export interface SpawnResult {
  sessionId: string;
  pid: number;
}


/** Holds the discord.js connection; ambient in→same-channel out (Spec 05). */
export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Post to a channel; returns the bot message id (for reply correlation). */
  post(channelId: string, content: string, opts?: ReplyOptions): Promise<string>;
  /**
   * Open a public thread hanging off an existing message and return the thread id. The thread id
   * is itself a sendable channel id, so {@link post} delivers into the thread. Used by the progress
   * feed (`src/discord/progress.ts`): the main channel stays sparse (the ack), while the thread
   * carries the granular per-worker play-by-play. Throws if the anchor message can't be resolved or
   * the client is offline (the caller keeps buffering and retries on a later event).
   */
  startThread(channelId: string, anchorMessageId: string, name: string): Promise<string>;
  /** Trigger the typing indicator in a channel (~10s; re-call to keep it alive). */
  sendTyping(channelId: string): Promise<void>;
  /** Register the inbound message handler (intake + awaiting-reply resolution). */
  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): void;
  isConnected(): boolean;
  lastEventAgeMs(): number | null;
}


/** Recall + write over the markdown knowledge graph (Spec 08). */
export interface Memory {
  recall(q: RecallQuery): Promise<RecallResult>;
  remember(intent: RememberIntent): Promise<MemoryNode>;
  /** Rebuild the SQL mirror from the md tree (Spec 09 §2.12). */
  reindex(): Promise<void>;
}


/** Minimal structured logger surface (src/log.ts). */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A child logger that tags every line with a component name. */
  child(component: string): Logger;
}
