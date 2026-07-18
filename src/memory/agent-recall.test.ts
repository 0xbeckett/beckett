/**
 * Memory-agent recall tests (issue #26).
 * Pins the agentic note-passing contract on top of moss retrieval:
 *   - a relevant answer passes a concise note citing only candidate ids;
 *   - a clean PASS returns no note and no ids (no fabrication);
 *   - hallucinated ids are stripped, and if none survive the answer degrades to a PASS;
 *   - a follow-up ("is that all?") re-invokes the agent with the prior exchange;
 *   - the model is reached ONLY through an invoker (production: `claude -p` / `pi`, never the API);
 *   - recall never goes dark: a throwing/garbage invoker falls back to the moss ranking;
 *   - THE NON-NEGOTIABLE: the visibility gate runs in code AFTER retrieval, fail-closed, so a
 *     scoped note is never even handed to the agent for a viewer who can't see it.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type MemoryStore } from "./index.ts";
import { agentRecall, parseAgentOutput, type ModelInvoker } from "./agent-recall.ts";
import type { Audience } from "./search.ts";
import type { Logger, MemoryNode, ScoredNode } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-agent-recall-"));
  tmpDirs.push(dir);
  return { store: createMemory({ memoryDir: dir, logger: quietLog, git: false }), dir };
}

/** A minimal ScoredNode over a fake node — enough for the agent to render + cite. */
function candidate(name: string, description = "", body = ""): ScoredNode {
  const node = {
    name,
    type: "reference",
    description,
    body,
    metadata: {},
    path: `/tmp/${name}.md`,
    created: "",
    updated: "",
    source: "manual",
    stale: false,
    phantom: false,
    mtime: 0,
  } as MemoryNode;
  return { node, score: 1, via: "match", reason: "test" };
}

/** An invoker that always returns the same canned text, and records what it was asked. */
function cannedInvoker(text: string): { invoke: ModelInvoker; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  const invoke: ModelInvoker = async (system, user) => {
    calls.push({ system, user });
    return { text, latencyMs: 1 };
  };
  return { invoke, calls };
}

// ── output parsing ───────────────────────────────────────────────────────────────────────

test("parseAgentOutput accepts raw, fenced, and trailing JSON", () => {
  expect(parseAgentOutput('{"relevant":true,"noteIds":["a"],"note":"x"}')).toEqual({
    relevant: true,
    noteIds: ["a"],
    note: "x",
  });
  expect(parseAgentOutput('```json\n{"relevant":false,"noteIds":[],"note":""}\n```')?.relevant).toBe(false);
  expect(parseAgentOutput('here you go: {"relevant":true,"noteIds":["b"],"note":"y"} done')?.noteIds).toEqual(["b"]);
  expect(parseAgentOutput("not json at all")).toBeNull();
});

// ── relevant / PASS / fabrication ──────────────────────────────────────────────────────────

test("a relevant answer passes a concise note citing only candidate ids", async () => {
  const { invoke } = cannedInvoker('{"relevant":true,"noteIds":["deploy-note"],"note":"Use beckett deploy."}');
  const session = await agentRecall(
    [candidate("deploy-note", "how to deploy"), candidate("other", "unrelated")],
    "how do I deploy?",
    { invoke },
  );
  expect(session.answer.relevant).toBe(true);
  expect(session.answer.note).toBe("Use beckett deploy.");
  expect(session.answer.noteIds).toEqual(["deploy-note"]);
  expect(session.answer.fallback).toBe(false);
});

test("a clean PASS returns no note and no ids", async () => {
  const { invoke } = cannedInvoker('{"relevant":false,"noteIds":[],"note":""}');
  const session = await agentRecall([candidate("x", "something")], "unrelated question", { invoke });
  expect(session.answer.relevant).toBe(false);
  expect(session.answer.note).toBe("");
  expect(session.answer.noteIds).toEqual([]);
  expect(session.answer.fallback).toBe(false);
});

test("hallucinated ids are stripped; if none survive it degrades to a clean PASS", async () => {
  const { invoke } = cannedInvoker('{"relevant":true,"noteIds":["made-up","also-fake"],"note":"totally real"}');
  const session = await agentRecall([candidate("real-note", "real")], "q", { invoke });
  // The model claimed relevance but cited only ids it was never given → PASS, no fabricated prose.
  expect(session.answer.relevant).toBe(false);
  expect(session.answer.noteIds).toEqual([]);
  expect(session.answer.note).toBe("");
});

test("a partially-hallucinated citation keeps only the real ids, in order", async () => {
  const { invoke } = cannedInvoker('{"relevant":true,"noteIds":["fake","real-a","real-b"],"note":"n"}');
  const session = await agentRecall(
    [candidate("real-a"), candidate("real-b")],
    "q",
    { invoke },
  );
  expect(session.answer.noteIds).toEqual(["real-a", "real-b"]);
  expect(session.answer.relevant).toBe(true);
});

