/**
 * Beckett — Routine dispatch plan (`src/routine/plan.ts`)
 * =======================================================================================
 * Turns a routine's ACTION into a concrete, inspectable dispatch plan for the `beckett
 * browser` background lane. This is the seam shared by:
 *
 *   - the daemon scheduler, which builds a plan then hands it to a `dispatch` executor that
 *     calls the browser agent (issue #50/#58) — off the scheduler process, never inline; and
 *   - the CLI `--dry-run`, which builds the SAME plan and prints it WITHOUT dispatching, so
 *     compose + dispatch wiring is provable without a real live post.
 *
 * A plan carries the composed preview text and the exact browser task + creds entry that
 * WOULD be dispatched. It never carries a secret value — only the jingle entry NAME.
 */

import type { Routine } from "./types.ts";
import { buildXPostTask, composeShitpost } from "./compose.ts";

export interface RoutineDispatchPlan {
  routineId: string;
  /** Which lane executes this — today always the background browser agent. */
  lane: "browser";
  /** The composed shitpost / summary shown to a human (dry-run + logs). */
  preview: string;
  /** The self-contained task string for `beckett browser`. */
  browserTask: string;
  /** jingle keychain entry passed to the lane via --creds (a NAME, never a secret). */
  credsEntry: string | null;
  /** Discord channel the lane reports back to (may be filled from env by the executor). */
  channelId: string | null;
  /** Authenticated requester the run is attributed to (may be filled from env). */
  requesterId: string | null;
}

/**
 * Build the plan for a routine firing now. `rng` drives composition (which shitpost) so tests
 * are deterministic and so "varies run to run" is observable. Pure — no I/O, no dispatch.
 */
export function buildDispatchPlan(routine: Routine, rng: () => number = Math.random): RoutineDispatchPlan {
  const action = routine.action;
  if (action.kind === "x-shitpost") {
    const text = composeShitpost(rng);
    return {
      routineId: routine.id,
      lane: "browser",
      preview: text,
      browserTask: buildXPostTask(text, action.account),
      credsEntry: action.credsEntry,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }
  // kind === "browser"
  return {
    routineId: routine.id,
    lane: "browser",
    preview: action.task,
    browserTask: action.task,
    credsEntry: action.credsEntry ?? null,
    channelId: action.channelId ?? null,
    requesterId: action.requesterId ?? null,
  };
}
