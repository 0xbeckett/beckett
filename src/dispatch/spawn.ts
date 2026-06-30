/**
 * Beckett v3 — ticket-worker spawn helper (`src/dispatch/spawn.ts`)
 * =======================================================================================
 * The thin v3 spawn glue the {@link Dispatcher} (`./dispatcher.ts`) calls to stand up one
 * worker for a ticket stage (see `docs/V3.md` §6). v3.1: a ticket gets ONE git worktree on its
 * own branch, REUSED across implement→review→rework (not a fresh worktree per stage — that churn
 * + the `wk_*` branch litter was the waste). Work stays on the ticket branch; Beckett never
 * auto-merges it to `main`. The worktree isolates concurrent tickets, so `beckett plan` nodes can
 * still run in parallel.
 *
 * What it wires:
 *   1. Driver — `createDriver(harness, config, logger)` (claude today; codex once registered).
 *   2. Worktree — `createWorktree({ reuseIfExists: true })` at {@link ticketWorkspace} on
 *      {@link ticketBranch}; created by the first stage, attached to by the rest. Removed by the
 *      dispatcher (`removeTicketWorktree`) only when the ticket is terminal.
 *   3. Scope-guard — written to `<worktree>/.beckett/worker-settings.json` and delivered via
 *      `claude --settings` (so the checkout's own `.claude` is never clobbered), plus the
 *      done-signal schema at `<worktree>/.beckett/done-schema.json`; `.beckett/` is git-excluded.
 *   4. Spawn — a {@link SpawnSpec} built from the ticket (title/body/criteria), staged for the
 *      `implement` or `review` role (review diffs `<baseRef>..HEAD` to see the contribution).
 *
 * The returned {@link TicketWorkerHandle} exposes the control surface the dispatcher needs:
 * `nudge` (STEERING), `abort` (CANCEL), `onDone`/`onFinished` (advance the ticket), plus
 * `reap` (unsubscribe — the shared worktree is torn down per-ticket, not per-worker). The handle
 * satisfies BOTH the task spec (`id`, `nudge`, `abort`, `onDone`, `state`) and the `docs/V3.md`
 * §6 contract (`workerId`, `ticketId`, `stage`, `onFinished`, `reap`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type {
  Config,
  Logger,
  FileScope,
  ResourceEnvelope,
  Effort,
  SpawnSpec,
  WorkerEvent,
  WorkerState,
  HarnessDriver,
} from "../types.ts";
import type { HarnessSpec, Ticket } from "../plane/types.ts";
import { createDriver } from "../drivers/index.ts";
import { workerId as mintWorkerId } from "../ids.ts";
import { log } from "../log.ts";
import { createWorktree, removeWorktree, excludeFromGit } from "../worker/worktree.ts";
import { scopeGuardSpec } from "../hooks/scope-guard.ts";
import { renderClaudeSettings } from "../hooks/registry.ts";

// =======================================================================================
// Handle contract
// =======================================================================================

/** The terminal outcome of a worker run, captured from its `finished` event. */
export interface TicketWorkerResult {
  status: "success" | "error";
  /** A short human summary (done-signal `summary`, else the last assistant text). */
  summary: string;
  /** The raw structured done-signal (`{ status, summary, filesChanged, ... }`), if any. */
  structured: unknown | null;
}

/** Callback fired exactly once when a worker reaches a terminal `finished` event. */
export type DoneCallback = (status: "success" | "error", summary: string) => void;

/**
 * The live worker handle the dispatcher tracks per ticket. Superset of the task spec and the
 * `docs/V3.md` §6 contract so either caller's expectations hold.
 */
export interface TicketWorkerHandle {
  /** Beckett worker id (e.g. "wk_7f3a"). Alias: {@link workerId}. */
  readonly id: string;
  readonly workerId: string;
  readonly ticketId: string;
  /** "implement" | "review" | future stage names. */
  readonly stage: string;
  /** Absolute path to this worker's git worktree (its cwd). */
  readonly workspace: string;
  /** The worktree branch carrying this worker's contribution. */
  readonly branch: string;
  /** Current lifecycle state (spawning→running→review/failed/aborted). */
  readonly state: WorkerState;
  /** The terminal result once finished; null while still live. */
  readonly result: TicketWorkerResult | null;

