/**
 * Beckett — REVIEW & GATE (`src/brain/review.ts`)
 * =======================================================================================
 * The quality canon (Spec 11). Three things live here:
 *
 *   1. {@link reviewNode} — the NL judgment (B7). v0 is self/fresh; this is the Opus review:
 *      diff + check results + criteria → a {@link ReviewVerdict} (Spec 11 §4.2/§5.4). It
 *      re-throws on a brain-infra failure so the orchestrator pauses + escalates rather than
 *      gating blind (Spec 06 §3.4 / Spec 11 §6.3).
 *   2. The deterministic half — {@link runChecks} runs every `criteria.checks` command in the
 *      worktree, all-run-no-short-circuit, timeouts fail-closed (Spec 11 §3).
 *   3. The pure GATE algorithm — {@link normalizeVerdict} (fail-closed), {@link runGate}
 *      (checksPass AND reviewPass — no override), tier selection, the re-dispatch brief, the
 *      escalation builder, and the {@link GateOutcomeRow} the Store logs (Spec 11 §6/§7).
 *
 * The verdict prompt is businesslike/adversarial — NO persona (Spec 06 §5.1; internal prompt).
 */

import { z } from "zod";
import type {
  NodeRecord,
  BrainContext,
  ReviewVerdict,
  ChecksOutcome,
  CheckResult,
  ReviewTier,
  ReviewerFeedback,
  GateResult,
  GateOutcome,
  GateOutcomeRow,
  CriticalitySignals,
  Worker,
  Harness,
  Escalation,
} from "../types.ts";
import { MAX_RETRIES } from "../types.ts";
import { callJSON, type RoleDeps } from "./llm.ts";
import { reviewSystem, reviewUser, indent, tailText } from "./prompts.ts";
import { gateOutcomeId } from "../ids.ts";

// =======================================================================================
// The ReviewVerdict schema (Spec 11 §5.4)
// =======================================================================================

export const REVIEW_VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "criteriaMet", "issues", "confidence"],
  properties: {
    pass: { type: "boolean", description: "overall: does it meet ALL criteria?" },
    criteriaMet: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met"],
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          note: { type: "string", description: "why / why not, with file:line" },
        },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "detail"],
        properties: {
          severity: { enum: ["blocker", "major", "minor"] },
          criterion: { type: "string" },
          detail: { type: "string" },
          location: { type: "string", description: "file:line" },
        },
      },
    },
    confidence: { type: "number", description: "0..1: reviewer's confidence in its verdict" },
  },
};

const VerdictZ = z.object({
  pass: z.boolean(),
  criteriaMet: z.array(
    z.object({ criterion: z.string(), met: z.boolean(), note: z.string().optional() }),
  ),
  issues: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor"]),
      criterion: z.string().optional(),
      detail: z.string(),
      location: z.string().optional(),
    }),
  ),
  confidence: z.number(),
});

/**
 * The NL review (B7). Returns the model's verdict (NOT yet normalized — call
 * {@link normalizeVerdict} or {@link runGate}). Throws {@link import("./llm.ts").BrainCallError}
 * on infra exhaustion: an unreachable reviewer is a review-infra escalation, not a node retry
 * (Spec 11 §6.3 / Spec 06 §3.4).
 */
export async function reviewNode(
  node: NodeRecord,
  checks: ChecksOutcome,
  diff: string,
  ctx: BrainContext | undefined,
  deps: RoleDeps,
  model: string,
): Promise<ReviewVerdict> {
  return callJSON<ReviewVerdict>({
    bin: deps.bin,
    model,
    system: reviewSystem(),
    prompt: reviewUser(node, checks, diff, ctx),
    jsonSchema: REVIEW_VERDICT_SCHEMA,
    validate: (v) => VerdictZ.parse(v) as ReviewVerdict,
    schemaName: "review",
    retry: deps.retry,
    logger: deps.logger,
  });
}

// =======================================================================================
// The deterministic half — run the checks (Spec 11 §3)
// =======================================================================================

