/**
 * Beckett Plan Stage — shared-context artifact formatting (`src/dispatch/plan-artifact.ts`)
 * =======================================================================================
 * Pure, dependency-free string formatting for the Plan stage's artifact (a strong-seat-authored
 * brief a mandatory `plan` stage writes before any implement worker is staffed — see the Plan
 * Stage design). This module owns exactly the CONSUMPTION half of that design: turning a plan
 * document's markdown into the inlined block an implement worker's turn-1 prompt carries, the
 * system-append line that tells it not to re-derive what the plan already gives it, and the
 * pointer line a reviewer gets instead of a second full copy.
 *
 * Two failure modes this module exists to prevent, in priority order:
 *
 *   1. THE ARTIFACT MUST NOT BLOAT EVERY TURN. The whole point of front-loading orientation once
 *      is that it costs less than a worker re-deriving it turn after turn (see the Plan Stage
 *      design's turn-cost table). A ceiling ({@link PLAN_TOKEN_CEILING}) and a defined drop order
 *      ({@link planContextBlock}) keep a runaway plan doc from costing MORE than the turns it was
 *      meant to save — this is a defense-in-depth backstop; the `plan_check` stage is the primary
 *      enforcement of the ceiling, this is what happens if a doc slips past it anyway.
 *   2. A MISSING PLAN MUST DEGRADE TO EXACTLY TODAY'S BEHAVIOR, NEVER A BROKEN PROMPT. Every
 *      ticket that predates this stage — and any future ticket that somehow reaches implement
 *      with no `planVerified` record — must get a byte-identical prompt to what shipped before
 *      this module existed. {@link planContextBlock} returning `""` for an undefined/empty doc is
 *      the load-bearing guarantee here: the stage-registry wiring (`stages.ts`, owned by the
 *      Plan Stage's STAGE half) prepends this function's return value verbatim, so `""` in means
 *      no change to `genericTaskPrompt`'s output.
 *
 * These functions are intentionally free of I/O, config, and Ticket/StageOps types — they take
 * only the strings they need to format, so they can be tested (and reasoned about) in complete
 * isolation from the dispatcher and the stage registry that call them.
 */

/**
 * The plan doc's soft size budget, in ~tokens (4 chars/token, the same rough conversion the
 * rest of the codebase uses for prompt-size reasoning). This is the SAME ceiling the `plan_check`
 * stage mechanically rejects a doc for exceeding — kept here, not duplicated, so the authoring
 * stage, the checker stage, and this formatter can never drift out of agreement on the number.
 */
export const PLAN_TOKEN_CEILING = 800; // ~3,200 chars at 4 chars/token

/** Convert the token ceiling to the char budget this module actually measures against. */
const PLAN_CHAR_CEILING = PLAN_TOKEN_CEILING * 4;

/**
 * The six sections a plan document is authored against, in canonical order. The plan stage's
 * `buildPrompt` (STAGE half, `plan-stage.ts`) instructs the author to use these as markdown
 * headings; this module locates sections by matching a heading's text against this list
 * case-insensitively, so heading level (`##` vs `###`) and exact author phrasing of everything
 * BUT the six names don't matter.
 */
export const PLAN_SECTIONS = [
  "Scope & files",
  "Approach",
  "Conventions & traps",
  "Acceptance mapping",
  "Verification commands",
  "Open questions",
] as const;

/**
 * Sections this module will drop, in the order it drops them, when a doc overruns the ceiling
 * despite `plan_check` — this is what the two lowest-value-per-token sections buy back. "Scope &
 * files" and "Approach" are NEVER dropped: they're the two sections a worker most needs to skip
 * re-deriving, per the Plan Stage design's own reasoning for the drop order.
 */
const DROPPABLE_SECTIONS: readonly string[] = ["Open questions", "Conventions & traps"];

/** True iff `doc` fits the plan artifact's size budget. Pure, no I/O — a mechanical char count. */
export function planWithinCeiling(doc: string): boolean {
  return doc.length <= PLAN_CHAR_CEILING;
}

interface ParsedSection {
  /** The canonical {@link PLAN_SECTIONS} name if the heading matched one, else the raw heading text. */
  name: string;
  /** The heading line's own text, exactly as authored (kept so re-rendering is lossless). */
  heading: string;
  body: string;
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/gm;

/**
 * Split a plan doc into its headed sections, preserving the doc's own order (not
 * {@link PLAN_SECTIONS}'s canonical order — a doc that orders its sections differently is
 * rendered as-authored). Content before the first heading (if any) becomes an unnamed
 * "preamble" section that is never a drop candidate — {@link DROPPABLE_SECTIONS} matches by
 * name only. A doc with no recognizable headings at all comes back as one preamble section, so
 * hand-written fixtures / malformed docs still degrade to "render everything, then hard-truncate
 * if it's still too big" rather than throwing.
 */
function parseSections(doc: string): ParsedSection[] {
  const matches = [...doc.matchAll(HEADING_RE)];
  if (matches.length === 0) {
    const body = doc.trim();
    return body ? [{ name: "__preamble__", heading: "", body }] : [];
  }

  const sections: ParsedSection[] = [];
  const preamble = doc.slice(0, matches[0]!.index!).trim();
  if (preamble) sections.push({ name: "__preamble__", heading: "", body: preamble });

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const headingText = m[1]!.trim();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : doc.length;
    const body = doc.slice(start, end).trim();
    const canonical = PLAN_SECTIONS.find((s) => s.toLowerCase() === headingText.toLowerCase());
    sections.push({ name: canonical ?? headingText, heading: headingText, body });
  }
  return sections;
}

