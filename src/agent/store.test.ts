import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import type { AgentDefinition } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(seedBuiltins = false): { path: string; store: AgentStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-agents-"));
  dirs.push(dir);
  const path = join(dir, "agents.json");
  return { path, store: new AgentStore(path, { seedBuiltins }) };
}

const SAMPLE: Omit<AgentDefinition, "createdAt" | "updatedAt" | "builtin"> = {
  id: "release-notes-writer",
  description: "drafts release notes from a changelog",
  systemPrompt: "You write crisp release notes.",
  model: { harness: "claude", model: "claude-opus-5", effort: "high" },
  skills: ["github"],
  tools: ["Read", "Edit"],
  persistent: false,
};

test("add captures the full agent schema and stamps builtin:false + timestamps", async () => {
  const { store } = makeStore();
  const added = await store.add(SAMPLE);
  expect(added.builtin).toBe(false);
  expect(added.createdAt).toBeTruthy();
  expect(added.updatedAt).toBeTruthy();
  expect(added.description).toBe("drafts release notes from a changelog");
  expect(added.systemPrompt).toBe("You write crisp release notes.");
  expect(added.model).toEqual({ harness: "claude", model: "claude-opus-5", effort: "high" });
  expect(added.skills).toEqual(["github"]);
  expect(added.tools).toEqual(["Read", "Edit"]);
  expect(added.persistent).toBe(false);
});

test("add rejects a duplicate id", async () => {
  const { store } = makeStore();
  await store.add(SAMPLE);
  await expect(store.add(SAMPLE)).rejects.toThrow(/already exists/);
});

test("list and get read back the stored definition, and it persists across a fresh store", async () => {
  const { path, store } = makeStore();
  await store.add(SAMPLE);
  await store.add({ ...SAMPLE, id: "a-first-agent" });

  // Fresh store simulates a daemon restart / a separate CLI process reading the same file.
  const restored = new AgentStore(path, { seedBuiltins: false });
  const all = await restored.list();
  expect(all.map((a) => a.id)).toEqual(["a-first-agent", "release-notes-writer"]); // sorted by id
  const one = await restored.get("release-notes-writer");
  expect(one!.systemPrompt).toBe("You write crisp release notes.");
});

test("the persistent flag round-trips (ephemeral vs persistent)", async () => {
  const { store } = makeStore();
  await store.add({ ...SAMPLE, id: "ephemeral", persistent: false });
  await store.add({ ...SAMPLE, id: "persistent", persistent: true });
  expect((await store.get("ephemeral"))!.persistent).toBe(false);
  expect((await store.get("persistent"))!.persistent).toBe(true);
});

test("remove deletes an agent live", async () => {
  const { store } = makeStore();
  await store.add(SAMPLE);
  expect(await store.remove("release-notes-writer")).toBe(true);
  expect(await store.get("release-notes-writer")).toBeNull();
  expect(await store.remove("release-notes-writer")).toBe(false); // already gone
});

test("effort defaults and empty-string 'harness default' are accepted", async () => {
  const { store } = makeStore();
  const added = await store.add({
    ...SAMPLE,
    id: "defaulted",
    model: { harness: "pi", model: "some-model", effort: "" },
  });
  expect(added.model.effort).toBe("");
  expect(added.model.harness).toBe("pi");
});

test("a corrupt registry file fails loud in the CLI mutate path", async () => {
  const { path, store } = makeStore();
  writeFileSync(path, "{ not valid json ][");
  await expect(store.list()).rejects.toThrow(/unreadable/);
});

test("the registry envelope carries the removedBuiltins array (built-in removal bookkeeping)", async () => {
  // No built-in agents ship today, but the bookkeeping path is exercised by removing a seeded id
  // when one exists. Here we just assert the registry envelope carries the removedBuiltins array.
  const { path, store } = makeStore();
  await store.add(SAMPLE);
  await store.remove("release-notes-writer");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  expect(Array.isArray(raw.removedBuiltins)).toBe(true);
});
