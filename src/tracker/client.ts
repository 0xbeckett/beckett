/**
 * The tracker client contract + factory. bored (frgmt0/bored) is Beckett's ONE tracker —
 * the Plane backend and its BECKETT_TRACKER selection flag were removed in OPS-191 after
 * the OPS-190 bridge proved bored end-to-end. Dispatch, poller, CLI, and Concierge all
 * construct their client here and program against {@link TrackerClient} only.
 */
import type { Config, Logger } from "../types.ts";
import type { CreateTicketInput, ProvisioningResult, Ticket, TicketComment, TicketState, WorkflowState } from "./types.ts";
import { createBoredClient } from "../bored/client.ts";

/** The dispatch/poll surface every tracker backend must satisfy. */
export interface TrackerClient {
  stats(): { lastHttpStatus: number | null; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null };
  listIssues(opts?: { updatedSince?: string }): Promise<Ticket[]>;
  listIssueHeads(): Promise<Array<{ id: string; updatedAt: string }>>;
  getIssue(id: string): Promise<Ticket | null>;
  createIssue(input: CreateTicketInput): Promise<Ticket>;
  setState(id: string, state: TicketState): Promise<void>;
  setIssueState(id: string, state: TicketState): Promise<void>;
  listComments(ticketId: string, since?: string, opts?: { inclusive?: boolean }): Promise<TicketComment[]>;
  addComment(ticketId: string, body: string): Promise<TicketComment>;
  board(): string;
  projectInfo(): Promise<{ board: string; projectId: string; identifier: string | null }>;
  listStates(): Promise<WorkflowState[]>;
  ensureProvisioned(): Promise<ProvisioningResult>;
}

export interface CreateTrackerClientDeps {
  config: Config;
  board?: string;
  logger?: Logger;
}

/** Construct the tracker client (bored). */
export function createTrackerClient(deps: CreateTrackerClientDeps): TrackerClient {
  return createBoredClient(deps);
}