/** Re-render a section list back to markdown, in list order. */
function renderSections(sections: ParsedSection[]): string {
  return sections
    .map((s) => (s.name === "__preamble__" ? s.body : `## ${s.heading}\n\n${s.body}`))
    .filter(Boolean)
    .join("\n\n");
}

const TRUNCATION_NOTE =
  "\n\n_[plan truncated: the document exceeded the plan artifact's size budget even after " +
  "dropping optional sections — see the committed doc for the full text]_";

/**
 * Format a plan doc's raw markdown into the inlined `<plan>...</plan>` block for implement's
 * turn-1 prompt (mirrors `reviewDiffBlock`'s shape, `stages.ts:360-376`: inline when it fits,
 * degrade gracefully when it doesn't, never throw). Returns `""` when `doc` is undefined/empty —
 * implement's prompt must be byte-identical to today's output for any ticket with no plan (see
 * this module's header comment, failure mode 2).
 *
 * The header line carries the doc's authored-against SHA as a freshness marker, so a worker that
 * picks up a ticket after other commits landed knows the plan may be stale in places rather than
 * silently trusting file references that have since moved.
 *
 * Non-empty output always ends with a blank line, so callers can prepend it directly ahead of
 * `<task>` with no extra join logic (`planContextBlock(...) + genericTaskPromptBody`).
 */
export function planContextBlock(doc: string | undefined, sha: string | undefined): string {
  const trimmed = doc?.trim();
  if (!trimmed) return "";

  const header = sha
    ? `plan authored against ${sha.slice(0, 7)}; if HEAD has moved further, re-verify affected sections.`
    : "plan authored at an unspecified revision; re-verify affected sections if this looks stale.";

  const allSections = parseSections(trimmed);
  const wrap = (body: string) => `<plan>\n${header}\n\n${body}\n</plan>\n\n`;

  // Try full content, then drop DROPPABLE_SECTIONS one at a time (in their declared order),
  // then hard-truncate what's left — never dropping "Scope & files" or "Approach", and never
  // overrunning the ceiling regardless of how big the input was.
  let dropped = 0;
  for (; dropped <= DROPPABLE_SECTIONS.length; dropped++) {
    const dropNames = new Set(DROPPABLE_SECTIONS.slice(0, dropped));
    const kept = allSections.filter((s) => !dropNames.has(s.name));
    const rendered = renderSections(kept);
    if (rendered.length <= PLAN_CHAR_CEILING || dropped === DROPPABLE_SECTIONS.length) {
      if (rendered.length <= PLAN_CHAR_CEILING) return wrap(rendered);
      // Still over budget after dropping every droppable section — hard-truncate the rest,
      // reserving room for the truncation note so the final block never overruns the ceiling.
      const budget = Math.max(0, PLAN_CHAR_CEILING - TRUNCATION_NOTE.length);
      return wrap(rendered.slice(0, budget) + TRUNCATION_NOTE);
    }
  }

  // Unreachable (the loop above always returns), kept only so control flow is provably total.
  return wrap(renderSections(allSections));
}

/**
 * The system-append line telling an implement worker to treat the inlined plan as given rather
 * than re-deriving it — the actual turn-reduction lever (see the Plan Stage design's turn-cost
 * table). Explicitly licenses overriding a wrong plan: the plan stage still "may investigate but
 * less so" per the owner's framing, it is not a blindfold.
 */
export function planNoRederiveNote(): string {
  return (
    "A plan document is inlined above under `<plan>`. Treat Scope/Approach/Conventions/" +
    "Acceptance-mapping as given — do not re-derive them from scratch. Investigate only what's " +
    "listed under Open Questions, or anything you discover is actually wrong (say so and correct " +
    "course)."
  );
}

/**
 * Review's pointer-only line — NOT the full doc. Review already has the diff as ground truth via
 * `preloadsDiff`; inlining an ~800-token plan block a second time into every review turn would
 * cost more than it saves (the Plan Stage design's priority-2 cost discipline), so review gets a
 * path to read on demand instead.
 */
export function planReviewPointer(planDocPath: string): string {
  return (
    `A shared-context plan exists at \`${planDocPath}\` (read it if you need the intended ` +
    `approach; the diff above is what actually shipped).`
  );
}
