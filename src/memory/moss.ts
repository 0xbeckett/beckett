/**
 * Beckett — Memory retrieval over the local Moss runtime (`src/memory/moss.ts`)
 * =======================================================================================
 * Issue #20: recall's ranking is served by the fully-local Moss index built in #31.1
 * (src/moss-local — hybrid dense+keyword retrieval, in-process embeddings, no network).
 *
 * Boundaries that keep this a transplant and not a rewrite:
 *   - **Moss is a retrieval accelerator, NOT the authority on who may see a fact.** The
 *     index stores every node (scoped ones included) and returns raw relevance scores;
 *     visibility (public/owner/dm) is enforced fail-closed by `recallOver` in code, on
 *     every hit and every link expansion, exactly as before. Nothing here reads audience.
 *   - **The markdown files stay canonical.** The index under `<memoryDir>/.moss/` is a
 *     derived cache: {@link syncMossWithGraph} diffs the freshly built graph against the
 *     index by content hash on every recall/remember/maintain, so out-of-band edits, `git
 *     pull`s, and deletes are healed on the next call, and the first call over a pre-moss
 *     store migrates every existing memory file automatically.
 *   - **An unreadable index is a cache miss, not an outage**: {@link openMemoryMoss}
 *     resets a corrupt/incompatible index and rebuilds from the tree; if the runtime is
 *     unavailable entirely, MemoryStore falls back to the lexical scorer (search.ts).
 *
 * Ranking contract ({@link mossScores}): Moss's rank-fused hybrid scores are relative —
 * every document gets a score for ANY query, even "zzz qqq" (the dense arm always ranks).
 * The keyword arm (semanticWeight 0) returns only documents with actual lexical evidence
 * and is empty for nonsense. So: the keyword arm decides WHICH nodes match (the old
 * `scoreNode > 0` floor), the hybrid arm decides their ORDER (dense concepts + n-grams
 * sharpen ranking within the matched set). Both queries are answered by Moss.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openLocalMoss, type LocalMoss, type MossDocument } from "../moss-local/index.ts";
import { searchableText } from "./search.ts";
import type { Logger, MemoryGraph, MemoryNode } from "../types.ts";

/** Index name inside the data dir (files: `memory.moss` + `memory.docs.json`). */
export const MEMORY_INDEX_NAME = "memory";

/** Hybrid fusion weight for the ranking query — #31.1's default (0.75 dense, 0.25 keyword). */
const RANKING_SEMANTIC_WEIGHT = 0.75;

/**
 * A deliberately small field-aware lexical sharpener for the Moss hybrid rank. It is applied
 * only after Moss has selected lexical matches, so dense+keyword retrieval remains primary.
 */
export const MOSS_LEXICAL_SHARPENER_WEIGHT = 0.025;

/** The derived-cache home: hidden inside the memory dir (gitignored by MemoryStore). */
export function memoryMossDir(memoryDir: string): string {
  return join(memoryDir, ".moss");
}

/**
 * Open the memory store's local Moss index. A corrupt or version-incompatible index is
 * reset and rebuilt from scratch (it is a pure cache of the markdown tree — the next
 * {@link syncMossWithGraph} repopulates it); only a genuinely broken runtime throws.
 */
export async function openMemoryMoss(memoryDir: string, logger?: Logger): Promise<LocalMoss> {
  const dataDir = memoryMossDir(memoryDir);
  try {
    return await openLocalMoss({ indexName: MEMORY_INDEX_NAME, dataDir });
  } catch (err) {
    logger?.warn("memory: local moss index unreadable — resetting the cache", {
      dataDir,
      err: String(err),
    });
    rmSync(join(dataDir, `${MEMORY_INDEX_NAME}.moss`), { force: true });
    rmSync(join(dataDir, `${MEMORY_INDEX_NAME}.docs.json`), { force: true });
    return openLocalMoss({ indexName: MEMORY_INDEX_NAME, dataDir });
  }
}

/** Render one graph node as the Moss document recall retrieves it by. */
export function memoryDocument(node: MemoryNode): MossDocument {
  const text = searchableText(node);
  return {
    id: node.name,
    text,
    // `hash` powers the diff-sync; `type` is informational (NOT used for access control).
    metadata: { type: node.type, hash: sha256(text) },
  };
}

/**
 * Make the index mirror the graph: upsert new/changed nodes (by content hash), delete
 * documents whose files are gone (archive, merge, out-of-band `rm`). Called on every
 * recall AND after every remember/maintain write, so the index can never drift for more
 * than one call — and a store predating moss is migrated wholesale on first contact.
 */
export async function syncMossWithGraph(
  moss: LocalMoss,
  g: MemoryGraph,
): Promise<{ upserted: number; removed: number }> {
  const desired = new Map<string, MossDocument>();
  for (const node of g.nodes.values()) {
    if (!node.phantom) desired.set(node.name, memoryDocument(node));
  }
  const currentHashes = new Map(moss.list().map((d) => [d.id, d.metadata?.hash]));
  const stale = [...currentHashes.keys()].filter((id) => !desired.has(id));
  const changed = [...desired.values()].filter((d) => currentHashes.get(d.id) !== d.metadata!.hash);
  if (stale.length > 0) await moss.delete(stale);
  if (changed.length > 0) await moss.upsert(changed);
  return { upserted: changed.length, removed: stale.length };
}

/**
 * Score a recall query through Moss: node name → relevance. Only nodes with lexical
 * evidence (keyword arm) get a score — a nonsense query maps to an empty result, matching
 * the old lexical floor — but their ordering comes from the hybrid arm, where the dense
 * side's concept lexicon and character n-grams catch rewordings the keyword arm ranks
 * poorly. Scores are in (0, 1]; callers layer their own boosts/recency on top.
 */
export function mossScores(moss: LocalMoss, text: string): Map<string, number> {
  const scores = new Map<string, number>();
  const query = text.trim();
  const topK = moss.docCount;
  if (!query || topK === 0) return scores;
  const matched = new Set(
    moss.query(query, undefined, { topK, semanticWeight: 0 }).docs.map((d) => d.id),
  );
  if (matched.size === 0) return scores;
  for (const hit of moss.query(query, undefined, { topK, semanticWeight: RANKING_SEMANTIC_WEIGHT }).docs) {
    if (matched.has(hit.id)) scores.set(hit.id, hit.score);
  }
  return scores;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
