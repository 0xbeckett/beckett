/**
 * Beckett — Routine dispatch plan (`src/routine/plan.ts`)
 * =======================================================================================
 * Turns a routine's ACTION into a concrete, inspectable dispatch plan. This is the seam shared by:
 *
 *   - the daemon scheduler, which builds a plan then hands it to a `dispatch` executor
 *     ({@link ../shell/main.ts}) — the executor runs it OFF the scheduler process; and
 *   - the CLI `--dry-run`, which builds the SAME plan and prints it WITHOUT dispatching, so the
 *     wiring is provable without a real live post.
 *
 * Two lanes:
 *   - `agent`  → invoke a registered agent with `agentInput`; the agent AUTHORS the browser task at
 *      dispatch time (its taste lives in its prompt, not here), so the plan carries the invocation,
 *      not composed text. The authored post is not knowable until the agent runs.
 *   - `browser`→ a STATIC self-contained browser task, known at plan time.
 *
 * The pre-#72 `x-shitpost` action is folded onto the `agent` lane here (target: the `social-media`
 * agent), so a legacy routines.json fires through exactly ONE path with no bespoke composition code.
 *
 * A plan never carries a secret value — only the jingle entry NAME.
 */

import type { Routine } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";

/** The instruction handed to the social-media agent when a legacy `x-shitpost` routine fires. */
export const LEGACY_SHITPOST_INPUT =
  "Compose today's shitpost — one fresh, in-voice line — and author the browser task that posts it to X.";

export interface RoutineDispatchPlan {
  routineId: string;
  /** Which lane executes this: run an agent that authors the post, or a static browser task. */
  lane: "agent" | "browser";
  /** agent lane: the registry id to invoke LIVE at dispatch (null for the browser lane). */
  agentId: string | null;
  /** agent lane: the instruction handed to that agent (null for the browser lane). */
  agentInput: string | null;
  /** browser lane: the static task string (null for the agent lane, which authors its task live). */
  browserTask: string | null;
  /** Human-readable summary shown in a dry-run + logs. */
  preview: string;
  /** jingle keychain entry passed to the browser lane via --creds (a NAME, never a secret). */
  credsEntry: string | null;
  /** Discord channel the lane reports back to (may be filled from env by the executor). */
  channelId: string | null;
  /** Authenticated requester the run is attributed to (may be filled from env). */
  requesterId: string | null;
}

/** Build the dispatch plan for a routine firing now. Pure — no I/O, no dispatch, no composition. */
export function buildDispatchPlan(routine: Routine): RoutineDispatchPlan {
  const action = routine.action;

  if (action.kind === "agent") {
    return {
      routineId: routine.id,
      lane: "agent",
      agentId: action.agentId,
      agentInput: action.input,
      browserTask: null,
      preview: `invoke agent ${action.agentId}: ${action.input}`,
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "x-shitpost") {
    // Legacy shape → the same agent lane. The account/voice/how-to-post now live in the agent's
    // prompt; the routine only supplies the creds entry the browser lane injects.
    return {
      routineId: routine.id,
      lane: "agent",
      agentId: SOCIAL_MEDIA_AGENT_ID,
      agentInput: LEGACY_SHITPOST_INPUT,
      browserTask: null,
      preview: `invoke agent ${SOCIAL_MEDIA_AGENT_ID}: ${LEGACY_SHITPOST_INPUT}`,
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  // kind === "browser"
  return {
    routineId: routine.id,
    lane: "browser",
    agentId: null,
    agentInput: null,
    browserTask: action.task,
    preview: action.task,
    credsEntry: action.credsEntry ?? null,
    channelId: action.channelId ?? null,
    requesterId: action.requesterId ?? null,
  };
}
