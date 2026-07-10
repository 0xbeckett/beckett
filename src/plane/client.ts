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
import { resolvePlaneBoard, resolvePlaneBoardName } from "../config.ts";
import type { Config, Logger } from "../types.ts";
import { parseCast, serializeCast } from "./cast.ts";
import type { Casting, PlaneComment, Ticket, TicketState } from "./types.ts";

const REQUEST_TIMEOUT_MS = 15_000;
// Six retry windows cover a one-minute DRF rate-limit window (1 + 2 + 4 + 8 + 16 + 30s).
// This keeps a boot-time burst invisible to callers while remaining bounded when Plane is down.
const REQUEST_MAX_ATTEMPTS = 7;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const RETRY_JITTER_RATIO = 0.25;

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
  /** Named Plane board to scope this client to; defaults to config.plane.default_board. */
  board?: string;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** A Plane workflow state, as returned by the states endpoint. */
export interface PlaneState {
  id: string;
  name: string;
  group?: string;
}

/** What a call to {@link PlaneClient.ensureProvisioned} had to create. */
export interface PlaneProvisioningResult {
  projectCreated: boolean;
  statesCreated: string[];
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

/** The slim `fields=id,updated_at` row {@link PlaneClient.listIssueHeads} sweeps (issue #33). */
const IssueHeadSchema = z.object({ id: z.string(), updated_at: z.string() }).passthrough();

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
  private readonly boardName: string;
  private readonly boardConfig: Config["plane"]["boards"][string];

  // Rolling health counters for the `beckett status` surface (issue #30).
  private lastHttpStatus: number | null = null;
  private lastOkAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;

  // Lazily-resolved + cached project + workflow-state lookups.
  private projectId: string | null = null;
  private projectIdentifier: string | null = null;
  private statesByName: Map<string, PlaneState> | null = null; // name(lower) -> state
  private idToTicketState: Map<string, TicketState> | null = null;
  private cachedStates: PlaneState[] | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  /** Deduplicates concurrent startup callers while this board is being provisioned. */
  private provisionPromise: Promise<PlaneProvisioningResult> | null = null;
  private provisioned = false;

  constructor(deps: PlaneClientDeps) {
    this.config = deps.config;
    this.token = deps.token;
    this.logger = deps.logger ?? log.child("plane.client");
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.boardName = resolvePlaneBoardName(this.config, deps.board);
    this.boardConfig = resolvePlaneBoard(this.config, this.boardName);
    // API calls use the internal URL when set (bypasses the public auth gate / TLS);
    // base_url stays public for human-facing ticket links.
    const apiRoot = (process.env.PLANE_INTERNAL_URL ?? this.config.plane.base_url).replace(/\/+$/, "");
    this.apiBase = `${apiRoot}/api/v1/workspaces/${this.config.plane.workspace_slug}`;
  }

  // ── public surface (docs/V3.md §3) ───────────────────────────────────────────────────

  /**
   * Rolling API health for `beckett status` (issue #30): the last HTTP status Plane returned,
   * when the last successful call landed, and the last error seen. Purely observational.
   */
  stats(): { lastHttpStatus: number | null; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null } {
    return {
      lastHttpStatus: this.lastHttpStatus,
      lastOkAt: this.lastOkAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
    };
  }

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

