/**
 * Beckett v3 — ticket-worker spawn helper (`src/dispatch/spawn.ts`)
 * =======================================================================================
 * The thin v3 spawn glue the {@link Dispatcher} (`./dispatcher.ts`) calls to stand up one
 * worker for a ticket stage (see `docs/V3.md` §6). v3.1: each ticket builds its OWN project repo
 * at `~/Projects/<slug>` (pushed to `0xbeckett/<slug>`), fully decoupled from Beckett's own source.
 * The worker runs IN that repo — implement, review, and rework share the one checkout and edit in
 * place. Isolation between tickets is just "different project dirs," so `beckett plan` nodes still
 * run in parallel. The dispatcher provisions the repo (clone-or-init) before the first spawn.
 *
 * What it wires:
 *   1. Driver — `createDriver(harness, config, logger)` (claude today; codex once registered).
 *   2. Workspace — `repoRoot` (the provisioned project repo); no per-worker worktree.
 *   3. Scope-guard — written to `<repo>/.beckett/worker-settings.json` and delivered via
 *      `claude --settings` (so the project's own `.claude` is never clobbered), plus the
 *      done-signal schema at `<repo>/.beckett/done-schema.json`; `.beckett/` is git-excluded.
 *   4. Spawn — a {@link SpawnSpec} built from the ticket (title/body/criteria), staged for the
 *      `implement` or `review` role (review diffs `<baseRef>..HEAD` to see the contribution).
 *
 * The returned {@link TicketWorkerHandle} exposes the control surface the dispatcher needs:
 * `nudge` (STEERING), `abort` (CANCEL), `onDone`/`onFinished` (advance the ticket), plus
 * `reap` (unsubscribe — the project repo persists). The handle
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
import { projectSlug } from "../plane/cast.ts";
import { createDriver } from "../drivers/index.ts";
import { workerId as mintWorkerId } from "../ids.ts";
import { log } from "../log.ts";
import { excludeFromGit, currentBranch } from "../worker/worktree.ts";
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
  /**
   * True when this run ended because it tripped the generous backstop wall-clock cap (the driver's
   * `error_wall_clock_cap` finish, OPS-50), rather than finishing/erroring on its own. The
   * dispatcher keys on this to handle the timeout gracefully (commit WIP, retry / return to ready).
   */
  timedOut: boolean;
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
  /**
   * Optional progress sink: every {@link WorkerEvent} off the driver stream is forwarded here so the
   * dispatcher can mirror the granular play-by-play into the ticket's Discord thread (see
   * `src/discord/progress.ts`). Best-effort by contract — a throwing sink is swallowed and never
   * disturbs the worker. Omitted in tests / when no thread is wired.
   */
  onProgress?: (ev: WorkerEvent, ctx: { stage: string; workerId: string }) => void;
  logger?: Logger;
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
 * The recurring footgun (OPS-15, OPS-17, OPS-19): workers improvise their own deploy — a
 * foreground server that dies on session end, a server bound somewhere the tunnel can't reach, or
 * a hand-edited ingress with no DNS record — so the URL 404s / never resolves and burns review
 * cycles. The fix is to give ONE exact path and forbid every improvised alternative, then make the
 * worker prove the public URL responds before it may call the ticket done. Slug-parameterized so
 * the recipe names the worker's real hostname (`<slug>.0xbeckett.me`).
 */
function deployDurabilityNote(slug: string): string {
  return (
    `DEPLOY DURABLY (only if the ticket needs a public URL): there is exactly ONE supported path, ` +
    `and improvising your own is the #1 cause of dead links here. Do these three steps, nothing else:\n` +
    `  1. Serve the build on a local port with a server that SURVIVES your session: write a ` +
    `\`systemd --user\` unit and \`systemctl --user enable --now <unit>\`. Bind it to 127.0.0.1 (the ` +
    `tunnel reaches localhost). A foreground process (\`python -m http.server\`, \`vite\`, ` +
    `\`bun run dev\`) or a bare \`&\`/\`nohup\` job is FORBIDDEN — it dies when you exit and the link 404s.\n` +
    `  2. Run \`beckett deploy ${slug} --port <thePort>\`. That command (and ONLY that command) ` +
    `creates BOTH the Cloudflare tunnel ingress AND the public DNS record for ` +
    `\`${slug}.0xbeckett.me\`. NEVER hand-edit \`~/.cloudflared/config.yml\` or touch DNS yourself — ` +
    `that leaves a half-deploy with an ingress but no DNS, which never resolves.\n` +
    `  3. VERIFY before you call the ticket done: ` +
    `\`curl -fsS -o /dev/null -w '%{http_code}' https://${slug}.0xbeckett.me\` must print 200. If it ` +
    `can't resolve or returns 502, the deploy is NOT done (your unit isn't running, or ` +
    `\`beckett deploy\` didn't run) — fix it and re-check. Never report a URL you haven't curled.`
  );
}

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
  const slug = projectSlug(ticket.project || ticket.identifier);
  return (
    `You are an autonomous worker implementing a ticket. Your cwd is THIS PROJECT'S OWN git repo ` +
    `(\`~/Projects/${slug}\`) — it is yours to build in. Edit freely and commit your work; treat ` +
    `anything outside it (especially Beckett's own source) as read-only.\n` +
    `Acceptance criteria (you are done when ALL hold):\n${crit}\n` +
    `SELF-REVIEW before you finish: re-read your own diff and CHECK each acceptance criterion ` +
    `holds — there may be no separate reviewer after you. Run the check commands; fix what fails.\n` +
    `GITHUB: don't push anything yourself. When this ticket is done, Beckett automatically ` +
    `publishes this repo to \`0xbeckett/${slug}\` (a standalone PUBLIC repo, NOT tied to ` +
    `0xbeckett/beckett). Just commit your work in this checkout — the push is handled for you.\n` +
    `${deployDurabilityNote(slug)}\n` +
    `When finished, emit the structured done-signal matching the provided schema (status ` +
    `"complete" when all criteria hold AND your self-review passed, "blocked"/"partial" ` +
    `otherwise with a reason).`
  );
}

