import type { Ticket } from "../plane/types.ts";

/** Keep task-backed Git refs in the public `#N.x` namespace; legacy tickets retain their ref. */
export function gitBranchForTicket(ticket: Pick<Ticket, "identifier" | "branchRef">): string {
  if (ticket.branchRef) return `beckett/task-${ticket.branchRef.replace(/\./g, "-")}`;
  return `beckett/${ticket.identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}
