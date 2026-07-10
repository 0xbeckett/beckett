/**
 * Beckett v3 — Dispatcher (`src/dispatch/dispatcher.ts`)
 * =======================================================================================
 * The single consumer of {@link PollEvent}s (emitted by the Plane poller, `docs/V3.md` §4).
 * It is the v3 state machine: it spawns workers when tickets enter `in_progress`/`in_review`,
 * steers live workers from new ticket comments, aborts on `cancelled`, and — when a worker
 * finishes — advances the ticket's Plane state and posts a summary comment. It NEVER does the
 * work itself and NEVER routes through the retired v2 `WorkerManager`/`Store` — it composes
 * the focused {@link spawnWorker} helper (`./spawn.ts`) directly (`docs/V3.md` §5/§6).
 *
 * State-machine table (docs/V3.md §5):
 *
 *   | PollEvent                     | Condition            | Action                                  |
 *   |-------------------------------|----------------------|-----------------------------------------|
 *   | state_changed → in_progress   | no live worker       | spawn casting.implement (default claude)|
 *   | state_changed → in_review     | no live reviewer     | spawn casting.review (default claude)   |
 *   | comment_added                 | live worker, not bot | worker.nudge(comment.body)  (STEERING)  |
 *   | comment_added                 | no live worker       | ignore                                  |
 *   | cancelled                     | live worker          | worker.abort + reap, drop handle        |
 *   | state_changed → done/other    | —                    | reap any live worker; no spawn          |
 *   | created                       | —                    | no spawn (log)                          |
 *
 *   on worker finish (work is committed in the ticket's own project repo, `~/Projects/<slug>`):
 *     implement success, self + real diff    → setState(done)       (ONE pass — worker self-reviewed)
 *     implement success, fresh/no self-pass   → setState(in_review)  + summary comment
 *     implement incomplete/error             → retry or return to todo with WIP
 *     review   complete verdict              → setState(done) + verdict comment
 *     review   blocked/partial verdict       → setState(in_progress) + verdict comment (re-work)
 *     review   infra/schema failure          → retry review, then hold for a human
 *
 * Review tier (see {@link reviewTierFor}) derives from the cast `effort` (low/medium → self;
 * high/xhigh/unset → fresh) or an explicit `reviewTier` on the implement cast.
 *
 * Concurrency is bounded by `config.concurrency.max_workers` (default 2 — each ticket has its own
 * project repo, so independent tickets/DAG nodes run in parallel); over-cap spawns are queued FIFO
 * and pumped as workers free their slots.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, Harness, Logger, WorkerEvent, DoneSignal } from "../types.ts";
import type {
  Ticket,
  TicketState,
  PlaneComment,
  PollEvent,
  HarnessSpec,
} from "../plane/types.ts";
import type { ProgressSink } from "../progress/journal.ts";
import { log } from "../log.ts";
import {
  commitWorktree,
  headSha,
  hasDiffSince,
  ensureProjectRepo,
  readDiff,
  createWorktree,
  removeWorktree,
  fetchRemote,
  SCAFFOLDING_DIR,
} from "../worker/worktree.ts";
import { projectSlug } from "../plane/cast.ts";
import { hardCapSeconds, sweepLedgeredWorker } from "../drivers/proc.ts";
import { spawnWorker, type TicketWorkerHandle } from "./spawn.ts";
import { AdvanceOutbox, type AdvanceOperation } from "./advance-outbox.ts";
import { appendSpendRecord, type SpendOutcome } from "../spend.ts";

// =======================================================================================
// Collaborators
// =======================================================================================

/**
 * The subset of the Plane REST client (`docs/V3.md` §3, `src/plane/client.ts`) the dispatcher
 * uses. Declared structurally so this module does not hard-depend on the parallel-built client
 * — the concrete `PlaneClient` satisfies it.
 */
export interface PlaneClientLike {
  /** Move a ticket to a new lifecycle state (resolves state_map name → Plane state UUID). */
  setState(id: string, state: TicketState): Promise<void>;
  /** Fetch a ticket before dispatcher-initiated state changes, so human terminal moves win. */
  getIssue?(id: string): Promise<Ticket | null>;
  /** Post a comment on a ticket; returns the created comment. */
  addComment(ticketId: string, body: string): Promise<PlaneComment>;
  /** List every ticket in the project — used to find dependents to promote when one finishes. */
  listIssues(): Promise<Ticket[]>;
}

/** Construction dependencies for the {@link Dispatcher} (docs/V3.md §5). */
/**
 * The git/worktree ops the dispatcher performs. Grouped so tests can inject fakes via
 * {@link DispatcherDeps.gitOps} WITHOUT `mock.module`-ing `../worker/worktree.ts` — that mock is
 * process-global in bun and leaked its fakes into other files' real-git tests (scaffolding-guard).
 */
export interface GitOps {
  commitWorktree: typeof commitWorktree;
  headSha: typeof headSha;
  hasDiffSince: typeof hasDiffSince;
  ensureProjectRepo: typeof ensureProjectRepo;
  readDiff: typeof readDiff;
  createWorktree: typeof createWorktree;
  removeWorktree: typeof removeWorktree;
  fetchRemote: typeof fetchRemote;
}

export interface DispatcherDeps {
  /** Default Plane client (normally config.plane.default_board). */
  client: PlaneClientLike;
  /** All board-scoped clients the daemon polls; used for identifier lookup and cross-board deps. */
  clients?: PlaneClientLike[];
  /** Resolve the board-scoped client for a Plane project id. Falls back to client. */
  clientForProjectId?: (projectId: string) => PlaneClientLike | undefined;
  config: Config;
  /** Override any git op (tests inject fakes here); unset ops use the real worktree.ts impl. */
  gitOps?: Partial<GitOps>;
  /** Resolve the absolute path of a ticket's own project repo (`~/Projects/<slug>`). */
  resolveRepoRoot: (ticket: Ticket) => string;
  /**
   * Publish a done ticket's project repo to GitHub (`0xbeckett/<slug>`, public) and return its web
   * URL. Injected so the dispatcher stays decoupled from the GitHub client + identity loading (and
   * stays unit-testable). Omitted in tests / when no PAT is configured → publishing is skipped.
   */
  publishRepo?: (args: {
    slug: string;
    repoRoot: string;
    description: string;
    ticket?: string;
  }) => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>;
  /**
   * Optional progress feed: the dispatcher forwards each worker's granular {@link WorkerEvent}
   * stream here, keyed by ticket identifier, so it lands in the ticket's PRIVATE journal (see
   * `src/progress/journal.ts`). Injected from the Concierge in `v4-main.ts`; omitted in tests.
   */
  progress?: ProgressSink;
  /** JSONL path for durable post-finish Plane advances. Omitted in tests unless needed. */
  advanceOutboxPath?: string;
  /** JSON path for restart-surviving dispatcher ticket memory (base SHA + retry/rework counters). */
  runtimeStatePath?: string;
  /** Append-only per-stage telemetry JSONL path; defaults to config `[paths].spend`. */
  spendLedgerPath?: string;
  /** Test seam for {@link Dispatcher.recoverFromCrash}'s orphan sweep; default ps-verifies + kills. */
  sweepOrphan?: (pid: number, expectedBin: string) => boolean;
  /**
   * Harness health probe (issue #17): consulted before casting so a dead harness produces one
   * clear substitution instead of a wedged ticket. Wire `preflightFor` from `drivers/index.ts`
   * in production (v4-main does); omitted in tests → every harness is presumed healthy.
   */
  preflight?: (harness: Harness) => Promise<{ ok: boolean; problems: string[] }>;
  /**
   * Fired the moment the dispatcher writes a state advance to Plane (issue #33), with the same
   * {@link PollEvent} shape the poller would emit ≤5s later. v4-main routes it straight into
   * `concierge.notify` (an instant done ping instead of a poll-gap-delayed one) AND into
   * `poller.observe` (so the next tick doesn't re-emit the transition as a duplicate).
   */
  onAdvance?: (event: PollEvent) => void;
  logger?: Logger;
}

/**
 * Marker prepended to every dispatcher-authored Plane comment so STEERING never treats one of
 * its own summaries as a human nudge (avoids a self-nudge loop, docs/V3.md §5). Rendered as an
 * invisible HTML comment in Plane's markdown.
 */
export const BECKETT_COMMENT_MARKER = "<!-- beckett:dispatcher -->";

/** Max implement↔review round-trips before the dispatcher stops auto-reworking and waits for a human. */
const MAX_REWORK_CYCLES = 3;

/** The completeness checker may send an incomplete design back once before escalating to its owner. */
const MAX_DESIGN_CYCLES = 2;

/**
 * Max times an implement worker that ended WITHOUT a clean finish (hit the backstop wall-clock cap,
 * crashed, or errored) is auto-respawned to continue from its committed WIP before the dispatcher
 * stops retrying and returns the ticket to a ready state (OPS-50).
 */
const MAX_IMPLEMENT_RETRIES = 3;

/** Max review infra/schema retries before the dispatcher stops and waits for a human verdict. */
const MAX_REVIEW_INFRA_RETRIES = 1;

/**
 * Backoff before re-attempting a failed SPAWN (issue #17): a harness that would not even start
 * won't be fixed by an instant retry, so give transient causes (network blip, box load) room —
 * 30s, then 2m, then 10m — before parking the ticket for a human.
 */
const SPAWN_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

/** Per-harness "how a human fixes auth" hint for park comments (issue #17). */
const LOGIN_HINTS: Record<string, string> = {
  claude: "sign in by running `claude` as the beckett user (subscription login)",
  codex: "run `codex login` as the beckett user (ChatGPT subscription)",
  pi: "run `pi` once as the beckett user to sign in",
};

/** A spawn deferred because the concurrency cap was reached. */
interface PendingSpawn {
  ticket: Ticket;
  stage: string;
  repoRoot: string;
  waitingFor?: string;
}

interface RepoOwner {
  ticketId: string;
  identifier: string;
}

interface SpendStageMeta {
  harness: string;
  model: string;
  effort: string;
  startedAt: number;
}

type DispatcherLiveEntry =
  | { state: "live"; ticketId: string; workerId: string; repoRoot: string | null }
  | {
      state: "queued";
      ticketId: string;
      workerId: null;
      stage: string;
      repoRoot: string;
      waitingFor?: string;
    };

export interface DispatcherShutdownResult {
  liveWorkers: number;
  queuedSpawns: number;
  completed: number;
  timedOut: boolean;
}

/**
 * One live worker's crash-recovery ledger entry (issue #20), persisted in the runtime-state file
 * at spawn and removed on clean finish/cancel/park — but KEPT by the shutdown drain, so the next
 * boot can sweep the orphan pid (crash case) and resume the persisted session instead of
 * re-running the whole ticket from scratch.
 */
interface LedgeredWorker {
  identifier: string;
  stage: string;
  workerId: string;
  sessionId: string;
  pid: number;
  repoRoot: string;
  harness: string;
  spawnedAt: number;
}

interface DispatcherRuntimeState {
  version: 1;
  baseShaForTicket: Record<string, string>;
  reworkCount: Record<string, number>;
  implementRetries: Record<string, number>;
  reviewInfraRetries: Record<string, number>;
  /** Incomplete design-check passes; bounded so an owner is always eventually paged. */
  designCycles?: Record<string, number>;
  /** Crash-recovery worker ledger, keyed by ticket id (absent in pre-ledger state files). */
  liveWorkers?: Record<string, LedgeredWorker>;
  /** Steering comments awaiting the next worker, keyed by ticket id (issue #22 — restart-proof). */
  pendingSteers?: Record<string, string[]>;
}

/** Outcome of {@link Dispatcher.publishProject} — gates whether a ticket may be marked done. */
type PublishOutcome =
  | { status: "skipped" } // no publisher wired (tests / no PAT) — nothing to gate on
  | { status: "published"; url: string; kind: "pushed" | "pr"; prUrl?: string }
  | { status: "failed"; error: string };

function parseDoneSignal(structured: unknown): DoneSignal | null {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const o = structured as Record<string, unknown>;
  const allowed = new Set(["status", "summary", "filesChanged", "checksRun", "blockedReason"]);
  if (Object.keys(o).some((key) => !allowed.has(key))) return null;
  const status = o.status;
  if (status !== "complete" && status !== "blocked" && status !== "partial") return null;
  if (typeof o.summary !== "string") return null;
  if (!Array.isArray(o.filesChanged) || !o.filesChanged.every((f) => typeof f === "string")) return null;
  if (
    o.checksRun !== null &&
    (!Array.isArray(o.checksRun) || !o.checksRun.every((c) => typeof c === "string"))
  ) {
    return null;
  }
  if (o.blockedReason !== null && typeof o.blockedReason !== "string") return null;

  return {
    status,
    summary: o.summary,
    filesChanged: o.filesChanged,
    ...(Array.isArray(o.checksRun) ? { checksRun: o.checksRun } : {}),
    ...(typeof o.blockedReason === "string" ? { blockedReason: o.blockedReason } : {}),
  };
}

