/**
 * Beckett — Human-cadence reply chunking (`src/discord/chunk.ts`)
 * =======================================================================================
 * Beckett's replies should read like a person tapping out a few messages, not one wall of
 * text dropped in a single API call. This module owns the *natural* split (paragraph →
 * sentence boundaries, code fences kept whole) and the *typing cadence* (a flat, jittered 2–4s
 * pause between messages, with a hard latency cap). It is deliberately a set
 * of PURE functions so the splitter + cadence can be unit-tested without a live gateway; the
 * gateway ({@link file://./gateway.ts} `sendNow`) wires them into the one shared send point so
 * BOTH the auto-posted turn text and the `beckett discord reply` CLI path benefit.
 *
 * This is a separate concern from {@link splitDiscordContent} in gateway.ts: that one enforces
 * Discord's hard 2000-char ceiling (a physical limit); this one decides where a reply reads as
 * "several messages" for *humanness*. The gateway applies this split first, then the hard-limit
 * split per section, so a section that is still too long stays correct.
 */

/**
 * Sentence-split threshold: a SINGLE paragraph longer than this is broken on sentence
 * boundaries so no one message is a wall. It is NOT a "collapse everything shorter into one
 * message" switch — a blank line between paragraphs always splits, however short (that's how
 * an "I'll check." ack lands as its own message ahead of the answer). A lone short paragraph
 * still comes back byte-for-byte.
 */
export const CHUNK_THRESHOLD = 300;

/** Never fragment a reply into more than this many messages (over-fragmentation guard). */
export const MAX_CHUNKS = 6;

/**
 * Inter-bubble pause band (OPS-84): the gap between two consecutive messages is a flat, uniform
 * random value in this range — deliberately NOT scaled to message length. 2–4s reads like a person
 * tapping out the next bubble, and the randomness keeps the cadence off a fixed metronome.
 */
export const MIN_GAP_MS = 2_000;
export const MAX_GAP_MS = 4_000;

/**
 * Total added latency ceiling: a pathological many-chunk reply can never take longer than this to
 * finish. Sized well above a normal multi-bubble reply (4 bubbles ⇒ 3 gaps ⇒ ≤12s even when every
 * gap hits the 4s ceiling) so the budget only ever bites a genuinely over-fragmented reply, never
 * an ordinary chilled one.
 */
export const TOTAL_DELAY_BUDGET_MS = 16_000;

export interface ChunkOptions {
  /** Below this length (and nothing to split) the whole reply is one message. */
  threshold?: number;
  /** Cap on the number of messages produced. Overflow is merged into the last chunk. */
  maxChunks?: number;
}

/**
 * Split a reply into natural, sequentially-sendable messages.
 *
 * Rules (Spec: OPS-62, revised):
 *  - **A blank line between paragraphs is a message boundary.** Each paragraph becomes its own
 *    message — even when the whole reply is short. This is how a "I'll check." ack is sent ahead
 *    of the answer instead of glued to it. Paragraphs are NOT packed back together; the model
 *    controls cadence by choosing where to put a blank line (single newlines keep one message).
 *  - A LONE paragraph (no blank lines) is one message, byte-for-byte — unless it's longer than
 *    `threshold`, in which case it falls back to sentence boundaries so no message is a wall. A
 *    split NEVER lands mid-sentence.
 *  - A fenced code block (```…```) is always one contiguous message and is never split, even if
 *    the fence is never closed (safer to keep the tail whole than to guess a boundary).
 *  - `maxChunks` bounds fragmentation; excess chunks are merged back into the last one.
 *  - If the text can't be split into ≥2 pieces, the ORIGINAL string is returned untouched.
 */
export function chunkReply(content: string, opts: ChunkOptions = {}): string[] {
  const threshold = opts.threshold ?? CHUNK_THRESHOLD;
  const maxChunks = Math.max(1, opts.maxChunks ?? MAX_CHUNKS);
  if (content.length === 0) return [];

  const blocks = toBlocks(content);

  // A single block (one paragraph or one fence) is one message — byte-for-byte for the common
  // short reply. The only reason to break it is a long single paragraph, which we split on
  // sentence boundaries so it doesn't arrive as a wall.
  if (blocks.length <= 1) {
    const only = blocks[0];
    if (!only || only.isFence || only.text.length <= threshold) return [content];
    const sentences = packSentences(only.text, threshold);
    return sentences.length <= 1 ? [content] : capChunks(sentences, maxChunks);
  }

  // Multiple blocks: honor every blank-line boundary as its own message (no packing). A fence
  // stands alone; a paragraph over `threshold` breaks into sentence-sized messages.
  const chunks: string[] = [];
  for (const block of blocks) {
    if (block.isFence || block.text.length <= threshold) {
      chunks.push(block.text);
    } else {
      chunks.push(...packSentences(block.text, threshold));
    }
  }

  // Couldn't actually break it up → send the original, unchanged.
  if (chunks.length <= 1) return [content];
  return capChunks(chunks, maxChunks);
}

