/**
 * Beckett — the Plan stage (`src/dispatch/plan-stage.ts`, issue #128)
 * =======================================================================================
 * THE STRUCTURAL GUARANTEE the owner asked for, verbatim: "it makes it permanent to make sure
 * that the prompt to the workers is actually high quality. because sonnet would not write good
 * prompts I'm sure of it." The concierge chat seat drops to `claude-sonnet-5` @ medium (issue
 * #128, `src/capability/builtins.ts`) — that is only safe because THIS stage stands between the
 * concierge and every implement worker, authoring the worker's brief at a strong seat (Fable or
 * Opus, never Sonnet, never the cheap chat seat) regardless of who filed the ticket or what cast
 * they tried to attach. Modeled directly on the `design`/`design_check` pair
 * (`dispatch/stages.ts`): a real authoring worker (`planStage`) followed by an independent,
 * deliberately CHEAPER checker (`planCheckStage`) that cannot mark its own author's homework —
 * same shape, same cycle-cap discipline, same "commit → check → advance or bounce" finish
 * pattern. Unlike `design`, `plan` is MANDATORY and UNIVERSAL (every board, not just INT) and its
 * `setState("plan")` case in `bored/client.ts` is a real, tested, working transition — `design`'s
 * never got wired for a state re-entry and would 501 if it tried; `plan_check`'s own retry
 * deliberately avoids that trap (see this file's `planCheckStage.finish`).
 *
 * THE ENFORCEMENT POINT (not here — named so a reader doesn't have to hunt for it):
 * `implementStage.entryGuard` (`dispatch/stages.ts`, `hasQualifyingPlan`) refuses to staff an
 * implement worker unless `ops.hasVerifiedPlan(ticket.id)` is true. That flag is DISPATCHER
 * RUNTIME STATE (`Dispatcher.planVerified`, `dispatch/dispatcher.ts`), written in exactly ONE
 * place: `planCheckStage.finish`, below, on a genuine pass. No ticket field, cast block, or
 * filer-supplied description can set it — the concierge (or anything else that files a ticket)
 * cannot write itself past this gate, cast the plan stage away, or file straight into
 * `in_progress`: `dependentStartState` (dispatcher.ts) always resolves a fresh/promoted ticket's
 * start state to `plan` unless the ticket explicitly names a different `startState`, and even
 * that only reaches `implementStage.entryGuard`'s hard bar — it is not a way past it.
 *
 * BYPASS INVENTORY (every one closed, cited by file/line at the point of closure):
 *   1. Cast the plan stage to a cheap model → `tracker/cast.ts#validateCasting` refuses any
 *      `plan` cast outside `PLAN_STAGE_ALLOWLIST` at FILE TIME (every CLI filing path runs
 *      `validateCasting`), and `planStage.resolveCast` below refuses again at SPAWN TIME for
 *      anything that reaches the dispatcher some other way — belt AND suspenders, not just one.
 *   2. Skip the plan stage entirely by filing straight into `in_progress` → `implementStage
 *      .entryGuard` blocks staffing regardless of how the ticket arrived at that state; see
 *      `hasQualifyingPlan` in `dispatch/stages.ts`.
 *   3. Author your own "plan" and claim it counts → `planCheckStage`'s cast is a SEPARATE cheap
 *      model/session from whatever authored the doc (same discipline as `design_check`), and it
 *      records the plan verified ONLY against the cast that ACTUALLY RAN (`PlanVerification`),
 *      never the ticket's requested cast — a substitution can't silently satisfy the gate with a
 *      weaker seat.
 *   4. Let a harness-health substitution quietly downgrade the plan author → `pickHealthyHarness`
 *      (`dispatch/dispatcher.ts`) refuses to walk `fallback_order` for `stage === "plan"`; an
 *      unhealthy strong seat FAILS LOUD (`planStage.spawnFailure`, below) instead of finishing the
 *      brief on whatever's healthy.
 *   5. A future call site forgets to consult `entryGuard` → `doSpawn`'s own independent assertion
 *      (`dispatch/dispatcher.ts`) refuses to launch ANY `implement` spawn with no `planVerified`
 *      record, regardless of how it was reached.
 */

