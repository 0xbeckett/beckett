/**
 * Beckett v3 — Plane REST client (`src/plane/client.ts`)
 * =======================================================================================
 * The ONLY module that speaks HTTP to the self-hosted Plane instance (`plane.0xbeckett.me`).
 * It hydrates raw Plane issues into Beckett {@link Ticket}s (running {@link parseCast} over the
 * description) and translates Beckett's {@link TicketState} ⇄ Plane workflow-state UUIDs via
 * `config.plane.state_map` + the project's live state list (see {@link PlaneClient.listStates}).
 *
 * Auth is subscription-free API-token: `X-API-Key: ${PLANE_API_TOKEN}` read from the
 * environment (never from `config.toml`, per Spec v3 §10). External JSON is validated with zod at
 * the boundary (the repo convention) — a missing/odd field degrades, it never crashes hydration.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions.
 */

import { z } from "zod";
import { log } from "../log.ts";
import type { Config, Logger } from "../types.ts";
import { parseCast, serializeCast } from "./cast.ts";
import type { Casting, PlaneComment, Ticket, TicketState } from "./types.ts";

// =======================================================================================
// Public input/dependency shapes (the contract in docs/V3.md §3)
// =======================================================================================

/** Inputs to {@link PlaneClient.createIssue}. `body`/`description` are aliases (prose only). */
export interface CreateTicketInput {
  title: string;
  /** Human prose body; {@link serializeCast} composes the final Plane description. */
  body?: string;
  /** Alias for {@link CreateTicketInput.body} (the CLI / Concierge may pass either name). */
  description?: string;
  casting?: Casting;
  criteria?: string[];
  /** Identifiers of tickets this one is blocked by (held in `backlog` until all are `done`). */
  blockedBy?: string[];
  /** Code-project slug — the ticket's own repo under `~/Projects/<project>` (see {@link Ticket.project}). */
  project?: string;
  /** Lifecycle state to file into; defaults to `"backlog"`. */
  state?: TicketState;
  /** Plane member ids to assign. */
  assignees?: string[];
  /**
   * Discord channel that originated this ticket. Stored as a marker in the description so
   * worker/ticket updates route back to the right conversation (closed agent loop). Stripped
   * back out on hydration into {@link Ticket.originChannel} — workers never see it.
   */
  originChannel?: string;
}

/** Constructor dependencies for {@link PlaneClient}. */
export interface PlaneClientDeps {
  config: Config;
  /** API token; defaults to `process.env.PLANE_API_TOKEN`. */
  token?: string;
  logger?: Logger;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** A Plane workflow state, as returned by the states endpoint. */
export interface PlaneState {
  id: string;
  name: string;
  group?: string;
}

/** An HTTP error from the Plane API, carrying the status code for callers to branch on. */
export class PlaneApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlaneApiError";
  }
}

// =======================================================================================
// zod schemas — validate Plane's raw JSON at the boundary (never trust the wire)
// =======================================================================================

const IssueSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    description_html: z.string().nullable().optional(),
    description_stripped: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    sequence_id: z.number().nullable().optional(),
    project: z.string().nullable().optional(),
    assignees: z.array(z.string()).nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

const StateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    group: z.string().nullable().optional(),
  })
  .passthrough();