/**
 * Break a long paragraph into sentence-sized messages: greedily pack whole sentences up to
 * `limit`, never cutting inside a sentence. Returns `[text]` when there are no sentence
 * boundaries to split on (an unbreakable run).
 */
function packSentences(text: string, limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const sentence of splitSentences(text)) {
    if (cur && cur.length + 1 + sentence.length > limit) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) out.push(cur);
  return out;
}

/** Over-fragmentation / latency guard: merge the tail so we never exceed `maxChunks` messages. */
function capChunks(chunks: string[], maxChunks: number): string[] {
  if (chunks.length <= maxChunks) return chunks;
  const head = chunks.slice(0, maxChunks - 1);
  const tail = chunks.slice(maxChunks - 1).join("\n\n");
  return [...head, tail];
}

/** An ordered piece of the reply: either prose (`isFence:false`) or a whole code fence. */
interface Block {
  text: string;
  isFence: boolean;
}

/**
 * Break content into ordered blocks: fenced code stays intact as one block, prose is split into
 * paragraphs on blank lines. Order is strictly preserved. An unterminated fence keeps everything
 * from the opening ``` to end-of-text as a single (fence) block.
 */
function toBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flushProse = () => {
    if (buf.length === 0) return;
    const prose = buf.join("\n");
    buf = [];
    for (const para of prose.split(/\n{2,}/)) {
      const t = para.trim();
      if (t) blocks.push({ text: t, isFence: false });
    }
  };

  for (const line of lines) {
    const isFenceMarker = /^\s*```/.test(line);
    if (isFenceMarker && !inFence) {
      flushProse();
      inFence = true;
      buf.push(line);
    } else if (isFenceMarker && inFence) {
      buf.push(line);
      blocks.push({ text: buf.join("\n"), isFence: true });
      buf = [];
      inFence = false;
    } else {
      buf.push(line);
    }
  }
  // Trailing buffer: an unterminated fence is emitted whole; leftover prose is paragraph-split.
  if (inFence && buf.length > 0) {
    blocks.push({ text: buf.join("\n"), isFence: true });
  } else {
    flushProse();
  }
  return blocks;
}

/**
 * Split prose into sentences, keeping terminal punctuation. Never cuts inside a sentence — and
 * never loses a character: the text is sliced AT boundary positions (terminator + optional
 * closing quotes/brackets + whitespace), so every slice together covers the whole input. A `.`
 * with no whitespace after it (a URL, `$4,099.99`, `v1.2.3`) is never a boundary. The old
 * `match(/g)`-based splitter silently DROPPED any run the sentence pattern couldn't match —
 * a long paragraph containing a bare URL went to Discord with the URL's head deleted.
 */
function splitSentences(text: string): string[] {
  const boundary = /[.!?]+["')\]]*\s+/g;
  const out: string[] = [];
  let start = 0;
  for (let m = boundary.exec(text); m !== null; m = boundary.exec(text)) {
    const piece = text.slice(start, m.index + m[0].length).trim();
    if (piece) out.push(piece);
    start = m.index + m[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [text.trim()];
}

/**
 * The pause (ms) before sending the NEXT bubble: a flat, uniform random value in
 * [{@link MIN_GAP_MS}, {@link MAX_GAP_MS}] (OPS-84). Deliberately independent of message length —
 * SSH wants every inter-bubble pause to feel the same, not "longer message ⇒ longer wait". `rand`
 * is injectable for deterministic tests; it defaults to `Math.random`.
 */
export function bubbleGapMs(rand: () => number = Math.random): number {
  return Math.round(MIN_GAP_MS + rand() * (MAX_GAP_MS - MIN_GAP_MS));
}

export interface ScheduleOptions {
  /** Total latency ceiling across all gaps. Defaults to {@link TOTAL_DELAY_BUDGET_MS}. */
  budget?: number;
  /** Injectable RNG for deterministic tests. Defaults to `Math.random`. */
  rand?: () => number;
}

/**
 * Build the inter-message delay schedule for a reply that lands as `count` messages. Returns one
 * gap per gap between consecutive messages (so `count - 1` entries); gap `i` precedes message
 * `i+1`. The FIRST message has no leading gap — it always sends immediately. Each gap is a flat
 * random 2–4s pause ({@link bubbleGapMs}), independent of message length. The sum is capped at
 * `budget`: once the budget is spent the remaining gaps are 0, so a pathological many-chunk reply
 * can never take forever.
 */
export function delaySchedule(count: number, opts: ScheduleOptions = {}): number[] {
  const budget = opts.budget ?? TOTAL_DELAY_BUDGET_MS;
  const rand = opts.rand ?? Math.random;
  const gaps: number[] = [];
  let spent = 0;
  for (let i = 1; i < count; i++) {
    if (spent >= budget) {
      gaps.push(0);
      continue;
    }
    let gap = bubbleGapMs(rand);
    if (spent + gap > budget) gap = budget - spent; // trim the final gap to fit the budget
    spent += gap;
    gaps.push(gap);
  }
  return gaps;
}
