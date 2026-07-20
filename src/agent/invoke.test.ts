/** Generic agent invoke-lane: runs ANY registered agent by its definition (issue #55/#72). */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Logger } from "../types.ts";
import { createAgentRunner } from "./invoke.ts";
import { builtinAgentDefs, SOCIAL_MEDIA_AGENT_ID } from "./builtins.ts";
import type { AgentDefinition } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

/** A stub harness that echoes its argv to stdout (so tests can assert the seat), or fails on FAILNOW. */
function writeStubBin(dir: string): string {
  const bin = join(dir, "claude-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/bash
if printf '%s' "$*" | grep -q FAILNOW; then echo "stub failure" >&2; exit 5; fi
printf '%s\\n' "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function makeConfig(dir: string): Config {
  return {
    paths: {
      beckett_dir: dir,
      db: "beckett.db",
      events_dir: "events",
      logs_dir: "logs",
      memory_dir: "memory",
      socket: "beckett.sock",
      spend: "spend.jsonl",
      projects: "projects",
    },
    harness: {
      claude: { bin: writeStubBin(dir), default_model: "fallback-model", permission_mode: "bypassPermissions", extra_flags: [] },
    },
  } as unknown as Config;
}

function makeDef(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "sample-agent",
    description: "d",
    systemPrompt: "SYSTEM-PROMPT-MARKER",
    model: { harness: "claude", model: "test-model", effort: "high" },
    skills: ["browser"],
    tools: [],
    persistent: false,
    builtin: true,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-invoke-"));
  dirs.push(dir);
  return createAgentRunner({ config: makeConfig(dir), logger: quietLog });
}

test("runs the agent's seat: prompt, model, effort, and permission mode all reach the harness", async () => {
  const runner = setup();
  const out = await runner.run(makeDef(), "author today's post");
  expect(out.state).toBe("done");
  expect(out.output).toContain("author today's post"); // the -p input
  expect(out.output).toContain("--append-system-prompt");
  expect(out.output).toContain("SYSTEM-PROMPT-MARKER");
  expect(out.output).toContain("--model");
  expect(out.output).toContain("test-model");
  expect(out.output).toContain("bypassPermissions");
  expect(out.output).toContain("--effort");
  expect(out.output).toContain("high");
});

test("the runner is generic — it runs whatever definition it is handed, not a hardcoded agent", async () => {
  const runner = setup();
  const a = await runner.run(makeDef({ id: "one", systemPrompt: "PROMPT-A", model: { harness: "claude", model: "model-a", effort: "" } }), "x");
  const b = await runner.run(makeDef({ id: "two", systemPrompt: "PROMPT-B", model: { harness: "claude", model: "model-b", effort: "low" } }), "x");
  expect(a.output).toContain("PROMPT-A");
  expect(a.output).toContain("model-a");
  expect(a.output).not.toContain("--effort"); // "" effort → harness default, flag omitted
  expect(b.output).toContain("PROMPT-B");
  expect(b.output).toContain("model-b");
  expect(b.output).toContain("low");
});

test("a blank model falls back to the harness default_model", async () => {
  const runner = setup();
  const out = await runner.run(makeDef({ model: { harness: "claude", model: "", effort: "" } }), "x");
  expect(out.output).toContain("fallback-model");
});

test("granted tools narrow the harness surface; none granted leaves it at defaults", async () => {
  const runner = setup();
  const withTools = await runner.run(makeDef({ tools: ["Read", "Edit"] }), "x");
  expect(withTools.output).toContain("--allowedTools");
  expect(withTools.output).toContain("Read,Edit");

  const noTools = await runner.run(makeDef({ tools: [] }), "x");
  expect(noTools.output).not.toContain("--allowedTools");
});

test("a non-zero harness exit is a clean error outcome, never a throw", async () => {
  const runner = setup();
  const out = await runner.run(makeDef(), "please FAILNOW");
  expect(out.state).toBe("error");
  expect(out.error).toContain("code 5");
});

test("an unsupported harness fails cleanly with a clear seam message", async () => {
  const runner = setup();
  const out = await runner.run(makeDef({ model: { harness: "codex", model: "m", effort: "" } }), "x");
  expect(out.state).toBe("error");
  expect(out.error).toMatch(/not spawnable/);
});

test("empty input is rejected before any spawn", async () => {
  const runner = setup();
  const out = await runner.run(makeDef(), "   ");
  expect(out.state).toBe("error");
  expect(out.error).toMatch(/non-empty/);
});

test("the built-in social-media agent is pure data and runs through the same generic lane", async () => {
  const runner = setup();
  const def = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!;
  const full: AgentDefinition = { ...def, createdAt: "t", updatedAt: "t" };
  const out = await runner.run(full, "compose today's shitpost");
  expect(out.state).toBe("done");
  // Its behavior lives entirely in the systemPrompt (data) — the browser-posting instructions
  // reach the harness, no bespoke code path.
  expect(out.output).toContain("@beckposting");
  expect(out.output).toContain("--append-system-prompt");
});
