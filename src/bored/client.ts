/**
 * HTTP adapter for bored's loopback tracker API.
 *
 * bored exposes a small, workflow-oriented API. This adapter keeps Beckett's dispatch-facing
 * Ticket contract stable: Bored refs are the ticket ids, and the serialized cast lives in the
 * ticket body (the same fenced-block format the cast module has always used).
 */
import { z } from "zod";
import { log } from "../log.ts";
import { resolveBoardName } from "../config.ts";
import type { Config, Logger } from "../types.ts";
import { parseCast, serializeCast } from "../tracker/cast.ts";
import type { CreateTicketInput, ProvisioningResult, WorkflowState } from "../tracker/types.ts";
import type { Casting, TicketComment, Ticket, TicketState } from "../tracker/types.ts";

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

/** bored's loopback base URL: BECKETT_BORED_URL, else the managed-service default. */
export function boredBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.BECKETT_BORED_URL ?? "http://127.0.0.1:7770").replace(/\/+$/, "");
}

const TicketStateSchema = z.enum([
  "backlog", "todo", "plan", "design", "design_review", "in_progress", "in_review", "done", "cancelled",
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

/**
 * A THREE-gate Bored flow used only as a state bridge. Bored keeps the durable source of truth
 * and its documented `staff`/`gate` verbs advance the same states the legacy dispatcher requests;
 * human gates deliberately spawn no Bored worker, so there is never a duplicate harness process.
 *
 * `beckett_plan` is now the ENTRY node (issue #128): every ticket's flow run starts at Plan, not
 * Implement — the state-machine half of the guarantee that no ticket reaches an implement worker
 * without a strong-seat-authored brief first (the other half is `implementStage.entryGuard` in
 * `dispatch/stages.ts`, which is the actual enforcement point; this flow shape just keeps Bored's
 * own projection honest about the order work happens in). `onFail` parks rather than looping —
 * the dispatcher's own `planCycles` cap (not this static Bored node cap) decides whether a failed
 * plan check gets another authoring pass; see `dispatch/plan-stage.ts`'s `planCheckStage`, which
 * retries by re-spawning `plan` directly (no `beckett_plan` gate verdict) rather than by feeding
 * this node a `fail`, so a same-state retry never needs a state Bored's HTTP API can't set (unlike
 * INT's `design`/`design_review`, which is not wired here and would 501 if you tried).
 */
function dispatcherBridgeFlow(): Record<string, unknown> {
  return {
    version: 1,
    entry: "beckett_plan",
    nodes: {
      beckett_plan: {
        kind: "gate", by: "human", onPass: "beckett_implement", onFail: "park", maxFails: 3, maxVisits: 4,
      },
      beckett_implement: {
        kind: "gate", by: "human", onPass: "beckett_review", onFail: "park", maxFails: 1, maxVisits: 1,
      },
      beckett_review: {
        kind: "gate", by: "human", onPass: "done", onFail: "beckett_implement", maxFails: 3, maxVisits: 3,
      },
    },
  };
}

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
    this.apiBase = deps.baseUrl?.replace(/\/+$/, "") ?? boredBaseUrl();
    this.boardName = resolveBoardName(this.config, deps.board);
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
      // The bridge flow makes bored's projected state follow the existing dispatcher without
      // launching a second worker. Each human gate is advanced by setState below.
      flow: dispatcherBridgeFlow(),
      stateMap: { beckett_plan: "plan", beckett_implement: "in_progress", beckett_review: "in_review" },
      autoStaff: false,
    }) as { ticket?: unknown };
    const ticket = this.hydrate(BoredTicketSchema.parse(response.ticket));
    // Bored files ready tickets as `todo`; it has no mutable backlog column. Do not turn an
    // omitted/default backlog request into a failing write; explicit transitions still go
    // through the supported workflow verbs below.
    if (input.state && input.state !== ticket.state) {
      // A direct filing may request a later lifecycle state. Walk the bridge in order so Bored
      // has opened the run before a gate is decided.
      if (input.state === "in_review" || input.state === "done") {
        await this.setState(ticket.id, "in_progress");
        await this.setState(ticket.id, "in_review");
      }
      if (input.state === "done") await this.setState(ticket.id, "done");
      else if (input.state !== "in_review") await this.setState(ticket.id, input.state);
    }
    return (await this.getIssue(ticket.id)) ?? ticket;
  }

  async setState(id: string, state: TicketState): Promise<void> {
    // Bored's state is a workflow projection, not a mutable column. The bridge flow above
    // translates the dispatcher's lifecycle writes into Bored's documented workflow verbs.
    switch (state) {
      case "plan": {
        // The flow's ENTRY node (issue #128) — an unstaffed backlog/todo ticket starts its run
        // here, never at beckett_implement. A same-state "please re-author" request (the plan
        // checker found gaps and there's cycle budget left) does NOT come through here: it never
        // changes ticket.state, so `planCheckStage`'s finish handler re-spawns the `plan` stage
        // directly (`ops.spawnStage`) instead of asking Bored to re-set a state it's already in —
        // unlike INT's `design`, which tries exactly that and 501s (no case below handles it).
        await this.req("POST", `${this.ticketPath(id)}/staff`, {});
        break;
      }
      case "in_progress": {
        // Three distinct callers ask for `in_progress`, and only the read tells them apart:
        //   - a reviewer sending work back for rework → Bored's `beckett_review` fail edge.
        //   - the plan-completeness checker passing its own gate → `beckett_plan` pass edge,
        //     advancing the flow onto `beckett_implement` (the plan → implement handoff).
        //   - anything else (legacy/direct request with no active Plan run for this ticket) →
        //     fall back to staffing fresh. On a real Bored flow that starts a run at the entry
        //     node (`beckett_plan`), so a caller that tries to skip straight to `in_progress`
        //     lands the ticket in `plan` instead of the state it asked for — the tracker itself
        //     refuses to originate work at Implement, on top of `implementStage.entryGuard`.
        const current = await this.getIssue(id);
        if (current?.state === "in_review") {
          await this.req("POST", `${this.ticketPath(id)}/gate`, { node: "beckett_review", verdict: "fail" });
        } else if (current?.state === "plan") {
          await this.req("POST", `${this.ticketPath(id)}/gate`, { node: "beckett_plan", verdict: "pass" });
        } else {
          await this.req("POST", `${this.ticketPath(id)}/staff`, {});
        }
        break;
      }
      case "in_review":
        await this.req("POST", `${this.ticketPath(id)}/gate`, { node: "beckett_implement", verdict: "pass" });
        break;
      case "done":
        await this.req("POST", `${this.ticketPath(id)}/gate`, { node: "beckett_review", verdict: "pass" });
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

  /**
   * Beckett's bridge uses Bored human gates, which are already workflow-parked while still
   * projected as active columns. The dispatcher persists the explicit hold in its runtime state;
   * there is no second Bored transition to request here.
   */
  async park(id: string): Promise<void> {
    this.logger.info("ticket parked for a human in dispatcher state", { ticketId: id });
  }

  /** An explicit dispatcher re-staff owns resuming its local hold; Bored's bridge gate stays put. */
  async resume(id: string): Promise<void> {
    this.logger.info("ticket resumed from dispatcher human hold", { ticketId: id });
  }

  /** Bored's event journal is its comment-equivalent; nudges are the human text dispatch consumes. */
  async listComments(ticketId: string, since?: string, opts: { inclusive?: boolean } = {}): Promise<TicketComment[]> {
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
  async addComment(ticketId: string, body: string): Promise<TicketComment> {
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

  async listStates(): Promise<WorkflowState[]> {
    return ["backlog", "todo", "plan", "design", "design_review", "in_progress", "in_review", "done", "cancelled"]
      .map((name) => ({ id: name, name }));
  }

  /** Bored is provisioned by its managed service; clients do not create boards or states. */
  async ensureProvisioned(): Promise<ProvisioningResult> {
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
      createdAt: raw.createdAt,
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
