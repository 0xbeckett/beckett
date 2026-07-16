/**
 * Unit coverage for the human-cadence reply chunker (OPS-62): threshold (short = one message,
 * byte-for-byte), natural boundaries (paragraph → sentence), code-fence preservation, strict
 * ordering, over-fragmentation cap, and the bounded inter-message latency schedule. All pure —
 * no live gateway, no real timers.
 */

import { expect, test, describe } from "bun:test";
import {
  chunkReply,
  bubbleGapMs,
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

  test("multi-paragraph splits at the blank line even when short (a blank line = a new message)", () => {
    const twoShortParas = "first thought\n\nsecond thought";
    expect(twoShortParas.length).toBeLessThan(CHUNK_THRESHOLD);
    expect(chunkReply(twoShortParas)).toEqual(["first thought", "second thought"]);
  });

  test("a short ack + answer separated by a blank line become two messages (OPS regression)", () => {
    const reply = `I'll check.\n\nno peers. your list's empty. add one with "add @TheBot to my peers" and i'll wire it up.`;
    expect(reply.length).toBeLessThan(CHUNK_THRESHOLD);
    expect(chunkReply(reply)).toEqual([
      "I'll check.",
      `no peers. your list's empty. add one with "add @TheBot to my peers" and i'll wire it up.`,
    ]);
  });

  test("single newlines stay in ONE message — only blank lines split", () => {
    const oneMessage = "line one\nline two\nline three";
    expect(chunkReply(oneMessage)).toEqual([oneMessage]);
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

describe("chunkReply — sentence split never loses text (URL / decimal regression)", () => {
  // The old match(/g)-based splitSentences silently DROPPED any run its sentence pattern
  // couldn't consume: a '.' not followed by whitespace (URLs, $4,099.99) made it discard
  // everything scanned since the previous boundary. A real reply lost "https://www.newegg."
  // and "($4,099." on the way to Discord. Splits may only ever rearrange whitespace.
  const strip = (s: string) => s.replace(/\s+/g, "");

  test("a long paragraph containing a bare URL keeps the URL intact and loses nothing", () => {
    const url =
      "https://www.newegg.com/msi-rtx-5090-32g-suprim-liquid-soc-geforce-rtx-5090-32gb-graphics-card-liquid-cooler/p/N82E16814137916";
    const para =
      `Found an in-stock, buyable NVIDIA RTX 5090 graphics card on Newegg: ${url} — the MSI Suprim ` +
      `Liquid SOC with a live listed price ($4,099.99), and an active "Add to cart" buy button as proof ` +
      `of real availability (not just an out-of-stock product page). Several other RTX 5090 cards were ` +
      `also confirmed in stock on Newegg in the $4,099–$4,330 range if this one runs out.`;
    expect(para.length).toBeGreaterThan(CHUNK_THRESHOLD);
    const out = chunkReply(para);
    // The URL survives, whole, inside exactly one message.
    expect(out.filter((m) => m.includes(url))).toHaveLength(1);
    // The decimal price survives, undismembered.
    expect(out.some((m) => m.includes("($4,099.99)"))).toBe(true);
    // Nothing was dropped anywhere: the messages re-concatenate to the input (modulo whitespace).
    expect(strip(out.join(" "))).toBe(strip(para));
  });

  test("splitting is lossless for punctuation-dense prose (decimals, abbreviations, versions)", () => {
    const para =
      `Upgraded to v2.13.4 today. The p95 latency dropped from 412.7ms to 96.3ms (i.e. a 4.3x win) ` +
      `after the fix landed in commit abc123... but watch the e.g. cases in config.toml, ` +
      `notably retry.max=3 and timeout=35.5s! ` +
      `See https://example.com/changelog#v2.13.4 for details. ` +
      `${"More filler prose to push this paragraph well past the sentence-split threshold. ".repeat(3)}`.trim();
    expect(para.length).toBeGreaterThan(CHUNK_THRESHOLD);
    const out = chunkReply(para);
    expect(strip(out.join(" "))).toBe(strip(para));
  });

  test("a paragraph whose only periods are inside a URL is returned whole, not shredded", () => {
    const longUrl = `https://example.com/${"segment.with.dots/".repeat(25)}end`;
    const para = `grab it here ${longUrl} before it goes down`;
    expect(para.length).toBeGreaterThan(CHUNK_THRESHOLD);
    const out = chunkReply(para);
    expect(out.some((m) => m.includes(longUrl))).toBe(true);
    expect(strip(out.join(" "))).toBe(strip(para));
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

describe("bubbleGapMs / delaySchedule — flat 2–4s inter-bubble jitter (OPS-84)", () => {
  test("a single gap is a flat random value in [MIN_GAP_MS, MAX_GAP_MS]", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = bubbleGapMs(() => r);
      expect(d).toBeGreaterThanOrEqual(MIN_GAP_MS);
      expect(d).toBeLessThanOrEqual(MAX_GAP_MS);
    }
    // The band is exactly [2000, 4000].
    expect(MIN_GAP_MS).toBe(2000);
    expect(MAX_GAP_MS).toBe(4000);
    expect(bubbleGapMs(() => 0)).toBe(2000);
    expect(bubbleGapMs(() => 1)).toBe(4000);
    expect(bubbleGapMs(() => 0.5)).toBe(3000);
  });

  test("the gap is flat — it does NOT scale with message length", () => {
    // bubbleGapMs takes no length at all: same RNG ⇒ same gap, however long the message. This is
    // the OPS-84 behavior change away from the old length-scaled schedule.
    expect(bubbleGapMs(() => 0.3)).toBe(bubbleGapMs(() => 0.3));
  });

  test("schedule has one gap between each pair of messages", () => {
    const gaps = delaySchedule(4, { rand: () => 0.5 });
    expect(gaps).toHaveLength(3); // 4 messages ⇒ 3 gaps
  });

  test("the first message is immediate — the schedule is only the gaps BETWEEN messages", () => {
    // gap[i-1] precedes message i, so message 0 has nothing before it: 3 messages ⇒ 2 gaps.
    expect(delaySchedule(3, { rand: () => 0.5 })).toHaveLength(2);
  });

  test("a single message has no delay at all", () => {
    expect(delaySchedule(1, { rand: () => 0.5 })).toEqual([]);
  });

  test("every gap in a normal multi-bubble reply lands in [2000, 4000]", () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
      for (const g of delaySchedule(4, { rand: () => r })) {
        expect(g).toBeGreaterThanOrEqual(MIN_GAP_MS);
        expect(g).toBeLessThanOrEqual(MAX_GAP_MS);
      }
    }
  });

  test("a 4-bubble reply at max jitter is NOT truncated by the budget", () => {
    // 4 bubbles ⇒ 3 gaps ⇒ 12s even at the 4s ceiling: comfortably under the budget, every gap
    // survives at full 4s (no budget-reached path for a normal multi-message reply).
    const gaps = delaySchedule(4, { rand: () => 1 });
    expect(gaps).toEqual([4000, 4000, 4000]);
    expect(gaps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TOTAL_DELAY_BUDGET_MS);
  });

  test("total added latency is capped by the budget for a pathological reply", () => {
    // 50 messages at max jitter would blow way past the budget without the cap.
    const gaps = delaySchedule(50, { rand: () => 1 });
    const total = gaps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_DELAY_BUDGET_MS);
    // Once the budget is spent, the remaining gaps are zero (send promptly).
    expect(gaps[gaps.length - 1]).toBe(0);
  });

  test("respects a custom budget exactly", () => {
    const gaps = delaySchedule(20, { budget: 2500, rand: () => 0.5 });
    expect(gaps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2500);
  });
});
