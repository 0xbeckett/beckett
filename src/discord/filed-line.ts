/**
 * Beckett — "filed" subtext line (`src/discord/filed-line.ts`)
 * =======================================================================================
 * Beckett no longer opens a Discord thread per task. Work is filed silently and reports back
 * into the channel the request came from, which means the ONLY signal that a request became
 * real work is a single small grey line stamped under the reply: Discord renders a message
 * line starting with `-# ` as subtext. That line has to carry the task refs so the person can
 * turn around and attach them to a thread of their own (`&12`, see
 * {@link file://../concierge/thread-attach.ts}).
 *
 * This module is PURE — it takes refs and returns the line, nothing else. The point of the
 * split is that the failure modes here are all formatting failure modes, and formatting is
 * exactly what a unit test can pin:
 *
 *   - **Nothing filed must post NOTHING.** An empty list returns `null`, not `"-# "`. Callers
 *     that dutifully post whatever they're handed would otherwise leave a stray grey artifact
 *     under every ordinary chat reply — the loudest possible way to advertise a no-op.
 *   - **Filing order is meaning.** Refs are emitted in the order they were filed and are never
 *     sorted; `1, 2, 3` says what happened first. Duplicates collapse to their first sighting.
 *   - **The line can never inject.** Refs reach us in mixed spellings from several call sites
 *     (`#1`, `1`, `#1.2`) and, though internal and well-formed today, they are one refactor
 *     away from carrying user text. Anything that is not a dotted numeric ref is dropped
 *     outright, so the rendered line structurally cannot contain a mention, a backtick, or a
 *     newline — the three things that would let a ref escape the subtext line and either ping a
 *     room or break the message formatting.
 */

/**
 * The only shape a ref may have: a dotted numeric path (`12`, `12.1`, `12.1.3`). Deliberately
 * narrow — it excludes `@`, backticks and newlines by construction rather than by blocklist, so
 * new Discord markup can't quietly become an escape hatch.
 */
const FILED_REF_PATTERN = /^\d+(?:\.\d+)*$/;

/**
 * Canonicalize the refs for display: strip a leading `#`, trim, drop blanks, drop anything that
 * isn't a dotted numeric ref, dedupe preserving first-seen order. Exported because the caller
 * often wants to know whether ANYTHING survived before it decides to post at all.
 */
export function normalizeFiledRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of refs) {
    if (typeof raw !== "string") continue;
    const ref = raw.trim().replace(/^#/, "").trim();
    if (!ref || !FILED_REF_PATTERN.test(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Render the subtext line, or `null` when there is nothing to say. `null` is a hard contract:
 * callers must post no message at all, not an empty one.
 */
export function formatFiledLine(refs: string[]): string | null {
  const clean = normalizeFiledRefs(refs);
  if (clean.length === 0) return null;
  if (clean.length === 1) return `-# filed ticket ${clean[0]}`;
  return `-# filed tickets: ${clean.join(", ")}`;
}
