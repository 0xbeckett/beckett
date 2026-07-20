/** Built-in agents are pure DATA seeds — the social-media agent has no bespoke code module. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { builtinAgentDefs, builtinAgentIds, SOCIAL_MEDIA_AGENT_ID } from "./builtins.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ships a social-media builtin defined entirely as data (prompt + seat, no code)", () => {
  const def = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID);
  expect(def).toBeTruthy();
  expect(def!.builtin).toBe(true);
  expect(def!.model.harness).toBe("claude");
  // The behavior — voice, target handle, how to post — is all in the prompt string.
  expect(def!.systemPrompt).toContain("@beckposting");
  expect(def!.systemPrompt.toLowerCase()).toContain("browser");
  // No credential is baked into the definition.
  expect(JSON.stringify(def).toLowerCase()).not.toContain("password");
  expect(builtinAgentIds()).toContain(SOCIAL_MEDIA_AGENT_ID);
});

test("the store seeds the social-media agent into agents.json on first load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-builtins-"));
  dirs.push(dir);
  const store = new AgentStore(join(dir, "agents.json"), { seedBuiltins: true });
  const agents = await store.list();
  const social = agents.find((a) => a.id === SOCIAL_MEDIA_AGENT_ID);
  expect(social).toBeTruthy();
  expect(social!.builtin).toBe(true);
  expect(social!.createdAt).toBeTruthy();
});

test("a removed builtin stays gone — seeding does not resurrect it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-builtins-rm-"));
  dirs.push(dir);
  const path = join(dir, "agents.json");
  const store = new AgentStore(path, { seedBuiltins: true });
  await store.list(); // seed
  expect(await store.remove(SOCIAL_MEDIA_AGENT_ID)).toBe(true);
  const reopened = new AgentStore(path, { seedBuiltins: true });
  const agents = await reopened.list();
  expect(agents.find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)).toBeUndefined();
});
