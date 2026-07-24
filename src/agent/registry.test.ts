import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgentRegistry } from "./registry.ts";
import { AgentStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-agent-reg-"));
  dirs.push(dir);
  return join(dir, "agents.json");
}

/** A capturing logger so we can assert the loader logged-and-skipped rather than threw. */
function recordingLogger() {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: any = {
    debug() {},
    info() {},
    warn(msg: string, fields?: Record<string, unknown>) {
      warns.push({ msg, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

const VALID = {
  id: "writer",
  description: "writes things",
  systemPrompt: "You write.",
  model: { harness: "claude", model: "claude-opus-5", effort: "medium" },
  skills: [],
  tools: [],
  persistent: false,
  builtin: false,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

test("a missing file yields an empty list, not an error", () => {
  const reg = new LiveAgentRegistry(tmpPath());
  expect(reg.list()).toEqual([]);
  expect(reg.get("anything")).toBeNull();
});

test("reads what the store wrote — live, no restart", async () => {
  const path = tmpPath();
  const store = new AgentStore(path, { seedBuiltins: false });
  const reg = new LiveAgentRegistry(path);
  expect(reg.list()).toEqual([]);

  await store.add({
    id: "writer",
    description: "writes things",
    systemPrompt: "You write.",
    model: { harness: "claude", model: "claude-opus-5", effort: "medium" },
    skills: [],
    tools: [],
    persistent: false,
  });

  // Same registry instance, no restart — the new agent shows up on the next read.
  expect(reg.list().map((a) => a.id)).toEqual(["writer"]);
  expect(reg.get("writer")!.description).toBe("writes things");

  await store.remove("writer");
  expect(reg.list()).toEqual([]);
});

test("a single malformed agent is logged-and-skipped; the valid ones still load", () => {
  const path = tmpPath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      agents: [VALID, { id: "broken", description: "missing prompt/model" }, { ...VALID, id: "writer-2" }],
      removedBuiltins: [],
    }),
  );
  const { logger, warns } = recordingLogger();
  const reg = new LiveAgentRegistry(path, { logger });
  const ids = reg.list().map((a) => a.id);
  expect(ids).toEqual(["writer", "writer-2"]); // the broken one dropped, valid ones kept
  expect(warns.some((w) => w.msg.includes("skipping malformed agent"))).toBe(true);
});

test("unparseable JSON does not throw — logs and returns the last good snapshot", () => {
  const path = tmpPath();
  writeFileSync(path, JSON.stringify({ version: 1, agents: [VALID], removedBuiltins: [] }));
  const { logger, warns } = recordingLogger();
  const reg = new LiveAgentRegistry(path, { logger });
  expect(reg.list().map((a) => a.id)).toEqual(["writer"]); // establishes a good snapshot

  writeFileSync(path, "{ half-written not json ][");
  // Never throws; falls back to the last good snapshot so the daemon keeps enumerating.
  expect(reg.list().map((a) => a.id)).toEqual(["writer"]);
  expect(warns.some((w) => w.msg.includes("not valid JSON"))).toBe(true);
});

test("a totally corrupt file with no prior good read yields empty, never throws", () => {
  const path = tmpPath();
  writeFileSync(path, "]]] not json");
  const reg = new LiveAgentRegistry(path);
  expect(reg.list()).toEqual([]);
  expect(reg.get("x")).toBeNull();
});
