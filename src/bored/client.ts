/**
 * HTTP adapter for bored's loopback tracker API.
 *
 * bored deliberately exposes a smaller, workflow-oriented API than Plane. This adapter keeps
 * Beckett's dispatch-facing Ticket contract stable: Bored refs become ticket ids, and the
 * serialized cast remains in the ticket body just as it did in Plane descriptions.
 */
import { z } from "zod";
import { log } from "../log.ts";
import { resolvePlaneBoardName } from "../config.ts";
import type { Config, Logger } from "../types.ts";
import { parseCast, serializeCast } from "../plane/cast.ts";
import type { CreateTicketInput, PlaneProvisioningResult, PlaneState } from "../plane/client.ts";
import type { Casting, PlaneComment, Ticket, TicketState } from "../plane/types.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_MAX_ATTEMPTS = 7;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface BoredClientDeps {
  config: Config;
  logger?: Logger;
  /** Defaults to BECKETT_BORED_URL, then bored's managed-service loopback URL. */
  baseUrl?: string;
  board?: string;
  fetch?: typeof fetch;
}

export class BoredApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BoredApiError";
  }
}

const TicketStateSchema = z.enum([
  "backlog", "todo", "design", "design_review", "in_progress", "in_review", "done", "cancelled",
]);
const BoredTicketSchema = z.object({
  ref: z.string(),
  title: z.string(),
  body: z.string().optional(),
  criteria: z.array(z.string()).optional(),
  state: TicketStateSchema,
  originChannel: z.string().optional(),
  parent: z.string().optional(),
  needs: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();
const EventSchema = z.object({
  seq: z.number(),
  timestamp: z.string(),
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

/** Bored's tracker client, shaped to satisfy TrackerClient. */
export class BoredClient {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly boardName: string;
  private lastHttpStatus: number | null = null;
  private lastOkAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;

  constructor(deps: BoredClientDeps) {
    this.config = deps.config;
    this.logger = deps.logger ?? log.child("bored.client");
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiBase = (deps.baseUrl ?? process.env.BECKETT_BORED_URL ?? "http://127.0.0.1:7770").replace(/\/+$/, "");
    this.boardName = resolvePlaneBoardName(this.config, deps.board);
  }

  stats(): { lastHttpStatus: number | null; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null } {
    return { lastHttpStatus: this.lastHttpStatus, lastOkAt: this.lastOkAt, lastErrorAt: this.lastErrorAt, lastError: this.lastError };
  }

  async listIssues(opts?: { updatedSince?: string }): Promise<Ticket[]> {
    const response = await this.req("GET", "/tickets") as { tickets?: unknown };
    const tickets = z.array(BoredTicketSchema).parse(response.tickets ?? []).map((ticket) => this.hydrate(ticket));
    return opts?.updatedSince ? tickets.filter((ticket) => ticket.updatedAt > opts.updatedSince!) : tickets;
  }

  async listIssueHeads(): Promise<Array<{ id: string; updatedAt: string }>> {
    const response = await this.req("GET", "/tickets") as { tickets?: unknown };
    return z.array(BoredTicketSchema).parse(response.tickets ?? []).map((ticket) => ({ id: ticket.ref, updatedAt: ticket.updatedAt }));
  }

  async getIssue(id: string): Promise<Ticket | null> {
    try {
      const response = await this.req("GET", this.ticketPath(id)) as { ticket?: unknown };
      return this.hydrate(BoredTicketSchema.parse(response.ticket));
    } catch (err) {
      if (err instanceof BoredApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createIssue(input: CreateTicketInput): Promise<Ticket> {
    const body = input.body ?? input.description ?? "";
    const description = serializeCast(
      input.casting ?? {}, input.criteria ?? [], body, input.blockedBy ?? [], input.project,
      input.branchRef, input.branchRef ? (input.startState ?? input.state) : undefined, input.targetBranch,
    );
    const response = await this.req("POST", "/tickets", {
      title: input.title,
      body: description,
      criteria: input.criteria ?? [],
      needs: input.blockedBy ?? [],
      ...(input.parentId ? { parent: input.parentId } : {}),
      ...(input.originChannel ? { originChannel: input.originChannel } : {}),
      // Beckett's dispatcher owns staffing while this additive adapter is selected. Letting
      // bored auto-staff would launch a second worker for the same ticket.
      autoStaff: false,
    }) as { ticket?: unknown };
    const ticket = this.hydrate(BoredTicketSchema.parse(response.ticket));
    // Bored files ready tickets as `todo`; unlike Plane it has no mutable backlog column.
    // Do not turn Plane's omitted/default backlog into a failing write; explicit transitions
    // still go through the supported workflow verbs below.
    if (input.state && input.state !== ticket.state) await this.setState(ticket.id, input.state);
    return (await this.getIssue(ticket.id)) ?? ticket;
  }

  async setState(id: string, state: TicketState): Promise<void> {
    // These are the state transitions bored's public API can honestly perform. Its state is a
    // projection of its run, not a mutable column like Plane's workflow state.
    switch (state) {
      case "in_progress":
        await this.req("POST", `${this.ticketPath(id)}/staff`, {});
        break;
      case "in_review":
        await this.req("POST", `${this.ticketPath(id)}/pause`, {});
        break;
      case "cancelled":
        await this.req("POST", `${this.ticketPath(id)}/cancel`, {});
        break;
      default:
        throw new BoredApiError(501, `bored cannot set ${state}: its HTTP API projects this state from a workflow run`);
    }
    this.logger.info("ticket state requested", { ticketId: id, state });
  }

  setIssueState(id: string, state: TicketState): Promise<void> {
    return this.setState(id, state);
  }

  /** Bored's event journal is its comment-equivalent; nudges are the human text dispatch consumes. */
  async listComments(ticketId: string, since?: string, opts: { inclusive?: boolean } = {}): Promise<PlaneComment[]> {
    const events = await this.listEvents(ticketId);
    return events
      .filter((event) => event.type === "nudge_delivered" && typeof event.text === "string")
      .map((event) => ({
        id: `${ticketId}:event:${event.seq}`,
        ticketId,
        author: "bored",
        body: event.text!,
        createdAt: event.timestamp,
      }))
      .filter((comment) => !since || (opts.inclusive ? comment.createdAt >= since : comment.createdAt > since))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Bored has no free-form comment resource. A dispatcher note is sent through its documented
   * nudge endpoint and is subsequently visible through the event journal above.
   */
  async addComment(ticketId: string, body: string): Promise<PlaneComment> {
    const response = await this.req("POST", `${this.ticketPath(ticketId)}/nudge`, { text: body }) as {
      receipt?: { target?: string };
    };
    return {
      id: `${ticketId}:nudge:${response.receipt?.target ?? Date.now()}`,
      ticketId,
      author: "beckett",
      body,
      createdAt: new Date().toISOString(),
    };
  }

  /** Raw human journal exposed by bored for operator and diagnostic consumers. */
  async listJournal(ticketId: string, tail?: number): Promise<string[]> {
    const query = tail === undefined ? "" : `?tail=${encodeURIComponent(String(tail))}`;
    const response = await this.req("GET", `${this.ticketPath(ticketId)}/journal${query}`) as { journal?: unknown };
    return z.array(z.string()).parse(response.journal ?? []);
  }

  /** Structured event feed used as the poller's comment/nudge equivalent. */
  private async listEvents(ticketId: string, tail?: number): Promise<Array<z.infer<typeof EventSchema>>> {
    const query = tail === undefined ? "" : `?tail=${encodeURIComponent(String(tail))}`;
    const response = await this.req("GET", `${this.ticketPath(ticketId)}/events${query}`) as { events?: unknown };
    return z.array(EventSchema).parse(response.events ?? []);
  }

  board(): string { return this.boardName; }

  async projectInfo(): Promise<{ board: string; projectId: string; identifier: string | null }> {
    return { board: this.boardName, projectId: `bored:${this.boardName}`, identifier: this.boardName };
  }

  async listStates(): Promise<PlaneState[]> {
    return ["backlog", "todo", "design", "design_review", "in_progress", "in_review", "done", "cancelled"]
      .map((name) => ({ id: name, name }));
  }

  /** Bored is provisioned by its managed service; clients do not create boards or states. */
  async ensureProvisioned(): Promise<PlaneProvisioningResult> {
    await this.req("GET", "/health");
    return { projectCreated: false, statesCreated: [] };
  }

  private hydrate(raw: z.infer<typeof BoredTicketSchema>): Ticket {
    const description = raw.body ?? "";
    const parsed = parseCast(description);
    return {
      id: raw.ref,
      identifier: raw.ref,
      title: raw.title,
      description,
      body: parsed.body || description,
      state: raw.state,
      assignees: [],
      casting: parsed.casting as Casting,
      criteria: parsed.criteria.length ? parsed.criteria : raw.criteria ?? [],
      blockedBy: parsed.blockedBy.length ? parsed.blockedBy : raw.needs,
      ...(parsed.project ? { project: parsed.project } : {}),
      ...(parsed.branchRef ? { branchRef: parsed.branchRef } : {}),
      ...(parsed.targetBranch ? { targetBranch: parsed.targetBranch } : {}),
      ...(raw.parent ? { parentId: raw.parent } : {}),
      ...(parsed.startState ? { startState: parsed.startState } : {}),
      projectId: `bored:${this.boardName}`,
      url: `${this.apiBase}/tickets/${encodeURIComponent(raw.ref)}`,
      updatedAt: raw.updatedAt,
      ...(raw.originChannel ? { originChannel: raw.originChannel } : {}),
    };
  }

  private ticketPath(id: string): string {
    return `/tickets/${encodeURIComponent(id)}`;
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiBase}${path}`;
    for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        this.lastHttpStatus = res.status;
        if (!res.ok) {
          let detail = "";
          try { detail = (await res.text()).slice(0, 500); } catch { /* ignored */ }
          const error = new BoredApiError(res.status, `${method} ${url} → ${res.status}: ${detail}`);
          if (attempt < REQUEST_MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
            await this.sleep(this.retryDelay(attempt, res.headers.get("Retry-After")));
            continue;
          }
          throw this.recordError(error);
        }
        this.lastOkAt = Date.now();
        return res.status === 204 ? undefined : await res.json();
      } catch (err) {
        if (err instanceof BoredApiError) throw err;
        if (attempt < REQUEST_MAX_ATTEMPTS) {
          await this.sleep(this.retryDelay(attempt, null));
          continue;
        }
        throw this.recordError(new BoredApiError(0, `network error on ${method} ${url}: ${(err as Error).message}`));
      }
    }
    throw this.recordError(new BoredApiError(0, `network error on ${method} ${url}: exhausted retries`));
  }

  private retryDelay(attempt: number, retryAfter: string | null): number {
    const seconds = Number(retryAfter);
    const hinted = retryAfter && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
    return Math.min(RETRY_MAX_MS, hinted ?? RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
  private recordError(error: BoredApiError): BoredApiError {
    this.lastErrorAt = Date.now();
    this.lastError = error.message.slice(0, 300);
    return error;
  }
}

export function createBoredClient(deps: BoredClientDeps): BoredClient {
  return new BoredClient(deps);
}
