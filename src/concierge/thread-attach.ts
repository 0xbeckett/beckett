/**
 * Beckett — thread attach command (`src/concierge/thread-attach.ts`)
 * =======================================================================================
 * Beckett never creates threads any more; the PERSON creates one when they want an organized
 * space, and claims work for it by posting a message whose entire content is `&<ref>` (or
 * `&recent`). From that point the attached work reports into their thread instead of the
 * channel. `&clear` gives the thread back.
 *
 * The parse rule is deliberately, almost rudely strict: the ENTIRE trimmed message content must
 * be the command and nothing else. That strictness IS the feature. `&` is an ordinary character
 * in ordinary prose — "tom & jerry", "&recent is a good idea", "see &12 for context" — and a
 * lenient parser that scans for a `&12` anywhere in a sentence would silently rebind where a
 * ticket reports every time someone mentions it in conversation. A missed attach is a person
 * typing four characters again; a false attach is work vanishing into a thread nobody is
 * watching. So: exact match or `null`.
 *
 * The module is PURE. It answers "is this message an attach command, and for what?" and knows
 * nothing about Discord, threads, or the task store — the caller owns the side effects and owns
 * deciding whether the ref actually exists.
 */

/**
 * What the person asked for. Discriminated so the caller must handle each case explicitly —
 * `recent` and `task` bind different things, and `clear` unbinds.
 */
export type AttachCommand =
  /** `&recent` — attach the work most recently filed by this person. */
  | { kind: "recent" }
  /** `&12` / `&#12.1` — attach one specific task. `ref` is normalized (no leading `#`). */
  | { kind: "task"; ref: string }
  /** `&clear` — detach everything currently reporting into this thread. */
  | { kind: "clear" };

/**
 * A task ref: dotted numeric segments, at most four deep (`12`, `12.1`, `12.1.3.4`). The depth
 * cap and the leading-zero ban exist so that a typo or a paste of some unrelated dotted number
 * (a version string, an IP-ish fragment) reads as prose and falls through to `null` rather than
 * being accepted as a ref that can never resolve.
 */
const TASK_REF_PATTERN = /^\d+(?:\.\d+){0,3}$/;

/** `&` + optional `#` + the ref, anchored — no leading text, no trailing text, no spaces. */
const ATTACH_TASK_PATTERN = /^&#?([\d.]+)$/;

/** Leading zeros are never how a ticket is spelled; `&012` is a typo, not ticket 12. */
function hasLeadingZeroSegment(ref: string): boolean {
  return ref.split(".").some((seg) => /^0\d/.test(seg));
}

/**
 * Parse an attach command, or `null` if the content is anything else at all.
 *
 * Whitespace around the WHOLE content is forgiven (Discord clients love a trailing newline, and
 * a mobile keyboard loves a trailing space); nothing internal is. `String.prototype.trim` covers
 * unicode whitespace — NBSP, ideographic space, line separators — so a copy-pasted `&recent`
 * with an invisible companion still lands.
 */
export function parseAttachCommand(content: string): AttachCommand | null {
  if (typeof content !== "string") return null;
  const text = content.trim();
  // Cheapest possible rejection for the overwhelmingly common case: ordinary chat.
  if (text.length < 2 || !text.startsWith("&")) return null;

  const lower = text.toLowerCase();
  if (lower === "&recent") return { kind: "recent" };
  if (lower === "&clear") return { kind: "clear" };

  const m = ATTACH_TASK_PATTERN.exec(text);
  if (!m) return null;
  const ref = m[1]!;
  // `[\d.]+` above is loose on purpose so that `12.`, `1..2` and `1.2.3.4.5` reach a single
  // explicit validity check here rather than being three near-identical regex branches.
  if (!TASK_REF_PATTERN.test(ref)) return null;
  if (hasLeadingZeroSegment(ref)) return null;
  return { kind: "task", ref };
}
