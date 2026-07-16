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
  /** Live guild role ids for code-enforced capability gates; empty/absent in DMs and legacy tests. */
  roleIds?: string[];
  channelId: string;
  /** The channel's name at capture time (e.g. "media") — undefined for DMs, which have none. */
  channelName?: string;
  guildId: string | null;
  content: string;
  repliedToId: string | null; // the strong correlation key
  /** The referenced bot message carries Beckett's fixed atomic browser-question marker. */
  repliedToBrowserQuestion?: boolean;
  /** A bot reply reference could not be inspected; privacy-sensitive routing must fail closed. */
  repliedToBotUnverified?: boolean;
  mentionsBot: boolean;
  authorIsBot: boolean;
  createdAt: number;
  attachments: IncomingAttachment[]; // files dragged into the message (empty when none)
}


/**
 * A thread a PERSON just opened, normalized off the gateway's thread-create event. These can be
 * adopted as workspaces; Beckett-created numbered task threads use {@link TaskThreadCreated}.
 */
export interface ThreadCreated {
  threadId: string;
  parentChannelId: string;
  /** The thread name the creator chose (may carry ticket identifiers, e.g. "OPS-120 auth"). */
  name: string;
  /** Discord user id of the thread creator. */
  creatorId: string;
}


/** Options for posting a reply (ambient model — always the origin channel, Spec 05 §3). */
export interface ReplyOptions {
  replyToMessageId?: string; // native reply-to for correlation
  /** Discord author id of replyToMessageId; enables only that person's native-reply notification. */
  replyToUserId?: string;
  files?: string[]; // local file paths to attach (image-only posts OK)
  embeds?: DiscordEmbed[]; // rich status cards; never carry raw diffs or secret account data
  buttons?: DiscordLinkButton[]; // URL-only actions such as Open PR / Checks / Comments
  /**
   * Send content and attachments in exactly one Discord API message. This bypasses text
   * transforms, human-cadence splitting, and inter-message delays; over-2000 content is
   * rejected instead of silently weakening the one-message guarantee.
   */
  singleMessage?: boolean;
  /** Mark an atomic screenshot question so replies remain recognizable across daemon crashes. */
  browserQuestion?: boolean;
  /** Fail immediately instead of queueing when offline; used for expiring browser questions. */
  queueIfOffline?: boolean;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Render-neutral subset of Discord's embed payload used by task, branch, and usage cards. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordLinkButton {
  label: string;
  url: string;
}

export interface DiscordCommand {
  name: "stats" | "task" | "branch";
  subcommand?: string;
  userId: string;
  channelId: string;
  options: Record<string, string | number | boolean>;
}

export interface DiscordCommandReply {
  content?: string;
  embeds?: DiscordEmbed[];
  buttons?: DiscordLinkButton[];
}

