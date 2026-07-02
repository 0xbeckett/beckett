/**
 * Beckett — Human-cadence reply chunking (`src/discord/chunk.ts`)
 * =======================================================================================
 * Beckett's replies should read like a person tapping out a few messages, not one wall of
 * text dropped in a single API call. This module owns the *natural* split (paragraph →
 * sentence boundaries, code fences kept whole) and the *typing cadence* (a short, jittered,
 * length-scaled delay between messages, with a hard latency cap). It is deliberately a set
 * of PURE functions so the splitter + cadence can be unit-tested without a live gateway; the
 * gateway ({@link file://./gateway.ts} `sendNow`) wires them into the one shared send point so
 * BOTH the auto-posted turn text and the `beckett discord reply` CLI path benefit.
 *
 * This is a separate concern from {@link splitDiscordContent} in gateway.ts: that one enforces
 * Discord's hard 2000-char ceiling (a physical limit); this one decides where a reply reads as
 * "several messages" for *humanness*. The gateway applies this split first, then the hard-limit
 * split per section, so a section that is still too long stays correct.
 */

/** Under this many chars a reply is a single message — byte-for-byte identical to before. */
export const CHUNK_THRESHOLD = 300;

/** Never fragment a reply into more than this many messages (over-fragmentation guard). */
export const MAX_CHUNKS = 6;

/** Inter-message delay floor / ceiling (~1–3s so it reads as human typing, not robotic). */
export const MIN_GAP_MS = 900;
export const MAX_GAP_MS = 2800;

/** Total added latency ceiling: a very long reply can never take longer than this to finish. */
export const TOTAL_DELAY_BUDGET_MS = 9_000;

/** Length that maps to the max gap — chunks longer than this all "take" MAX_GAP_MS to type. */
const GAP_SCALE_CHARS = 400;
/** Peak-to-peak jitter added to a gap (±half of this) so the cadence isn't a fixed metronome. */
const GAP_JITTER_MS = 600;

export interface ChunkOptions {
  /** Below this length (and nothing to split) the whole reply is one message. */
  threshold?: number;
  /** Cap on the number of messages produced. Overflow is merged into the last chunk. */
  maxChunks?: number;
}

/**
 * Split a reply into natural, sequentially-sendable messages.
 *
 * Rules (Spec: OPS-62):
 *  - Short replies (≤ `threshold`) return `[content]` UNCHANGED — one message, byte-for-byte.
 *  - Splits prefer paragraph breaks (blank lines); a paragraph that is itself very long falls
 *    back to sentence boundaries. A split NEVER lands mid-sentence.
 *  - A fenced code block (```…```) is always one contiguous message and is never split, even if
 *    the fence is never closed (safer to keep the tail whole than to guess a boundary).
 *  - `maxChunks` bounds fragmentation; excess chunks are merged back into the last one.
 *  - If the text can't be split into ≥2 pieces, the ORIGINAL string is returned untouched.
 */
export function chunkReply(content: string, opts: ChunkOptions = {}): string[] {
  const threshold = opts.threshold ?? CHUNK_THRESHOLD;
  const maxChunks = Math.max(1, opts.maxChunks ?? MAX_CHUNKS);
  if (content.length === 0) return [];
  // Short reply: exactly one message, identical to today. Also covers the common case cheaply.
  if (content.length <= threshold) return [content];

  const blocks = toBlocks(content);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = "";
    }
  };

  for (const block of blocks) {
    if (block.isFence) {
      // A code fence stands alone as its own message — never merged, never split.
      flush();
      chunks.push(block.text);
      continue;
    }
    if (block.text.length <= threshold) {
      // A normal paragraph: pack with adjacent short paragraphs up to the soft target.
      if (cur && cur.length + 2 + block.text.length > threshold) flush();
      cur = cur ? `${cur}\n\n${block.text}` : block.text;
      continue;
    }
    // A single very long paragraph: fall back to sentence boundaries so no message is a wall,
    // and never cut inside a sentence.
    flush();
    let sc = "";
    for (const sentence of splitSentences(block.text)) {
      if (sc && sc.length + 1 + sentence.length > threshold) {
        chunks.push(sc);
        sc = "";
      }
      sc = sc ? `${sc} ${sentence}` : sentence;
    }
    if (sc) chunks.push(sc);
  }
  flush();

  // Couldn't actually break it up (e.g. one unbroken run) → send the original, unchanged.
  if (chunks.length <= 1) return [content];

  // Over-fragmentation / latency guard: merge the tail so we never exceed maxChunks messages.
  if (chunks.length > maxChunks) {
    const head = chunks.slice(0, maxChunks - 1);
    const tail = chunks.slice(maxChunks - 1).join("\n\n");
    return [...head, tail];
  }
  return chunks;
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

/** Split prose into sentences, keeping terminal punctuation. Never cuts inside a sentence. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)(?:\s+|$)/g);
  if (!parts) return [text.trim()];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Delay (ms) to "type" a chunk of the given length before sending the NEXT message: a base gap
 * scaled toward the chunk's length plus small jitter, clamped to the human band. `rand` is
 * injectable for deterministic tests; it defaults to `Math.random`.
 */
export function chunkDelayMs(chunkLen: number, rand: () => number = Math.random): number {
  const span = MAX_GAP_MS - MIN_GAP_MS;
  const scaled = MIN_GAP_MS + (Math.min(chunkLen, GAP_SCALE_CHARS) / GAP_SCALE_CHARS) * span;
  const jitter = (rand() - 0.5) * GAP_JITTER_MS;
  return Math.round(clamp(scaled + jitter, MIN_GAP_MS, MAX_GAP_MS));
}

export interface ScheduleOptions {
  /** Total latency ceiling across all gaps. Defaults to {@link TOTAL_DELAY_BUDGET_MS}. */
  budget?: number;
  /** Injectable RNG for deterministic tests. Defaults to `Math.random`. */
  rand?: () => number;
}

/**
 * Build the inter-message delay schedule for a sequence of message lengths. Returns one gap per
 * gap between consecutive messages (so `lengths.length - 1` entries); gap `i` precedes message
 * `i+1` and is scaled to message `i` (the one just "typed"). The sum is capped at `budget`: once
 * the budget is spent the remaining gaps are 0, so a huge reply can never take forever.
 */
export function delaySchedule(lengths: number[], opts: ScheduleOptions = {}): number[] {
  const budget = opts.budget ?? TOTAL_DELAY_BUDGET_MS;
  const rand = opts.rand ?? Math.random;
  const gaps: number[] = [];
  let spent = 0;
  for (let i = 1; i < lengths.length; i++) {
    if (spent >= budget) {
      gaps.push(0);
      continue;
    }
    let gap = chunkDelayMs(lengths[i - 1]!, rand);
    if (spent + gap > budget) gap = budget - spent; // trim the final gap to fit the budget
    spent += gap;
    gaps.push(gap);
  }
  return gaps;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
