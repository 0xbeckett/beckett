import type { Ticket } from "../tracker/types.ts";

/** Keep task-backed Git refs in the public `#N.x` namespace; legacy tickets retain their ref. */
export function gitBranchForTicket(ticket: Pick<Ticket, "identifier" | "branchRef">): string {
  if (ticket.branchRef) return `beckett/task-${ticket.branchRef.replace(/\./g, "-")}`;
  return `beckett/${ticket.identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

/**
 * The single filesystem path segment a ticket's worktree lives at, under
 * `<repoRoot>/.beckett/worktrees/<segment>`. Ticket ids are public refs like `#131`, and a literal
 * `#` in the worker's cwd breaks npm and Vite-style web builds — `#` is a URL-fragment delimiter and
 * npm's own path resolution mangles it, so `npm test` / `npm run build:web` fail inside the tree for
 * reasons unrelated to the code under review (#134). We scrub every character outside `[a-z0-9._-]`
 * to `-` — the same ref-safe class {@link gitBranchForTicket} uses — collapsing runs and trimming
 * leading/trailing separators so the segment is a clean, human-readable directory (a `#131` ticket
 * becomes `131`, `#131.1` becomes `131.1`). Uniqueness within a repo is inherited from the ticket
 * id, which is already unique per ticket; the scrub is applied to that id, so two distinct tickets
 * keep distinct segments. Falls back to `ticket` only if a pathological id scrubs to empty.
 */
export function worktreeDirForTicket(ticket: Pick<Ticket, "id">): string {
  const scrubbed = ticket.id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return scrubbed || "ticket";
}