test("empty candidates PASS cleanly without spending a model call", async () => {
  let called = false;
  const invoke: ModelInvoker = async () => {
    called = true;
    return { text: "{}", latencyMs: 0 };
  };
  const session = await agentRecall([], "anything", { invoke });
  expect(called).toBe(false);
  expect(session.answer.relevant).toBe(false);
  expect(session.answer.fallback).toBe(false);
});

// ── graceful degradation (never dark) ──────────────────────────────────────────────────────

test("a throwing invoker falls back to the moss ranking, not darkness", async () => {
  const invoke: ModelInvoker = async () => {
    throw new Error("claude not found");
  };
  const session = await agentRecall(
    [candidate("first"), candidate("second"), candidate("third")],
    "q",
    { invoke, logger: quietLog },
  );
  expect(session.answer.fallback).toBe(true);
  expect(session.answer.noteIds).toEqual(["first", "second", "third"]);
  expect(session.answer.note).toBe(""); // no fabricated prose on fallback
});

test("garbage model output falls back to the moss ranking", async () => {
  const { invoke } = cannedInvoker("the model rambled with no JSON");
  const session = await agentRecall([candidate("a"), candidate("b")], "q", { invoke, logger: quietLog });
  expect(session.answer.fallback).toBe(true);
  expect(session.answer.noteIds).toEqual(["a", "b"]);
});

// ── probing follow-up ──────────────────────────────────────────────────────────────────────

test("a follow-up re-invokes the agent carrying the prior exchange", async () => {
  const { invoke, calls } = cannedInvoker('{"relevant":true,"noteIds":["n"],"note":"first"}');
  const session = await agentRecall([candidate("n", "note")], "first question", { invoke });
  await session.followUp("is that all?");
  expect(calls.length).toBe(2);
  // The follow-up prompt must include BOTH questions (the transcript is carried forward).
  expect(calls[1]!.user).toContain("first question");
  expect(calls[1]!.user).toContain("is that all?");
});

// ── THE NON-NEGOTIABLE: fail-closed visibility gate before the agent ────────────────────────

test("a scoped note never reaches the agent for a viewer who can't see it", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "public-deploy",
    type: "reference",
    description: "how to deploy the cloudflare tunnel",
    body: "run beckett deploy",
    source: "manual",
    reason: "t",
  });
  await store.remember({
    op: "create",
    name: "secret-deploy",
    type: "reference",
    description: "the owner-only cloudflare tunnel token and deploy secret",
    body: "SECRET-TOKEN-DO-NOT-LEAK",
    metadata: { visibility: "owner" },
    source: "manual",
    reason: "t",
  });

  // Capture exactly what the agent is handed. A non-owner viewer must never see the scoped note —
  // not its id, not its description, not its body — in the candidate prompt.
  const seen: string[] = [];
  const invoke: ModelInvoker = async (_system, user) => {
    seen.push(user);
    return { text: '{"relevant":false,"noteIds":[],"note":""}', latencyMs: 1 };
  };

  const member: Audience = { viewerId: "999", viewerRole: "member", context: "guild" };
  const { base } = await store.recallAgentic(
    { text: "cloudflare tunnel deploy secret token", audience: member },
    { invoke },
  );

  // The engine's fail-closed gate ran in code AFTER retrieval: the scoped node is not a candidate.
  expect(base.hits.map((h) => h.node.name)).not.toContain("secret-deploy");
  expect(base.hits.map((h) => h.node.name)).toContain("public-deploy");
  const prompt = seen.join("\n");
  expect(prompt).not.toContain("secret-deploy");
  expect(prompt).not.toContain("SECRET-TOKEN-DO-NOT-LEAK");
});

test("the same scoped note IS handed to the owner, proving the gate is scope-based not a blanket drop", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "secret-deploy",
    type: "reference",
    description: "the owner-only cloudflare tunnel token and deploy secret",
    body: "SECRET-TOKEN",
    metadata: { visibility: "owner" },
    source: "manual",
    reason: "t",
  });
  let prompt = "";
  const invoke: ModelInvoker = async (_s, user) => {
    prompt = user;
    return { text: '{"relevant":true,"noteIds":["secret-deploy"],"note":"the token"}', latencyMs: 1 };
  };
  const owner: Audience = { viewerId: "1", viewerRole: "owner", context: "guild" };
  const { base } = await store.recallAgentic(
    { text: "cloudflare tunnel deploy secret token", audience: owner },
    { invoke },
  );
  expect(base.hits.map((h) => h.node.name)).toContain("secret-deploy");
  expect(prompt).toContain("secret-deploy");
});
