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
export type HarnessName = "claude" | "codex";

/** One stage's harness selection: which CLI, optionally which model + reasoning effort. */
export interface HarnessSpec {
  harness: HarnessName;
  model?: string;
  effort?: "low" | "medium" | "high";
}

/**
 * Per-stage casting for a ticket. `implement` staffs the `in_progress` worker; `review`
 * staffs the `in_review` reviewer. Open-ended: future stages (e.g. `integrate`) key in by
 * name. Stored inside the Plane issue description as a ```beckett-cast``` fenced block.
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
  projectId: string; // Plane project id
  url: string; // deep link to the issue in the Plane web UI
  updatedAt: string; // ISO-8601; the poll cursor / change key
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

/** The three parts {@link parseCast} pulls out of a Plane issue description. */
export interface ParsedCast {
  casting: Casting;
  criteria: string[];
  body: string; // prose with the cast block + criteria section removed
}
