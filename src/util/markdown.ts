/**
 * Beckett — shared markdown helpers (`src/util/markdown.ts`)
 * =======================================================================================
 * Consolidation home for the markdown-tree primitives that were copy-pasted across the
 * memory store, the CLI `mem` commands, and the skills loader:
 *   - {@link listMarkdownFiles} — enumerate `.md` files under a dir (the listing logic that
 *     existed in three slightly-different forms).
 *   - {@link splitFrontmatter} — split a `---`-fenced frontmatter block from the body (moved
 *     verbatim from the memory store; the canonical, BOM/CRLF-tolerant implementation).
 *
 * Behavior-preserving: each former caller passes options that reproduce its exact prior
 * behavior (recursive vs not, which names/dirs to exclude). Errors fail soft to [].
 */

import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export interface ListMarkdownOpts {
  /** Recurse into subdirectories (Node's `readdirSync(..., {recursive})`). Default false. */
  recursive?: boolean;
  /** Exclude entries whose RELATIVE path exactly matches one of these (e.g. "MEMORY.md"). */
  excludeRels?: string[];
  /** Exclude entries whose BASENAME matches one of these (e.g. "MEMORY.md" at any depth). */
  excludeBasenames?: string[];
  /** Exclude entries with any path SEGMENT in this set (e.g. ".git"). */
  excludeDirSegments?: string[];
}

/**
 * List `.md` files under `dir` as absolute paths. Missing dir or any FS error → []. The
 * exclusion options let each caller match its historical filtering exactly.
 */
export function listMarkdownFiles(dir: string, opts: ListMarkdownOpts = {}): string[] {
  if (!existsSync(dir)) return [];
  let rels: string[];
  try {
    rels = readdirSync(dir, { recursive: !!opts.recursive }) as string[];
  } catch {
    return [];
  }
  const exRels = new Set(opts.excludeRels ?? []);
  const exBase = new Set(opts.excludeBasenames ?? []);
  const exSeg = opts.excludeDirSegments ?? [];
  return rels
    .filter((r) => r.endsWith(".md"))
    .filter((r) => !exRels.has(r))
    .filter((r) => !exBase.has(basename(r)))
    .filter((r) => exSeg.length === 0 || !r.split(/[\\/]/).some((s) => exSeg.includes(s)))
    .map((r) => join(dir, r));
}

/**
 * Split a `---`-fenced frontmatter block from the markdown body. Tolerates a leading BOM and
 * CRLF. No fence → `{ frontmatter: "", body: <whole text> }`. (Moved verbatim from the memory
 * store — Spec 08 §1.2.)
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[1]!, body: text.slice(m[0].length) };
}
