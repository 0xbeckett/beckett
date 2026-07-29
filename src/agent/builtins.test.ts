/** Built-in agents are pure DATA seeds — the social-media agent has no bespoke code module. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { builtinAgentDefs, builtinAgentIds, SOCIAL_MEDIA_AGENT_ID, X_PING_ROSTER } from "./builtins.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ships a social-media builtin defined entirely as data (prompt + seat, no code)", () => {
  const def = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID);
  expect(def).toBeTruthy();
  expect(def!.builtin).toBe(true);
  // No harness pin: the agent rides `[harness.lanes.agent]` (pi since #125) rather than carrying
  // a claude default nobody chose. Its model is a LIVE id — `claude-sonnet-4-5` has not existed
  // since the Claude 5 family shipped.
  expect(def!.model.harness).toBeUndefined();
  expect(def!.model.model).toBe("claude-sonnet-5");
  // The behavior — voice, target handle, how to post — is all in the prompt string.
  expect(def!.systemPrompt).toContain("@beckposting");
  expect(def!.systemPrompt.toLowerCase()).toContain("browser");
  // No credential is baked into the definition.
  expect(JSON.stringify(def).toLowerCase()).not.toContain("password");
  expect(builtinAgentIds()).toContain(SOCIAL_MEDIA_AGENT_ID);
});

test("PING SOMEONE names an explicit roster, rotates the target, and never @s a stranger (issue #107)", () => {
  const prompt = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!.systemPrompt;
  const flat = prompt.toLowerCase().replace(/\s+/g, " "); // collapse the wrapped lane text

  // The roster is real and led by the established interlocutor — a single verified handle is valid
  // (and strictly safer than one padded with an unverified guess).
  expect(X_PING_ROSTER.length).toBeGreaterThanOrEqual(1);
  expect(X_PING_ROSTER).toContain("@jawrooo_");

  // No entry is a bare unverified placeholder: every roster handle is a real, specific X handle.
  for (const handle of X_PING_ROSTER) expect(handle).not.toBe("@ssh");

  // The prompt is BUILT from the roster (single source of truth), so every handle appears in the lane text.
  for (const handle of X_PING_ROSTER) expect(prompt).toContain(handle);

  // Target rotation: consecutive ping-posts must not reuse the same person, checked against recent posts.
  expect(flat).toContain("with_replies");
  expect(flat).toContain("not @ the same person two ping-posts running");

  // No path to an arbitrary follower/stranger: the roster is the COMPLETE allow-list.
  expect(flat).toContain("complete list of who you may @");
  expect(flat).toContain("never @ a stranger");

  // Existing lane-rotation instruction is untouched.
  expect(prompt).toContain("PICK A LANE (vary it — do not lean on the same lane every time):");
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