const CommentSchema = z
  .object({
    id: z.string(),
    comment_html: z.string().nullable().optional(),
    comment_stripped: z.string().nullable().optional(),
    actor: z.string().nullable().optional(),
    actor_detail: z
      .object({ display_name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    created_by: z.string().nullable().optional(),
    issue: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();

const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    identifier: z.string().nullable().optional(),
  })
  .passthrough();

/** Plane's cursor-paginated envelope (some endpoints return a bare array instead). */
const PageSchema = z
  .object({
    results: z.array(z.unknown()).optional(),
    next_cursor: z.string().nullable().optional(),
    next_page_results: z.boolean().nullable().optional(),
  })
  .passthrough();

// =======================================================================================
// HTML <-> text helpers (we own the round-trip for our own writes)
// =======================================================================================

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;|&#39;|&amp;|&lt;|&gt;|&quot;|&nbsp;/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/**
 * Render arbitrary text into Plane `description_html`. We wrap in a single `<pre>` so the cast
 * fence + criteria bullets survive verbatim (no whitespace collapse), which {@link htmlToText}
 * reverses exactly. Used for issue descriptions.
 */
function textToPreHtml(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

/**
 * The Discord-origin marker stored at the tail of an issue description (closed agent loop). It is
 * an HTML-comment-shaped token but stored as ESCAPED text inside the `<pre>` (see
 * {@link textToPreHtml}), so Plane's sanitizer treats it as literal text and it round-trips
 * verbatim — yet it never collides with the cast/criteria parser.
 */
const ORIGIN_MARKER_RE = /<!--\s*beckett-origin:\s*([^\s>]+)\s*-->/i;

/** Append the origin marker to a serialized description (no-op when no channel is given). */
export function withOriginMarker(description: string, channel?: string): string {
  if (!channel) return description;
  const marker = `<!-- beckett-origin: ${channel} -->`;
  return description ? `${description}\n\n${marker}` : marker;
}

/** Split the origin channel back off a stored description; returns the cleaned description. */
export function extractOriginMarker(stored: string): { channel?: string; description: string } {
  const m = stored.match(ORIGIN_MARKER_RE);
  if (!m) return { description: stored };
  const channel = m[1];
  const description = stored.replace(ORIGIN_MARKER_RE, "").trim();
  return { channel, description };
}

/** Render text into paragraph HTML (one `<p>` per line) — used for comment bodies. */
function textToParagraphHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.map((l) => (l.length ? `<p>${escapeHtml(l)}</p>` : "<p></p>")).join("");
}

/**
 * Recover plain text from a Plane HTML field. For our own `<pre>`-wrapped writes this is an exact
 * inverse of {@link textToPreHtml}; for human-edited rich text it falls back to a generic
 * block-aware tag strip. `stripped` (Plane's `*_stripped`) is the last resort.
 */
function htmlToText(html?: string | null, stripped?: string | null): string {
  if (!html) return (stripped ?? "").trim();

  const preMatch = html.match(/^\s*<pre[^>]*>([\s\S]*?)<\/pre>\s*$/i);
  if (preMatch) return decodeEntities(preMatch[1] ?? "").trim();

  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();
}

// =======================================================================================
// PlaneClient
// =======================================================================================

export class PlaneClient {
  private readonly config: Config;
  private readonly token?: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  // Lazily-resolved + cached project + workflow-state lookups.
  private projectId: string | null = null;
  private projectIdentifier: string | null = null;
  private statesByName: Map<string, PlaneState> | null = null; // name(lower) -> state
  private idToTicketState: Map<string, TicketState> | null = null;
  private cachedStates: PlaneState[] | null = null;

  constructor(deps: PlaneClientDeps) {
    this.config = deps.config;
    this.token = deps.token;
    this.logger = deps.logger ?? log.child("plane.client");
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    // API calls use the internal URL when set (bypasses the public auth gate / TLS);
    // base_url stays public for human-facing ticket links.
    const apiRoot = (process.env.PLANE_INTERNAL_URL ?? this.config.plane.base_url).replace(/\/+$/, "");
    this.apiBase = `${apiRoot}/api/v1/workspaces/${this.config.plane.workspace_slug}`;
  }

  // ── public surface (docs/V3.md §3) ───────────────────────────────────────────────────

  /** All issues in the configured project, hydrated to {@link Ticket}s. `updatedSince` narrows. */
  async listIssues(opts?: { updatedSince?: string }): Promise<Ticket[]> {
    await this.bootstrap();
    const raw = await this.fetchAllPages(this.issuesPath());
    let tickets = raw.map((r) => this.hydrate(r));
    if (opts?.updatedSince) {
      const since = opts.updatedSince;
      tickets = tickets.filter((t) => t.updatedAt > since);
    }
    return tickets;
  }

  /** One issue by Plane id, hydrated; `null` on 404. */
  async getIssue(id: string): Promise<Ticket | null> {
    await this.bootstrap();
    try {
      const raw = await this.req("GET", `${this.issuesPath()}${encodeURIComponent(id)}/`);
      return this.hydrate(raw);
    } catch (err) {
      if (err instanceof PlaneApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Create an issue; serializes casting+criteria+body into the description. Returns hydrated. */
  async createIssue(input: CreateTicketInput): Promise<Ticket> {
    await this.bootstrap();
    const body = input.body ?? input.description ?? "";
    const casting = input.casting ?? {};
    const criteria = input.criteria ?? [];
    const blockedBy = input.blockedBy ?? [];
    const description = withOriginMarker(
      serializeCast(casting, criteria, body, blockedBy, input.project),
      input.originChannel,
    );
    const payload: Record<string, unknown> = {
      name: input.title,
      description_html: textToPreHtml(description),
      state: this.resolveStateId(input.state ?? "backlog"),
    };
    if (input.assignees && input.assignees.length > 0) payload.assignees = input.assignees;

    const raw = await this.req("POST", this.issuesPath(), payload);
    return this.hydrate(raw);
  }

  /** Move a ticket to a new lifecycle state (resolves `state_map` name → Plane state UUID). */
  async setState(id: string, state: TicketState): Promise<void> {
    await this.bootstrap();
    await this.req("PATCH", `${this.issuesPath()}${encodeURIComponent(id)}/`, {
      state: this.resolveStateId(state),
    });
    this.logger.info("ticket state set", { ticketId: id, state });
  }

  /** Alias for {@link setState} (the task's `setIssueState(id, state)` name). */
  setIssueState(id: string, state: TicketState): Promise<void> {
    return this.setState(id, state);
  }

  /** Comments on an issue, oldest→newest. `since` (ISO) returns only strictly-newer comments. */
  async listComments(ticketId: string, since?: string): Promise<PlaneComment[]> {
    await this.bootstrap();
    const raw = await this.fetchAllPages(
      `${this.issuesPath()}${encodeURIComponent(ticketId)}/comments/`,
    );
    let comments = raw
      .map((r) => this.hydrateComment(ticketId, r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (since) comments = comments.filter((c) => c.createdAt > since);
    return comments;
  }

  /** Post a comment (worker summaries + dispatcher status). Returns the created comment. */
  async addComment(ticketId: string, body: string): Promise<PlaneComment> {
    await this.bootstrap();
    const raw = await this.req(
      "POST",
      `${this.issuesPath()}${encodeURIComponent(ticketId)}/comments/`,
      { comment_html: textToParagraphHtml(body) },
    );
    return this.hydrateComment(ticketId, raw);
  }

  /** The project's Plane workflow states (cached after the first call). */
  async listStates(): Promise<PlaneState[]> {
    await this.bootstrap();
    return this.cachedStates ? [...this.cachedStates] : [];
  }

  // ── hydration ────────────────────────────────────────────────────────────────────────

  private hydrate(raw: unknown): Ticket {
    const issue = IssueSchema.parse(raw);
    const storedDescription = htmlToText(issue.description_html, issue.description_stripped);
    // Pull the origin-channel marker out before anything else parses the description, so neither
    // the worker body nor the cast parser ever sees it (the closed agent loop's routing key).
    const { channel: originChannel, description: rawDescription } = extractOriginMarker(storedDescription);
    const { casting, criteria, blockedBy, project, body } = parseCast(rawDescription);
    const state = this.reverseState(issue.state ?? null);
    const identifier =
      issue.sequence_id != null && this.projectIdentifier
        ? `${this.projectIdentifier}-${issue.sequence_id}`
        : issue.id;
    const projectId = issue.project ?? this.projectId ?? "";
    return {
      id: issue.id,
      identifier,
      title: issue.name,
      description: rawDescription,
      body,
      state,
      assignees: issue.assignees ?? [],
      casting,
      criteria,
      blockedBy,
      ...(project ? { project } : {}),
      projectId,
      url: `${this.config.plane.base_url.replace(/\/+$/, "")}/${this.config.plane.workspace_slug}/projects/${projectId}/issues/${issue.id}`,
      updatedAt: issue.updated_at ?? issue.created_at ?? new Date(0).toISOString(),
      ...(originChannel ? { originChannel } : {}),
    };
  }

  private hydrateComment(ticketId: string, raw: unknown): PlaneComment {
    const c = CommentSchema.parse(raw);
    const author = c.actor_detail?.display_name ?? c.actor ?? c.created_by ?? "unknown";
    return {
      id: c.id,
      ticketId,
      author,
      body: htmlToText(c.comment_html, c.comment_stripped),
      createdAt: c.created_at ?? new Date(0).toISOString(),
    };
  }

  // ── state translation (config.plane.state_map ⇄ Plane UUIDs) ──────────────────────────

  /** Plane state UUID for a Beckett {@link TicketState}; throws if Plane lacks that state. */
  private resolveStateId(state: TicketState): string {
    const name = this.config.plane.state_map[state];
    const found = this.statesByName?.get(name.toLowerCase());
    if (!found) {
      throw new PlaneApiError(
        0,
        `no Plane workflow state named "${name}" (for TicketState "${state}") in project ${this.projectIdentifier ?? this.projectId}; ` +
          `available: ${(this.cachedStates ?? []).map((s) => s.name).join(", ") || "none"}`,
      );
    }
    return found.id;
  }

  /** Beckett {@link TicketState} for a Plane state UUID; unmapped → `"backlog"` (logged). */
  private reverseState(stateId: string | null): TicketState {
    if (!stateId) return "backlog";
    const mapped = this.idToTicketState?.get(stateId);
    if (mapped) return mapped;
    this.logger.warn("unmapped Plane state — defaulting to backlog", { stateId });
    return "backlog";
  }

  // ── bootstrap: resolve project + workflow states (cached) ─────────────────────────────

  private async bootstrap(): Promise<void> {
    if (this.projectId && this.statesByName && this.idToTicketState) return;
    await this.resolveProject();
    await this.loadStates();
  }

  private async resolveProject(): Promise<void> {
    if (this.projectId) return;
    const raw = await this.fetchAllPages(`${this.apiBase}/projects/`);
    const slug = this.config.plane.project_slug.toLowerCase();
    const projects = raw.map((r) => ProjectSchema.parse(r));
    const match =
      projects.find((p) => (p.identifier ?? "").toLowerCase() === slug) ??
      projects.find((p) => p.name.toLowerCase() === slug) ??
      projects.find((p) => p.id.toLowerCase() === slug);
    if (!match) {
      throw new PlaneApiError(
        0,
        `no Plane project matching slug "${this.config.plane.project_slug}" in workspace ` +
          `"${this.config.plane.workspace_slug}" (have: ${projects.map((p) => p.identifier ?? p.name).join(", ") || "none"})`,
      );
    }
    this.projectId = match.id;
    this.projectIdentifier = match.identifier ?? match.name ?? null;
    this.logger.info("resolved Plane project", {
      slug: this.config.plane.project_slug,
      projectId: this.projectId,
      identifier: this.projectIdentifier,
    });
  }

  private async loadStates(): Promise<void> {
    if (this.statesByName && this.idToTicketState) return;
    const raw = await this.fetchAllPages(`${this.issuesProjectPath()}states/`);
    const states: PlaneState[] = raw.map((r) => {
      const s = StateSchema.parse(r);
      return { id: s.id, name: s.name, group: s.group ?? undefined };
    });
    const byName = new Map<string, PlaneState>();
    for (const s of states) byName.set(s.name.toLowerCase(), s);

    const reverse = new Map<string, TicketState>();
    const ticketStates: TicketState[] = [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ];
    for (const ts of ticketStates) {
      const name = this.config.plane.state_map[ts];
      const st = byName.get(name.toLowerCase());
      if (st) reverse.set(st.id, ts);
      else
        this.logger.warn("state_map name has no matching Plane state", {
          ticketState: ts,
          name,
        });
    }

    this.cachedStates = states;
    this.statesByName = byName;
    this.idToTicketState = reverse;
  }

  // ── path helpers ───────────────────────────────────────────────────────────────────────

  private issuesProjectPath(): string {
    return `${this.apiBase}/projects/${this.projectId}/`;
  }

  private issuesPath(): string {
    return `${this.issuesProjectPath()}issues/`;
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────────────────────

  /** Walk Plane's cursor pagination, collecting every result row (bare-array tolerant). */
  private async fetchAllPages(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const q: Record<string, string> = { ...query, per_page: "100" };
      if (cursor) q.cursor = cursor;
      const raw = await this.req("GET", path, undefined, q);
      if (Array.isArray(raw)) {
        out.push(...raw);
        break;
      }
      const page = PageSchema.parse(raw);
      if (page.results) out.push(...page.results);
      cursor = page.next_page_results && page.next_cursor ? page.next_cursor : undefined;
      guard += 1;
    } while (cursor && guard < 50);
    return out;
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const token = this.token ?? process.env.PLANE_API_TOKEN;
    if (!token) {
      throw new PlaneApiError(0, "PLANE_API_TOKEN is not set in the environment");
    }
    const qs = query
      ? "?" +
        Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const url = path + qs;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          // Plane personal API tokens authenticate via X-API-Key (not Bearer).
          "X-API-Key": token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new PlaneApiError(0, `network error on ${method} ${url}: ${(err as Error).message}`);
    }

    if (res.status === 404) throw new PlaneApiError(404, `${method} ${url} → 404 not found`);
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        /* ignore body read failure */
      }
      throw new PlaneApiError(res.status, `${method} ${url} → ${res.status}: ${detail}`);
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}

/** Factory matching the repo's `createX(deps)` convention (see `createWorkerManager`). */
export function createPlaneClient(deps: PlaneClientDeps): PlaneClient {
  return new PlaneClient(deps);
}
