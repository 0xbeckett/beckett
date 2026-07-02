/**
 * Unit coverage for the human-cadence reply chunker (OPS-62): threshold (short = one message,
 * byte-for-byte), natural boundaries (paragraph → sentence), code-fence preservation, strict
 * ordering, over-fragmentation cap, and the bounded inter-message latency schedule. All pure —
 * no live gateway, no real timers.
 */

import { expect, test, describe } from "bun:test";
import {
  chunkReply,
  chunkDelayMs,
  delaySchedule,
  CHUNK_THRESHOLD,
  MAX_CHUNKS,
  MIN_GAP_MS,
  MAX_GAP_MS,
  TOTAL_DELAY_BUDGET_MS,
} from "./chunk.ts";

describe("chunkReply — threshold / single-message behavior", () => {
  test("empty content yields no messages", () => {
    expect(chunkReply("")).toEqual([]);
  });

  test("short reply stays a single message, byte-for-byte", () => {
    const short = "hey — on it, back in a sec.";
    expect(chunkReply(short)).toEqual([short]);
  });

  test("a reply at exactly the threshold is not split", () => {
    const atLimit = "a".repeat(CHUNK_THRESHOLD);
    expect(chunkReply(atLimit)).toEqual([atLimit]);
  });

  test("multi-paragraph but under threshold stays one message", () => {
    const twoShortParas = "first thought\n\nsecond thought";
    expect(twoShortParas.length).toBeLessThan(CHUNK_THRESHOLD);
    expect(chunkReply(twoShortParas)).toEqual([twoShortParas]);
  });

  test("an unbreakable long run is returned unchanged rather than force-split", () => {
    const wall = "x".repeat(CHUNK_THRESHOLD + 200); // no spaces, no boundaries
    expect(chunkReply(wall)).toEqual([wall]);
  });
});

describe("chunkReply — natural boundaries + ordering", () => {
  test("long multi-paragraph reply splits on blank lines, order preserved", () => {
    const p1 = "A".repeat(200);
    const p2 = "B".repeat(200);
    const p3 = "C".repeat(200);
    const out = chunkReply(`${p1}\n\n${p2}\n\n${p3}`);
    expect(out.length).toBeGreaterThan(1);
    // Order is strict: the A-paragraph precedes the B-paragraph precedes the C-paragraph.
    const joined = out.join("\n");
    expect(joined.indexOf("A")).toBeLessThan(joined.indexOf("B"));
    expect(joined.indexOf("B")).toBeLessThan(joined.indexOf("C"));
    // No message dropped any paragraph content.
    expect(joined).toContain(p1);
    expect(joined).toContain(p2);
    expect(joined).toContain(p3);
  });

  test("a very long single paragraph falls back to sentence boundaries, never mid-sentence", () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `This is sentence number ${i} which is reasonably long.`);
    const para = sentences.join(" ");
    expect(para.length).toBeGreaterThan(CHUNK_THRESHOLD);
    const out = chunkReply(para);
    expect(out.length).toBeGreaterThan(1);
    // Every emitted message ends at a sentence terminator — no split landed inside a sentence.
    for (const msg of out) {
      expect(/[.!?]["')\]]*$/.test(msg.trim())).toBe(true);
    }
    // Every sentence survives somewhere, in order.
    const joined = out.join(" ");
    let cursor = -1;
    for (let i = 0; i < sentences.length; i++) {
      const at = joined.indexOf(`sentence number ${i}`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});

describe("chunkReply — code-fence preservation", () => {
  test("a fenced code block is never split and stays one contiguous message", () => {
    const intro = "here's the fix:";
    const code = "```ts\n" + "const x = 1;\n".repeat(40) + "```"; // well over the threshold
    const outro = "let me know if that compiles.";
    const out = chunkReply(`${intro}\n\n${code}\n\n${outro}`);
    // Exactly one emitted message is the whole fence, opening+closing intact.
    const fenceMsgs = out.filter((m) => m.includes("```ts"));
    expect(fenceMsgs).toHaveLength(1);
    const fence = fenceMsgs[0]!;
    expect(fence.startsWith("```ts")).toBe(true);
    expect(fence.trimEnd().endsWith("```")).toBe(true);
    // The fence body is unbroken — the same number of code lines it went in with.
    expect(fence.match(/const x = 1;/g)).toHaveLength(40);
  });

  test("blank lines INSIDE a fence do not trigger a split", () => {
    const code = "```\nline one\n\nline two\n\nline three\n```";
    const long = "prose paragraph ".repeat(30).trim();
    const out = chunkReply(`${long}\n\n${code}`);
    const fenceMsgs = out.filter((m) => m.includes("line one"));
    expect(fenceMsgs).toHaveLength(1);
    expect(fenceMsgs[0]).toBe(code);
  });

  test("an unterminated fence keeps its tail whole", () => {
    const head = "explanation ".repeat(30).trim();
    const openFence = "```js\nnever closed\nstill going";
    const out = chunkReply(`${head}\n\n${openFence}`);
    const fenceMsgs = out.filter((m) => m.includes("never closed"));
    expect(fenceMsgs).toHaveLength(1);
    expect(fenceMsgs[0]).toBe(openFence);
  });
});

describe("chunkReply — fragmentation cap", () => {
  test("never produces more than maxChunks messages", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"z".repeat(120)}`).join("\n\n");
    const out = chunkReply(many);
    expect(out.length).toBeLessThanOrEqual(MAX_CHUNKS);
    // All content survives — the overflow is merged into the last message, not dropped.
    const joined = out.join("\n\n");
    for (let i = 0; i < 30; i++) expect(joined).toContain(`Paragraph ${i}`);
  });

  test("a custom maxChunks is honored", () => {
    const many = Array.from({ length: 12 }, (_, i) => `Para ${i} ${"q".repeat(150)}`).join("\n\n");
    const out = chunkReply(many, { maxChunks: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
  });
});

describe("chunkDelayMs / delaySchedule — bounded human cadence", () => {
  test("a single delay stays within the human band", () => {
    for (const len of [0, 50, 300, 1000, 5000]) {
      const d = chunkDelayMs(len, () => 0.5);
      expect(d).toBeGreaterThanOrEqual(MIN_GAP_MS);
      expect(d).toBeLessThanOrEqual(MAX_GAP_MS);
    }
  });

  test("longer chunks map to longer typing delays", () => {
    const short = chunkDelayMs(20, () => 0.5);
    const long = chunkDelayMs(1000, () => 0.5);
    expect(long).toBeGreaterThan(short);
  });

  test("schedule has one gap between each pair of messages", () => {
    const gaps = delaySchedule([100, 100, 100, 100], { rand: () => 0.5 });
    expect(gaps).toHaveLength(3); // 4 messages ⇒ 3 gaps
  });

  test("a single message has no delay at all", () => {
    expect(delaySchedule([100], { rand: () => 0.5 })).toEqual([]);
  });

  test("total added latency is capped by the budget", () => {
    // 50 long messages would blow way past the budget without the cap.
    const lengths = Array.from({ length: 50 }, () => 5000);
    const gaps = delaySchedule(lengths, { rand: () => 0.9 });
    const total = gaps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_DELAY_BUDGET_MS);
    // Once the budget is spent, the remaining gaps are zero (send promptly).
    expect(gaps[gaps.length - 1]).toBe(0);
  });

  test("respects a custom budget exactly", () => {
    const lengths = Array.from({ length: 20 }, () => 4000);
    const gaps = delaySchedule(lengths, { budget: 2500, rand: () => 0.5 });
    expect(gaps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2500);
  });
});
