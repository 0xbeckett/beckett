/**
 * Beckett v3 — cast-block parse/serialize (`src/plane/cast.ts`)
 * =======================================================================================
 * Per-stage casting + acceptance criteria are stored INSIDE the Plane issue description so
 * Plane stays the single source of truth (no sidecar DB). The format is:
 *
 *   <human prose body…>
 *
 *   ```beckett-cast
 *   { "implement": {"harness":"codex"},
 *     "review": {"harness":"claude","model":"claude-opus-4-8"} }
 *   ```
 *
 *   ## Acceptance criteria
 *   - first criterion
 *   - second criterion
 *
 * {@link parseCast} is the READER (poller/dispatcher hydrating a Ticket); {@link serializeCast}
 * is the WRITER (Concierge filing a ticket via the PlaneClient). They round-trip: parse∘
 * serialize preserves casting + criteria + body. External input (the JSON inside the fence)
 * is validated with zod — a malformed block degrades to empty casting, never throws.
 *
 * Import style: explicit `.ts` extensions.
 */

import { z } from "zod";
import type { Casting, HarnessSpec, ParsedCast } from "./types.ts";

/** The fenced-block language tag that carries the casting JSON. */
export const CAST_FENCE = "beckett-cast";

/** The fenced-block language tag that carries the blocked-by dependency identifiers (JSON array). */
export const DEPS_FENCE = "beckett-deps";

/** The markdown heading that introduces the acceptance-criteria bullet list. */
export const CRITERIA_HEADING = "## Acceptance criteria";

// =======================================================================================
// zod schema for the cast-block JSON (external input — validate, never trust)
// =======================================================================================

const HarnessSpecSchema: z.ZodType<HarnessSpec> = z.object({
  harness: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  reviewTier: z.enum(["self", "fresh"]).optional(),
});

/** A casting object is a map of stage-name → HarnessSpec (implement/review + open-ended). */
const CastingSchema = z.record(z.string(), HarnessSpecSchema);

/**
 * Parse + validate a raw cast-block JSON string into a {@link Casting}. Returns an empty
 * casting (`{}`) on any parse/validation failure — a bad block must not crash hydration.
 */
export function parseCastJson(raw: string): Casting {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = CastingSchema.safeParse(obj);
  return result.success ? (result.data as Casting) : {};
}

// =======================================================================================
// parseCast — READER
// =======================================================================================

const FENCE_RE = new RegExp(
  "```" + CAST_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```",
  "i",
);

const DEPS_RE = new RegExp(
  "```" + DEPS_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```",
  "i",
);

/** A blocked-by dependency list is a JSON array of ticket-identifier strings. */
const DepsSchema = z.array(z.string().min(1));

/** Parse + validate a raw deps-block JSON string into a list of identifiers. `[]` on any failure. */
export function parseDepsJson(raw: string): string[] {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = DepsSchema.safeParse(obj);
  return result.success ? result.data : [];
}

/**
 * Split a Plane issue description into its structured halves + prose body.
 *   - `casting`  — parsed from the first ```beckett-cast``` fenced block (zod-validated).
 *   - `criteria` — the bullet lines under the `## Acceptance criteria` heading.
 *   - `body`     — the description with BOTH the cast block and the criteria section removed,
 *                  trimmed. This is the human-readable prose the worker reads as context.
 * Tolerant: a missing cast block yields `{}`; a missing criteria section yields `[]`.
 */
export function parseCast(description: string): ParsedCast {
  const desc = description ?? "";

  // 1. cast block
  const fenceMatch = desc.match(FENCE_RE);
  const casting = fenceMatch ? parseCastJson(fenceMatch[1] ?? "") : {};
  let rest = fenceMatch ? desc.replace(fenceMatch[0], "") : desc;

  // 1b. deps (blocked-by) block
  const depsMatch = rest.match(DEPS_RE);
  const blockedBy = depsMatch ? parseDepsJson(depsMatch[1] ?? "") : [];
  if (depsMatch) rest = rest.replace(depsMatch[0], "");

  // 2. acceptance-criteria section (heading → end-of-string or next h2)
  const criteria: string[] = [];
  const headingIdx = indexOfHeading(rest);
  if (headingIdx >= 0) {
    const after = rest.slice(headingIdx);
    const lines = after.split(/\r?\n/);
    // drop the heading line itself, then collect bullets until the next `## ` heading
    const sectionLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^##\s/.test(line)) break;
      sectionLines.push(line);
    }
    for (const line of sectionLines) {
      const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (m && m[1]) criteria.push(m[1].trim());
    }
    // remove the consumed criteria section (heading + the bullet block) from the body
    const consumed = lines.slice(0, 1 + sectionLines.length).join("\n");
    rest = rest.slice(0, headingIdx) + after.slice(consumed.length);
  }

  return { casting, criteria, blockedBy, body: rest.trim() };
}

/** Case-insensitive index of the criteria heading at a line start, or -1. */
function indexOfHeading(text: string): number {
  const re = /(^|\n)##\s+acceptance criteria\s*(\n|$)/i;
  const m = text.match(re);
  if (!m || m.index === undefined) return -1;
  // point at the `##`, not the preceding newline
  return m.index + (m[1] ? m[1].length : 0);
}

// =======================================================================================
// serializeCast — WRITER
// =======================================================================================

/**
 * Compose a Plane issue description from prose + structured casting + criteria + deps. Inverse of
 * {@link parseCast}: `parseCast(serializeCast(c, cr, b, d))` recovers `c`, `cr`, `d`, and `b.trim()`.
 * The cast block is omitted when `casting` is empty, the deps block when `blockedBy` is empty, and
 * the criteria section when `criteria` is empty — so a trivial ticket serializes to just its prose.
 */
export function serializeCast(
  casting: Casting,
  criteria: string[],
  body: string,
  blockedBy: string[] = [],
): string {
  const parts: string[] = [];
  const trimmedBody = (body ?? "").trim();
  if (trimmedBody) parts.push(trimmedBody);

  const castEntries = Object.entries(casting ?? {}).filter(([, v]) => v !== undefined);
  if (castEntries.length > 0) {
    const json = JSON.stringify(Object.fromEntries(castEntries), null, 2);
    parts.push("```" + CAST_FENCE + "\n" + json + "\n```");
  }

  const cleanDeps = (blockedBy ?? []).map((d) => d.trim()).filter(Boolean);
  if (cleanDeps.length > 0) {
    parts.push("```" + DEPS_FENCE + "\n" + JSON.stringify(cleanDeps) + "\n```");
  }

  const cleanCriteria = (criteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (cleanCriteria.length > 0) {
    parts.push(CRITERIA_HEADING + "\n" + cleanCriteria.map((c) => `- ${c}`).join("\n"));
  }

  return parts.join("\n\n");
}
