/**
 * Beckett — crash-recovery / resume test (`tests/resume.e2e.test.ts`)
 * =======================================================================================
 * Spec 12 §5.2 `daemon-restart`: a worker crashes mid-turn (no `result` line) and is recovered
 * via `--resume <session_id>`, losing ≤ 1 turn. This exercises the REAL {@link ClaudeDriver}
 * resume mechanism against the fake harness's `daemon-restart` scenario (crash + resumeBeats).
 *
 * It lives in its OWN test file (= its own bun process) because it selects the scenario via the
 * `BECKETT_FAKE_SCENARIO` env: on a `--resume` launch the driver writes NO initial prompt, so the
 * harness cannot read a `[[scenario:…]]` tag from stdin and must learn the scenario from the env.
 * Isolating it in a separate process keeps that env off the prompt-tag-driven loop tests.
 *
 * Contract note (flagged in the spine report): the frozen {@link WorkerManager} `dispatch` always
 * allocates a NEW worktree keyed by a NEW worker-id, so orchestrator-level recovery re-dispatches
 * fresh rather than reattaching. The resume SEAM the future reattach will build on is the driver's
 * in-place relaunch tested here: same worktree (pre-crash files intact) + same session id.
 */

import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { makeLogger } from "../src/log.ts";
import { ClaudeDriver } from "../src/drivers/claude.ts";
import type { WorkerEvent, SpawnSpec, Config } from "../src/types.ts";

const REPO_ROOT = process.cwd();
const FAKE_HARNESS = join(REPO_ROOT, "src/test/fake-harness.ts");
const SCRATCH = join("/tmp", "beckett-e2e", "resume");
const WRAPPER = join(SCRATCH, "fake-claude.sh");
const log = makeLogger().child("e2e-resume");

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, "beckett", "memory"), { recursive: true });
  writeFileSync(
    WRAPPER,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HARNESS)} "$@"\n`,
  );
  chmodSync(WRAPPER, 0o755);
  writeFileSync(
    join(SCRATCH, "beckett", "config.toml"),
    ["[harness.claude]", `bin = ${JSON.stringify(WRAPPER)}`, 'default_model = "claude-sonnet-5"', "extra_flags = []"].join("\n"),
  );
  writeFileSync(join(SCRATCH, "beckett", ".env"), "");
  writeFileSync(join(SCRATCH, "beckett", "persona.md"), "Beckett.\n");
  writeFileSync(join(SCRATCH, "beckett", "memory", "MEMORY.md"), "# Memory index\n");
});

function loadCfg(): Config {
  const env = { ...process.env, BECKETT_DIR: join(SCRATCH, "beckett") } as Record<string, string>;
  return loadConfig({ env });
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000, intervalMs = 10): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(intervalMs);
  }
  return pred();
}

test("daemon-restart: a crashed worker resumes via --resume <session_id>, losing <= 1 turn", async () => {
  process.env.BECKETT_FAKE_SCENARIO = "daemon-restart";
  process.env.BECKETT_FAKE_SPEED = "0.6";

  const config = loadCfg();
  const ws = join(SCRATCH, "worktree");
  mkdirSync(ws, { recursive: true });

  const driver = new ClaudeDriver(config, log);
  const finishes: { status: string; subtype: string }[] = [];
  driver.onEvent((e: WorkerEvent) => {
    if (e.kind === "finished") finishes.push({ status: e.status, subtype: e.subtype });
  });

  const spec: SpawnSpec = {
    workerId: "wk_crash",
    prompt: "multi-step task [[scenario:daemon-restart]]",
    systemAppend: "You are a worker.",
    workspace: ws,
    scope: { ownedGlobs: ["**"], readGlobs: null, description: "the worktree" },
    envelope: { effort: "low", turnCap: 12, wallClockS: 120, network: false },
    model: "claude-sonnet-5",
    doneSchemaPath: join(ws, "done-schema.json"),
  };
  writeFileSync(spec.doneSchemaPath, "{}");

  const first = await driver.spawn(spec);
  const sessionId = first.sessionId;
  expect(sessionId).toBeTruthy();

  // It crashes mid-turn (exit 137, no result) → the driver synthesizes a finished/error.
  await waitFor(() => finishes.some((f) => f.status === "error"));
  expect(existsSync(join(ws, "step-1.txt"))).toBe(true); // the pre-crash turn was persisted
  expect(existsSync(join(ws, "step-2.txt"))).toBe(false);

  // Resume in-place via --resume <session_id>: same worktree, same session.
  await driver.resume();
  await waitFor(() => finishes.some((f) => f.status === "success"));

  // Same session id (resumed, not a fresh run) and all three steps now exist — 0 turns lost.
  expect(driver.currentSessionId).toBe(sessionId);
  expect(existsSync(join(ws, "step-1.txt"))).toBe(true);
  expect(existsSync(join(ws, "step-2.txt"))).toBe(true);
  expect(existsSync(join(ws, "step-3.txt"))).toBe(true);

  await driver.abort("test teardown").catch(() => {});
  delete process.env.BECKETT_FAKE_SCENARIO;
});
