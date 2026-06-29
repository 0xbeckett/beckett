import { test, expect } from "bun:test";
import { AmbientPump } from "./ambient.ts";

test("buffers overheard lines and flushes one digest when full", () => {
  const sent: string[] = [];
  const pump = new AmbientPump((t) => sent.push(t), { maxLines: 3, quietMs: 999_999 });
  pump.add("c1", "u1", "we should build a dashboard");
  pump.add("c1", "u2", "yeah with charts");
  expect(sent.length).toBe(0); // not full yet, timer not fired
  pump.add("c1", "u3", "and dark mode"); // hits maxLines → flush
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("[ambient channel=c1]");
  expect(sent[0]).toContain("u1: we should build a dashboard");
  expect(sent[0]).toContain("u3: and dark mode");
  pump.stop();
});

test("flush is per-channel and a no-op when empty", () => {
  const sent: string[] = [];
  const pump = new AmbientPump((t) => sent.push(t), { maxLines: 99, quietMs: 999_999 });
  pump.add("a", "u1", "hi");
  pump.add("b", "u2", "yo");
  pump.flush("a");
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("channel=a");
  pump.flush("a"); // already drained → no-op
  expect(sent.length).toBe(1);
  pump.flush("b");
  expect(sent.length).toBe(2);
  expect(sent[1]).toContain("channel=b");
  pump.stop();
});
