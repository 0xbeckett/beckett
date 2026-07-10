/**
 * Beckett — Memory lexical retrieval (`src/memory/search.ts`)
 * =======================================================================================
 * The scoring core behind `recall` (OPS-121 "better memory"). Deliberately **keyword-based
 * and deterministic** — no embeddings, no vector store, no network (per the requester's
 * steer: tighter relevance matching, not a semantic layer). What makes it sharper than the
 * old name/description token overlap:
 *
 *   - **Light stemming** — "deployed" / "deploying" / "deploys" all match "deploy", so a
 *     query worded differently from the stored fact still lands on it.
 *   - **Full-node scan** — the body and metadata values (emails, urls, roles, paths) are
 *     scored, not just the one-line description, so a fact buried mid-note is found.
 *   - **IDF weighting** — a term rare across the store ("cloudflare") outranks one that
 *     appears everywhere ("project"), so distinctive words dominate the ranking.
 *   - **Prefix credit** — "deploy" partially matches "deployment"; catches morphology the
 *     tiny stemmer doesn't.
 *   - **Coverage scaling** — a node matching 3 of 4 query terms beats one matching 1 of 4
 *     with a higher raw hit, so multi-word queries rank whole-fact matches first.
 *
 * Also exports the node-vs-node similarity used for write-time dedup and the maintenance
 * pass's duplicate merge (same stems, so "deploy docs" and "deploying the docs" collide).
 *
 * Everything here is pure over parsed nodes — no filesystem access.
 */

import type { MemoryNode } from "../types.ts";

/** Tiny English stopword set (moved from index.ts; lexical, not embeddings). */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "for", "in", "on", "is", "are", "we", "that",
  "this", "it", "with", "as", "be", "or", "at", "by", "from", "our", "you", "your",
  "i", "me", "my", "was", "were", "has", "have", "had", "but", "not", "if", "so",
  "about", "into", "over", "up", "out", "what", "when", "how", "who", "which", "their",
  "they", "them", "its", "his", "her", "he", "she", "do", "does", "did", "will", "can",
]);

/** Field weights: where a term matches matters (a name hit ≫ a body mention). */
const FIELD_WEIGHTS = {
  name: 4,
  alias: 4,
  description: 2.5,
  meta: 1.5,
  body: 1,
} as const;

/** Credit multiplier for a prefix (rather than exact-stem) match. */
const PREFIX_CREDIT = 0.6;
/** Minimum token length for prefix matching (avoid "re" matching everything). */
const PREFIX_MIN = 4;

// =======================================================================================
// Tokenizing + stemming
// =======================================================================================

/** Lowercase alnum tokens, stopwords and single chars dropped. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Light suffix-stripping stemmer (a deliberate subset of Porter): collapses the plural and
 * -ed/-ing verb forms that make keyword recall brittle, without a dependency. Trailing "e"
 * is dropped last so "release"/"released"/"releasing" all land on "releas".
 */
export function stem(t: string): string {
  let s = t;
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && s.endsWith("ing")) s = undouble(s.slice(0, -3));
  else if (s.length > 4 && s.endsWith("ed")) s = undouble(s.slice(0, -2));
  else if (s.length > 3 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** "runn" → "run" after stripping -ing/-ed doubled the final consonant. */
function undouble(s: string): string {
  return s.length > 2 && s[s.length - 1] === s[s.length - 2] && !/[aeiou]/.test(s[s.length - 1]!)
    ? s.slice(0, -1)
    : s;
}

/** Tokenize + stem, deduped. */
export function stems(s: string): Set<string> {
  return new Set(tokenize(s).map(stem));
}

// =======================================================================================
// Corpus statistics (IDF)
// =======================================================================================

/** Per-store document frequencies so rare terms can outrank ubiquitous ones. */
export interface CorpusStats {
  /** Real (non-phantom) node count. */
  docs: number;
  /** stem → number of nodes containing it (in any field). */
  df: Map<string, number>;
}

/** All searchable text of a node, one string per field kind. */
function nodeFields(node: MemoryNode): { name: string; alias: string; description: string; meta: string; body: string } {
  return {
    name: node.name,
    alias: asStrings(node.metadata.aliases).join(" "),
    description: `${node.description} ${node.type}`,
    meta: metaText(node.metadata),
    body: node.body,
  };
}

/** Flatten metadata values (not keys) into scannable text — emails, urls, roles, paths. */
function metaText(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "aliases" || key === "created" || key === "updated") continue;
    for (const v of asStrings(value)) parts.push(v);
  }
  return parts.join(" ");
}

