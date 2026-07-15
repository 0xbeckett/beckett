/**
 * Beckett v3 — Plane ticket-queue shared domain types (`src/plane/types.ts`)
 * =======================================================================================
 * THE v3 CONTRACT. Every v3 build agent imports its shared vocabulary from here:
 *   - PlaneClient (`./client.ts`)        — speaks the Plane REST API, returns {@link Ticket}s
 *   - Poller     (`./poll.ts`)           — diffs poll snapshots, emits {@link PollEvent}s
 *   - Dispatcher (`./dispatcher.ts`)     — consumes {@link PollEvent}s, spawns workers
 *   - Concierge  (`../concierge/*`)      — files {@link Ticket}s with per-stage {@link Casting}
 *
 * This module is intentionally implementation-free (types only), mirroring the root
 * `src/types.ts` convention. The cast-block parse/serialize logic lives next door in
 * `./cast.ts` so this file stays a pure contract.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions —
 *   `import type { Ticket } from "./types.ts";`
 */

// =======================================================================================
// Ticket lifecycle
// =======================================================================================

/**
 * Beckett's canonical ticket lifecycle. Maps onto Plane's per-project workflow state NAMES
 * via `config.plane.state_map` (the dispatcher/client translate name → Plane state UUID).
 */
export type TicketState =
  | "backlog"
  | "todo"
  /** INT only: live design-document authoring stage. */
  | "design"
  /** INT only: parked human approval gate for the design document. */
  | "design_review"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

/** Terminal ticket states — no worker runs once a ticket is here. */
export const TICKET_TERMINAL: ReadonlySet<TicketState> = new Set<TicketState>([
  "done",
  "cancelled",
]);

// =======================================================================================
// Casting — which harness/model runs each workflow stage
// =======================================================================================

/** A coding-agent CLI Beckett drives as a worker (matches root `Harness`, v3 subset). */
export type HarnessName = "claude" | "codex" | "pi";

/** One stage's harness selection: which CLI, optionally which model + reasoning effort. */
export interface HarnessSpec {
  harness: HarnessName;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  /**
   * v3.1 review gate (set on the `implement` cast). `self` = the implement worker self-verifies
   * inline and the ticket goes straight to `done` (one pass, no separate reviewer). `fresh` = a
   * separate adversarial reviewer runs (`in_review` stage). When unset the dispatcher derives it
   * from `effort` (low/medium → self; high/xhigh/unset → fresh).
   */
  reviewTier?: "self" | "fresh";
}

/**
 * Per-stage casting for a ticket. `design` staffs an INT ticket's design worker, `implement`
 * staffs the `in_progress` worker, and `review` staffs the `in_review` reviewer. Open-ended:
 * future stages (e.g. `integrate`) key in by name. Stored inside the Plane issue description as
 * a ```beckett-cast``` fenced block.
 */
export interface Casting {
  implement?: HarnessSpec;
  review?: HarnessSpec;
  [stage: string]: HarnessSpec | undefined;
}

// =======================================================================================
// Ticket + comments — the hydrated view of a Plane issue
// =======================================================================================

/**
 * A Plane issue hydrated into Beckett's view. `description` is the raw Plane description
 * (cast block + criteria + prose); `body` is JUST the human prose with the cast block and
 * the acceptance-criteria section stripped out (see {@link parseCast} in `./cast.ts`).
 * `casting` and `criteria` are the parsed-out structured halves of `description`.
 */