  /** STEERING: inject a mid-flight nudge (claude: next turn boundary; codex: queued). */
  nudge(text: string): Promise<void>;
  /** CANCEL: hard-stop the harness process, retaining its session id. */
  abort(reason?: string): Promise<void>;
  /** Register a finish callback (task-spec name). Fired once with the terminal status. */
  onDone(cb: DoneCallback): void;
  /** Register a finish callback (docs/V3.md §6 name). Same semantics as {@link onDone}. */
  onFinished(cb: DoneCallback): void;
  /** Tear down: unsubscribe from the driver stream and remove the git worktree. Idempotent. */
  reap(): Promise<void>;
}

/** Arguments to {@link spawnWorker}. */
export interface SpawnWorkerArgs {
  ticket: Ticket;
  /** "implement" | "review" | future stage names. */
  stage: string;
  /** The casting entry for this stage (which harness/model/effort). */
  harness: HarnessSpec;
  config: Config;
  /** Absolute git repo root the worktree is allocated under. */
  repoRoot: string;
  /** Base ref the ticket's worktree was first branched from (the REVIEW diff base). */
  baseRef: string;
  logger?: Logger;
}

/** Sanitize a ticket identifier into a safe path/branch segment (e.g. "OPS-15"). */
function ticketSlug(ticket: Ticket): string {
  return ticket.identifier.replace(/[^A-Za-z0-9._-]/g, "_") || ticket.id;
}

/**
 * The single git worktree a ticket REUSES across all its stages (implement→review→rework) — v3.1.
 * One per ticket (not one per worker/stage), so there's no per-stage churn and no `wk_*` litter.
 */
export function ticketWorkspace(repoRoot: string, ticket: Ticket): string {
  return join(repoRoot, ".beckett", "worktrees", ticketSlug(ticket));
}

/** The branch carrying a ticket's work. One per ticket; Beckett never auto-merges it to `main`. */
export function ticketBranch(ticket: Ticket): string {
  return `beckett/${ticketSlug(ticket)}`;
}

/**
 * Remove a ticket's worktree directory when it reaches a terminal state (done/cancelled). The
 * branch — the record of the work — is intentionally KEPT; Beckett never silently merges it to
 * `main`. Idempotent / best-effort.
 */
export async function removeTicketWorktree(repoRoot: string, ticket: Ticket): Promise<void> {
  await removeWorktree(repoRoot, ticketWorkspace(repoRoot, ticket));
}

// =======================================================================================
// Constants reused from the v2 manager (kept local — v3 does not depend on the manager)
// =======================================================================================

