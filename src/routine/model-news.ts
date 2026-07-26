/**
 * Beckett — model-news feed (`src/routine/model-news.ts`)
 * =======================================================================================
 * The read side of the `watch` routine action: fetching and defensively parsing the ai-tracker
 * model-news feed (issue #1), plus the pure qualification predicate that decides whether a feed
 * item is genuinely fresh, event-worthy news.
 *
 * The feed is a THIRD PARTY service (ssh.codes) that Beckett does not own, so everything here
 * treats its shape defensively: a non-200 response, a timeout, unparseable JSON, or a single
 * malformed item never throws — each failure mode reports as a typed, loggable result instead,
 * so the caller can skip the round and try again next interval rather than crash or (worse)
 * post on bad data.
 */

import { z } from "zod";

/** The feed this routine watches — new model releases only. */
export const MODEL_NEWS_FEED_URL = "https://ai-tracker.ssh.codes/api/v1/model-news?type=model&new_models=true";

/** How long a request is allowed to hang before it counts as a broken round. */
export const MODEL_NEWS_FETCH_TIMEOUT_MS = 10_000;

/**
 * One feed item. Every field beyond `id` is optional with a safe default — the feed can add,
 * rename, or omit fields without this routine crashing; a field this routine actually depends
 * on being missing just makes that item fail to qualify (see {@link isQualifyingItem}), not
 * fail the whole round.
 */
export const ModelNewsItemSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    category: z.string().optional(),
    title: z.string().optional().default(""),
    summary: z.string().optional().default(""),
    topic: z.string().optional(),
    topicLabel: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
    source: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        url: z.string().optional(),
      })
      .partial()
      .optional(),
    url: z.string().optional(),
    publishedAt: z.string().optional().default(""),
    stage: z.string().optional(),
    newModel: z.boolean().optional().default(false),
    models: z.array(z.string()).optional().default([]),
    removedModels: z.array(z.string()).optional().default([]),
  })
  .passthrough();
export type ModelNewsItem = z.infer<typeof ModelNewsItemSchema>;

/** The bare shape a response needs to even attempt item-by-item parsing. */
const ModelNewsFeedShape = z.object({ items: z.array(z.unknown()) }).passthrough();

export type ModelNewsFetchResult =
  | { ok: true; items: ModelNewsItem[] }
  | { ok: false; reason: string };

/**
 * Fetch + defensively parse the feed. Never throws: network errors, non-200 statuses, timeouts,
 * unparseable JSON, and an unexpected top-level shape all come back as `{ ok: false, reason }`.
 * An individual malformed item is dropped rather than failing the whole round — the feed is a
 * changelog of a handful of items; one bad entry should not blind the watcher to the rest.
 */
export async function fetchModelNewsFeed(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelNewsFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? MODEL_NEWS_FETCH_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, reason: `feed request failed: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `feed returned HTTP ${res.status}` };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    return { ok: false, reason: `feed body is not valid JSON: ${(err as Error).message}` };
  }

  const shape = ModelNewsFeedShape.safeParse(raw);
  if (!shape.success) {
    return { ok: false, reason: "feed response has no items array" };
  }

  const items: ModelNewsItem[] = [];
  for (const candidate of shape.data.items) {
    const parsed = ModelNewsItemSchema.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    // A single malformed item is dropped silently at this layer; the caller logs the round's
    // item count, which is enough signal that something shrank without needing per-item noise.
  }
  return { ok: true, items };
}

/** The model id an item is deduped/rate-limited under: its first named model, else its feed id. */
export function pickModelId(item: ModelNewsItem): string {
  return item.models[0]?.trim() || item.id;
}

/** How stale a "new model" item is allowed to be before it stops being news. */
export const MODEL_NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a feed item time-stamped slightly ahead of this clock (skew, not a bad actor). */
export const MODEL_NEWS_CLOCK_SKEW_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * The event-fire predicate: an item only qualifies when it is unseen, genuinely marks a new
 * model (`newModel === true`), carries a `publishedAt` inside the last 24h, and has a source
 * URL to verify against — the whole point of the listener is that the agent reads the source
 * before writing, and there is nothing to read without one.
 */
export function isQualifyingItem(
  item: ModelNewsItem,
  opts: { seenIds: ReadonlySet<string>; now: Date },
): boolean {
  if (opts.seenIds.has(item.id)) return false;
  if (item.newModel !== true) return false;
  if (!item.source?.url?.trim()) return false;
  const published = Date.parse(item.publishedAt);
  if (!Number.isFinite(published)) return false;
  const ageMs = opts.now.getTime() - published;
  return ageMs <= MODEL_NEWS_MAX_AGE_MS && ageMs >= -MODEL_NEWS_CLOCK_SKEW_TOLERANCE_MS;
}