export interface Ticket {
  id: string; // Plane issue id (UUID)
  identifier: string; // human ref, e.g. "BEC-42"
  title: string;
  description: string; // raw Plane description (cast block + criteria + prose)
  body: string; // prose only (cast block + criteria section removed)
  state: TicketState;
  assignees: string[]; // Plane member ids
  casting: Casting;
  criteria: string[]; // acceptance-criteria bullet lines
  /**
   * Identifiers of tickets this one is blocked by (a `beckett plan` dependency edge, e.g.
   * `["OPS-41"]`). The ticket is held in `backlog` until EVERY blocker reaches `done`, at which
   * point the dispatcher promotes it to `in_progress`. Empty for an independent ticket. Stored in
   * the issue description (```beckett-deps``` block) so Plane stays the single source of truth and
   * the DAG survives a daemon restart — no in-memory dependency state to lose.
   */
  blockedBy: string[];
  /**
   * The CODE project this ticket builds — its own repo under `~/Projects/<project>`, pushed to
   * `0xbeckett/<project>` on GitHub, fully decoupled from Beckett's own source repo. The Concierge
   * names it at creation (```beckett-project``` block); absent ⇒ the dispatcher falls back to the
   * ticket identifier (a per-ticket sandbox). NOT the Plane project (that's `projectId`).
   */
  project?: string;
  /** Stable user-facing task-branch reference, for example `42.2`. */
  branchRef?: string;
  /**
   * Non-main integration/target branch this ticket publishes onto (```beckett-target-branch``` block,
   * e.g. `v5-daemon`). When set, the publisher ships the finished work to THIS branch on the code
   * repo and never advances the repo's default branch (`main`) — the funnel that keeps a campaign
   * off `main` until one final human-merged integration→main PR (OPS-185). Absent ⇒ publish to the
   * repo default exactly as a normal ticket does.
   */
  targetBranch?: string;
  /** Native Plane parent work-item id when this branch is nested under another started branch. */
  parentId?: string;
  /** Lifecycle state a held task branch should enter once its dependencies finish. */
  startState?: TicketState;
  projectId: string; // Plane project id (the queue, e.g. "ops") — NOT the code project above
  url: string; // deep link to the issue in the Plane web UI
  updatedAt: string; // ISO-8601; the poll cursor / change key
  /**
   * Discord channel that filed this ticket, stamped by the Concierge at creation so worker/ticket
   * updates can be routed back to the conversation that asked (the closed agent loop). Absent for
   * tickets created outside Discord (e.g. straight in Plane). Round-tripped through the issue
   * description by the PlaneClient — Plane stays the single source of truth (no sidecar DB).
   */
  originChannel?: string;
}

/** One comment on a Plane issue. */
export interface PlaneComment {
  id: string;
  ticketId: string;
  author: string; // Plane member id / display name
  body: string;
  createdAt: string; // ISO-8601
}

// =======================================================================================
// PollEvent — the normalized shell→dispatcher signal stream
// =======================================================================================

/**
 * What the poller emits after diffing one poll snapshot against the last. The dispatcher is
 * the sole consumer (Spec: shell POLLS Plane every `config.plane.poll_secs`, emits these).
 */
export type PollEvent =
  | { kind: "created"; ticket: Ticket }
  | { kind: "state_changed"; ticket: Ticket; from: TicketState | null; to: TicketState }
  | { kind: "comment_added"; ticket: Ticket; comment: PlaneComment }
  | { kind: "cancelled"; ticket: Ticket };

/** Convenience discriminator alias for the four poll-event kinds. */
export type PollEventKind = PollEvent["kind"];

// =======================================================================================
// Cast-block parse/serialize — the structured halves of a ticket description
// =======================================================================================

/** The structured parts {@link parseCast} pulls out of a Plane issue description. */
export interface ParsedCast {
  casting: Casting;
  criteria: string[];
  blockedBy: string[]; // ticket identifiers this one waits on (```beckett-deps``` block)
  project?: string; // code-project slug (```beckett-project``` block) — see Ticket.project
  branchRef?: string; // user-facing task branch (```beckett-branch``` block), e.g. `42.2`
  startState?: TicketState; // desired post-dependency state (```beckett-start-state``` block)
  targetBranch?: string; // non-main publish/integration branch (```beckett-target-branch```) — see Ticket.targetBranch
  body: string; // prose with the cast/deps/project blocks + criteria section removed
}