/** Scrubbed execution environment for checks (Spec 11 §3.5). */
export interface CheckEnv {
  /** Per-check wall-clock seconds (config `review.check_timeout_s`, default 600). */
  timeoutS: number;
  /** The (already-scrubbed) env the check process sees. */
  vars: Record<string, string>;
  /** Head+tail cap per stream in bytes (config `review.check_output_cap_bytes`, default 16384). */
  outputCapBytes: number;
}

/** Patterns stripped from the check env so a rogue check can't exfiltrate secrets (Spec 11 §3.5). */
const SECRET_PATTERNS = [/_TOKEN$/, /_SECRET$/, /_KEY$/, /^DISCORD_/, /^GITHUB_PAT$/];

/**
 * Build a scrubbed check env: inherit the parent, drop secret-shaped keys and the forbidden
 * API keys (subscription-only, Spec 00 §4). Network is governed by the worker envelope, not here.
 */
export function buildCheckEnv(timeoutS = 600, outputCapBytes = 16384): CheckEnv {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "OPENAI_API_KEY") continue;
    if (SECRET_PATTERNS.some((re) => re.test(k))) continue;
    vars[k] = v;
  }
  return { timeoutS, vars, outputCapBytes };
}

/** Head+tail truncation, dropping the middle (test failures live at both ends — Spec 11 §3.3). */
function capHeadTail(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const half = Math.floor(cap / 2);
  const elided = s.length - cap;
  return `${s.slice(0, half)}\n… [${elided} bytes elided] …\n${s.slice(s.length - half)}`;
}

/** Run one check command in the worktree (Spec 11 §3.1). A timeout is a fail (exit 124). */
export async function runCheck(cmd: string, ws: string, env: CheckEnv): Promise<CheckResult> {
  const t0 = Date.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bash", "-lc", cmd], {
      cwd: ws,
      env: env.vars,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      cmd,
      exitCode: 127,
      stdout: "",
      stderr: `failed to spawn check: ${(err as Error).message}`,
      durationMs: Date.now() - t0,
      timedOut: false,
      pass: false,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, env.timeoutS * 1000);

  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return {
    cmd,
    exitCode: timedOut ? 124 : exitCode,
    stdout: capHeadTail(out, env.outputCapBytes),
    stderr: capHeadTail(err, env.outputCapBytes),
    durationMs: Date.now() - t0,
    timedOut,
    pass: !timedOut && exitCode === 0,
  };
}

/**
 * Run ALL checks sequentially in the worktree — no short-circuit, so the reviewer and jawrooo
 * see the full failure picture in one pass (Spec 11 §3.1). Empty `checks` ⇒ `allPass:true`
 * vacuously (a non-code node rests on review, Spec 11 §3.4).
 */
export async function runChecks(checks: string[], ws: string, env: CheckEnv): Promise<ChecksOutcome> {
  const results: CheckResult[] = [];
  for (const cmd of checks) results.push(await runCheck(cmd, ws, env));
  return { results, allPass: results.every((r) => r.pass) };
}

// =======================================================================================
// The GATE algorithm (Spec 11 §6) — pure
// =======================================================================================

/**
 * Re-derive `pass` fail-closed; don't trust the model (Spec 11 §5.4): pass iff every criterion
 * is met AND no blocker issue. A `blocker` forces fail even if the model said true.
 */
export function normalizeVerdict(verdict: ReviewVerdict): ReviewVerdict {
  const allMet = verdict.criteriaMet.every((c) => c.met);
  const noBlocker = verdict.issues.every((i) => i.severity !== "blocker");
  return { ...verdict, pass: allMet && noBlocker };
}

/** A one-line human read of the gate result (retry brief + escalation — Spec 11 §6.1). */
export function summarizeGate(checks: ChecksOutcome, verdict: ReviewVerdict): string {
  const passed = checks.results.filter((r) => r.pass).length;
  const total = checks.results.length;
  const checkPart = total ? `${passed}/${total} checks pass` : "no checks";
  const blockers = verdict.issues.filter((i) => i.severity === "blocker").length;
  const unmet = verdict.criteriaMet.filter((c) => !c.met).length;
  const reviewPart = verdict.pass
    ? "review: pass"
    : `review: ${blockers} blocker${blockers === 1 ? "" : "s"}, ${unmet} unmet`;
  return `${checkPart}; ${reviewPart}`;
}

