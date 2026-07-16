import type { Ticket } from "../tracker/types.ts";
import type { TaskStore } from "./store.ts";

/** Reconcile a complete tracker board snapshot, including states the event poller intentionally omits. */
export async function reconcileTaskTickets(
  store: TaskStore,
  tickets: Ticket[],
  board: string,
  onError: (ticket: Ticket, error: unknown) => void = () => {},
): Promise<number> {
  let synced = 0;
  for (const ticket of tickets) {
    if (!ticket.branchRef) continue;
    try {
      if (await store.syncTicket(ticket, board)) synced++;
    } catch (err) {
      onError(ticket, err);
    }
  }
  return synced;
}