/** The structured done-signal JSON schema (Spec 02 §6) written per-worker for the driver. */
// NOTE: codex's `--output-schema` enforces OpenAI strict mode — EVERY property must appear in
// `required`, and "optional" fields are expressed as nullable unions (type: [..., "null"]).
// Claude accepts this form too, so one schema serves both harnesses.
const DONE_SCHEMA = {
  type: "object",
  required: ["status", "summary", "filesChanged", "checksRun", "blockedReason"],
  properties: {
    status: { type: "string", enum: ["complete", "blocked", "partial"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    checksRun: { type: ["array", "null"], items: { type: "string" } },
    blockedReason: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

/** Effort → (turnCap, wallClockS) envelope mapping (mirrors `manager.ts#buildEnvelope`). */
const ENVELOPE_BY_EFFORT: Record<Effort, { turnCap: number; wallClockS: number }> = {
  low: { turnCap: 15, wallClockS: 600 },
  medium: { turnCap: 30, wallClockS: 1200 },
  high: { turnCap: 60, wallClockS: 2400 },
  xhigh: { turnCap: 100, wallClockS: 3600 },
};

/** Max chars of fallback assistant text used as a summary. */
const SUMMARY_MAX = 1200;

/**
 * Durable-deploy guidance baked into every implement worker's system prompt (v3.1 robustness).
 * The OPS-15 footgun: a worker "deployed" a site via a throwaway foreground server that died when
 * its session ended, so the URL 404'd and burned two review cycles. Anything that must stay up
 * goes through Beckett's durable Cloudflare tunnel, never an ephemeral process.
 */
const DEPLOY_DURABILITY_NOTE =
  `DEPLOY DURABLY: if the ticket needs a running URL, publish it with Beckett's durable deploy ` +
  `(the \`deploy\` skill / \`beckett deploy\`, a Cloudflare tunnel that survives your session). ` +
  `NEVER hand back a link served by a throwaway foreground process (e.g. \`python -m http.server\`, ` +
  `\`vite\`, \`bun run dev\`) — it dies when you exit and the link 404s. Verify the deployed URL ` +
  `actually responds before you call the ticket done.`;

// =======================================================================================
// Prompt + system-append builders (stage-aware)
// =======================================================================================

/** The criteria bullet block, or a placeholder when none were authored. */
function criteriaBlock(criteria: string[]): string {
  return criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : "- (none specified)";
}

/** The diff command a reviewer runs to see the ticket's whole contribution on its branch. */
function diffHint(baseRef?: string): string {
  return baseRef && baseRef !== "HEAD"
    ? `\`git diff ${baseRef}..HEAD\` (plus \`git status\` for anything uncommitted)`
    : "`git diff HEAD` and `git log`";
}

/** The initial task brief (first user turn) handed to the worker. */
function buildPrompt(ticket: Ticket, stage: string, baseRef?: string): string {
  const header = `[${ticket.identifier}] ${ticket.title}`;
  const body = ticket.body.trim() ? `\n\n${ticket.body.trim()}` : "";
  const crit = `\n\nAcceptance criteria:\n${criteriaBlock(ticket.criteria)}`;
  if (stage === "review") {
    return (
      `Review the implementation for ticket ${header}.${body}${crit}\n\n` +
      `The implementation is committed in the repo you're in (your cwd). Inspect it with ` +
      `${diffHint(baseRef)}, then verify it against EVERY acceptance criterion above. Do not ` +
      `modify the implementation — your job is to judge it.`
    );
  }
  return `${header}${body}${crit}`;
}

/** The businesslike worker persona + scope + criteria system append (stage-aware). */
function buildSystemAppend(ticket: Ticket, stage: string, baseRef?: string): string {
  const crit = criteriaBlock(ticket.criteria);
  if (stage === "review") {
    return (
      `You are an autonomous REVIEWER. The implementation under review is committed in the repo ` +
      `at your cwd. Inspect it with ${diffHint(baseRef)} and judge it against the acceptance ` +
      `criteria — do NOT edit the implementation.\n` +
      `Acceptance criteria:\n${crit}\n` +
      `When finished, emit the structured done-signal matching the provided schema:\n` +
      `  - status "complete"  → the work PASSES review (all criteria met).\n` +
      `  - status "blocked"   → the work FAILS review; put the specific reasons in summary + ` +
      `blockedReason so the next implement pass can fix them.\n` +
      `Put your one-line verdict in summary.`
    );
  }
  return (
    `You are an autonomous worker implementing a ticket. Your cwd is a dedicated checkout on this ` +
    `ticket's own branch — edit it freely and commit your work; treat anything outside it as read-only.\n` +
    `Acceptance criteria (you are done when ALL hold):\n${crit}\n` +
    `SELF-REVIEW before you finish: re-read your own diff and CHECK each acceptance criterion ` +
    `holds — there may be no separate reviewer after you. Run the check commands; fix what fails.\n` +
    `${DEPLOY_DURABILITY_NOTE}\n` +
    `When finished, emit the structured done-signal matching the provided schema (status ` +
    `"complete" when all criteria hold AND your self-review passed, "blocked"/"partial" ` +
    `otherwise with a reason).`
  );
}

/** Resolve the worker's write scope. A ticket worker owns its whole worktree. */
function buildScope(ticket: Ticket): FileScope {
  return { ownedGlobs: [], readGlobs: null, description: `${ticket.identifier}: ${ticket.title}` };
}

/** Build the resource envelope from the casting effort (defaults to the configured worker effort). */
function buildEnvelope(harness: HarnessSpec, config: Config): ResourceEnvelope {
  const effort: Effort = harness.effort ?? config.harness.claude.default_effort;
  const { turnCap, wallClockS } = ENVELOPE_BY_EFFORT[effort];
  // Ticket workers self-provision tools / run checks → allow network. codex honors its own
  // sandbox/network config; the envelope flag is informational for claude.
  const network = harness.harness === "codex" ? config.harness.codex.network_default : true;
  return { effort, turnCap, wallClockS, network };
}

/**
 * Write the per-worker meta under `<repoRoot>/.beckett/` (git-excluded): the scope-guard hook
 * settings and the done-signal schema. v3.1 runs the worker IN the project checkout, so the
 * scope-guard is delivered via `claude --settings <file>` (NOT `.claude/settings.json`) — claude
 * layers it on top of the project's own settings rather than overwriting them. The scope-guard's
 * boundary is the repo root, so the worker may edit the whole repo but nothing outside it.
 */
function writeWorkerMeta(
  repoRoot: string,
  scopeGuardPath: string,
  ownedGlobs: string[],
): { doneSchemaPath: string; settingsPath: string } {
  const metaDir = join(repoRoot, ".beckett");
  mkdirSync(metaDir, { recursive: true });

  const settingsPath = join(metaDir, "worker-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(renderClaudeSettings([scopeGuardSpec(scopeGuardPath, repoRoot, ownedGlobs)]), null, 2),
  );

  const doneSchemaPath = join(metaDir, "done-schema.json");
  writeFileSync(doneSchemaPath, JSON.stringify(DONE_SCHEMA, null, 2));
  return { doneSchemaPath, settingsPath };
}

/** Extract a human summary from a finished event's structured done-signal or fallback text. */
function summaryFrom(structured: unknown | null, lastAssistantText: string): string {
  if (structured && typeof structured === "object") {
    const s = (structured as Record<string, unknown>).summary;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  const text = lastAssistantText.trim();
  if (text) return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
  return "(worker finished without a summary)";
}

// =======================================================================================
// spawnWorker — the single entry point the dispatcher calls
// =======================================================================================

/**
 * Stand up one worker for a ticket stage. v3.1: the worker runs in the TICKET'S OWN worktree
 * ({@link ticketWorkspace}) on its own branch ({@link ticketBranch}) — created on the first stage
 * and reused (`reuseIfExists`) by review + every rework, so a ticket has ONE worktree instead of
 * one per stage. Work stays on the ticket branch; Beckett never auto-merges it to `main`. The
 * scope-guard (delivered via `claude --settings`, so it never clobbers the checkout's own
 * `.claude`) bounds writes to the worktree. Throws if the harness launch fails; the dispatcher
 * surfaces that as a ticket comment and removes the worktree only when the ticket is terminal.
 * Because tickets are isolated, independent `beckett plan` nodes can run in parallel (cap > 1).
 *
 * Exported under both names: `spawnWorker` (task spec) and `spawnTicketWorker` (docs/V3.md §6).
 */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<TicketWorkerHandle> {
  const { ticket, stage, harness, config, repoRoot, baseRef } = args;
  const logger = (args.logger ?? log.child("dispatch.spawn")).child(`ticket.${ticket.identifier}`);

  const id = mintWorkerId();
  // v3.1: ONE worktree per TICKET, reused across all its stages — `reuseIfExists` makes the
  // implement spawn create it and every later review/rework spawn attach to the SAME tree+branch.
  const workspace = ticketWorkspace(repoRoot, ticket);
  const branch = ticketBranch(ticket);
  const scope = buildScope(ticket);
  const envelope = buildEnvelope(harness, config);
  const scopeGuardPath = join(import.meta.dir, "../hooks/scope-guard.ts");

  // claude owns its resume identity from t=0 via a pre-minted UUID; codex captures a thread id.
  const preMintSession = harness.harness === "claude" ? randomUUID() : undefined;

  const driver: HarnessDriver = createDriver(harness.harness, config, logger);

  // ── live-handle bookkeeping ──────────────────────────────────────────────────────────
  let state: WorkerState = "spawning";
  let result: TicketWorkerResult | null = null;
  let lastAssistantText = "";
  let finishedFired = false;
  let reaped = false;
  const doneCbs = new Set<DoneCallback>();

  const fireDone = (status: "success" | "error", summary: string): void => {
    if (finishedFired) return;
    finishedFired = true;
    for (const cb of doneCbs) {
      try {
        cb(status, summary);
      } catch (err) {
        logger.warn("done callback threw", { err: String(err) });
      }
    }
  };

  const unsubscribe = driver.onEvent((e: WorkerEvent) => {
    switch (e.kind) {
      case "session_started":
        if (state === "spawning") state = "running";
        break;
      case "assistant_text":
        if (!e.partial && e.text.trim()) lastAssistantText = e.text;
        break;
      case "finished": {
        const summary = summaryFrom(e.structuredOutput, lastAssistantText);
        result = { status: e.status, summary, structured: e.structuredOutput };
        state = e.status === "success" ? "review" : "failed";
        logger.info("ticket worker finished", { workerId: id, stage, status: e.status });
        fireDone(e.status, summary);
        break;
      }
      default:
        break;
    }
  });

  // ── attach to the ticket's worktree (create on first stage, reuse after) + scope-guard ──
  try {
    await createWorktree({ repoRoot, workspace, branch, baseRef, reuseIfExists: true });
    await excludeFromGit(workspace, [".beckett/"]);
    const { doneSchemaPath, settingsPath } = writeWorkerMeta(workspace, scopeGuardPath, scope.ownedGlobs);

    const spec: SpawnSpec = {
      workerId: id,
      prompt: buildPrompt(ticket, stage, baseRef),
      systemAppend: buildSystemAppend(ticket, stage, baseRef),
      workspace,
      scope,
      envelope,
      model: harness.model ?? "",
      sessionId: preMintSession,
      doneSchemaPath,
      settingsPath,
    };

    const spawnResult = await driver.spawn(spec);
    state = "running";
    logger.info("ticket worker dispatched", {
      workerId: id,
      stage,
      harness: harness.harness,
      model: harness.model ?? "(driver default)",
      sessionId: spawnResult.sessionId,
      branch,
      baseRef,
      workspace,
    });
  } catch (err) {
    state = "failed";
    unsubscribe();
    logger.error("ticket worker spawn failed", { workerId: id, stage, error: (err as Error).message });
    throw err;
  }

  // ── the control handle ─────────────────────────────────────────────────────────────────
  const handle: TicketWorkerHandle = {
    id,
    workerId: id,
    ticketId: ticket.id,
    stage,
    workspace,
    branch,
    get state() {
      return state;
    },
    get result() {
      return result;
    },
    async nudge(text: string): Promise<void> {
      const receipt = await driver.sendNudge(text);
      logger.info("ticket worker nudged", { workerId: id, accepted: receipt.accepted, len: text.length });
    },
    async abort(reason = "aborted"): Promise<void> {
      await driver.abort(reason);
      state = "aborted";
    },
    onDone(cb: DoneCallback): void {
      if (finishedFired && result) cb(result.status, result.summary);
      else doneCbs.add(cb);
    },
    onFinished(cb: DoneCallback): void {
      handle.onDone(cb);
    },
    async reap(): Promise<void> {
      if (reaped) return;
      reaped = true;
      unsubscribe();
      // v3.1: reap is per-WORKER (one stage); it does NOT remove the worktree, which is shared
      // across the ticket's stages. The dispatcher removes the ticket's worktree only when the
      // ticket itself reaches a terminal state (see `removeTicketWorktree`).
      logger.info("ticket worker reaped", { workerId: id, stage });
    },
  };

  return handle;
}

/** docs/V3.md §6 alias for {@link spawnWorker}. */
export const spawnTicketWorker = spawnWorker;