/**
 * THE GATE (Spec 11 §6.1): passes iff every check exits 0 AND the (normalized) review passes.
 * No partial pass, no override. `feedback` is ALWAYS produced — it drives RE_DISPATCH on fail
 * and is logged on pass.
 */
export function runGate(
  node: NodeRecord,
  checks: ChecksOutcome,
  rawVerdict: ReviewVerdict,
  tier: ReviewTier,
  reviewerId?: string,
): GateResult {
  const verdict = normalizeVerdict(rawVerdict);
  const checksPass = checks.allPass;
  const reviewPass = verdict.pass;
  const feedback: ReviewerFeedback = {
    attempt: node.attempts,
    tier,
    reviewerId,
    verdict,
    checkResults: checks.results,
    summary: summarizeGate(checks, verdict),
    at: Date.now(),
  };
  return { pass: checksPass && reviewPass, checksPass, reviewPass, feedback };
}

/** Has this node exhausted its retry budget? (Spec 11 §7.3: the 4th need-to-retry escalates.) */
export function gateRetriesExhausted(node: NodeRecord): boolean {
  return node.attempts >= MAX_RETRIES;
}

// =======================================================================================
// Tier selection & criticality (Spec 11 §4.1)
// =======================================================================================

export interface ReviewConfig {
  blastRadiusCritical: number; // default 2
  diffLinesCritical: number; // default 150
  filesCritical: number; // default 8
  crossProviderEnabled: boolean; // v0 false
  panicNodes: boolean; // v0 false
}

/** Spec 11 §11 defaults (the `[review]` config block is not in the frozen Config — see report). */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  blastRadiusCritical: 2,
  diffLinesCritical: 150,
  filesCritical: 8,
  crossProviderEnabled: false,
  panicNodes: false,
};

/** Choose the review tier from criticality signals (Spec 11 §4.1). v0 resolves to self|fresh. */
export function chooseTier(s: CriticalitySignals, cfg: ReviewConfig = DEFAULT_REVIEW_CONFIG): ReviewTier {
  const critical =
    s.touchesSecurity ||
    s.touchesDeps ||
    s.externalSurface ||
    s.blastRadius >= cfg.blastRadiusCritical ||
    s.diffLines >= cfg.diffLinesCritical ||
    s.filesChanged >= cfg.filesCritical ||
    s.priorRetries >= 1;

  if (!critical) return "self";
  if (s.touchesSecurity || s.externalSurface) {
    if (cfg.crossProviderEnabled) return "cross";
    if (cfg.panicNodes) return "panel";
  }
  return "fresh";
}

const SECURITY_HINT =
  /\b(auth|authz|authn|crypto|secret|token|session|password|permission|payment|jwt|oauth)\b/i;
const DEPS_HINT = /(package\.json|package-lock|bun\.lock|yarn\.lock|pnpm-lock|Dockerfile|\.github\/|requirements\.txt|Cargo\.toml|go\.mod)/i;
const EXTERNAL_HINT = /\b(migration|migrate|DROP\s+TABLE|DELETE\s+FROM|public api|breaking)\b/i;

/**
 * Derive {@link CriticalitySignals} from a node + its merged diff + DAG fan-out. Heuristic but
 * real: scans scope globs and the diff text for security/dependency/external-surface markers
 * (Spec 11 §4.1). Diff-line/file counts come from the diff; an explicit `fresh` reviewTier on
 * the node forces criticality.
 */
export function criticalitySignals(
  node: NodeRecord,
  diff: string,
  blastRadius: number,
): CriticalitySignals {
  const haystack = `${node.scope.ownedGlobs.join(" ")} ${node.scope.description} ${node.title} ${diff}`;
  const { added, removed, files } = diffStats(diff);
  return {
    touchesSecurity: SECURITY_HINT.test(haystack),
    touchesDeps: DEPS_HINT.test(haystack),
    blastRadius,
    diffLines: added + removed,
    filesChanged: files,
    externalSurface: EXTERNAL_HINT.test(haystack),
    priorRetries: node.attempts,
  };
}

/** Count +/- lines and changed files from a unified diff. */
export function diffStats(diff: string): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed, files };
}

