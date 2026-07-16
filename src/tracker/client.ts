/** Active tracker selection. `BECKETT_TRACKER=plane` remains the compatibility default. */
import type { Config, Logger } from "../types.ts";
import type { CreateTicketInput, ProvisioningResult, WorkflowState } from "../tracker/types.ts";
import type { TicketComment, Ticket, TicketState } from "../tracker/types.ts";
import { createPlaneClient } from "../tracker/types.ts";
import { createBoredClient } from "../bored/client.ts";

/** The dispatch/poll surface shared by Plane and bored. */
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

export type TrackerKind = "plane" | "bored";

/** Read the one tracker switch. Invalid values fail fast instead of silently changing backend. */
export function trackerKind(env: Record<string, string | undefined> = process.env): TrackerKind {
  const value = env.BECKETT_TRACKER?.trim().toLowerCase() || "plane";
  if (value === "plane" || value === "bored") return value;
  throw new Error(`BECKETT_TRACKER must be "plane" or "bored" (got ${JSON.stringify(value)})`);
}

/** Construct the selected backend. Plane is deliberately the default. */
export function createTrackerClient(deps: CreateTrackerClientDeps): TrackerClient {
  return trackerKind() === "bored"
    ? createBoredClient(deps)
    : createPlaneClient(deps);
}