function doneSignalSummary(signal: DoneSignal, fallback: string): string {
  const blockedReason = signal.blockedReason ? `\n\nBlocked reason:\n${signal.blockedReason}` : "";
  const summary = signal.summary || fallback;
  return `${summary}${blockedReason}`;
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`${field}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

function parseNumberRecord(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Number.isInteger(item) || item < 0) throw new Error(`${field}.${key} must be a non-negative integer`);
    out[key] = item;
  }
  return out;
}

/** Lenient pending-steer parse (issue #22): a malformed entry is dropped, never fatal. */
function parseSteers(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [ticketId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const steers = raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (steers.length) out[ticketId] = steers;
  }
  return out;
}

/** Lenient ledger parse: a malformed entry is dropped (recovery is best-effort), never fatal. */
function parseLedger(value: unknown): Record<string, LedgeredWorker> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, LedgeredWorker> = {};
  for (const [ticketId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    if (typeof w.identifier !== "string" || typeof w.stage !== "string") continue;
    if (typeof w.sessionId !== "string" || typeof w.repoRoot !== "string") continue;
    out[ticketId] = {
      identifier: w.identifier,
      stage: w.stage,
      workerId: typeof w.workerId === "string" ? w.workerId : "",
      sessionId: w.sessionId,
      pid: Number.isInteger(w.pid) ? (w.pid as number) : 0,
      repoRoot: w.repoRoot,
      harness: typeof w.harness === "string" ? w.harness : "claude",
      spawnedAt: typeof w.spawnedAt === "number" ? w.spawnedAt : 0,
    };
  }
  return out;
}

function parseRuntimeState(value: unknown): DispatcherRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime state must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported runtime state version");
  return {
    version: 1,
    baseShaForTicket: parseStringRecord(raw.baseShaForTicket, "baseShaForTicket"),
    reworkCount: parseNumberRecord(raw.reworkCount, "reworkCount"),
    implementRetries: parseNumberRecord(raw.implementRetries, "implementRetries"),
    reviewInfraRetries: parseNumberRecord(raw.reviewInfraRetries, "reviewInfraRetries"),
    designCycles: raw.designCycles === undefined ? {} : parseNumberRecord(raw.designCycles, "designCycles"),
    liveWorkers: parseLedger(raw.liveWorkers),
    pendingSteers: parseSteers(raw.pendingSteers),
  };
}

// =======================================================================================
// Dispatcher
// =======================================================================================

export class Dispatcher {
  private readonly client: PlaneClientLike;
  private readonly clients: PlaneClientLike[];
  private readonly clientForProjectIdDep?: (projectId: string) => PlaneClientLike | undefined;
  private readonly projectIdByTicketId = new Map<string, string>();
  private readonly config: Config;
  private readonly git: GitOps;
  private readonly resolveRepoRoot: (ticket: Ticket) => string;
  private readonly publishRepo?: (args: {
    slug: string;
    repoRoot: string;
    description: string;
    ticket?: string;
  }) => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>;
  private readonly progress?: ProgressSink;
  private readonly onAdvance?: (event: PollEvent) => void;
  private readonly logger: Logger;
  private readonly advanceOutbox?: AdvanceOutbox;
  private readonly runtimeStatePath?: string;
  private readonly spendLedgerPath: string;

  /** At most one live worker per ticket (implement OR review). */
  private readonly workers = new Map<string, TicketWorkerHandle>();
  /** Full ticket metadata for live workers, needed for shutdown WIP commits. */
  private readonly liveTickets = new Map<string, Ticket>();
  /**
   * Repo HEAD sha captured when a ticket FIRST entered `implement` — the REVIEW/rework diff base.
   * v3.1 runs every stage of a ticket in the one project checkout (no per-stage branch), so the
   * reviewer diffs `<baseSha>..HEAD` to see the ticket's whole contribution. Persists across
   * rework cycles (so re-review still diffs from the original base); cleared on done/cancel.
   */
  private readonly baseShaForTicket = new Map<string, string>();
  /** FIFO queue of spawns waiting for a free concurrency slot. */
  private readonly pending: PendingSpawn[] = [];
  /**
   * Ticket ids with a spawn ADMITTED but whose handle has not yet landed in {@link workers}
   * (the async `spawnWorker` gap — worktree alloc + harness launch). This is the airtight
   * per-ticket dedup reservation: it is added SYNCHRONOUSLY the instant a spawn is admitted,
   * before any `await`, so a second event for the same ticket arriving during the gap is
   * rejected instead of launching a duplicate worker. Without it, duplicate spawns landed on
   * the same ticket id, the second `workers.set` overwrote (orphaning the first process), and
   * `atCap()` undercounted → the concurrency cap was silently bypassed (runaway fan-out).
   */
  private readonly staffing = new Set<string>();
  /**
   * Legacy per-repo exclusivity map. v3.2 runs each ticket in its OWN worktree, so same-repo
   * tickets are no longer serialized — {@link launchSpawn} stops populating this, leaving the
   * guards in {@link spawnGuarded}/{@link pump} to always see "free" (concurrent under the cap).
   * Kept (inert) rather than ripping out the guard scaffolding.
   */
  private readonly repoOwners = new Map<string, RepoOwner>();
  /** Reverse lookup so release paths can free the project repo for this ticket. */
  private readonly repoByTicket = new Map<string, string>();
  /** Ticket id → its allocated worktree path, so terminal paths can tear it down. */
  private readonly workspaceByTicket = new Map<string, string>();
  /**
   * Per-repo promise chain that serializes the git ALLOC step (fetch + `git worktree add`) so
   * concurrent same-repo spawns can't race on the shared `.git` index/HEAD locks. Only the alloc
   * is serialized; the workers themselves then run in parallel in their isolated worktrees.
   */
  private readonly repoAllocChain = new Map<string, Promise<unknown>>();
  /** Ids of comments the dispatcher itself posted — never read back as steering (Fix: self-nudge). */
  private readonly ownCommentIds = new Set<string>();
  /** Per-ticket implement↔review round-trips, to bound auto-rework. */
  private readonly reworkCount = new Map<string, number>();
  /** Per-ticket count of implement workers that ended without a clean finish, to bound auto-retry. */
  private readonly implementRetries = new Map<string, number>();
  /** Per-ticket count of review crashes or malformed verdicts; separate from real rework cycles. */
  private readonly reviewInfraRetries = new Map<string, number>();
  /** Per-ticket incomplete design-check count, bounded by MAX_DESIGN_CYCLES. */
  private readonly designCycles = new Map<string, number>();
  /** Crash-recovery ledger for CURRENTLY live workers (persisted; see {@link LedgeredWorker}). */
  private readonly liveLedger = new Map<string, LedgeredWorker>();
  /** Epoch ms of each live worker's last driver event — the "is it moving?" status signal (#30). */
  private readonly lastEventAt = new Map<string, number>();
  /** Ledger entries loaded from a previous daemon's state file, consumed by {@link recoverFromCrash}. */
  private recoveredWorkers: Record<string, LedgeredWorker> | null = null;
  /** Per-ticket resume hints produced by recovery: the next same-stage spawn resumes this session. */
  private readonly resumables = new Map<string, { stage: string; sessionId: string; harness: string }>();

  /**
   * Steering comments that arrived while no worker could take them (issue #22): pre-spawn, the
   * spawn gap, queued at the cap, between rework cycles, or after a finish. Held per ticket,
   * persisted (restart-proof), and consumed by the next spawn (folded into the prompt) or
   * flushed as a nudge when they land mid-spawn-gap. NEVER silently dropped.
   */
  private readonly pendingSteers = new Map<string, string[]>();
  /** Orphan-sweep hook (injectable for tests); defaults to the ps-verified group kill in proc.ts. */
  private readonly sweepOrphan: (pid: number, expectedBin: string) => boolean;
  /** Harness health probe (issue #17); absent → every harness is presumed healthy. */
  private readonly preflight?: (harness: Harness) => Promise<{ ok: boolean; problems: string[] }>;
  /** Pending delayed spawn retries (issue #17 backoff), keyed by ticket id. */
  private readonly spawnRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One-shot cast substitutions from classed-failure recovery (issue #17), by ticket id. */
  private readonly castOverrides = new Map<string, { stage: string; spec: HarnessSpec }>();
  /** Spawn-time cast facts retained until the run is ledgered (including cancellation). */
  private readonly spendMetaByWorker = new Map<string, SpendStageMeta>();

  constructor(deps: DispatcherDeps) {
    this.client = deps.client;
    this.clients = deps.clients && deps.clients.length > 0 ? deps.clients : [deps.client];
    this.clientForProjectIdDep = deps.clientForProjectId;
    this.config = deps.config;
    this.git = {
      commitWorktree,
      headSha,
      hasDiffSince,
      ensureProjectRepo,
      readDiff,
      createWorktree,
      removeWorktree,
      fetchRemote,
      ...deps.gitOps,
    };
    this.resolveRepoRoot = deps.resolveRepoRoot;
    this.publishRepo = deps.publishRepo;
    this.progress = deps.progress;
    this.onAdvance = deps.onAdvance;
    this.logger = deps.logger ?? log.child("dispatch.dispatcher");
    this.advanceOutbox = deps.advanceOutboxPath
      ? new AdvanceOutbox(deps.advanceOutboxPath, this.logger.child("advance-outbox"))
      : undefined;
    this.runtimeStatePath = deps.runtimeStatePath;
    // Minimal test/embedded configs predate `[paths]`; production config always supplies it.
    this.spendLedgerPath = deps.spendLedgerPath ?? this.config.paths?.spend ?? join(process.env.HOME ?? "/home/beckett", ".beckett", "spend.jsonl");
    this.sweepOrphan =
      deps.sweepOrphan ?? ((pid, expectedBin) => sweepLedgeredWorker(pid, expectedBin, this.logger));
    this.preflight = deps.preflight;
    this.loadRuntimeState();
  }

  /**
   * Boot-time crash recovery (issue #20). Call ONCE, after construction and BEFORE the poller
   * starts re-staffing tickets. For every worker the previous daemon left in the ledger:
   *   1. sweep its process group if still alive (daemon crash → setsid'd orphans keep editing
   *      the checkout with no watchdog; ps-verified so a recycled pid is never killed),
   *   2. commit any ghost WIP in its checkout so re-staff base-sha captures aren't polluted,
   *   3. record a resume hint so the re-staffed same-stage worker resumes the persisted session
   *      instead of re-paying the whole ticket's exploration cost.
   * The ledger is then cleared (those workers are no longer live).
   */
  async recoverFromCrash(): Promise<void> {
    const recovered = this.recoveredWorkers;
    this.recoveredWorkers = null;
    if (!recovered) return;
    const entries = Object.entries(recovered);
    if (entries.length === 0) return;

    let swept = 0;
    for (const [ticketId, w] of entries) {
      if (w.pid > 0) {
        try {
          if (this.sweepOrphan(w.pid, this.harnessBin(w.harness))) swept++;
        } catch (err) {
          this.logger.warn("orphan sweep failed", { pid: w.pid, error: (err as Error).message });
        }
      }
      try {
        const commit = await this.git.commitWorktree(
          w.repoRoot,
          `beckett: ${w.identifier} restart WIP (${w.workerId || "unknown worker"})`,
        );
        if (commit.committed) {
          this.logger.info("committed ghost WIP from interrupted worker", {
            ticket: w.identifier,
            sha: commit.sha,
          });
        }
      } catch (err) {
        this.logger.warn("restart WIP commit failed", {
          ticket: w.identifier,
          repoRoot: w.repoRoot,
          error: (err as Error).message,
        });
      }
      if (w.sessionId) {
        this.resumables.set(ticketId, { stage: w.stage, sessionId: w.sessionId, harness: w.harness });
      }
    }
    this.persistRuntimeState(); // liveLedger is empty now — clears the on-disk ledger
    this.logger.info("crash recovery complete", {
      interrupted: entries.length,
      sweptOrphans: swept,
      resumable: this.resumables.size,
    });
  }

  /** The binary name expected on a ledgered worker's command line (for the ps identity check). */
  private harnessBin(harness: string): string {
    const h = this.config.harness as unknown as Record<string, { bin?: string } | undefined>;
    return h?.[harness]?.bin || harness;
  }

  private rememberTicket(ticket: Ticket | null | undefined): void {
    if (ticket?.id && ticket.projectId) this.projectIdByTicketId.set(ticket.id, ticket.projectId);
  }

  private clientForProjectId(projectId?: string): PlaneClientLike {
    if (!projectId) return this.client;
    return this.clientForProjectIdDep?.(projectId) ?? this.client;
  }

  private clientForTicket(ticket: Ticket): PlaneClientLike {
    this.rememberTicket(ticket);
    return this.clientForProjectId(ticket.projectId);
  }

  private clientForTicketId(ticketId: string, projectId?: string): PlaneClientLike {
    return this.clientForProjectId(projectId ?? this.projectIdByTicketId.get(ticketId));
  }

  private async listAllIssues(): Promise<Ticket[]> {
    const boards = await Promise.all(this.clients.map((client) => client.listIssues()));
    const seen = new Set<string>();
    const out: Ticket[] = [];
    for (const ticket of boards.flat()) {
      if (seen.has(ticket.id)) continue;
      seen.add(ticket.id);
      this.rememberTicket(ticket);
      out.push(ticket);
    }
    return out;
  }

  // ── public surface ─────────────────────────────────────────────────────────────────────

  /**
   * Route one or a batch of poll events through the state machine. Accepts a single
   * {@link PollEvent} (docs/V3.md §5) or an array (task spec); events are handled in order.
   */
  async handle(event: PollEvent | PollEvent[]): Promise<void> {
    await this.replayAdvances();
    const batch = Array.isArray(event) ? event : [event];
    for (const e of batch) {
      // Per-event isolation (issue #33): the poller's snapshot has already advanced past this
      // batch, so an event that throws must not take the REST of the batch down with it — those
      // events would never re-emit (a dropped cancel is the worst case).
      try {
        await this.handleOne(e);
      } catch (err) {
        this.logger.error("event handling failed — continuing with the rest of the batch", {
          kind: e.kind,
          ticket: e.ticket.identifier,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Replay durable Plane advances left by previous write failures. Safe to call on every tick. */
  async replayAdvances(): Promise<void> {
    if (!this.advanceOutbox) return;
    const applied = await this.advanceOutbox.drain((op) => this.applyAdvance(op));
    if (applied > 0) this.logger.info("replayed queued Plane advances", { count: applied });
  }

  /** Current active and queued dispatcher work, including repo queue context for status surfaces. */
  live(): DispatcherLiveEntry[] {
    const live = [...this.workers.entries()].map(([ticketId, h]) => ({
      state: "live" as const,
      ticketId,
      workerId: h.id,
      repoRoot: this.repoByTicket.get(ticketId) ?? null,
    }));
    const queued = this.pending.map((p) => ({
      state: "queued" as const,
      ticketId: p.ticket.id,
      workerId: null,
      stage: p.stage,
      repoRoot: p.repoRoot,
      waitingFor: p.waitingFor,
    }));
    return [...live, ...queued];
  }

  /**
   * The `beckett status` worker table (issue #30): one row per live worker with everything an
   * operator needs to judge health at a glance — who is working on what, on which harness/pid,
   * for how long, and how long since it last showed a sign of life.
   */
  statusWorkers(): Array<Record<string, unknown>> {
    const now = Date.now();
    // Self-pruning: entries for finished workers die here, so the map never grows unbounded.
    for (const id of [...this.lastEventAt.keys()]) {
      if (!this.workers.has(id)) this.lastEventAt.delete(id);
    }
    const live = [...this.workers.entries()].map(([ticketId, h]) => {
      const ledger = this.liveLedger.get(ticketId);
      const lastEvent = this.lastEventAt.get(ticketId);
      return {
        state: "live",
        ticket: ledger?.identifier ?? this.liveTickets.get(ticketId)?.identifier ?? ticketId,
        stage: h.stage,
        harness: h.harness,
        workerId: h.id,
        pid: h.pid || null,
        workerState: h.state,
        elapsedSecs: ledger ? Math.round((now - ledger.spawnedAt) / 1000) : null,
        lastEventAgeSecs: lastEvent === undefined ? null : Math.round((now - lastEvent) / 1000),
      };
    });
    const queued = this.pending.map((p) => ({
      state: "queued",
      ticket: p.ticket.identifier,
      stage: p.stage,
      waitingFor: p.waitingFor,
    }));
    return [...live, ...queued];
  }

  /**
   * Stop live workers during daemon shutdown, preserving any dirty checkout as a WIP commit before
   * process exit. Bounded so SIGTERM handling cannot hang indefinitely under systemd.
   */
  async drainForShutdown(
    reason = "daemon shutdown",
    timeoutMs = 20_000,
  ): Promise<DispatcherShutdownResult> {
    const live = [...this.workers.entries()];
    const queuedSpawns = this.pending.length;
    this.pending.splice(0);
    for (const timer of this.spawnRetryTimers.values()) clearTimeout(timer);
    this.spawnRetryTimers.clear();
    if (live.length === 0) {
      this.logger.info("dispatcher shutdown drain: no live workers", { queuedSpawns });
      return { liveWorkers: 0, queuedSpawns, completed: 0, timedOut: false };
    }

    this.logger.warn("dispatcher shutdown drain: stopping live workers", {
      liveWorkers: live.length,
      queuedSpawns,
      timeoutMs,
      reason,
    });

    let completed = 0;
    const drain = Promise.allSettled(
      live.map(async ([ticketId, handle]) => {
        const ticket = this.liveTickets.get(ticketId);
        this.workers.delete(ticketId);
        this.liveTickets.delete(ticketId);
        this.staffing.delete(ticketId);
        try {
          await handle.abort(reason);
        } catch (err) {
          this.logger.warn("shutdown worker abort failed", {
            ticketId,
            workerId: handle.id,
            error: (err as Error).message,
          });
        }
        const sha = ticket ? await this.commitWip(ticket, handle) : null;
        try {
          await handle.reap();
        } catch (err) {
          this.logger.warn("shutdown worker reap failed", {
            ticketId,
            workerId: handle.id,
            error: (err as Error).message,
          });
        } finally {
          this.releaseRepo(ticketId);
        }
        completed++;
        this.logger.info("shutdown drained worker", {
          ticket: ticket?.identifier ?? ticketId,
          workerId: handle.id,
          wipSha: sha,
        });
      }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);
    const timedOut = result === "timeout";
    if (timedOut) {
      this.logger.warn("dispatcher shutdown drain timed out", {
        liveWorkers: live.length,
        completed,
        timeoutMs,
      });
    }
    return { liveWorkers: live.length, queuedSpawns, completed, timedOut };
  }

  // ── event routing ────────────────────────────────────────────────────────────────────

  private async handleOne(event: PollEvent): Promise<void> {
    this.rememberTicket(event.ticket);
    switch (event.kind) {
      case "created":
        this.logger.info("ticket created", {
          ticket: event.ticket.identifier,
          state: event.ticket.state,
        });
        return;
      case "state_changed":
        await this.onStateChanged(event.ticket, event.from, event.to);
        return;
      case "comment_added":
        await this.onComment(event.ticket, event.comment);
        return;
      case "cancelled":
        await this.onCancelled(event.ticket);
        return;
    }
  }

  private async onStateChanged(
    ticket: Ticket,
    from: TicketState | null,
    to: TicketState,
  ): Promise<void> {
    this.logger.info("ticket state changed", { ticket: ticket.identifier, from, to });
    switch (to) {
      case "design":
        // `design` is INT-only. The identifier guard keeps a malformed non-INT board state
        // from accidentally spending a design worker.
        if (!this.isIntTicket(ticket)) return;
        if (this.workers.has(ticket.id)) return;
        this.spawnGuarded(ticket, "design");
        return;
      case "in_progress":
        if (this.workers.has(ticket.id)) return; // already staffed
        this.spawnGuarded(ticket, "implement");
        return;
      case "in_review":
        if (this.workers.has(ticket.id)) return; // already has a reviewer
        this.spawnGuarded(ticket, "review");
        return;
      case "done": {
        // Unapplied steering on a finished ticket must not vanish (issue #22): tell the human
        // how to act on it before the ticket's memory is cleared.
        const orphaned = this.takeSteers(ticket.id);
        if (orphaned.length > 0) {
          await this.postComment(
            ticket.id,
            `This ticket finished with ${orphaned.length === 1 ? "a steering comment" : `${orphaned.length} steering comments`} that no worker applied:\n` +
              orphaned.map((s) => `> ${s.split("\n")[0]}`).join("\n") +
              `\n\nMove the ticket back to **in_progress** (or file a follow-up) to act on ${orphaned.length === 1 ? "it" : "them"}.`,
          );
        }
        await this.reapTicket(ticket.id, "ticket done");
        await this.promoteDependents(ticket);
        return;
      }
      case "cancelled":
        await this.onCancelled(ticket);
        return;
      case "todo":
      case "backlog":
      case "design_review":
        await this.onParked(ticket, to);
        return;
    }
  }

  /**
   * A human comment is a STEER and must never vanish (issue #22). Live worker → nudge it and
   * narrate any receipt weaker than `delivered`. No live worker (pre-spawn, spawn gap, queued at
   * the cap, between stages, finished-but-not-advanced) → hold it in {@link pendingSteers}
   * (persisted) for the next worker, and say so on the ticket.
   */
  private async onComment(ticket: Ticket, comment: PlaneComment): Promise<void> {
    if (this.isBeckettComment(comment)) {
      return; // our own summary/status comment — never self-nudge
    }
    const handle = this.workers.get(ticket.id);

    if (!handle || handle.result) {
      if (ticket.state === "done" || ticket.state === "cancelled") {
        // Shouldn't normally arrive (the poller stops collecting on terminal tickets), but if it
        // does: never silence — tell the human how to act on it.
        await this.postComment(
          ticket.id,
          `This comment landed after the ticket was **${ticket.state}**, so no worker will see ` +
            `it. Move the ticket back to **in_progress** (or file a follow-up) to act on it.`,
        );
        return;
      }
      this.bufferSteer(ticket, comment.body);
      await this.postComment(
        ticket.id,
        `No worker is live on this ticket right now, so I'm holding this comment and will hand ` +
          `it to the next worker (it becomes part of their brief).`,
      );
      return;
    }

    this.logger.info("steering live worker from comment", {
      ticket: ticket.identifier,
      workerId: handle.id,
      author: comment.author,
    });
    // Fire-and-forget (issue #33): an un-echoed nudge waits up to 30s for its stdin ack, and the
    // poll loop awaits handle() — awaiting here froze ALL polling (including cancels) for the
    // duration. The receipt narration runs async; receipt semantics (issue #22) are unchanged.
    void handle
      .nudge(comment.body)
      .then(async (accepted) => {
        if (accepted === "delivered") return; // acked live — nothing to narrate

        if (accepted === "dropped") {
          // The worker finished between the poll and the nudge — carry the words to the next stage.
          this.bufferSteer(ticket, comment.body);
          await this.postComment(
            ticket.id,
            `The worker had already finished when this comment arrived, so I'm holding it and will ` +
              `hand it to the next worker on this ticket.`,
          );
          return;
        }
        // `queued` (claude: inside the harness, unacked) / `will-restart` (one-shot: applies when
        // the current run ends). Honest one-liner so the user's mental model stays true.
        await this.postComment(
          ticket.id,
          accepted === "will-restart"
            ? `Steering received. This worker's harness can't take mid-run input, so your note ` +
              `applies when its current run ends (it restarts with your note as the next instruction).`
            : `Steering received and queued — the worker picks it up at its next turn boundary.`,
        );
      })
      .catch(async (err) => {
        // A nudge that ERRORS must still never vanish (issue #22): hold it for the next worker.
        this.logger.warn("nudge failed — holding comment for the next worker", {
          ticket: ticket.identifier,
          error: (err as Error).message,
        });
        this.bufferSteer(ticket, comment.body);
        await this.postComment(
          ticket.id,
          `Delivering this comment to the live worker failed, so I'm holding it and will hand it ` +
            `to the next worker on this ticket.`,
        ).catch(() => {});
      });
  }

  /** Hold a steering comment for the next worker on this ticket (persisted, issue #22). */
  private bufferSteer(ticket: Ticket, text: string): void {
    const steers = this.pendingSteers.get(ticket.id) ?? [];
    steers.push(text);
    this.pendingSteers.set(ticket.id, steers);
    this.persistRuntimeState();
    this.logger.info("steering comment held for next worker", {
      ticket: ticket.identifier,
      pending: steers.length,
    });
  }

  /** Drain the held steers for a ticket (consumed by the next spawn / flush). */
  private takeSteers(ticketId: string): string[] {
    const steers = this.pendingSteers.get(ticketId);
    if (!steers || steers.length === 0) return [];
    this.pendingSteers.delete(ticketId);
    this.persistRuntimeState();
    return steers;
  }

  private async onCancelled(ticket: Ticket): Promise<void> {
    const handle = this.workers.get(ticket.id);
    // Cancelled = the work is not wanted; held steering dies with it (deliberate, issue #22).
    if (this.pendingSteers.delete(ticket.id)) this.persistRuntimeState();
    this.clearTicketMemory(ticket.id);
    this.staffing.delete(ticket.id); // drop any mid-spawn reservation so doSpawn discards it
    this.dropPending(ticket.id);
    this.releaseRepo(ticket.id);
    if (!handle) {
      this.logger.info("ticket cancelled (no live worker)", { ticket: ticket.identifier });
      await this.disposeWorktree(ticket.id);
      this.pump();
      return;
    }
    this.logger.warn("ticket cancelled — aborting worker", {
      ticket: ticket.identifier,
      workerId: handle.id,
    });
    this.workers.delete(ticket.id);
    this.recordSpend(ticket, handle.stage, handle, "error", this.spendMetaByWorker.get(handle.id), "cancelled");
    this.spendMetaByWorker.delete(handle.id);
    await handle.abort("ticket cancelled");
    await handle.reap();
    // Aborted + reaped → nothing holds the tree; remove it (the work is unwanted).
    await this.disposeWorktree(ticket.id);
    this.pump();
  }

  private async onParked(ticket: Ticket, state: "todo" | "backlog" | "design_review"): Promise<void> {
    const handle = this.workers.get(ticket.id);
    this.clearTicketMemory(ticket.id);
    this.staffing.delete(ticket.id);
    this.dropPending(ticket.id);
    this.releaseRepo(ticket.id);
    if (!handle) {
      this.logger.info("ticket parked (no live worker)", { ticket: ticket.identifier, state });
      this.pump();
      return;
    }

    this.logger.warn("ticket parked — stopping live worker", {
      ticket: ticket.identifier,
      workerId: handle.id,
      state,
    });
    this.workers.delete(ticket.id);
    // A human park is a cancellation of this stage, not a harness failure.
    this.recordSpend(ticket, handle.stage, handle, "error", this.spendMetaByWorker.get(handle.id), "cancelled");
    this.spendMetaByWorker.delete(handle.id);
    await handle.abort(`ticket moved to ${state}`);
    await handle.reap();
    const sha = await this.commitWip(ticket, handle);
    const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";
    await this.postComment(
      ticket.id,
      `Ticket moved to **${state}** while a worker was running, so I stopped the worker and ` +
        `committed any WIP${at}. Move it back to **in_progress** when you're ready to resume.`,
    );
    this.pump();
  }

  // ── spawning + concurrency ─────────────────────────────────────────────────────────────

  /**
   * Operator lever (issue #21): abort whatever worker a ticket has (committing its WIP) and
   * spawn a fresh one for the ticket's current stage — optionally pinned to a different harness.
   * Exposed to the Concierge as `beckett ticket restaff <id> [--harness h]` via the control bus.
   * Accepts a Plane uuid OR a human identifier ("OPS-42").
   */
  async restaff(
    idOrIdentifier: string,
    harness?: Harness,
  ): Promise<{ ticket: string; stage: string; harness?: Harness }> {
    const ticket = await this.findTicket(idOrIdentifier);
    if (!ticket) throw new Error(`no such ticket: ${idOrIdentifier}`);
    const stage = ticket.state === "design" ? "design" : ticket.state === "in_review" ? "review" : "implement";
    if (ticket.state !== "design" && ticket.state !== "in_progress" && ticket.state !== "in_review") {
      throw new Error(
        `ticket ${ticket.identifier} is in "${ticket.state}" — move it to in_progress/in_review ` +
          `(or INT Design) to (re)staff it`,
      );
    }

    const handle = this.workers.get(ticket.id);
    this.cancelSpawnRetry(ticket.id);
    this.dropPending(ticket.id);
    this.staffing.delete(ticket.id);
    if (handle) {
      this.logger.warn("restaff: aborting live worker", {
        ticket: ticket.identifier,
        workerId: handle.id,
        stage,
      });
      this.workers.delete(ticket.id);
      this.liveTickets.delete(ticket.id);
      if (this.liveLedger.delete(ticket.id)) this.persistRuntimeState();
      await handle.abort("restaffed by operator");
      await handle.reap();
      await this.commitWip(ticket, handle);
      this.releaseRepo(ticket.id);
    }
    if (harness) this.castOverrides.set(ticket.id, { stage, spec: { harness } });

    await this.postComment(
      ticket.id,
      `Restaffing the ${stage} worker${harness ? ` on **${harness}**` : ""} (operator request). ` +
        `Any work-in-progress was committed and the new worker continues from it.`,
    );
    this.spawnGuarded(ticket, stage);
    return { ticket: ticket.identifier, stage, harness };
  }

  /** Resolve a ticket by Plane uuid or human identifier ("OPS-42"), else null. */
  private async findTicket(idOrIdentifier: string): Promise<Ticket | null> {
    const key = idOrIdentifier.trim();
    if (!key) return null;
    // Identifiers look like "OPS-42"; uuids don't contain an unprefixed short slug-dash-number.
    if (/^[0-9a-f-]{32,}$/i.test(key)) {
      for (const client of this.clients) {
        if (!client.getIssue) continue;
        try {
          const t = await client.getIssue(key);
          if (t) {
            this.rememberTicket(t);
            return t;
          }
        } catch {
          /* fall through to the identifier scan */
        }
      }
    }
    const all = await this.listAllIssues();
    return all.find((t) => t.id === key || t.identifier.toLowerCase() === key.toLowerCase()) ?? null;
  }

  /** INT is a separate Plane board; its identifiers are minted as INT-N. */
  private isIntTicket(ticket: Ticket): boolean {
    return ticket.identifier.toUpperCase().startsWith("INT-") || ticket.projectId.toUpperCase() === "INT";
  }

  /** True if a worker is live, OR a spawn is mid-flight, for this ticket (airtight dedup). */
  private isStaffed(ticketId: string): boolean {
    return this.workers.has(ticketId) || this.staffing.has(ticketId);
  }

  /** True when live workers + admitted-but-not-yet-live spawns already fill the concurrency cap. */
  private atCap(): boolean {
    return this.workers.size + this.staffing.size >= this.config.concurrency.max_workers;
  }

  /** Spawn immediately if a slot is free, else enqueue for {@link pump}. */
  private spawnGuarded(ticket: Ticket, stage: string): void {
    if (this.isStaffed(ticket.id)) return; // already staffed (live or mid-spawn)
    const repoRoot = this.resolveRepoRoot(ticket);
    if (this.atCap()) {
      this.pending.push({ ticket, stage, repoRoot });
      this.logger.info("spawn queued (concurrency cap reached)", {
        ticket: ticket.identifier,
        stage,
        repoRoot,
        inUse: this.workers.size + this.staffing.size,
        cap: this.config.concurrency.max_workers,
        queueDepth: this.pending.length,
      });
      return;
    }
    const owner = this.repoOwners.get(repoRoot);
    if (owner) {
      this.pending.push({ ticket, stage, repoRoot, waitingFor: owner.identifier });
      this.logger.info("spawn queued (project repo busy)", {
        ticket: ticket.identifier,
        stage,
        repoRoot,
        waitingFor: owner.identifier,
        queueDepth: this.pending.length,
      });
      if (owner.ticketId !== ticket.id) {
        void this.postComment(
          ticket.id,
          `Waiting for ${owner.identifier} to free \`${repoRoot}\` before starting this ${stage} worker.`,
        );
      }
      return;
    }
    this.launchSpawn(ticket, stage, repoRoot);
  }

  /**
   * Reserve the ticket's slot SYNCHRONOUSLY ({@link staffing}.add) BEFORE the async spawn, so two
   * spawns racing through {@link spawnGuarded} can't both pass the dedup/cap checks. The
   * reservation is released — into {@link workers} on success, or dropped on failure — by
   * {@link doSpawn}; the queue is pumped once the spawn settles.
   */
  private launchSpawn(ticket: Ticket, stage: string, repoRoot: string): void {
    this.staffing.add(ticket.id);
    // v3.2: no per-repo reservation — each ticket gets its own worktree, so same-repo tickets run
    // concurrently under the global cap. Only the `staffing` dedup + `atCap()` gate admission.
    this.repoByTicket.set(ticket.id, repoRoot);
    void this.doSpawn(ticket, stage, repoRoot)
      .catch(() => {
        /* doSpawn handles its own errors + ticket comment */
      })
      .finally(() => {
        this.staffing.delete(ticket.id); // no-op if doSpawn already moved it into `workers`
        if (!this.workers.has(ticket.id)) this.releaseRepo(ticket.id);
        this.pump();
      });
  }

  /**
   * Allocate (or reuse) the ticket's own worktree. Serialized per-repo via {@link repoAllocChain}
   * so concurrent same-repo spawns don't race `git fetch`/`worktree add` on the shared `.git`;
   * the workers then run in parallel in their isolated trees. First allocation branches from a
   * freshly-fetched `origin/main` (no stale-base stacking — the OPS-59/61 failure); later stages
   * (review/rework) reuse the existing tree so they see the in-progress work.
   */
  private prepareWorktree(ticket: Ticket, repoRoot: string): Promise<string> {
    const prior = this.repoAllocChain.get(repoRoot) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.allocateTicketWorktree(ticket, repoRoot));
    this.repoAllocChain.set(repoRoot, run.catch(() => {}));
    return run;
  }

  private async allocateTicketWorktree(ticket: Ticket, repoRoot: string): Promise<string> {
    const firstTouch = !this.workspaceByTicket.has(ticket.id);
    const workspace = this.workspaceByTicket.get(ticket.id) ?? join(repoRoot, SCAFFOLDING_DIR, "worktrees", ticket.id);
    // Fresh base only when first cutting the tree; a reused tree keeps its in-progress commits.
    if (firstTouch) await this.git.fetchRemote(repoRoot);
    const branch = `beckett/${ticket.identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
    await this.git.createWorktree({ repoRoot, workspace, branch, baseRef: "origin/main", reuseIfExists: true });
    this.workspaceByTicket.set(ticket.id, workspace);
    return workspace;
  }

  /** Tear down a ticket's worktree (best-effort) once it's terminal-and-shipped or cancelled. */
  private async disposeWorktree(ticketId: string): Promise<void> {
    const workspace = this.workspaceByTicket.get(ticketId);
    if (!workspace) return;
    const repoRoot = this.repoByTicket.get(ticketId) ?? dirname(dirname(dirname(workspace)));
    this.workspaceByTicket.delete(ticketId);
    try {
      await this.git.removeWorktree(repoRoot, workspace);
    } catch (err) {
      this.logger.warn("worktree teardown failed (leaving it)", { ticketId, error: (err as Error).message });
    }
  }

  /** Admit queued spawns while slots are free. */
  private pump(): void {
    while (this.pending.length > 0 && !this.atCap()) {
      let launchAt = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const candidate = this.pending[i]!;
        if (this.isStaffed(candidate.ticket.id)) {
          this.pending.splice(i, 1);
          i--;
          continue;
        }
        const owner = this.repoOwners.get(candidate.repoRoot);
        if (owner) {
          candidate.waitingFor = owner.identifier;
          continue;
        }
        launchAt = i;
        break;
      }
      if (launchAt === -1) return;
      const next = this.pending.splice(launchAt, 1)[0]!;
      this.launchSpawn(next.ticket, next.stage, next.repoRoot);
    }
  }

  /** The real spawn path (cap already checked). Registers the finish handler. */
  private async doSpawn(ticket: Ticket, stage: string, repoRoot: string): Promise<void> {
    const stageStartedAt = Date.now();
    let spec = this.castFor(ticket, stage);

    // A classed-failure recovery (auth/rate-limit substitution) pinned a one-shot cast override
    // for this ticket-stage — it wins over the ticket's own casting.
    const override = this.castOverrides.get(ticket.id);
    if (override && override.stage === stage) {
      this.castOverrides.delete(ticket.id);
      spec = { ...override.spec, effort: override.spec.effort ?? spec.effort };
    }

    // Crash recovery (issue #20): a restart-interrupted same-stage worker left a persisted
    // session — resume it instead of re-running the whole ticket from a fresh prompt. The hint is
    // consumed here (one attempt); the session belongs to the ORIGINAL harness, so it wins over a
    // conflicting cast (the cast effort is kept — shared vocabulary).
    const hint = this.resumables.get(ticket.id);
    let resumeSessionId = hint && hint.stage === stage ? hint.sessionId : undefined;
    if (hint && resumeSessionId) {
      this.resumables.delete(ticket.id);
      if (hint.harness !== spec.harness) {
        spec = { harness: hint.harness as HarnessSpec["harness"], effort: spec.effort };
      }
      this.logger.info("resuming interrupted worker session after restart", {
        ticket: ticket.identifier,
        stage,
        harness: spec.harness,
      });
    }

    // Preflight the cast harness (issue #17): a dead harness (binary gone, login expired) must
    // produce ONE clear substitution comment, not a wedged ticket. Substituting loses any resume
    // hint (the session belongs to the unhealthy harness) — a fresh start elsewhere beats a wedge.
    const healthy = await this.pickHealthyHarness(ticket, stage, spec);
    if (!healthy) {
      await this.onSpawnFailure(
        ticket,
        stage,
        new Error("no healthy harness available (all preflights failed — check `beckett doctor`)"),
      );
      return; // launchSpawn's finally releases the reservation + pumps
    }
    if (healthy.harness !== spec.harness) {
      resumeSessionId = undefined; // the persisted session belongs to the unhealthy harness
      spec = healthy;
    }

    // v3.1: ensure the ticket's OWN project repo exists before any stage runs — clone
    // `0xbeckett/<slug>` if it's already on GitHub (a continuing project, or Beckett's source for a
    // self-improvement ticket), else `git init` a fresh one. A worker never touches Beckett's live
    // source. A provisioning failure leaves the ticket for a human rather than spawning blind.
    try {
      await this.git.ensureProjectRepo(repoRoot, projectSlug(ticket.project || ticket.identifier));
    } catch (err) {
      this.logger.error("project repo provisioning failed", {
        ticket: ticket.identifier,
        repoRoot,
        error: (err as Error).message,
      });
      await this.onSpawnFailure(
        ticket,
        stage,
        new Error(`could not provision the project repo at \`${repoRoot}\`: ${(err as Error).message}`),
      );
      return; // launchSpawn's finally releases the reservation + pumps
    }

    // Allocate (or reuse) the ticket's OWN worktree, off a freshly-fetched origin/main. A failure
    // here leaves the ticket for a human rather than spawning a worker with nowhere to work.
    let workspace: string;
    try {
      workspace = await this.prepareWorktree(ticket, repoRoot);
    } catch (err) {
      this.logger.error("worktree allocation failed", {
        ticket: ticket.identifier,
        repoRoot,
        error: (err as Error).message,
      });
      await this.onSpawnFailure(
        ticket,
        stage,
        new Error(`could not allocate a worktree under \`${repoRoot}\`: ${(err as Error).message}`),
      );
      return; // launchSpawn's finally releases the reservation + pumps
    }
    const branch = `beckett/${ticket.identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;

    // Capture the diff base the first time a ticket implements: the worktree branches from
    // origin/main, so its HEAD-before-any-work is how a later REVIEW sees the ticket's whole
    // contribution. A git hiccup here must never block the spawn — review falls back to diffing HEAD.
    if (stage === "implement" && !this.baseShaForTicket.has(ticket.id)) {
      try {
        const sha = await this.git.headSha(workspace);
        if (sha) {
          this.baseShaForTicket.set(ticket.id, sha);
          this.persistRuntimeState();
        }
      } catch (err) {
        this.logger.warn("base-sha capture failed; review will diff HEAD", {
          ticket: ticket.identifier,
          error: (err as Error).message,
        });
      }
    }
    const baseRef = this.baseShaForTicket.get(ticket.id) ?? "HEAD";

    // Mirror this worker's granular event stream into the ticket's Discord thread, keyed by the
    // stable ticket identifier so implement/review/rework workers all post to the one thread.
    const onProgress = (ev: WorkerEvent, ctx: { stage: string; workerId: string }) => {
      // Status heartbeat (issue #30): `beckett status` reports how long each worker has been silent.
      this.lastEventAt.set(ticket.id, Date.now());
      this.progress?.event(ticket.identifier, ev, ctx);
    };
    // Held steering (issue #22): comments that arrived while no worker was live become part of
    // this worker's brief — the user's words provably reach the first model turn.
    const steering = this.takeSteers(ticket.id);
    // Review economics (issue #27): hand the reviewer the diff instead of making it burn its
    // first N tool round trips rediscovering it. Best-effort — a git failure just means the
    // reviewer falls back to running the diff itself, exactly as before.
    let reviewDiff: string | undefined;
    if (stage === "review") {
      try {
        reviewDiff = await this.git.readDiff(workspace, baseRef);
      } catch (err) {
        this.logger.warn("review diff pre-read failed (reviewer will diff itself)", {
          ticket: ticket.identifier,
          error: (err as Error).message,
        });
      }
    }
    const spawnArgs = {
      ticket,
      stage,
      harness: spec,
      config: this.config,
      repoRoot,
      workspace,
      branch,
      baseRef,
      onProgress,
      steering,
      reviewDiff,
      logger: this.logger,
    };

    let handle: TicketWorkerHandle;
    try {
      handle = await spawnWorker({ ...spawnArgs, resumeSessionId });
    } catch (err) {
      // A failed RESUME (stale session file, harness drift) must degrade to a fresh worker —
      // never strand the ticket on a recovery optimization.
      if (resumeSessionId) {
        this.logger.warn("session resume failed — falling back to a fresh worker", {
          ticket: ticket.identifier,
          stage,
          error: (err as Error).message,
        });
        try {
          handle = await spawnWorker(spawnArgs);
        } catch (err2) {
          await this.onSpawnFailure(ticket, stage, err2 as Error);
          return; // launchSpawn's finally releases the reservation + pumps
        }
      } else {
        await this.onSpawnFailure(ticket, stage, err as Error);
        return; // launchSpawn's finally releases the reservation + pumps
      }
    }

    // If the ticket was cancelled/reaped DURING the spawn gap, its reservation was dropped from
    // {@link staffing}; discard the freshly-spawned worker rather than register an orphan.
    if (!this.staffing.has(ticket.id)) {
      this.logger.info("ticket no longer staffed mid-spawn — discarding worker", {
        ticket: ticket.identifier,
        stage,
        workerId: handle.id,
      });
      await handle.abort("ticket no longer active");
      await handle.reap();
      return;
    }

    this.workers.set(ticket.id, handle);
    this.liveTickets.set(ticket.id, ticket);
    // Crash-recovery ledger (issue #20): persist this worker's identity so a daemon restart can
    // sweep its orphan and resume its session. Removed on clean finish/cancel/park; kept by the
    // shutdown drain on purpose (the drained session is the thing the next boot resumes).
    this.liveLedger.set(ticket.id, {
      identifier: ticket.identifier,
      stage,
      workerId: handle.id,
      sessionId: handle.sessionId ?? "",
      pid: handle.pid ?? 0,
      repoRoot,
      harness: spec.harness,
      spawnedAt: Date.now(),
    });
    this.persistRuntimeState();
    const spendMeta: SpendStageMeta = {
      harness: spec.harness,
      model: this.modelFor(spec),
      effort: spec.effort ?? this.defaultEffortFor(spec.harness),
      startedAt: stageStartedAt,
    };
    this.spendMetaByWorker.set(handle.id, spendMeta);
    handle.onDone((status, summary) => {
      void this.onWorkerDone(ticket, stage, handle, status, summary, spendMeta);
    });
    handle.onStalled((idleMs, strikes) => {
      void this.onWorkerStalled(ticket, stage, handle, idleMs, strikes).catch((err) =>
        this.logger.warn("stall handling failed", { ticket: ticket.identifier, err: String(err) }),
      );
    });
    // Spawn-gap steers (issue #22): a comment that landed AFTER this worker's prompt was built
    // but BEFORE it registered would otherwise wait for a next stage that may never come — flush
    // it as a nudge now that the worker is live.
    const lateSteers = this.takeSteers(ticket.id);
    if (lateSteers.length > 0) {
      void handle
        .nudge(lateSteers.join("\n\n"))
        .then((accepted) => {
          if (accepted === "dropped") {
            for (const s of lateSteers) this.bufferSteer(ticket, s);
          }
        })
        .catch((err) =>
          this.logger.warn("late-steer flush failed", { ticket: ticket.identifier, err: String(err) }),
        );
    }
    this.logger.info("worker spawned for ticket", {
      ticket: ticket.identifier,
      stage,
      workerId: handle.id,
      harness: spec.harness,
    });
  }

  /**
   * The stall escalation ladder (issue #21). A worker that emits nothing for
   * `supervise.worker_stall_s` gets ONE automated status-check nudge (strike 1); if it stays
   * silent through another full window (strike 2), it is aborted and routed through the normal
   * incomplete/retry machinery — its committed WIP survives and the ticket never wedges a slot
   * until the hard cap. Every step is narrated on the ticket, which the Concierge surfaces to
   * Discord (the dispatcher-comment feed IS the alarm channel).
   */
  private async onWorkerStalled(
    ticket: Ticket,
    stage: string,
    handle: TicketWorkerHandle,
    idleMs: number,
    strikes: number,
  ): Promise<void> {
    if (this.workers.get(ticket.id) !== handle) return; // superseded/reaped — not ours anymore
    if (handle.result) return; // a real finish is already in flight; onDone owns the ticket
    const idleMin = Math.max(1, Math.round(idleMs / 60_000));

    if (strikes <= 1) {
      this.logger.warn("worker stalled — sending status-check nudge (strike 1)", {
        ticket: ticket.identifier,
        stage,
        workerId: handle.id,
        idleMin,
      });
      await handle.nudge(
        `Status check: you have produced no visible activity for ~${idleMin} minute(s). ` +
          `Reply with a one-line status (what you are doing and what, if anything, is blocking ` +
          `you) and continue. If you are stuck on a hung command or prompt, kill it and take a ` +
          `different approach.`,
      );
      await this.postComment(
        ticket.id,
        `The ${stage} worker went quiet (~${idleMin} min with no activity). I sent it a status ` +
          `check; if it stays silent I'll stop it and restart from its committed work.`,
      );
      return;
    }

    this.logger.warn("worker stalled through its status check — aborting for retry (strike 2)", {
      ticket: ticket.identifier,
      stage,
      workerId: handle.id,
      idleMin,
    });
    await handle.abort("stalled: no activity through two stall windows");
    if (handle.result) return; // finish raced the abort; the onDone path owns the outcome
    // Route through the normal finished-with-error machinery: commit WIP, bounded retry
    // (implement) / review-infra retry (review), park on exhaustion — never a wedged slot.
    void this.onWorkerDone(
      ticket,
      stage,
      handle,
      "error",
      `The worker stalled (~${idleMin} minutes with no activity) and did not respond to a ` +
        `status check, so I stopped it.`,
    );
  }

  /**
   * A worker could not be STARTED (spawn/provision failure — issue #17). Never wedge the ticket
   * in a fake `in_progress`: review-stage failures ride the existing review-infra retry; other
   * stages get a bounded, backed-off re-spawn (30s/2m/10m), and on exhaustion the ticket is
   * parked in `todo` with a loud comment — parked tickets cost zero tokens and are never
   * re-staffed until a human moves them back.
   */
  private async onSpawnFailure(ticket: Ticket, stage: string, err: Error): Promise<void> {
    this.logger.error("spawn failed", { ticket: ticket.identifier, stage, error: err.message });

    if (stage === "review") {
      await this.onReviewInfraFailure(ticket, `Could not start the review worker: ${err.message}.`, "");
      return;
    }

    const attempts = (this.implementRetries.get(ticket.id) ?? 0) + 1;
    this.implementRetries.set(ticket.id, attempts);
    this.persistRuntimeState();

    if (attempts <= MAX_IMPLEMENT_RETRIES) {
      const delayMs = SPAWN_RETRY_DELAYS_MS[Math.min(attempts - 1, SPAWN_RETRY_DELAYS_MS.length - 1)]!;
      await this.postComment(
        ticket.id,
        `Could not start the ${stage} worker: ${err.message}\n\nRetrying in ` +
          `${Math.round(delayMs / 1000)}s (attempt ${attempts}/${MAX_IMPLEMENT_RETRIES}).`,
      );
      const timer = setTimeout(() => {
        this.spawnRetryTimers.delete(ticket.id);
        this.spawnGuarded(ticket, stage);
      }, delayMs);
      this.spawnRetryTimers.set(ticket.id, timer);
      return;
    }

    this.implementRetries.delete(ticket.id);
    this.persistRuntimeState();
    await this.advanceTicket(
      ticket,
      "todo",
      `Could not start a ${stage} worker after ${MAX_IMPLEMENT_RETRIES} attempts ` +
        `(${err.message}). Parking this in **todo** — nothing is running and nothing will ` +
        `auto-retry; move it back to **in_progress** once the cause is fixed.`,
    );
    this.logger.warn("spawn retries exhausted — parked ticket", { ticket: ticket.identifier, stage });
  }

  /**
   * Class-specific handling for an implement worker that died on AUTH or RATE_LIMIT (issue #17).
   * First choice: substitute the next enabled + healthy harness (a claude outage must not stall
   * the fleet while a pi/codex login sits idle). Otherwise: auth parks the ticket with the exact
   * login command a human must run (retrying an expired login never succeeds); rate_limit
   * schedules a bounded, backed-off retry on the same harness.
   */
  private async onClassedImplementFailure(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    errorClass: "auth" | "rate_limit",
    summary: string,
    at: string,
  ): Promise<void> {
    const failed = handle.harness as Harness;
    const cause =
      errorClass === "auth"
        ? `**${failed}**'s login looks expired/invalid`
        : `**${failed}** is rate-limited`;

    // First choice: move the work to a healthy harness.
    if (this.preflight) {
      const order = this.config.harness?.fallback_order ?? ["claude", "pi", "codex"];
      for (const candidate of order) {
        if (candidate === failed) continue;
        if (candidate !== "claude" && this.config.harness?.[candidate]?.enabled === false) continue;
        const pf = await this.preflight(candidate);
        if (!pf.ok) continue;
        const attempts = (this.implementRetries.get(ticket.id) ?? 0) + 1;
        this.implementRetries.set(ticket.id, attempts);
        this.persistRuntimeState();
        if (attempts > MAX_IMPLEMENT_RETRIES) break; // fall through to park below
        this.castOverrides.set(ticket.id, { stage: "implement", spec: { harness: candidate } });
        await this.postComment(
          ticket.id,
          `${cause}, so I'm continuing this ticket on **${candidate}** instead (WIP committed${at}, ` +
            `attempt ${attempts}/${MAX_IMPLEMENT_RETRIES}).\n\nWhere it stopped:\n${summary}`,
        );
        this.logger.warn("classed failure — substituting harness", {
          ticket: ticket.identifier,
          errorClass,
          failed,
          substitute: candidate,
        });
        this.spawnGuarded(ticket, "implement");
        return;
      }
    }

    if (errorClass === "auth") {
      this.implementRetries.delete(ticket.id);
      this.persistRuntimeState();
      await this.advanceTicket(
        ticket,
        "todo",
        `${cause} and no other harness is available, so I'm parking this in **todo** — retrying ` +
          `would burn tokens against a closed door. Fix: ${LOGIN_HINTS[failed] ?? `re-auth ${failed}`}, ` +
          `then move the ticket back to **in_progress**. WIP is committed${at}.\n\n${summary}`,
      );
      this.logger.warn("auth failure — parked ticket for re-login", {
        ticket: ticket.identifier,
        harness: failed,
      });
      return;
    }

    // rate_limit with no substitute: bounded retry with real backoff on the same harness.
    const attempts = (this.implementRetries.get(ticket.id) ?? 0) + 1;
    this.implementRetries.set(ticket.id, attempts);
    this.persistRuntimeState();
    if (attempts <= MAX_IMPLEMENT_RETRIES) {
      const delayMs = SPAWN_RETRY_DELAYS_MS[Math.min(attempts - 1, SPAWN_RETRY_DELAYS_MS.length - 1)]!;
      await this.postComment(
        ticket.id,
        `${cause} — backing off ${Math.round(delayMs / 1000)}s before retrying (attempt ` +
          `${attempts}/${MAX_IMPLEMENT_RETRIES}). WIP committed${at}.`,
      );
      const timer = setTimeout(() => {
        this.spawnRetryTimers.delete(ticket.id);
        this.spawnGuarded(ticket, "implement");
      }, delayMs);
      this.spawnRetryTimers.set(ticket.id, timer);
      return;
    }
    this.implementRetries.delete(ticket.id);
    this.persistRuntimeState();
    await this.advanceTicket(
      ticket,
      "todo",
      `${cause} and it hasn't cleared after ${MAX_IMPLEMENT_RETRIES} backed-off retries. Parking ` +
        `in **todo**; move it back to **in_progress** when capacity returns. WIP committed${at}.`,
    );
    this.logger.warn("rate-limit retries exhausted — parked ticket", { ticket: ticket.identifier });
  }

  /** Cancel a pending backed-off spawn retry (ticket cancelled/parked/done). */
  private cancelSpawnRetry(ticketId: string): void {
    const timer = this.spawnRetryTimers.get(ticketId);
    if (timer) {
      clearTimeout(timer);
      this.spawnRetryTimers.delete(ticketId);
    }
  }

  /**
   * Health-check the cast harness and, when it fails preflight, walk `harness.fallback_order`
   * for the first enabled + healthy substitute (issue #17). Substitution posts ONE clear ticket
   * comment naming the cause. Returns null when no harness is usable. Without an injected
   * preflight (tests), every harness is presumed healthy.
   */
  private async pickHealthyHarness(
    ticket: Ticket,
    stage: string,
    spec: HarnessSpec,
  ): Promise<HarnessSpec | null> {
    if (!this.preflight) return spec;

    const cast = await this.preflight(spec.harness);
    if (cast.ok) return spec;

    const order = this.config.harness?.fallback_order ?? ["claude", "pi", "codex"];
    for (const candidate of order) {
      if (candidate === spec.harness) continue;
      if (candidate !== "claude" && this.config.harness?.[candidate]?.enabled === false) continue;
      const pf = await this.preflight(candidate);
      if (!pf.ok) continue;
      this.logger.warn("cast harness failed preflight — substituting", {
        ticket: ticket.identifier,
        stage,
        cast: spec.harness,
        substitute: candidate,
        problems: cast.problems,
      });
      await this.postComment(
        ticket.id,
        `**${spec.harness}** is unavailable (${cast.problems.join("; ")}) — running the ` +
          `${stage} stage on **${candidate}** instead.`,
      );
      // The cast model is harness-specific — drop it; the shared effort vocabulary survives.
      return { harness: candidate, effort: spec.effort };
    }

    this.logger.error("no healthy harness for spawn", {
      ticket: ticket.identifier,
      stage,
      cast: spec.harness,
      problems: cast.problems,
    });
    return null;
  }

  /**
   * Resolve the casting entry for a stage, applying defaults (docs/V3.md §5). A cast naming a
   * harness that is disabled in config (`harness.<h>.enabled = false`) falls back to claude —
   * the enabled keys are real switches, not decoration. The cast's model is dropped on fallback
   * (model ids are harness-specific); its effort survives (shared vocabulary).
   */
  private castFor(ticket: Ticket, stage: string): HarnessSpec {
    const explicit = ticket.casting[stage];
    let spec: HarnessSpec =
      explicit ??
      (stage === "design"
        ? { harness: "claude", model: "claude-opus-4-8", effort: "high" }
        : stage === "design_check"
          // Separate, inexpensive model: it must not mark the design author's own homework.
          ? { harness: "claude", model: "claude-haiku-4-5", effort: "low" }
          : stage === "review"
            ? { harness: "claude", model: this.config.models.reviewer, effort: this.reviewEffortFor(ticket) }
            : { harness: "claude" });
    // An explicit review cast that names no effort still gets the SCALED default (issue #27) —
    // otherwise it silently falls through to the harness default (xhigh), the priciest tier.
    if (stage === "review" && explicit && !explicit.effort) {
      spec = { ...explicit, effort: this.reviewEffortFor(ticket) };
    }
    if (spec.harness !== "claude" && this.config.harness?.[spec.harness]?.enabled === false) {
      this.logger.warn("cast harness is disabled in config — falling back to claude", {
        ticket: ticket.identifier,
        stage,
        cast: spec.harness,
      });
      return { harness: "claude", effort: spec.effort };
    }
    return spec;
  }

  /**
   * Review effort scaled from the implement cast (issue #27): a `low`-effort implement doesn't
   * need an `xhigh` review. Defaults to `high` — the review's job is judging a diff against
   * criteria, not re-deriving the implementation.
   */
  private reviewEffortFor(ticket: Ticket): NonNullable<HarnessSpec["effort"]> {
    switch (ticket.casting.implement?.effort) {
      case "low":
        return "medium";
      case "xhigh":
        return "xhigh";
      default:
        return "high";
    }
  }

  private defaultEffortFor(harness: HarnessSpec["harness"]): string {
    switch (harness) {
      case "claude": return this.config.harness.claude.default_effort;
      case "codex": return this.config.harness.codex.default_effort;
      case "pi": return this.config.harness.pi.thinking;
    }
  }

  private modelFor(spec: HarnessSpec): string {
    if (spec.model) return spec.model;
    switch (spec.harness) {
      case "claude": return this.config.harness.claude.default_model;
      case "codex": return this.config.harness.codex.default_model;
      case "pi": return this.config.harness.pi.default_model;
    }
  }

  /** Persist a stage's telemetry without allowing observability to affect dispatch. */
  private recordSpend(
    ticket: Ticket,
    stage: string,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    meta: SpendStageMeta | undefined,
    forcedOutcome?: SpendOutcome,
  ): void {
    if ((stage !== "implement" && stage !== "review") || !meta || typeof handle.telemetry !== "function") return;
    try {
      const t = handle.telemetry();
      const signal = status === "success" ? parseDoneSignal(handle.result?.structured) : null;
      const outcome: SpendOutcome = forcedOutcome ?? (status !== "success"
        ? "failed"
        : stage === "review" && signal?.status !== "complete" ? "rework"
        : stage === "implement" && (signal?.status === "blocked" || signal?.status === "partial") ? "rework"
        : "done");
      appendSpendRecord(this.spendLedgerPath, {
        ticketId: ticket.identifier,
        project: ticket.project ?? null,
        stage,
        harness: meta.harness,
        model: meta.model,
        effort: meta.effort,
        turns: t.turns,
        toolCalls: t.toolCalls,
        tokensIn: t.tokens.input + t.tokens.cacheRead + t.tokens.cacheCreate,
        tokensOut: t.tokens.output,
        costUsd: t.usdEstimate ?? null,
        durationMs: Math.max(0, Date.now() - meta.startedAt),
        outcome,
        reviewTier: this.reviewTierFor(ticket),
        ts: new Date().toISOString(),
      });
    } catch (err) {
      // The ledger is telemetry only: permission/disk/driver issues never alter casting or routing.
      this.logger.warn("spend ledger append failed", { ticket: ticket.identifier, stage, error: String(err) });
    }
  }

  /**
   * One-line spend telemetry for a finished worker, e.g. `12 turns · 34 tool calls · 1.2M tokens
   * · ~$1.87`. The $ figure appears only when the driver has real/estimable cost data (claude's
   * stream cost, pi's usage.cost, codex's price table) — never a made-up number. Best-effort:
   * a telemetry failure yields "" rather than disturbing finish handling.
   */
  private spendLine(handle: TicketWorkerHandle): string {
    try {
      const t = handle.telemetry();
      if (t.turns === 0 && t.toolCalls === 0) return "";
      const total = t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheCreate;
      const tokens =
        total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : `${Math.round(total / 1_000)}k`;
      const cost = t.usdEstimate != null ? ` · ~$${t.usdEstimate.toFixed(2)}` : "";
      return `_${t.turns} turns · ${t.toolCalls} tool calls · ${tokens} tokens${cost}_`;
    } catch {
      return "";
    }
  }

  // ── finish handling — advance the ticket + post a summary ────────────────────────────────

  private async onWorkerDone(
    ticket: Ticket,
    stage: string,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
    spendMeta?: SpendStageMeta,
  ): Promise<void> {
    this.recordSpend(ticket, stage, handle, status, spendMeta ?? this.spendMetaByWorker.get(handle.id));
    this.spendMetaByWorker.delete(handle.id);
    // Free the slot first so a queued spawn can take it.
    if (this.workers.get(ticket.id) === handle) this.workers.delete(ticket.id);
    this.liveTickets.delete(ticket.id);
    // A cleanly-finished worker leaves the crash-recovery ledger: there is nothing to sweep or
    // resume for it (the NEXT stage gets a fresh session on purpose).
    if (this.liveLedger.delete(ticket.id)) this.persistRuntimeState();

    // Steering the driver buffered but never applied (issue #22): carry the user's words into
    // the next stage (retry / review / rework prompt) instead of letting them die here.
    const unapplied = handle.result?.unappliedNudges ?? [];
    if (unapplied.length > 0) {
      for (const s of unapplied) this.bufferSteer(ticket, s);
      await this.postComment(
        ticket.id,
        `The worker finished before applying ${unapplied.length === 1 ? "a steering note" : `${unapplied.length} steering notes`} — carrying ${unapplied.length === 1 ? "it" : "them"} into the next stage's brief.`,
      );
    }

    // Ride the spend counters into every downstream finish comment — the cheapest possible
    // fleet-spend observability (turns/tools/tokens/$ per stage, straight off the driver).
    const spend = this.spendLine(handle);
    if (spend) summary = summary ? `${summary}\n\n${spend}` : spend;

    try {
      if (stage === "design") {
        await this.onDesignDone(ticket, handle, status, summary);
      } else if (stage === "design_check") {
        await this.onDesignCheckDone(ticket, handle, status, summary);
      } else if (stage === "implement") {
        await this.onImplementDone(ticket, handle, status, summary);
      } else if (stage === "review") {
        await this.onReviewDone(ticket, handle, status, summary);
      } else {
        await this.postComment(ticket.id, `${stage} ${status}.\n\n${summary}`);
      }
    } catch (err) {
      this.logger.error("post-finish handling failed", {
        ticket: ticket.identifier,
        stage,
        error: (err as Error).message,
      });
    } finally {
      await handle.reap();
      this.releaseRepo(ticket.id);
      this.pump();
    }
  }

  /**
   * Design is a real worker stage, followed by an independent cheap completeness pass. The
   * checker gets its own model/session so the author cannot approve its own document.
   */
  private async onDesignDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    const sha = await this.commitWip(ticket, handle);
    const at = sha ? ` (committed as \`${sha.slice(0, 9)}\`)` : "";
    await this.postComment(
      ticket.id,
      status === "success"
        ? `Design draft complete${at}; running an independent completeness check.`
        : `Design worker ended early${at}; running the completeness check on the saved draft.`,
    );
    this.spawnGuarded(ticket, "design_check");
  }

  private async onDesignCheckDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    const signal = status === "success" ? parseDoneSignal(handle.result?.structured) : null;
    if (signal?.status === "complete") {
      this.designCycles.delete(ticket.id);
      this.persistRuntimeState();
      await this.advanceTicket(
        ticket,
        "design_review",
        `Design completeness check passed. Design document: \`docs/design/${ticket.identifier.toLowerCase()}.md\`\n\n` +
          `**Here's the design — good to build?** Reply with approval to start implementation, or ` +
          `send changes and move this ticket back to **Design**.\n\n${summary}`,
      );
      return;
    }

    const gaps = signal ? doneSignalSummary(signal, summary) : summary || "The completeness checker did not return a valid verdict.";
    const cycle = (this.designCycles.get(ticket.id) ?? 0) + 1;
    this.designCycles.set(ticket.id, cycle);
    this.persistRuntimeState();
    if (cycle < MAX_DESIGN_CYCLES) {
      await this.advanceTicket(
        ticket,
        "design",
        `Design completeness check found gaps; returning to **Design** (pass ${cycle}/${MAX_DESIGN_CYCLES}). ` +
          `Please address these before the human review:\n\n${gaps}`,
      );
      return;
    }

    this.designCycles.delete(ticket.id);
    this.persistRuntimeState();
    await this.advanceTicket(
      ticket,
      "design_review",
      `⚠ Design completeness check still flagged gaps after ${MAX_DESIGN_CYCLES} passes:\n\n${gaps}\n\n` +
        `Design document: \`docs/design/${ticket.identifier.toLowerCase()}.md\`\n\n` +
        `**Here's the design — good to build?** Please approve it, or send changes and move this ticket back to **Design**.`,
    );
  }

  private async onImplementDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    if (status !== "success") {
      await this.onImplementIncomplete(ticket, handle, summary);
      return;
    }

    const signal = parseDoneSignal(handle.result?.structured);
    if (signal && (signal.status === "blocked" || signal.status === "partial")) {
      await this.onImplementReportedIncomplete(ticket, handle, signal, summary);
      return;
    }

    // Capture any uncommitted work the worker left in the checkout so review/rework (and the
    // human) can see it. The worker may have committed already; this is the safety net.
    let committedContribution = false;
    try {
      const commit = await this.git.commitWorktree(
        handle.workspace,
        `beckett: ${ticket.identifier} implement (${handle.workerId})`,
      );
      if (commit.committed) {
        committedContribution = true;
        this.logger.info("committed implementation", { ticket: ticket.identifier, sha: commit.sha });
      }
    } catch (err) {
      this.logger.warn("commit of implementation failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
    }

    // v3.1 effort-scaled review. `self` (low/medium-risk work) → the worker self-verified inline,
    // so go straight to done in ONE pass — no separate cold reviewer, no relay. `fresh` →
    // a separate adversarial reviewer (the in_review stage), as before. Done tickets promote DAG
    // dependents immediately here; the later poller state_changed(done) is only a restart backstop.
    if (this.reviewTierFor(ticket) === "self") {
      if (!(await this.hasTicketContribution(ticket, handle, committedContribution))) {
        await this.advanceTicket(
          ticket,
          "in_review",
          `Self-review withheld → **in_review** because the implement worker finished with no diff against the ticket base.\n\n${summary}`,
        );
        this.logger.warn("self-review withheld: zero-diff implementation", {
          ticket: ticket.identifier,
        });
        return;
      }
      const done = await this.finishTicketAsDone(ticket, "Self-reviewed → **done** (one pass).", summary);
      if (done) this.logger.info("ticket self-reviewed → done", { ticket: ticket.identifier });
      return;
    }

    await this.advanceTicket(ticket, "in_review", `Implementation complete → **in_review**.\n\n${summary}`);
    this.logger.info("ticket advanced to in_review", { ticket: ticket.identifier });
  }

  private async onImplementReportedIncomplete(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    signal: DoneSignal,
    summary: string,
  ): Promise<void> {
    const reason = doneSignalSummary(signal, summary);
    if (this.reviewTierFor(ticket) === "self") {
      const sha = await this.commitWip(ticket, handle);
      const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";
      await this.advanceTicket(
        ticket,
        "in_review",
        `The implement worker reported **${signal.status}**, so self-review is disabled and this ` +
          `is going to a fresh review instead of being marked done. I committed any WIP${at}.\n\n${reason}`,
      );
      this.logger.warn("self-tier implement reported incomplete — sent to review", {
        ticket: ticket.identifier,
        status: signal.status,
      });
      return;
    }

    await this.onImplementIncomplete(ticket, handle, reason);
  }

  private async hasTicketContribution(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    committedContribution: boolean,
  ): Promise<boolean> {
    if (committedContribution) return true;
    try {
      return await this.git.hasDiffSince(handle.workspace, this.baseShaForTicket.get(ticket.id) ?? null);
    } catch (err) {
      this.logger.warn("could not verify implementation diff; withholding self-review", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * An implement worker ended WITHOUT a clean finish — it tripped the generous backstop wall-clock
   * cap, crashed, or the harness errored. The fix for the OPS-50 "silent wedge": never leave the
   * ticket sitting in in_progress with nothing running. We (1) commit whatever WIP is in the
   * checkout so it's never lost, then (2) either retry — re-spawn an implement worker that continues
   * from that committed WIP (bounded by {@link MAX_IMPLEMENT_RETRIES}) — or, once retries are spent,
   * push the WIP to GitHub if we can and return the ticket to a ready state (`todo`) with a loud
   * comment so a human can pick it up. Both paths post a status comment saying what happened and
   * where the worker stopped.
   */
  private async onImplementIncomplete(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    summary: string,
  ): Promise<void> {
    const timedOut = handle.result?.timedOut === true;
    const reason = timedOut
      ? `hit the ${Math.round(hardCapSeconds(this.config) / 60)}-minute safety cap`
      : `stopped without finishing (crash or harness error)`;

    // 1. Safety-net commit so the WIP survives for the retry AND the human (the worker may have
    //    already committed; this captures anything still in the working tree).
    const sha = await this.commitWip(ticket, handle);
    const at = sha ? ` at \`${sha.slice(0, 9)}\`` : "";

    // Failure taxonomy (issue #17): auth and rate-limit deaths get a class-specific response —
    // a blind instant retry either burns tokens against a closed door (auth never self-heals)
    // or hammers the very limit that killed the worker.
    const errorClass = handle.result?.errorClass;
    if (errorClass === "auth" || errorClass === "rate_limit") {
      await this.onClassedImplementFailure(ticket, handle, errorClass, summary, at);
      return;
    }

    // 2. Bound the auto-retry so a persistently-failing ticket can't churn forever.
    const attempts = (this.implementRetries.get(ticket.id) ?? 0) + 1;
    this.implementRetries.set(ticket.id, attempts);
    this.persistRuntimeState();

    if (attempts <= MAX_IMPLEMENT_RETRIES) {
      await this.postComment(
        ticket.id,
        `The worker ${reason} before finishing. I committed its work-in-progress${at} and am ` +
          `retrying (attempt ${attempts}/${MAX_IMPLEMENT_RETRIES}), continuing from the committed ` +
          `work.\n\nWhere it stopped:\n${summary}`,
      );
      this.logger.warn("implement incomplete — retrying", {
        ticket: ticket.identifier,
        attempts,
        timedOut,
      });
      // The old worker's whole process tree is already dead (the driver group-killed it before
      // signalling done), so a fresh worker can safely edit the same checkout. The ticket stays in
      // in_progress but is once again ACTIVELY staffed — not silently wedged.
      this.spawnGuarded(ticket, "implement");
      return;
    }

    // 3. Retries exhausted. Never leave it stuck in in_progress: push the WIP so a human has it, then
    //    return the ticket to a ready state (`todo`) with a loud comment.
    this.implementRetries.delete(ticket.id);
    this.persistRuntimeState();
    const pub = await this.publishProject(ticket);
    const link =
      pub.status === "published"
        ? pub.kind === "pr"
          ? `\n\nWIP pushed as a PR: ${pub.prUrl ?? pub.url}`
          : `\n\nWIP pushed: ${pub.url}`
        : "";
    try {
      await this.advanceTicket(
        ticket,
        "todo",
        `The worker ${reason} again — that's ${MAX_IMPLEMENT_RETRIES} retries with no clean finish, ` +
          `so I'm stopping automatic retries and moving this back to **todo** so it isn't stuck in ` +
          `progress. Its WIP is committed${at}.${link}\n\nWhere it stopped:\n${summary}`,
      );
      this.logger.warn("implement retries exhausted — returned ticket to todo", {
        ticket: ticket.identifier,
      });
    } catch (err) {
      this.logger.warn("could not return ticket to todo after exhausted retries", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Commit whatever is in a ticket's checkout as a WIP snapshot, best-effort. Returns the new commit
   * sha, or null when there was nothing to commit (or the commit failed) — never throws.
   */
  private async commitWip(ticket: Ticket, handle: TicketWorkerHandle): Promise<string | null> {
    try {
      const commit = await this.git.commitWorktree(
        handle.workspace,
        `beckett: ${ticket.identifier} WIP (${handle.workerId})`,
      );
      if (commit.committed) {
        this.logger.info("committed WIP", { ticket: ticket.identifier, sha: commit.sha });
        return commit.sha ?? null;
      }
      return null;
    } catch (err) {
      this.logger.warn("WIP commit failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * The review gate for a ticket (v3.1). An explicit `reviewTier` on the implement cast wins;
   * otherwise it derives from the CAST effort: low/medium → `self` (one-pass, the worker
   * self-verifies inline), everything else (high/xhigh, or no cast) → `fresh` (separate
   * adversarial reviewer). Note this reads the *cast* effort, not the resolved worker effort —
   * an un-cast ticket defaults to a full fresh review (the safe, pre-v3.1 behavior).
   */
  private reviewTierFor(ticket: Ticket): "self" | "fresh" {
    const impl = this.castFor(ticket, "implement");
    if (impl.reviewTier) return impl.reviewTier;
    return impl.effort === "low" || impl.effort === "medium" ? "self" : "fresh";
  }

  /**
   * Publish a done ticket's checkout to GitHub and report the outcome. `skipped` when no `publishRepo`
   * was injected (tests / no PAT) — there's nothing to gate on, so the caller still marks it done.
   * `published` carries HOW it shipped (a repo push vs. a PR needing a human merge) so `done` wording
   * stays honest. `failed` is the load-bearing case: the caller must NOT mark the ticket done (a
   * done ticket whose work never left the box is the false-done this fixes — see OPS-30).
   */
  private async publishProject(ticket: Ticket): Promise<PublishOutcome> {
    if (!this.publishRepo) return { status: "skipped" };
    const slug = projectSlug(ticket.project || ticket.identifier);
    // Publish FROM the ticket's worktree (its work lives on `beckett/<ticket>`, not repoRoot's
    // main). Because that tree was cut from a fresh origin/main, the push/rebase is clean — this
    // is precisely what removes the stale-base conflict that stranded OPS-59/61.
    const repoRoot = this.workspaceByTicket.get(ticket.id) ?? this.resolveRepoRoot(ticket);
    try {
      const r = await this.publishRepo({ slug, repoRoot, description: ticket.title, ticket: ticket.identifier });
      this.logger.info("project published to github", { ticket: ticket.identifier, url: r.url, kind: r.kind });
      return { status: "published", url: r.url, kind: r.kind, prUrl: r.prUrl };
    } catch (err) {
      this.logger.warn("github publish failed", {
        ticket: ticket.identifier,
        error: (err as Error).message,
      });
      return { status: "failed", error: (err as Error).message };
    }
  }

  private async onReviewDone(
    ticket: Ticket,
    handle: TicketWorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    if (status !== "success") {
      await this.onReviewInfraFailure(ticket, `Reviewer exited with ${status}.`, summary);
      return;
    }

    const signal = parseDoneSignal(handle.result?.structured);
    if (!signal) {
      await this.onReviewInfraFailure(
        ticket,
        "Reviewer finished without a schema-valid structured verdict.",
        summary,
      );
      return;
    }

    this.reviewInfraRetries.delete(ticket.id);
    this.persistRuntimeState();
    if (signal.status === "complete") {
      const done = await this.finishTicketAsDone(ticket, "Review passed → **done**.", summary);
      if (done) this.logger.info("ticket advanced to done", { ticket: ticket.identifier });
      return;
    }

    // Review failed — bound the implement↔review loop so it can't churn forever.
    const cycles = (this.reworkCount.get(ticket.id) ?? 0) + 1;
    this.reworkCount.set(ticket.id, cycles);
    this.persistRuntimeState();
    if (cycles >= MAX_REWORK_CYCLES) {
      await this.postComment(
        ticket.id,
        `Review found issues, and this is rework cycle ${cycles}/${MAX_REWORK_CYCLES} — stopping ` +
          `automatic rework and leaving this in **in_review** for a human to take over.\n\n${summary}`,
      );
      this.reworkCount.delete(ticket.id);
      this.persistRuntimeState();
      this.logger.warn("rework cap reached — leaving for human", {
        ticket: ticket.identifier,
        cycles,
      });
      return; // no setState → no new event → loop stops, ticket awaits a human
    }

    await this.advanceTicket(
      ticket,
      "in_progress",
      `Review found issues → back to **in_progress** for re-work (cycle ${cycles}/${MAX_REWORK_CYCLES}).\n\n${summary}`,
    );
    this.logger.info("ticket sent back to in_progress (review fail)", {
      ticket: ticket.identifier,
      cycle: cycles,
    });
  }

  private async onReviewInfraFailure(ticket: Ticket, reason: string, summary: string): Promise<void> {
    const attempts = (this.reviewInfraRetries.get(ticket.id) ?? 0) + 1;
    this.reviewInfraRetries.set(ticket.id, attempts);
    this.persistRuntimeState();

    if (attempts <= MAX_REVIEW_INFRA_RETRIES) {
      await this.postComment(
        ticket.id,
        `${reason} Retrying the review gate (attempt ${attempts}/${MAX_REVIEW_INFRA_RETRIES}); ` +
          `this does not count as a rework cycle.\n\n${summary}`,
      );
      this.logger.warn("review infra/schema failure — retrying review", {
        ticket: ticket.identifier,
        attempts,
        reason,
      });
      this.spawnGuarded(ticket, "review");
      return;
    }

    this.reviewInfraRetries.delete(ticket.id);
    this.persistRuntimeState();
    await this.postComment(
      ticket.id,
      `${reason} Review still did not produce a reliable verdict after ${MAX_REVIEW_INFRA_RETRIES} ` +
        `retry, so I'm leaving this in **in_review** for a human instead of marking it done or ` +
        `sending it back as failed work.\n\n${summary}`,
    );
    this.logger.warn("review infra/schema retries exhausted — leaving for human", {
      ticket: ticket.identifier,
      reason,
    });
  }

  /**
   * Publish FIRST, then mark done — publish success now gates the done transition (and DAG promotion).
   * This reverses the old "done before best-effort publish" ordering: that let a publish failure slip
   * through as a green "done" while nothing shipped (the false-done, OPS-30). On failure the ticket is
   * Parked in `todo` with a loud "needs a courier" comment and dependents are NOT promoted. That
   * keeps the ticket from being re-staffed on restart while still refusing to report `done` for work
   * that did not leave the box. DAG dependents build from the local `~/Projects/<slug>` checkout, so
   * a PR-up-but-unmerged ticket doesn't starve them.
   */
  private async finishTicketAsDone(
    ticket: Ticket,
    messagePrefix: string,
    summary: string,
  ): Promise<boolean> {
    // DAG promotion does NOT wait for GitHub (issue #33): dependents build from the LOCAL
    // checkout (documented invariant above), so a 2–8s publish — or a failed one — must not
    // stall the wave. Only the `done` LABEL stays publish-gated (the OPS-30 false-done fix).
    await this.promoteDependents(ticket, { assumeDone: true });

    const pub = await this.publishProject(ticket);
    if (pub.status === "failed") {
      await this.advanceTicket(
        ticket,
        "todo",
        `The work is complete, but I couldn't publish it to GitHub (${pub.error}). It's committed ` +
          `locally in \`${this.resolveRepoRoot(ticket)}\` — moving this ticket to **todo** for a ` +
          `human/courier to push or PR. I'm NOT marking it done, so it isn't lost, and I'm parking ` +
          `it so no worker keeps burning tokens.\n\n${summary}`,
      );
      this.logger.warn("publish failed — parked ticket for courier", { ticket: ticket.identifier });
      return false; // no setState(done) — the work isn't shipped (dependents build locally)
    }

    // Honest wording: a PR still needs the human's merge; a direct push is actually shipped.
    const link =
      pub.status === "published"
        ? pub.kind === "pr"
          ? `\n\nPR opened (needs your merge): ${pub.prUrl ?? pub.url}`
          : `\n\nShipped: ${pub.url}`
        : "";
    // promoteDependents stays on the durable op too: promotion already ran above (the latency
    // win), but it's idempotent (promoted dependents are in_progress → skipped), and keeping it
    // on the outbox op means a crash-replayed done still promotes if the early pass was cut short.
    const advanced = await this.advanceTicket(ticket, "done", `${messagePrefix}${link}\n\n${summary}`, {
      promoteDependents: true,
    });
    // Shipped → the worktree has served its purpose; tear it down (best-effort). Only on a real
    // `done`: a park-to-todo (publish failed / retries exhausted) KEEPS the tree so a human/courier
    // can recover the committed work.
    if (advanced) await this.disposeWorktree(ticket.id);
    return advanced;
  }

  // ── dependency promotion (the `beckett plan` DAG) ────────────────────────────────────────

  /**
   * When a ticket reaches `done`, promote any dependent whose blockers are ALL now `done` from its
   * held `backlog`/`todo` slot to `in_progress` (which staffs it). The DAG lives entirely in Plane
   * (each ticket's ```beckett-deps``` block), so this is stateless and restart-proof: we re-read
   * the board and recompute readiness rather than track edges in memory. A dependent with a still
   * unresolved blocker (or a cancelled one) is left held and logged — never force-started.
   */
  private async promoteDependents(doneTicket: Ticket, opts: { assumeDone?: boolean } = {}): Promise<void> {
    let all: Ticket[];
    try {
      all = await this.listAllIssues();
    } catch (err) {
      this.logger.warn("promote: listIssues failed — dependents not advanced", {
        ticket: doneTicket.identifier,
        error: (err as Error).message,
      });
      return;
    }
    const stateByIdent = new Map(all.map((t) => [t.identifier, t.state]));
    // Finish-path reordering (issue #33): promotion now runs BEFORE the publish + done write, so
    // the finishing ticket still reads as in_review on the board — treat it as done for readiness.
    if (opts.assumeDone) stateByIdent.set(doneTicket.identifier, "done");

    for (const t of all) {
      if (!t.blockedBy.includes(doneTicket.identifier)) continue; // not waiting on this ticket
      if (t.state !== "backlog" && t.state !== "todo") continue; // already running/terminal — leave it
      const unresolved = t.blockedBy.filter((id) => stateByIdent.get(id) !== "done");
      if (unresolved.length > 0) {
        this.logger.info("dependent still blocked — leaving held", {
          ticket: t.identifier,
          waitingOn: unresolved,
        });
        continue;
      }
      this.logger.info("promoting unblocked dependent → in_progress", {
        ticket: t.identifier,
        after: doneTicket.identifier,
      });
      try {
        await this.clientForTicket(t).setState(t.id, "in_progress");
        await this.postComment(
          t.id,
          `All blockers done (${t.blockedBy.join(", ")}) → starting now.`,
        );
      } catch (err) {
        this.logger.warn("promote: setState failed", {
          ticket: t.identifier,
          error: (err as Error).message,
        });
      }
    }
  }

  private async advanceTicket(
    ticket: Ticket,
    state: TicketState,
    comment: string,
    opts: { promoteDependents?: boolean } = {},
  ): Promise<boolean> {
    // Any dispatcher-driven move out of a running state invalidates a scheduled backed-off
    // respawn — a timer firing on a parked/done ticket would staff work nobody asked for.
    if (state !== "design" && state !== "in_progress" && state !== "in_review") this.cancelSpawnRetry(ticket.id);
    const op: AdvanceOperation = {
      id: randomUUID(),
      ticketId: ticket.id,
      projectId: ticket.projectId,
      state,
      comment,
      ...(opts.promoteDependents ? { promoteDependents: true } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      await this.applyAdvance(op);
      // A dispatcher-driven move INTO a running state must staff its own worker here (issue #33
      // regression): applyAdvance's instant-milestone path (onAdvance → poller.observe) syncs the
      // poll snapshot so the poller will NOT re-emit this transition, which means the
      // `state_changed` echo that onStateChanged used to turn into a spawn never arrives. External
      // / human / promoteDependents moves still flow client.setState → poller → onStateChanged, so
      // those spawn as before; spawnGuarded's isStaffed dedup makes a double-trigger a no-op, and a
      // still-held repo (finishing worker not yet reaped) just queues the spawn until pump().
      if (state === "design" && this.isIntTicket(ticket)) this.spawnGuarded(ticket, "design");
      else if (state === "in_review") this.spawnGuarded(ticket, "review");
      else if (state === "in_progress") this.spawnGuarded(ticket, "implement");
      return true;
    } catch (err) {
      if (this.advanceOutbox) {
        this.advanceOutbox.append(op);
        return false;
      }
      throw err;
    }
  }

  private async applyAdvance(op: AdvanceOperation): Promise<void> {
    const state = op.state as TicketState;
    const client = this.clientForTicketId(op.ticketId, op.projectId);
    const current = await client.getIssue?.(op.ticketId);
    this.rememberTicket(current);
    if (current && this.humanTerminalMoveWins(current, state)) {
      this.logger.warn("skipping queued Plane advance because ticket is terminal", {
        ticket: current.identifier,
        current: current.state,
        requested: state,
      });
      return;
    }
    await client.setState(op.ticketId, state);
    await this.addMarkedComment(op.ticketId, op.comment, op.projectId ?? current?.projectId);
    // Instant milestone path (issue #33): hand the transition to v4-main NOW, in the exact shape
    // the poller would emit ≤5s later. Best-effort — a throwing listener must not fail the advance.
    if (this.onAdvance && current) {
      try {
        this.onAdvance({ kind: "state_changed", ticket: { ...current, state }, from: current.state, to: state });
      } catch (err) {
        this.logger.warn("onAdvance listener failed (ignored)", { error: (err as Error).message });
      }
    }
    if (op.promoteDependents) {
      let doneTicket = (await client.getIssue?.(op.ticketId)) ?? current;
      if (!doneTicket) {
        const all = await this.listAllIssues();
        doneTicket = all.find((t) => t.id === op.ticketId);
      }
      this.rememberTicket(doneTicket);
      if (doneTicket) await this.promoteDependents(doneTicket);
    }
    if (state === "done") this.clearTicketMemory(op.ticketId);
  }

  private humanTerminalMoveWins(current: Ticket, requested: TicketState): boolean {
    if (current.state === requested) return false;
    return current.state === "cancelled" || current.state === "done";
  }

  private clearTicketMemory(ticketId: string): void {
    this.cancelSpawnRetry(ticketId);
    this.castOverrides.delete(ticketId);
    this.baseShaForTicket.delete(ticketId);
    this.reworkCount.delete(ticketId);
    this.implementRetries.delete(ticketId);
    this.reviewInfraRetries.delete(ticketId);
    this.designCycles.delete(ticketId);
    this.liveTickets.delete(ticketId);
    this.liveLedger.delete(ticketId);
    this.resumables.delete(ticketId);
    this.persistRuntimeState();
  }

  // ── reaping + comments ───────────────────────────────────────────────────────────────

  /** Reap any live worker for a ticket (terminal-state cleanup). */
  private async reapTicket(ticketId: string, reason: string): Promise<void> {
    const handle = this.workers.get(ticketId);
    this.clearTicketMemory(ticketId);
    this.staffing.delete(ticketId); // drop any mid-spawn reservation so doSpawn discards it
    this.dropPending(ticketId);
    this.releaseRepo(ticketId);
    if (!handle) return;
    this.workers.delete(ticketId);
    this.logger.info("reaping worker", { ticketId, workerId: handle.id, reason });
    await handle.abort(reason);
    await handle.reap();
    this.pump();
  }

  private dropPending(ticketId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.ticket.id === ticketId) this.pending.splice(i, 1);
    }
  }

  private releaseRepo(ticketId: string): void {
    const repoRoot = this.repoByTicket.get(ticketId);
    if (!repoRoot) return;
    const owner = this.repoOwners.get(repoRoot);
    if (owner?.ticketId === ticketId) this.repoOwners.delete(repoRoot);
    this.repoByTicket.delete(ticketId);
  }

  private refreshRepoWaiters(repoRoot: string, waitingFor: string): void {
    for (const pending of this.pending) {
      if (pending.repoRoot === repoRoot) pending.waitingFor = waitingFor;
    }
  }

  /** Post a dispatcher comment, tagged with the bot marker so it is never read back as steering. */
  private async postComment(ticketId: string, body: string): Promise<void> {
    try {
      await this.addMarkedComment(ticketId, body);
    } catch (err) {
      this.logger.warn("addComment failed", { ticketId, error: (err as Error).message });
    }
  }

  private async addMarkedComment(ticketId: string, body: string, projectId?: string): Promise<void> {
    const posted = await this.clientForTicketId(ticketId, projectId).addComment(ticketId, `${BECKETT_COMMENT_MARKER}\n${body}`);
    // Record the id so we recognise our own comment even if Plane mangles the HTML marker.
    if (posted?.id) this.ownCommentIds.add(posted.id);
  }

  /**
   * True if a comment was authored by Beckett itself. Primary signal is the comment id we
   * recorded when we posted it; the HTML marker is a restart-surviving fallback (the id set is
   * in-memory). Either match means "don't treat this as a human steering nudge."
   */
  private isBeckettComment(comment: PlaneComment): boolean {
    return this.ownCommentIds.has(comment.id) || comment.body.trimStart().startsWith("<!-- beckett");
  }

  private loadRuntimeState(): void {
    if (!this.runtimeStatePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.runtimeStatePath, "utf8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
      if (code !== "ENOENT") {
        this.logger.warn("dispatcher runtime state read failed", {
          path: this.runtimeStatePath,
          error: (err as Error).message,
        });
      }
      return;
    }

    try {
      const parsed = parseRuntimeState(JSON.parse(raw));
      this.replaceMap(this.baseShaForTicket, parsed.baseShaForTicket);
      this.replaceMap(this.reworkCount, parsed.reworkCount);
      this.replaceMap(this.implementRetries, parsed.implementRetries);
      this.replaceMap(this.reviewInfraRetries, parsed.reviewInfraRetries);
      this.replaceMap(this.designCycles, parsed.designCycles ?? {});
      // Workers the previous daemon left behind — consumed by recoverFromCrash() at boot.
      if (parsed.liveWorkers && Object.keys(parsed.liveWorkers).length > 0) {
        this.recoveredWorkers = parsed.liveWorkers;
      }
      // Steering that was awaiting a worker when the daemon went down (issue #22).
      if (parsed.pendingSteers) {
        this.pendingSteers.clear();
        for (const [ticketId, steers] of Object.entries(parsed.pendingSteers)) {
          this.pendingSteers.set(ticketId, steers);
        }
      }
      this.logger.info("loaded dispatcher runtime state", {
        path: this.runtimeStatePath,
        tickets: new Set([
          ...Object.keys(parsed.baseShaForTicket),
          ...Object.keys(parsed.reworkCount),
          ...Object.keys(parsed.implementRetries),
          ...Object.keys(parsed.reviewInfraRetries),
          ...Object.keys(parsed.designCycles ?? {}),
        ]).size,
      });
    } catch (err) {
      this.logger.warn("dispatcher runtime state ignored", {
        path: this.runtimeStatePath,
        error: (err as Error).message,
      });
    }
  }

  private persistRuntimeState(): void {
    if (!this.runtimeStatePath) return;
    const state: DispatcherRuntimeState = {
      version: 1,
      baseShaForTicket: Object.fromEntries(this.baseShaForTicket),
      reworkCount: Object.fromEntries(this.reworkCount),
      implementRetries: Object.fromEntries(this.implementRetries),
      reviewInfraRetries: Object.fromEntries(this.reviewInfraRetries),
      designCycles: Object.fromEntries(this.designCycles),
      liveWorkers: Object.fromEntries(this.liveLedger),
      pendingSteers: Object.fromEntries(this.pendingSteers),
    };
    try {
      mkdirSync(dirname(this.runtimeStatePath), { recursive: true });
      const tmp = `${this.runtimeStatePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.runtimeStatePath);
    } catch (err) {
      this.logger.warn("dispatcher runtime state write failed", {
        path: this.runtimeStatePath,
        error: (err as Error).message,
      });
    }
  }

  private replaceMap<T extends string | number>(map: Map<string, T>, values: Record<string, T>): void {
    map.clear();
    for (const [key, value] of Object.entries(values)) map.set(key, value);
  }
}

/** Convenience factory matching the repo's `createX` style. */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return new Dispatcher(deps);
}