// =======================================================================================
// Re-dispatch feedback & escalation (Spec 11 §7)
// =======================================================================================

/**
 * The steering brief threaded into a re-dispatch (Spec 11 §7.1). `resume` keeps the worker's
 * worktree/context (default for a quality fail); `fresh` restarts from the criteria.
 */
export function redispatchBrief(fb: ReviewerFeedback, strategy: "resume" | "fresh"): string {
  const failedChecks = fb.checkResults
    .filter((r) => !r.pass)
    .map((r) => `- \`${r.cmd}\` → exit ${r.exitCode}\n${indent(tailText(r.stderr || r.stdout))}`);
  const blockers = fb.verdict.issues
    .filter((i) => i.severity !== "minor")
    .map((i) => `- [${i.severity}] ${i.detail}${i.location ? ` (${i.location})` : ""}`);

  if (strategy === "resume") {
    return [
      "Your change did not pass the gate. Fix these and keep your existing work:",
      failedChecks.length ? "Failing checks:\n" + failedChecks.join("\n") : "",
      blockers.length ? "Review found:\n" + blockers.join("\n") : "",
      "Re-run the checks yourself before signaling done.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    "A previous attempt failed review. Start fresh from the criteria.",
    "It failed for:\n" + [...failedChecks, ...blockers].join("\n"),
    "The prior (non-passing) diff is attached as a reference of an approach that did NOT work.",
  ].join("\n\n");
}

/**
 * Build the GATE escalation after MAX_RETRIES (Spec 11 §7.2): the fixed
 * "tried N×, stuck here: <summary>, options: A/B/C" spine. Spec 05 renders it in Beckett's
 * voice; Spec 04 owns the `Escalation` record. `reason` is a first-person account threaded
 * from each cycle's feedback so the escalation can show what every attempt tried.
 */
export function buildGateEscalation(node: NodeRecord): Escalation {
  const last = node.feedback.at(-1);
  const perCycle = node.feedback.map((f, i) => `  ${i + 1}. ${f.summary}`).join("\n");
  const head = last ? last.summary : "no reviewer feedback captured";
  return {
    origin: "GATE",
    nodeId: node.id,
    reason:
      `Node "${node.title}" failed the gate ${node.attempts}× (${last?.tier ?? "self"} review). ` +
      `Stuck here: ${head}.` +
      (perCycle ? `\nWhat each cycle hit:\n${perCycle}` : ""),
    options: [
      { key: "A", label: "Give me more rope", effect: "redispatch:+2 attempts with your guidance" },
      { key: "B", label: "Take it from here", effect: "deliver partial diff/PR for you to finish" },
      { key: "C", label: "Drop this node", effect: "abandon node; deliver the rest of the DAG" },
    ],
    raisedAt: Date.now(),
  };
}

// =======================================================================================
// Outcome rows for the Store (Spec 09 §2.7/§2.13)
// =======================================================================================

/** Build the per-attempt gate-outcome row for {@link import("../types.ts").Store.logGateOutcome}. */
export function gateOutcomeRow(node: NodeRecord, result: GateResult, workerId?: string): GateOutcomeRow {
  return {
    id: gateOutcomeId(),
    node_id: node.id,
    worker_id: workerId ?? null,
    attempt: node.attempts,
    checks_passed: result.checksPass ? 1 : 0,
    review_passed: result.reviewPass ? 1 : 0,
    review_tier: result.feedback.tier,
    reviewer_id: result.feedback.reviewerId ?? null,
    verdict: result.pass ? "pass" : "fail",
    feedback_json: JSON.stringify(result.feedback),
    created_at: Date.now(),
  };
}

/**
 * The canonical 7-field learned-model summary (Spec 00 §4 / types.ts {@link GateOutcome}).
 * The persisted superset (`worker_outcomes`) is the orchestrator's to log at worker finish.
 */
export function gateOutcome(
  result: GateResult,
  worker: Pick<Worker, "harness" | "model" | "spend">,
  taskType: string,
  driftEvents: number,
): GateOutcome {
  return {
    harness: worker.harness as Harness,
    model: worker.model,
    taskType,
    passed: result.pass,
    retries: result.feedback.attempt,
    driftEvents,
    turns: worker.spend.turns,
  };
}