/** Resolve the worker's write scope. A ticket worker owns its whole project repo. */
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
 * Stand up one worker for a ticket stage. v3.1: the worker runs IN the ticket's own project repo
 * (`repoRoot` = `~/Projects/<slug>`, provisioned by the dispatcher) — implement, review, and every
 * rework cycle share that one checkout and the worker edits + commits in place. Isolation between
 * tickets comes from each one having its OWN project repo, not from worktrees; the worker pushes to
 * `0xbeckett/<slug>` via the github skill. The scope-guard (delivered via `claude --settings`, so
 * it never clobbers the project's own `.claude`) bounds writes to the project repo. Throws if the
 * harness launch fails; the dispatcher surfaces that as a ticket comment.
 *
 * Exported under both names: `spawnWorker` (task spec) and `spawnTicketWorker` (docs/V3.md §6).
 */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<TicketWorkerHandle> {
  const { ticket, stage, harness, config, repoRoot, baseRef, onProgress } = args;
  const logger = (args.logger ?? log.child("dispatch.spawn")).child(`ticket.${ticket.identifier}`);

  const id = mintWorkerId();
  const workspace = repoRoot; // v3.1: the ticket's own project repo (the dispatcher provisioned it)
  const branch = await currentBranch(repoRoot); // informational: the project repo's branch
  const scope = buildScope(ticket);
  const envelope = buildEnvelope(harness, config);
  const scopeGuardPath = join(import.meta.dir, "../hooks/scope-guard.ts");

  // claude + pi own their resume identity from t=0 via a pre-minted UUID (claude --session-id,
  // pi --session-id "create if missing"); codex can't be told an id, so it captures a thread id.
  const preMintSession =
    harness.harness === "claude" || harness.harness === "pi" ? randomUUID() : undefined;

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
    // Mirror the granular event to the ticket's Discord progress thread (best-effort — a broken
    // sink must never derail the worker's own lifecycle bookkeeping below).
    if (onProgress) {
      try {
        onProgress(e, { stage, workerId: id });
      } catch (err) {
        logger.warn("progress sink threw (ignored)", { err: String(err) });
      }
    }
    switch (e.kind) {
      case "session_started":
        if (state === "spawning") state = "running";
        break;
      case "assistant_text":
        if (!e.partial && e.text.trim()) lastAssistantText = e.text;
        break;
      case "finished": {
        const summary = summaryFrom(e.structuredOutput, lastAssistantText);
        result = {
          status: e.status,
          summary,
          structured: e.structuredOutput,
          timedOut: e.subtype === "error_wall_clock_cap",
        };
        state = e.status === "success" ? "review" : "failed";
        logger.info("ticket worker finished", { workerId: id, stage, status: e.status });
        fireDone(e.status, summary);
        break;
      }
      default:
        break;
    }
  });

  // ── wire scope-guard into the project repo (already provisioned by the dispatcher), then launch ──
  try {
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
      // v3.1: nothing to tear down — the worker ran in the ticket's persistent project repo
      // (`~/Projects/<slug>`), which lives on as a real repo. Its committed work stays there; the
      // git-excluded `.beckett/` meta is harmless and overwritten by the next worker.
      logger.info("ticket worker reaped", { workerId: id, stage });
    },
  };

  return handle;
}

/** docs/V3.md §6 alias for {@link spawnWorker}. */
export const spawnTicketWorker = spawnWorker;
