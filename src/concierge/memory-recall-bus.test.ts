/** Warm memory recall is served by the daemon, while the engine still owns visibility/ranking. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import { createMemory } from "../memory/index.ts";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const savedDir = process.env.BECKETT_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(opts: { wire?: "constructor" | "setter" | "none" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-warm-recall-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const memory = createMemory({ memoryDir: join(dir, "memory"), git: false, warm: true });
  const gateway = {
    onMessage() {}, onThreadCreate() {}, async start() {}, async stop() {}, sendTyping() {},
    async post() { return "message"; }, isConnected: () => true, lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  const session = { async start() {}, async stop() {}, ask: async () => "", stats: () => ({}) } as unknown as ConciergeSession;
  const wire = opts.wire ?? "constructor";
  const concierge = new Concierge({
    config: validateConfig({}),
    ...(wire === "constructor" ? { memory } : {}),
    gateway,
    session,
  });
  // The daemon path since Phase 6: v4-main wires the memory EXTENSION's warm store post-init.
  if (wire === "setter") concierge.setMemoryStore(memory);
  return { memory, concierge };
}

test("memory.recall uses the daemon's cached graph and preserves the JSON result", async () => {
  const { memory, concierge } = harness();
  let builds = 0;
  const buildGraph = memory.buildGraph.bind(memory);
  memory.buildGraph = () => { builds++; return buildGraph(); };

  const args = { argv: ["deploy", "--json"] };
  const first = await concierge.onBusRequest({ cmd: "memory.recall", args });
  const second = await concierge.onBusRequest({ cmd: "memory.recall", args });

  expect(first).toEqual(second);
  expect(first.ok).toBeTrue();
  expect(builds).toBe(1); // graph parse + Moss sync happen once, not once per bus request
});

test("memory.recall keeps the audience gate in the shared recall engine", async () => {
  const { memory, concierge } = harness();
  await memory.remember({
    op: "create", name: "owner-plan", type: "preference", description: "private deploy plan",
    metadata: { visibility: "owner" }, source: "manual", reason: "test",
  });

  const hidden = await concierge.onBusRequest({ cmd: "memory.recall", args: { argv: ["deploy", "--json"] } });
  const visible = await concierge.onBusRequest({
    cmd: "memory.recall",
    args: { argv: ["deploy", "--viewer", "123", "--viewer-role", "owner", "--json"] },
  });
  expect((hidden.data as { hits: Array<{ name: string }> }).hits.map((hit) => hit.name)).not.toContain("owner-plan");
  expect((visible.data as { hits: Array<{ name: string }> }).hits.map((hit) => hit.name)).toContain("owner-plan");
});

test("memory.recall serves the extension store wired through setMemoryStore (the Phase 6 daemon path)", async () => {
  const { concierge } = harness({ wire: "setter" });
  const res = await concierge.onBusRequest({ cmd: "memory.recall", args: { argv: ["deploy", "--json"] } });
  expect(res.ok).toBeTrue();
});

test("memory.recall refuses when no store is wired — the lazy second warm store is gone", async () => {
  const { concierge } = harness({ wire: "none" });
  const res = await concierge.onBusRequest({ cmd: "memory.recall", args: { argv: ["deploy", "--json"] } });
  expect(res).toEqual({
    ok: false,
    error: "memory.recall unavailable — the memory extension store is not wired (v3 daemon only)",
  });
});