export interface TaskThreadCreated {
  threadId: string;
  parentChannelId: string;
  name: string;
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
    /** Login authenticated by GITHUB_PAT. */
    account: string;
    /** Account or organization that owns Beckett-managed project repositories. */
    owner: string;
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
  /** Hard narrowing (OPS-121): only these types/names are candidates at all — a hint boosts,
   *  a filter excludes. Powers targeted `beckett recall --type person --name jason`. */
  filter?: { types?: NodeType[]; names?: string[] };
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
  /** Resolved append-only per-stage telemetry ledger path. */
  spend: string;
  configFile: string; // <beckettDir>/config.toml
  envFile: string; // <beckettDir>/.env
  personaFile: string; // <beckettDir>/persona.md
  attachmentsDir: string; // <beckettDir>/attachments — downloaded Discord attachments
  channelsDir: string; // <beckettDir>/channels — per-channel shared-context JSONL (OPS-80)
  accessFile: string; // <beckettDir>/access.txt — Discord user whitelist (invite-only beta)
  imagesDir: string; // <beckettDir>/images — generated images (beckett image)
  identitiesFile: string; // <beckettDir>/identities.json — per-user known/preferred names (OPS-42)
  accessPendingFile: string; // <beckettDir>/access-pending.json — grant requests awaiting owner approval
  maintainersFile: string; // <beckettDir>/maintainers.txt — owner-approved additions to the bundled maintainer seed (OPS-144)
  maintainersPendingFile: string; // <beckettDir>/maintainers-pending.json — maintainer grants awaiting owner approval
  peersFile: string; // <beckettDir>/peers.txt — owner-added trusted peer Beckett bot ids (federation)
  announcedFile: string; // <beckettDir>/announced.txt — last commit SHA announced on restart (changelog)
  presetsFile: string; // <beckettDir>/presets.json — user-defined named cast presets (OPS-110)
  journalDir: string; // <beckettDir>/journal — private per-ticket worker progress journals
  workspacesFile: string; // <beckettDir>/workspaces.json — user-opened thread → ticket routing
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
    /** Checkpoint cadence (s): commit each live worker's worktree this often so a hard daemon
     *  crash loses at most one window of on-disk WIP, not the whole session. 0 disables. Default
     *  120 (OPS-125). */
    worker_checkpoint_s: number;
    /** Max implement↔review round-trips before auto-rework stops and waits for a human.
     *  Default 3 (was the dispatcher's MAX_REWORK_CYCLES constant; OPS-180). */
    max_rework_cycles: number;
    /** Total design-completeness passes before the design is escalated to its owner anyway.
     *  Default 2 (was MAX_DESIGN_CYCLES; OPS-180). */
    max_design_cycles: number;
    /** Max auto-respawns of an implement worker that ended without a clean finish (OPS-50)
     *  before the ticket is parked in todo. Default 3 (was MAX_IMPLEMENT_RETRIES; OPS-180). */
    max_implement_retries: number;
    /** Max review infra/schema retries before the ticket is left in_review for a human.
     *  Default 1 (was MAX_REVIEW_INFRA_RETRIES; OPS-180). */
    max_review_infra_retries: number;
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
      /** Model id (pi `--model`). e.g. "gpt-5.6-terra" (default) or "gpt-5.6-luna" (cheap lane). */
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
    /** Append-only per-stage telemetry JSONL ledger. */
    spend: string;
  };
  identity: {
    github_user: string;
    gmail_address: string;
  };
  /**
   * Ticket-queue (bored) config. bored's loopback URL rides BECKETT_BORED_URL in env, not here.
   * A legacy `[plane]` section in config.toml is still accepted and folded into this shape at
   * load time (the Plane backend itself was removed in OPS-191).
   */
  tracker: {
    poll_secs: number;
    /** Known board names (`--board` values). bored serves one managed board per instance. */
    boards: string[];
    /** Board name used when a caller omits --board. */
    default_board: string;
  };
  /** OPS-124 — GitHub PR poller. Secret GITHUB_PAT lives in env; active only when it's set. */
  github: {
    /** How often to re-read watched PRs' review/CI/merge signal (seconds). */
    poll_secs: number;
    /** External commits and merged PRs from Beckett's own repository, relayed to the dev feed. */
    activity: {
      enabled: boolean;
      repo: string;
      branch: string;
      poll_secs: number;
      channel_id: string;
      /** Daemon/deploy automation accounts whose commits and PRs are intentionally silent. */
      ignored_authors: string[];
    };
  };
  /** Ambient interjection policy. Ships disabled; per-channel modes are opt-in. */
  proactivity: {
    enabled: boolean;
    default_mode: ProactivityMode;
    /** Classifier backend: subscription `claude` CLI, or Cerebras' API (CEREBRAS_API_KEY). */
    triage_provider: "claude" | "cerebras";
    triage_model: string;
    triage_threshold: number;
    burst_quiet_secs: number;
    /** Quiet needed to flush a burst DURING an engaged conversation (a lull, not silence). */
    engaged_quiet_secs: number;
    channel_cooldown_secs: number;
    max_interjections_per_hour: number;
    /** Post-speech window in which a channel's chatter is an engaged continuation (no triage/caps). */
    engaged_window_secs: number;
    offer_ttl_secs: number;
    transcript_window: number;
    channels: Record<string, ProactivityMode>;
  };
  /**
   * OPS-80 — channel-scoped shared context (multiplayer): the per-channel attributed
   * transcript injected into Concierge turns. `enabled = false` restores the old
   * per-channel ring-buffer prefix path exactly.
   */
  shared_context: {
    enabled: boolean;
    /** Hard count cap per channel in the store. */
    max_entries_per_channel: number;
    /** Entries older than this are expired at read/compaction. */
    max_age_hours: number;
    /** Per-turn injection ceiling (chars/4 token heuristic). */
    inject_budget_tokens: number;
    /** Max participants named in the roster line. */
    roster_max: number;
    /** Model for the one-shot per-channel profile summarizer (server memory, v4.1). */
    profile_model: string;
    /** New entries in a channel before its profile is rebuilt. */
    profile_update_messages: number;
    /** Max other channels named in the cross-channel awareness footer. */
    awareness_max_channels: number;
  };
  /** v3 — the Concierge agent that owns Discord and files tickets. */
  concierge: {
    model: string;
    /** Summed-input-token ceiling at which the Concierge session auto-compacts (rotates). */
    rotate_at_tokens: number;
    /** Reasoning effort for the chat seat ("" = the claude CLI default; issue #25). */
    effort: "" | "low" | "medium" | "high" | "xhigh";
    /** "channel" = one session per Discord channel (concurrent conversations); "global" = the legacy single session. */
    session_scope: "channel" | "global";
    /** Turns executing at once across all concierge sessions (queued turns wait for a slot). */
    max_concurrent_turns: number;
    /** Live `claude` child processes; beyond it idle sessions are recycled (resume-on-demand). */
    max_live_sessions: number;
    /** Idle minutes before a session's child is recycled (transcript survives via --resume). */
    idle_recycle_minutes: number;
  };
  /**
   * Quick agents — the NO-TICKET lane: short-lived specialist `claude -p` harnesses
   * (`computer-use`, `quick-code`, `repo-explorer`) the Concierge dispatches via
   * `beckett quick` for errands between "answer inline" and "file a ticket".
   */
  quick: {
    enabled: boolean;
    /** Model for quick harnesses (speed matters more than depth here). */
    model: string;
    /** Reasoning effort for quick harnesses ("" = the claude CLI default). */
    effort: "" | "low" | "medium" | "high" | "xhigh";
    /** How long the dispatching bus call blocks before detaching (result then arrives as an update turn). */
    sync_wait_secs: number;
    /** Backstop wall-clock cap — past this the child is killed and that IS the result. */
    hard_timeout_secs: number;
    /** Reject new runs past this many live ones ("quick lane is full — retry or file a ticket"). */
    max_concurrent: number;
    /** Dedicated automation profile, absolute or relative to paths.beckett_dir. */
    browser_profile_dir: string;
    /** The production browser is headless; false is useful only for local diagnosis. */
    browser_headless: boolean;
    browser_viewport_width: number;
    browser_viewport_height: number;
    browser_launch_timeout_ms: number;
    browser_action_timeout_ms: number;
    browser_navigation_timeout_ms: number;
    browser_eval_timeout_ms: number;
    /** Per-tool output budget before the runtime truncates noisy page data. */
    browser_max_output_chars: number;
    /** How long a screenshot-backed user question may remain parked before expiring. */
    browser_question_wait_secs: number;
  };
  /**
   * Restart "what's new" announcement — instance-specific, OFF by default (empty channel), so a
   * fork inherits silence. When set, on boot with newer code than last announced the Concierge
   * posts a short, in-voice changelog to the channel (derived from git commit subjects).
   */
  announce: {
    /** Discord channel id to post the changelog to. Empty = feature off. */
    changes_channel_id: string;
    /** Cap on commits summarized in one announcement (a big deploy shouldn't dump 50 lines). */
    max_commits: number;
  };
  /**
   * Federation — talking to OTHER Becketts (the fork ecosystem). Discord ignores bots by
   * default (Beckett drops every `author.bot` message to kill self-loops); a peer whose bot
   * user id is listed here is exempted, so sibling Becketts can address each other. Ships
   * INERT: an empty `peers` list preserves today's "ignore all bots" behavior exactly. The
   * conversation protocol on top (addressing, handshakes, loop semantics) is deliberately
   * still open — this is only the primitive that makes peer messages *reach* the Concierge.
   */
  federation: {
    /** Discord bot user ids of trusted peer Becketts. Your OWN id is always ignored even if
     *  listed (self-loop guard); an unlisted bot is dropped as before. Default: none. */
    peers: string[];
    /** Runaway backstop: max peer-bot messages the gateway will process per channel per
     *  rolling minute, so two auto-replying Becketts can never melt a channel. Default 5. */
    peer_burst_per_min: number;
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
  /** Delete one bot-authored message when a privacy-critical ledger write fails. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Trigger the typing indicator in a channel (~10s; re-call to keep it alive). */
  sendTyping(channelId: string): Promise<void>;
  /** Register the inbound message handler (intake + awaiting-reply resolution). */
  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): void;
  /**
   * Register the handler for threads PEOPLE create (bot-created threads are filtered out at the
   * gateway). The Concierge registers each as a ticket workspace so messages inside it are
   * directed turns without an @mention. Beckett itself never opens threads — the old bot-spawned
   * activity/progress threads are gone; the worker firehose goes to the private ticket journal.
   */
  onThreadCreate(cb: (t: ThreadCreated) => void | Promise<void>): void;
  /** Register native slash-command handling. Optional on legacy injected test gateways. */
  onCommand?(cb: (command: DiscordCommand) => Promise<DiscordCommandReply>): void;
  /** Create or rename the dedicated Discord workspace for a numbered task. */
  createTaskThread?(channelId: string, name: string): Promise<TaskThreadCreated>;
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
