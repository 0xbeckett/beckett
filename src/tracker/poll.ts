/** Backend-neutral poller. The implementation is protocol-based and works with either tracker. */
export { PlanePoller as TrackerPoller, createPlanePoller as createTrackerPoller } from "../plane/poll.ts";
export type { PlanePollerDeps as TrackerPollerDeps, PollEventSink } from "../plane/poll.ts";
