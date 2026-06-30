/**
 * Beckett v3 — Plane poller alias (`src/plane/poller.ts`)
 * =======================================================================================
 * The canonical implementation lives in `./poll.ts` (the name the V3 contract / Dispatcher
 * import). This thin module re-exports it under the `Poller` name and a `createPoller`
 * factory so callers that reach for `src/plane/poller.ts` resolve to the same single source
 * of truth — there is no second implementation to drift.
 *
 * `Poller` satisfies the `{ constructor(deps); start(onEvents); stop() }` surface (plus the
 * lower-level `poll()` / `prime()` the shell drives directly).
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions.
 */

export {
  PlanePoller as Poller,
  PlanePoller,
  createPlanePoller as createPoller,
  createPlanePoller,
} from "./poll.ts";

export type { PlanePollerDeps as PollerDeps, PlanePollerDeps, PollEventSink } from "./poll.ts";