  /**
   * The polling diet's cheap sweep (issue #33): id + updated_at ONLY for every issue in the
   * project, via Plane's server-side `fields=` narrowing (verified honored on this instance).
   * No `description_html`, no zod ticket hydration, no cast parsing — the poller diffs these
   * against its snapshot and pays {@link getIssue} only for tickets that actually changed.
   */
  async listIssueHeads(): Promise<Array<{ id: string; updatedAt: string }>> {
    await this.bootstrap();
    const raw = await this.fetchAllPages(this.issuesPath(), { fields: "id,updated_at" });
    return raw.map((r) => {
      const row = IssueHeadSchema.parse(r);
      return { id: row.id, updatedAt: row.updated_at };
    });
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

  /**
   * Comments on an issue, oldest→newest. `since` (ISO) returns newer comments by default; pass
   * `{ inclusive: true }` when the caller tracks ids for comments sharing the cursor timestamp.
   *
   * Efficiency (issue #33): pages are requested NEWEST-first (`order_by=-created_at`, verified
   * honored) and pagination stops as soon as a page reaches past `since` — a chatty 200-comment
   * ticket costs one round trip for its one new comment, not the whole history every tick.
   */
  async listComments(
    ticketId: string,
    since?: string,
    opts: { inclusive?: boolean } = {},
  ): Promise<PlaneComment[]> {
    await this.bootstrap();
    const raw = await this.fetchAllPages(
      `${this.issuesPath()}${encodeURIComponent(ticketId)}/comments/`,
      { order_by: "-created_at" },
      since
        ? (pageRows) =>
            pageRows.some((r) => {
              const createdAt = (r as { created_at?: unknown }).created_at;
              // The page is newest-first: once any row is at/behind the cursor, older pages
              // can't contain anything new. (`inclusive` callers dedupe ties by id, so rows AT
              // the cursor must still be fetched — stop strictly BEHIND it.)
              return typeof createdAt === "string" && createdAt < since;
            })
        : undefined,
    );
    let comments = raw
      .map((r) => this.hydrateComment(ticketId, r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (since) {
      comments = comments.filter((c) => (opts.inclusive ? c.createdAt >= since : c.createdAt > since));
    }
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

  /** The selected board name this client is scoped to. */
  board(): string {
    return this.boardName;
  }

  /** Resolved Plane project info for routing write-backs by Ticket.projectId. */
  async projectInfo(): Promise<{ board: string; projectId: string; identifier: string | null }> {
    await this.bootstrap();
    return { board: this.boardName, projectId: this.projectId!, identifier: this.projectIdentifier };
  }

  /** The project's Plane workflow states (cached after the first call). */
  async listStates(): Promise<PlaneState[]> {
    await this.bootstrap();
    return this.cachedStates ? [...this.cachedStates] : [];
  }

  /**
   * Ensure this configured board has a Plane project and every workflow state in its state map.
   *
   * This is deliberately safe to call at every daemon start: it lists before writing and only
   * POSTs missing resources (case-insensitive by name). Requests all pass through `req`, so
   * Plane 429s honor Retry-After and use the shared bounded exponential backoff. The shell calls
   * this serially for boards at boot, rather than fanning a boot burst across Plane.
   */
  async ensureProvisioned(): Promise<PlaneProvisioningResult> {
    if (this.provisioned) return { projectCreated: false, statesCreated: [] };
    if (!this.provisionPromise) {
      this.provisionPromise = this.provision().finally(() => {
        this.provisionPromise = null;
      });
    }
    return this.provisionPromise;
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
    const name = this.boardConfig.state_map[state];
    const found = name ? this.statesByName?.get(name.toLowerCase()) : undefined;
    if (!found) {
      throw new PlaneApiError(
        0,
        `no Plane workflow state mapped for TicketState "${state}" in project ${this.projectIdentifier ?? this.projectId}; ` +
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
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.ensureProvisioned().then(() => undefined).finally(() => {
        this.bootstrapPromise = null;
      });
    }
    await this.bootstrapPromise;
  }

  /** List a matching project using the same forgiving lookup used by legacy installations. */
  private async findProject(): Promise<z.infer<typeof ProjectSchema> | undefined> {
    const raw = await this.fetchAllPages(`${this.apiBase}/projects/`);
    const slug = this.boardConfig.project_slug.toLowerCase();
    const projects = raw.map((r) => ProjectSchema.parse(r));
    return (
      projects.find((p) => (p.identifier ?? "").toLowerCase() === slug) ??
      projects.find((p) => p.name.toLowerCase() === slug) ??
      projects.find((p) => p.id.toLowerCase() === slug)
    );
  }

  private installProject(project: z.infer<typeof ProjectSchema>): void {
    this.projectId = project.id;
    this.projectIdentifier = project.identifier ?? project.name ?? null;
    this.logger.info("resolved Plane project", {
      board: this.boardName,
      slug: this.boardConfig.project_slug,
      projectId: this.projectId,
      identifier: this.projectIdentifier,
    });
  }

  /** Create the project if it was not returned by Plane's project list. */
  private async ensureProject(): Promise<boolean> {
    const existing = await this.findProject();
    if (existing) {
      this.installProject(existing);
      return false;
    }

    // Plane uses a short uppercase project identifier. The board name is stable and makes the
    // stock boards OPS/INT/VID/VIDPIP match their existing hand-created identifiers; the project
    // slug remains the display name and is always a valid lookup key if Plane normalizes it.
    const identifier = this.boardName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5) || "BOARD";
    try {
      const created = ProjectSchema.parse(
        await this.req("POST", `${this.apiBase}/projects/`, {
          name: this.boardConfig.project_slug,
          identifier,
        }),
      );
      this.installProject(created);
      this.logger.info("provisioned Plane project", { board: this.boardName, projectId: created.id, identifier });
      return true;
    } catch (err) {
      // A second daemon may have won the create race. Re-list once: if it is now visible this is
      // still an idempotent success; otherwise preserve the useful original API error.
      if (!(err instanceof PlaneApiError) || err.status !== 409) throw err;
      const raced = await this.findProject();
      if (!raced) throw err;
      this.installProject(raced);
      return false;
    }
  }

  private desiredWorkflowStates(): Array<{ ticketState: TicketState; name: string; group: string }> {
    const groups: Record<TicketState, string> = {
      backlog: "backlog",
      todo: "unstarted",
      design: "started",
      design_review: "unstarted",
      in_progress: "started",
      in_review: "started",
      done: "completed",
      cancelled: "cancelled",
    };
    const ticketStates: TicketState[] = [
      "backlog", "todo", "design", "design_review", "in_progress", "in_review", "done", "cancelled",
    ];
    const seen = new Set<string>();
    return ticketStates.flatMap((ticketState) => {
      const name = this.boardConfig.state_map[ticketState];
      if (!name || seen.has(name.toLowerCase())) return [];
      seen.add(name.toLowerCase());
      return [{ ticketState, name, group: groups[ticketState] }];
    });
  }

  private parseStates(raw: unknown[]): PlaneState[] {
    return raw.map((r) => {
      const s = StateSchema.parse(r);
      return { id: s.id, name: s.name, group: s.group ?? undefined };
    });
  }

  private installStates(states: PlaneState[]): void {
    const byName = new Map<string, PlaneState>();
    for (const s of states) byName.set(s.name.toLowerCase(), s);
    const reverse = new Map<string, TicketState>();
    for (const { ticketState, name } of this.desiredWorkflowStates()) {
      const st = byName.get(name.toLowerCase());
      if (st) reverse.set(st.id, ticketState);
      else this.logger.warn("state_map name has no matching Plane state", { ticketState, name });
    }
    // Option A video boards may include extra human-move states (e.g. Voiceover/Render) in
    // Plane's "started" group. Beckett does not set them, but reading them back should keep the
    // coarse engine in in_progress instead of falling to backlog.
    for (const st of states) {
      if (!reverse.has(st.id) && (st.group ?? "").toLowerCase() === "started") reverse.set(st.id, "in_progress");
    }
    this.cachedStates = states;
    this.statesByName = byName;
    this.idToTicketState = reverse;
  }

  private async provision(): Promise<PlaneProvisioningResult> {
    const projectCreated = await this.ensureProject();
    let states = this.parseStates(await this.fetchAllPages(`${this.issuesProjectPath()}states/`));
    const statesCreated: string[] = [];
    for (const wanted of this.desiredWorkflowStates()) {
      if (states.some((state) => state.name.toLowerCase() === wanted.name.toLowerCase())) continue;
      try {
        const created = StateSchema.parse(
          await this.req("POST", `${this.issuesProjectPath()}states/`, { name: wanted.name, group: wanted.group }),
        );
        states.push({ id: created.id, name: created.name, group: created.group ?? undefined });
        statesCreated.push(created.name);
      } catch (err) {
        // As above, treat a concurrent creator as success only after verifying the state exists.
        if (!(err instanceof PlaneApiError) || err.status !== 409) throw err;
        states = this.parseStates(await this.fetchAllPages(`${this.issuesProjectPath()}states/`));
        if (!states.some((state) => state.name.toLowerCase() === wanted.name.toLowerCase())) throw err;
      }
    }
    this.installStates(states);
    this.provisioned = true;
    this.logger.info("Plane board provisioned", { board: this.boardName, projectCreated, statesCreated });
    return { projectCreated, statesCreated };
  }

  // ── path helpers ───────────────────────────────────────────────────────────────────────

  private issuesProjectPath(): string {
    return `${this.apiBase}/projects/${this.projectId}/`;
  }

  private issuesPath(): string {
    return `${this.issuesProjectPath()}issues/`;
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────────────────────

  /**
   * Walk Plane's cursor pagination, collecting every result row (bare-array tolerant). An
   * optional `stopAfter` predicate, checked per collected page, ends the walk early — the
   * listComments newest-first cursor stop (issue #33).
   */
  private async fetchAllPages(
    path: string,
    query: Record<string, string> = {},
    stopAfter?: (pageRows: unknown[]) => boolean,
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
      if (page.results) {
        out.push(...page.results);
        if (stopAfter?.(page.results)) break;
      }
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
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            // Plane personal API tokens authenticate via X-API-Key (not Bearer).
            "X-API-Key": token,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        this.lastHttpStatus = res.status;

        if (res.status === 404) throw this.recordError(new PlaneApiError(404, `${method} ${url} → 404 not found`));
        if (!res.ok) {
          let detail = "";
          try {
            detail = (await res.text()).slice(0, 500);
          } catch {
            /* ignore body read failure */
          }
          const err = new PlaneApiError(res.status, `${method} ${url} → ${res.status}: ${detail}`);
          if (attempt < REQUEST_MAX_ATTEMPTS && shouldRetryStatus(res.status)) {
            await this.sleep(retryDelayMs(attempt, res.headers.get("Retry-After")));
            continue;
          }
          throw this.recordError(err);
        }
        this.lastOkAt = Date.now();
        if (res.status === 204) return undefined;
        try {
          return await res.json();
        } catch {
          return undefined;
        }
      } catch (err) {
        if (err instanceof PlaneApiError) throw err;
        if (attempt < REQUEST_MAX_ATTEMPTS) {
          await this.sleep(retryDelayMs(attempt, null));
          continue;
        }
        throw this.recordError(
          new PlaneApiError(0, `network error on ${method} ${url}: ${(err as Error).message}`),
        );
      }
    }
    throw this.recordError(new PlaneApiError(0, `network error on ${method} ${url}: exhausted retries`));
  }

  /** Stamp the health counters with a terminal request failure; returns the error for `throw`. */
  private recordError(err: PlaneApiError): PlaneApiError {
    this.lastErrorAt = Date.now();
    this.lastError = err.message.slice(0, 300);
    return err;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  // Honor Plane/DRF's Retry-After when present; otherwise use truncated exponential backoff.
  // Add jitter so simultaneous poller/bootstrap requests do not all retry in lockstep.
  const hinted = parseRetryAfterMs(retryAfter);
  const backoff = Math.min(RETRY_MAX_MS, hinted ?? RETRY_BASE_MS * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * (Math.floor(backoff * RETRY_JITTER_RATIO) + 1));
  return Math.min(RETRY_MAX_MS, backoff + jitter);
}

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, ts - Date.now());
}

/** Factory matching the repo's `createX(deps)` convention (see `createWorkerManager`). */
export function createPlaneClient(deps: PlaneClientDeps): PlaneClient {
  return new PlaneClient(deps);
}