import type { Config, DoneSignal } from "../types.ts";
import type { HarnessSpec, Ticket } from "../tracker/types.ts";
import { isPlanStageEligible, PLAN_STAGE_ALLOWLIST } from "../tracker/cast.ts";
import type { PromptBlock } from "../capability/index.ts";
import { steeringBlock } from "./resume-brief.ts";
import { PLAN_SECTIONS, PLAN_TOKEN_CEILING, planWithinCeiling } from "./plan-artifact.ts";
import {
  taskHeader,
  taskCriteria,
  workerSystemAppend,
  parseDoneSignal,
  doneSignalSummary,
  type StageDefinition,
  type StageOps,
} from "./stages.ts";

/** Where a ticket's plan stage writes (and its checker, and later implement/review, read) the plan document. */
export function planDocPath(ticket: Ticket): string {
  return `docs/plan/${ticket.identifier.toLowerCase()}.md`;
}

/** The `plan` stage's extra persona line, composed the same way `design`'s is (`stages.ts`'s `stageBlock` opt). */
const planStageBlock: PromptBlock = {
  id: "stage:plan-only",
  priority: 20,
  render: () =>
    "This is a PLAN stage: write and commit the shared-context plan document only; do not implement " +
    "the requested change. You may investigate the repo to make the plan concrete, but the point of " +
    "this stage is to do that investigation ONCE, well, so the implement worker doesn't have to.",
};

/** Human-readable name for a harness/model pair, for comments naming a rejected cast override. */
function castLabel(spec: HarnessSpec): string {
  return `${spec.harness}/${spec.model ?? "(default)"}`;
}

const PLAN_STAGE_DEFAULT: HarnessSpec = { harness: "claude", model: "claude-opus-5", effort: "high" };

// =======================================================================================
// planStage — the authoring worker
// =======================================================================================

export const planStage: StageDefinition = {
  name: "plan",
  // Universal (issue #128): every board, not INT-only like `design` — no entryGuard restricting
  // WHO gets a plan; the guard that matters is on the OTHER end (`implementStage.entryGuard`).
  entryState: "plan",
  resolveCast(explicit): HarnessSpec {
    // Bypass #1's spawn-time half: an explicit cast naming anything outside the strong-seat
    // allowlist is REFUSED, not merely defaulted-around — `validateCasting` (tracker/cast.ts)
    // already refuses this at file time for every CLI path; this is the belt to that suspenders
    // for a ticket that reached the dispatcher some other way. `planStage.finish` posts a comment
    // naming the rejection so it is never silent.
    if (explicit && isPlanStageEligible(explicit)) return explicit;
    return PLAN_STAGE_DEFAULT;
  },
  buildPrompt({ ticket, steering }): string {
    const body = ticket.body.trim() ? `\n\n${ticket.body.trim()}` : "";
    const path = planDocPath(ticket);
    const sections = PLAN_SECTIONS.map((s) => `  - ${s}`).join("\n");
    return (
      `<task>\nWrite the shared-context plan for ticket ${taskHeader(ticket)}.${body}\n</task>${taskCriteria(ticket)}${steeringBlock(steering)}\n\n` +
      `This is the MANDATORY **Plan** stage (issue #128): every ticket gets one before an implement ` +
      `worker is ever staffed. Your job is to do the orientation ONCE, well, so the implement worker ` +
      `doesn't have to re-read and re-grep to figure out what you already know. You may investigate ` +
      `the repo — read files, grep, run read-only commands — but do not implement the change.\n\n` +
      `Write the plan document at \`${path}\` with exactly these sections, in this order:\n${sections}\n\n` +
      `Keep the WHOLE document under ~${PLAN_TOKEN_CEILING} tokens (~${PLAN_TOKEN_CEILING * 4} characters) — ` +
      `an independent checker will mechanically reject anything longer, regardless of quality. Every ` +
      `claim you make must be anchored to a real \`path/to/file.ts:LINE\` — an unanchorable claim gets cut, ` +
      `not guessed at. "Open questions" is where genuine ambiguity belongs; it is not a hedge for work ` +
      `you didn't do. Commit the document before finishing; an independent, cheaper model checks it next.`
    );
  },
  buildSystemAppend: (args) => workerSystemAppend(args, { stageBlock: planStageBlock }),
  parseDoneSignal,
  /**
   * Health-check refused a spawn (issue #128, bypass #4): NO harness substitution is permitted
   * for this stage (`pickHealthyHarness` in `dispatch/dispatcher.ts` returns `null` outright for
   * `stage === "plan"` rather than walking `fallback_order`), so an unhealthy strong seat must
   * fail loud and hold the ticket in `plan` — never quietly finish the brief on whatever's
   * healthy. This is deliberately NOT the default bounded implement-retry backoff: a ticket stuck
   * here needs a human to fix the harness, not a background retry loop.
   */
  async spawnFailure(ops, ticket, error): Promise<void> {
    await ops.postComment(
      ticket.id,
      `Plan authorship stalled: the strong seat this stage requires (${[...PLAN_STAGE_ALLOWLIST].join(" or ")}) ` +
        `is unhealthy and no substitute is permitted for this stage (issue #128 — the whole point of Plan ` +
        `is a strong-seat-authored brief; substituting would defeat it). Error: ${error.message}\n\n` +
        `Use \`beckett ticket restaff\` once the harness/login issue is fixed.`,
    );
    ops.logger.warn("plan stage spawn failed — no substitution permitted, holding for a human", {
      ticket: ticket.identifier,
      error: error.message,
    });
  },
  /**
   * Real worker stage, followed by an independent cheap completeness pass — same shape as
   * `design`'s finish (`dispatch/stages.ts`). The checker gets its own model/session so the
   * author cannot approve its own document (bypass #3).
   */
  async finish(ops, { ticket, handle, status }): Promise<void> {
    // Bypass #1's after-the-fact half: name a rejected override so it's never silent, even
    // though `resolveCast` already fell back to the strong-seat default for the actual run.
    const requested = ticket.casting.plan;
    if (requested && !isPlanStageEligible(requested)) {
      await ops.postComment(
        ticket.id,
        `This ticket cast \`plan\` to \`${castLabel(requested)}\`, which is not a strong-seat pair — ` +
          `the plan stage only ever runs on ${[...PLAN_STAGE_ALLOWLIST].join(" or ")} (issue #128: the ` +
          `brief it writes must come from a strong seat, not a cheap one). Ran on the strong-seat ` +
          `default instead.`,
      );
    }
    const sha = await ops.commitWip(ticket, handle);
    const at = sha ? ` (committed as \`${sha.slice(0, 9)}\`)` : "";
    await ops.postComment(
      ticket.id,
      status === "success"
        ? `Plan draft complete${at}; running an independent completeness check.`
        : `Plan worker ended early${at}; running the completeness check on the saved draft.`,
    );
    ops.spawnStage(ticket, "plan_check");
  },
};