function asStrings(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

/** Build document frequencies over the real nodes of a graph. */
export function corpusStats(nodes: Iterable<MemoryNode>): CorpusStats {
  const df = new Map<string, number>();
  let docs = 0;
  for (const n of nodes) {
    if (n.phantom) continue;
    docs++;
    const f = nodeFields(n);
    const all = stems(`${f.name} ${f.alias} ${f.description} ${f.meta} ${f.body}`);
    for (const t of all) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { docs, df };
}

/** Smoothed IDF in roughly [0.5, ~4] for small stores; 1 when stats are absent. */
function idf(term: string, stats: CorpusStats | undefined): number {
  if (!stats || stats.docs === 0) return 1;
  const d = stats.df.get(term) ?? 0;
  return 0.5 + Math.log(1 + stats.docs / (1 + d));
}

// =======================================================================================
// Query scoring
// =======================================================================================

/** Precomputed per-node stem sets, cached per scoring run. */
interface NodeStems {
  name: Set<string>;
  alias: Set<string>;
  description: Set<string>;
  meta: Set<string>;
  body: Set<string>;
}

function nodeStems(node: MemoryNode): NodeStems {
  const f = nodeFields(node);
  return {
    name: stems(f.name),
    alias: stems(f.alias),
    description: stems(f.description),
    meta: stems(f.meta),
    body: stems(f.body),
  };
}

/**
 * Relevance of a node to free query text. 0 means "no term matched at all" — callers use
 * that as the drop floor. Deterministic; recency/staleness shaping is the caller's job
 * (it owns "now").
 */
export function scoreNode(queryText: string, node: MemoryNode, stats?: CorpusStats): number {
  const qStems = [...stems(queryText)];
  if (qStems.length === 0) return 0;
  const ns = nodeStems(node);

  let score = 0;
  let matched = 0;
  for (const q of qStems) {
    const w = idf(q, stats);
    let best = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [keyof NodeStems, number][]) {
      const set = ns[field];
      if (set.has(q)) best = Math.max(best, weight);
      else if (q.length >= PREFIX_MIN && best < weight * PREFIX_CREDIT) {
        for (const t of set) {
          if (t.startsWith(q) || (t.length >= PREFIX_MIN && q.startsWith(t))) {
            best = Math.max(best, weight * PREFIX_CREDIT);
            break;
          }
        }
      }
    }
    if (best > 0) {
      matched++;
      score += best * w;
    }
  }
  if (matched === 0) return 0;

  // Whole-fact matches first: scale by the fraction of query terms the node covers.
  score *= (1 + matched / qStems.length) / 2;

  // Phrase boosts: an alias or the spaced node name appearing verbatim is a strong signal.
  const low = queryText.toLowerCase();
  for (const a of asStrings(node.metadata.aliases)) {
    if (a.length >= 3 && low.includes(a.toLowerCase())) score += 8;
  }
  const spacedName = node.name.replace(/-/g, " ");
  if (spacedName.length >= 3 && low.includes(spacedName)) score += 6;

  return score;
}

// =======================================================================================
// Node-vs-node similarity (write-time dedup + maintenance merge)
// =======================================================================================

/** Similarity above which remember coerces create→update and maintenance flags a pair (§4.2). */
export const DEDUP_THRESHOLD = 0.82;
/** Similarity above which the maintenance pass auto-merges two same-type nodes. Deliberately
 *  stricter than {@link DEDUP_THRESHOLD}: between the two, a pair is only FLAGGED for a human
 *  (a wrong auto-merge is hard to undo; the skill doc says favor flagging). */
export const MERGE_THRESHOLD = 0.9;

/**
 * How likely two nodes describe the same fact, in [0, 1]. Stemmed name + description overlap
 * (descriptions carry the fact; names are short but decisive). Used by remember's
 * create→update coercion and the maintenance pass's duplicate detection.
 */
export function nodeSimilarity(
  a: { name: string; description: string },
  b: { name: string; description: string },
): number {
  return (
    0.7 * dice(stems(a.description), stems(b.description)) +
    0.3 * dice(stems(a.name), stems(b.name))
  );
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}
