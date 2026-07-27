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
 * Five lanes:
 *   - `agent`  → invoke a registered agent with `agentInput`; the agent AUTHORS the browser task at
 *      dispatch time (its taste lives in its prompt, not here), so the plan carries the invocation,
 *      not composed text. The authored post is not knowable until the agent runs.
 *   - `browser`→ a STATIC self-contained browser task, known at plan time.
 *   - `deps-update` → the LOCAL maintenance lane (issue #85): no agent, no browser, no credentials.
 *      The executor runs the dependency-update job in a throwaway clone and its output is a PR.
 *      This lane exists precisely so a maintenance job is NOT smuggled through the privileged
 *      browser lane, which would hand a local chore a web session it has no use for.
 *   - `watch` → the event-listener lane (issue #1): no I/O happens here (this function stays
 *      pure), so the plan only carries the intent to poll. The REAL work — fetching the feed,
 *      qualifying an item, rate-limiting, and dispatching the `agent` lane on a genuine hit —
 *      happens in the dispatcher, exactly like `deps-update`'s executor. A live, feed-aware
 *      preview for `--dry-run` is built separately by `runWatchCycle`/`previewWatchCycle`
 *      ({@link ./watch.ts}), which DO perform I/O — this function is not where that happens.
 *   - `self` → the ONLY lane that wakes Beckett itself (issue #26): no agent, no browser, no
 *      credentials. The plan carries just the prompt; the dispatcher hands it to the concierge's
 *      self-wake bus command, which frames a SYSTEM turn on `SYSTEM_SCOPE` via `askUpdate`. Like
 *      `deps-update`, it exists so a self-directed wake is NEVER smuggled through the browser lane.
 *
 * The pre-#72 `x-shitpost` action is folded onto the `agent` lane here (target: the `social-media`
 * agent), so a legacy routines.json fires through exactly ONE path with no bespoke composition code.
 *
 * A plan never carries a secret value — only the jingle entry NAME.
 */

import type { Routine } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";

/** The `deps-update` lane's parameters, resolved from the action (defaults filled at fire time). */
export interface DepsUpdateTarget {
  /** `owner/name` the PR opens on; null → the executor resolves it from the GitHub identity. */
  repo: string | null;
  /** The branch the PR TARGETS. Never pushed to, never merged into. */
  base: string;
  /** Checkout to clone FROM (read-only); null → the daemon's own source root. */
  sourceRepo: string | null;
}

/** The instruction handed to the social-media agent when a legacy `x-shitpost` routine fires. */
export const LEGACY_SHITPOST_INPUT =
  "Compose today's shitpost — one fresh, in-voice line — and author the browser task that posts it to X.";

export interface RoutineDispatchPlan {
  routineId: string;
  /**
   * Which lane executes this: an agent that authors a post, a static browser task, the local
   * dependency-update job, or the feed-watch poll. Only `agent`/`browser` (and, indirectly, a
   * qualifying `watch` fire) reach the browser.
   */
  lane: "agent" | "browser" | "deps-update" | "watch" | "self";
  /** agent lane: the registry id to invoke LIVE at dispatch (null for the browser lane). */
  agentId: string | null;
  /** agent lane: the instruction handed to that agent (null for the browser lane). */
  agentInput: string | null;
  /** browser lane: the static task string (null for the agent lane, which authors its task live). */
  browserTask: string | null;
  /** deps-update lane: what to update and where the PR goes (null on the other lanes). */
  depsUpdate: DepsUpdateTarget | null;
  /** self lane: the instruction Beckett gives itself, framed as a SYSTEM turn (null elsewhere). */
  selfPrompt: string | null;
  /**
   * self lane, dream variant (issue #36): true when this fire is the nightly dream pass. The
   * dispatcher then spawns the contained `beckett dream run` body instead of framing a concierge
   * turn — same pre-browser fork, same no-agent/no-browser/no-creds shape as a plain self wake.
   */
  dream: boolean;
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
      depsUpdate: null,
      selfPrompt: null,
      dream: false,
      preview: `invoke agent ${action.agentId}: ${action.input}`,
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "deps-update") {
    // Its own lane, deliberately: nothing here names an agent, a browser task, or a creds entry,
    // so there is no shape a dispatcher could mistake for browser work.
    return {
      routineId: routine.id,
      lane: "deps-update",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: {
        repo: action.repo ?? null,
        base: action.base,
        sourceRepo: action.sourceRepo ?? null,
      },
      selfPrompt: null,
      dream: false,
      preview:
        `update in-range dependencies in an isolated clone, run typecheck + tests, ` +
        `open a PR against ${action.base}${action.repo ? ` on ${action.repo}` : ""}`,
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "watch") {
    // Pure by construction: this is a DESCRIPTION of the poll, not a run of it. It carries
    // `agentId` (mirroring the `agent` lane, since a qualifying fire dispatches through it) but
    // `agentInput` is null — nobody knows which item, if any, will qualify until fire time.
    return {
      routineId: routine.id,
      lane: "watch",
      agentId: action.agentId,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      selfPrompt: null,
      dream: false,
      preview:
        `poll ${action.feedUrl} every ${action.pollIntervalMinutes}m; on a genuinely new, ` +
        `unseen, rate-limit-clear model release, dispatch agent ${action.agentId} with the item ` +
        `as the subject` +
        (action.dryRun ? " (dry-run: would post, does not post)" : ""),
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "self") {
    // Its own lane, deliberately (issue #26): the ONLY plan that wakes Beckett itself. Like
    // `deps-update` it names no agent, no browser task, and no creds entry — there is no shape a
    // dispatcher could mistake for browser work, so a self routine can never resolve a web session.
    return {
      routineId: routine.id,
      lane: "self",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      selfPrompt: action.prompt,
      dream: false,
      preview: `wake the concierge on its own ledger: ${action.prompt}`,
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "dream") {
    // The dream pass (issue #36) rides the SELF lane: same pre-browser fork, same guarantee that
    // nothing here can be mistaken for browser work. `dream: true` is the only difference — the
    // dispatcher spawns the contained `beckett dream run` body instead of framing a concierge
    // turn, so the token ceiling and the write containment stay enforced in code, not prompt.
    return {
      routineId: routine.id,
      lane: "self",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      selfPrompt: null,
      dream: true,
      preview:
        "replay the day on the self lane (dream pass): read-only assembly, budgeted reflection, " +
        "one dated journal entry under ~/.beckett/dreams, inference-only memories",
      credsEntry: null,
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
      depsUpdate: null,
      selfPrompt: null,
      dream: false,
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
    depsUpdate: null,
    selfPrompt: null,
    dream: false,
    preview: action.task,
    credsEntry: action.credsEntry ?? null,
    channelId: action.channelId ?? null,
    requesterId: action.requesterId ?? null,
  };
}