// =======================================================================================
// planCheckStage — the cheap, independent gate that WRITES the enforcement record
// =======================================================================================

/** The harness/model this stage's finish handler records as having actually authored the plan. */
function actualPlanCast(ticket: Ticket): HarnessSpec {
  const requested = ticket.casting.plan;
  return requested && isPlanStageEligible(requested) ? requested : PLAN_STAGE_DEFAULT;
}

export const planCheckStage: StageDefinition = {
  name: "plan_check",
  // Follow-on stage, spawned by planStage.finish — never staffed by a ticket state transition
  // (same shape as design_check).
  resolveCast: (explicit) => explicit ?? { harness: "claude", model: "claude-haiku-4-5", effort: "low" },
  buildPrompt({ ticket, steering }): string {
    const path = planDocPath(ticket);
    const sections = PLAN_SECTIONS.map((s) => `  - ${s}`).join("\n");
    return (
      `<task>\nSanity-check the plan document for ticket ${taskHeader(ticket)}.\n</task>${taskCriteria(ticket)}${steeringBlock(steering)}\n\n` +
      `Read \`${path}\` (and its rough size). Do not edit implementation or author the plan yourself. ` +
      `Decide whether it is complete: it must have all six sections, in order:\n${sections}\n\n` +
      `Every material claim should be anchored to a real \`path/to/file.ts:LINE\` — an unanchored claim ` +
      `is a gap, not a pass. Emit status \`complete\` only if the document is genuinely usable as a ` +
      `worker's shared context (not just present-but-empty sections). Otherwise emit \`blocked\` and ` +
      `list every specific gap in summary/blockedReason. You do not need to judge exact token length — ` +
      `size is checked mechanically, separately from your read.`
    );
  },
  buildSystemAppend(): string {
    return (
      `<persona>\n` +
      `You are an independent plan-document completeness checker — a separate model/session from ` +
      `whoever authored the plan, so you are not marking your own homework. Do not edit files. Apply ` +
      `the rubric in the task exactly and finish with the structured done-signal: "complete" only for ` +
      `a genuinely usable plan; otherwise "blocked" with actionable gaps.\n</persona>`
    );
  },
  parseDoneSignal,
  async finish(ops, { ticket, handle, status, summary }): Promise<void> {
    const signal = status === "success" ? parseDoneSignal(handle.result?.structured) : null;
    const path = planDocPath(ticket);

    // Mechanical size gate (defense-in-depth against the ceiling — the checker's own read is a
    // cheap model's judgment call; the char count never is). Best-effort: a read failure does not
    // silently pass — it counts as a gap like any other incompleteness.
    let withinCeiling = true;
    let docText = "";
    try {
      docText = await ops.readTicketFile(ticket, path);
      withinCeiling = planWithinCeiling(docText);
    } catch (err) {
      withinCeiling = false;
      ops.logger.warn("plan_check could not read the plan doc to size-check it", {
        ticket: ticket.identifier,
        path,
        error: (err as Error).message,
      });
    }

    const complete = signal?.status === "complete" && withinCeiling && docText.length > 0;
    if (complete) {
      // THE WRITE, THE ENFORCEMENT POINT'S OTHER HALF: record the cast that ACTUALLY authored
      // this plan (never the ticket's requested cast — bypass #3) so `implementStage.entryGuard`
      // can staff an implement worker.
      const cast = actualPlanCast(ticket);
      ops.counters.planCycles.delete(ticket.id);
      ops.persistRuntimeState();
      ops.recordPlanVerified(ticket.id, {
        sha: null,
        harness: cast.harness,
        ...(cast.model ? { model: cast.model } : {}),
        verifiedAt: new Date().toISOString(),
      });
      await ops.advanceTicket(
        ticket,
        "in_progress",
        `Plan completeness check passed. Plan document: \`${path}\`\n\nStarting implementation.\n\n${summary}`,
      );
      return;
    }

    const gaps =
      (signal ? doneSignalSummary(signal, summary) : summary || "The plan checker did not return a valid verdict.") +
      (withinCeiling ? "" : `\n\n(also over the ${PLAN_TOKEN_CEILING}-token size ceiling — trim it)`);
    ops.trace(ticket, "plan-check:verdict", "bounced", "plan completeness check found gaps");
    const cycle = (ops.counters.planCycles.get(ticket.id) ?? 0) + 1;
    ops.counters.planCycles.set(ticket.id, cycle);
    ops.persistRuntimeState();
    if (cycle < ops.caps.planCycles) {
      await ops.postComment(
        ticket.id,
        `Plan completeness check found gaps (pass ${cycle}/${ops.caps.planCycles}); re-authoring:\n\n${gaps}`,
      );
      // Deliberately NOT `ops.advanceTicket(ticket, "plan", ...)`: the ticket never left `plan`
      // (plan_check has no entryState — same as design_check), so there is no real state
      // transition to ask the tracker for. Unlike `design`, whose retry tries exactly that and
      // would 501 against real bored (`bored/client.ts#setState` has no re-entrant case for a
      // ticket already at its own state), `plan` just re-spawns the SAME stage directly.
      ops.spawnStage(ticket, "plan");
      return;
    }

    // Cap exhausted: PARK for a human, do not auto-advance. Deliberately stricter than
    // `design_check`'s exhaustion behavior (which auto-advances with a ⚠ flag) — this gate is a
    // hard requirement (issue #128), not advisory, so exhausting the auto-retry budget must not
    // quietly hand an implement worker a brief nobody verified.
    ops.counters.planCycles.delete(ticket.id);
    ops.persistRuntimeState();
    await ops.parkForHuman(
      ticket,
      `⚠ Plan completeness check still found gaps after ${ops.caps.planCycles} passes:\n\n${gaps}\n\n` +
        `Plan document: \`${path}\`\n\nParked for a human — this gate is mandatory (issue #128), so I ` +
        `will not start implementation on an unverified plan. Fix the doc and \`beckett ticket restaff\`.`,
    );
  },
};
