/**
 * Beckett — v0 loop end-to-end tests (`tests/loop.e2e.test.ts`)
 * =======================================================================================
 * THE LOOP TESTER (Spec 12 §5.2). Proves the v0 loop runs end-to-end at ZERO subscription
 * cost by driving the REAL spine — Orchestrator + WorkerManager + ClaudeDriver + Tailer
 * (Supervisor) + worktree git + Store — against the scripted fake harness
 * (`src/test/fake-harness.ts` + `src/test/scenarios.ts`).
 *
 * What is real vs faked:
 *   - REAL: Store (bun:sqlite + JSONL), WorkerManager, ClaudeDriver (spawns the fake harness
 *     binary exactly as it would spawn `claude -p`), Tailer/Supervisor + smoke-alarms,
 *     git worktree allocation + INTEGRATE merge, the deterministic check runner, the GATE
 *     algorithm (`runGate`), the retry loop, DELIVER.
 *   - FAKED (test doubles, never billed): the Brain (LLM judgment cannot run for free — a
 *     scripted Brain returns a single-node plan + criteria + a passing gate verdict + a
 *     "continue" supervise decision), and the Discord gateway (records posts in-memory).
 *   - The WORKER itself is the fake harness binary, driven by the real ClaudeDriver over the
 *     exact `claude -p` stream-json wire format. No `claude` subscription is touched.
 *
 * Scenarios (Spec 12 §5.2): happy-path, mid-task-nudge (THE load-bearing v0 criterion),
 * no-progress (drift smoke-alarm, no auto-kill), daemon-restart (crash + --resume), and a
 * GateOutcome row assertion.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { loadConfig } from "../src/config.ts";
import { buildPaths } from "../src/paths.ts";
import { makeLogger } from "../src/log.ts";
import { createStore } from "../src/persistence/store.ts";
import { createMemory } from "../src/memory/index.ts";
import { createAgency } from "../src/agency/index.ts";
import { Tailer } from "../src/supervise/tailer.ts";
import { createWorkerManager, type DriverRegistry } from "../src/worker/manager.ts";
import { createDriver } from "../src/drivers/index.ts";
import { createOrchestrator, type BeckettOrchestrator } from "../src/state/orchestrator.ts";
import type {
  Brain,
  Config,
  Paths,
  Worker,
  WorkerEvent,
  SmokeAlarm,
  IntakeEvent,
  HaikuClassification,
  TaskRecord,
  BrainContext,
  ClarifyOutput,
  PlanOutput,
  StaffOutput,
  WorkerSummary,
  SuperviseDecision,
  NodeRecord,
  ChecksOutcome,
  ReviewVerdict,
  Escalation,
  PlanNode,
  DiscordGateway,
  ReplyOptions,
  IncomingMessage,
} from "../src/types.ts";
import { staffFromPlan } from "../src/brain/plan.ts";

// =======================================================================================
// Fixture layout
// =======================================================================================

const REPO_ROOT = process.cwd();
const FAKE_HARNESS = join(REPO_ROOT, "src/test/fake-harness.ts");
const SCRATCH = join("/tmp", "beckett-e2e", "loop");
/** Wrapper so `harness.claude.bin` is a single executable token (no spaces). */
const WRAPPER = join(SCRATCH, "fake-claude.sh");

const log = makeLogger().child("e2e");

/** Speed up fixture timing a little while leaving room to inject a mid-run nudge. */
const FAKE_SPEED = "0.6";

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  // A single executable wrapper that execs the fake harness with the current bun.
  writeFileSync(
    WRAPPER,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HARNESS)} "$@"\n`,
  );
  chmodSync(WRAPPER, 0o755);
  // Speed is shared + harmless. Scenario is selected PER-WORKER via the `[[scenario:…]]` prompt
  // tag in the node title (the harness reads it from that worker's own stdin) — NOT via a shared
  // env var — so a worker can never read another test's scenario.
  process.env.BECKETT_FAKE_SPEED = FAKE_SPEED;
});

afterAll(() => {
  // leave SCRATCH for post-mortem inspection; harmless across runs (recreated in beforeAll)
});

// =======================================================================================
// A throwaway BECKETT_DIR + project git repo per test
// =======================================================================================

function gitSync(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (!r.success) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`);
  }
}

/** Create an isolated BECKETT_DIR with config/.env/persona/memory (Spec 12 §5.2 step 1). */
function makeBeckettDir(name: string): { beckettDir: string; config: Config; paths: Paths } {
  const beckettDir = join(SCRATCH, name, "beckett");
  mkdirSync(join(beckettDir, "memory"), { recursive: true });
  writeFileSync(
    join(beckettDir, "config.toml"),
    [
      "[harness.claude]",
      `bin = ${JSON.stringify(WRAPPER)}`,
      'default_model = "claude-sonnet-4-5"',
      "extra_flags = []",
      "",
      "[supervise]",
      "drift_no_progress_turns = 3",
      "repeated_tool_calls_n = 4",
      "",
      "[concurrency]",
      "max_workers = 4",
    ].join("\n"),
  );
  writeFileSync(join(beckettDir, ".env"), "");
  writeFileSync(join(beckettDir, "persona.md"), "I am Beckett. Plain, direct, sparing.\n");
  writeFileSync(join(beckettDir, "memory", "MEMORY.md"), "# Memory index\n");

  const env = { ...process.env, BECKETT_DIR: beckettDir } as Record<string, string>;
  const config = loadConfig({ env });
  const paths = buildPaths(config, env);
  return { beckettDir, config, paths };
}

/** Create a throwaway project git repo with one commit (the worktree base). */
function makeProjectRepo(name: string): string {
  const dir = join(SCRATCH, name, "project");
  mkdirSync(dir, { recursive: true });
  gitSync(["init", "-q", "-b", "main"], dir);
  gitSync(["config", "user.email", "test@beckett.local"], dir);
  gitSync(["config", "user.name", "Beckett Test"], dir);
  writeFileSync(join(dir, "README.md"), "# project\n");
  gitSync(["add", "-A"], dir);
  gitSync(["commit", "-q", "-m", "init"], dir);
  return dir;
}

// =======================================================================================
// Scripted (zero-cost) Brain — the only LLM stand-in
// =======================================================================================

interface FakeBrainOpts {
  scenario: string;
  checks: string[];
  nl?: string[];
}

/** Records the supervise decisions returned, so a test can assert "no auto-kill". */
class FakeBrain implements Brain {
  readonly superviseCalls: SuperviseDecision[] = [];
  constructor(private readonly o: FakeBrainOpts) {}

  async intake(_evt: IntakeEvent): Promise<HaikuClassification> {
    return { kind: "task", withinPurview: true, escalate: false, ack: "On it." };
  }
  async clarify(_task: TaskRecord, _ctx: BrainContext): Promise<ClarifyOutput> {
    return { needsClarify: false, assumptions: [] };
  }
  async plan(task: TaskRecord, _ctx: BrainContext): Promise<PlanOutput> {
    const node: PlanNode = {
      id: "n1",
      title: `Do the task [[scenario:${this.o.scenario}]]`,
      intent: task.prompt,
      dependsOn: [],
      scopePaths: ["**"],
      criteria: { checks: this.o.checks, nl: this.o.nl ?? ["the task is completed in the worktree"] },
      suggestedWorker: { harness: "claude", model: "claude-sonnet-4-5", effort: "low" },
      reviewTier: "self",
      envelope: { turnTarget: 6, wallClockSecs: 120 },
    };
    return { summary: "Single-node plan for the v0 loop test.", nodes: [node] };
  }
  async staff(_task: TaskRecord, plan: PlanOutput, _ctx: BrainContext): Promise<StaffOutput> {
    return staffFromPlan(plan);
  }
  async summarizeWorker(worker: Worker, _ctx: BrainContext): Promise<WorkerSummary> {
    return {
      workerId: worker.id,
      whatItsDoing: "working",
      recentActions: [],
      currentPlan: "finishing the node",
      signalsOfDrift: [],
      signalsOfProgress: [],
      blockedOn: null,
    };
  }
  async superviseRead(
    _worker: Worker,
    _summary: WorkerSummary,
    _alarms: SmokeAlarm[],
    _ctx: BrainContext,
  ): Promise<SuperviseDecision> {
    // Look, but never auto-kill: continue (Spec 03 — alarm is a prompt to think, not a verdict).
    const decision: SuperviseDecision = { action: "continue", reason: "Read the tail; real progress, let it run." };
    this.superviseCalls.push(decision);
    return decision;
  }
  async gate(node: NodeRecord, _checks: ChecksOutcome, _diff: string, _ctx: BrainContext): Promise<ReviewVerdict> {
    return {
      pass: true,
      criteriaMet: node.criteria.nl.map((c) => ({ criterion: c, met: true })),
      issues: [],
      confidence: 1,
    };
  }
  async deliver(_task: TaskRecord, _ctx: BrainContext): Promise<string> {
    return "Done — work is on the integration branch.";
  }
  async escalationVoice(escalation: Escalation, _ctx: BrainContext): Promise<string> {
    return escalation.reason;
  }
}

// =======================================================================================
// In-memory Discord gateway (records posts)
// =======================================================================================

class FakeDiscord implements DiscordGateway {
  readonly posts: { channelId: string; content: string; opts?: ReplyOptions }[] = [];
  private n = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async post(channelId: string, content: string, opts?: ReplyOptions): Promise<string> {
    this.posts.push({ channelId, content, opts });
    return `msg_${++this.n}`;
  }
  onMessage(_cb: (m: IncomingMessage) => void | Promise<void>): void {}
  isConnected(): boolean {
    return true;
  }
  lastEventAgeMs(): number | null {
    return 0;
  }
}

// =======================================================================================
// Harness assembly (mirrors daemon.ts wiring) + helpers
// =======================================================================================

interface Harness {
  store: ReturnType<typeof createStore>;
  orchestrator: BeckettOrchestrator;
  workerManager: ReturnType<typeof createWorkerManager>;
  supervisor: Tailer;
  discord: FakeDiscord;
  brain: FakeBrain;
  paths: Paths;
  config: Config;
  projectDir: string;
  alarms: SmokeAlarm[];
}

function makeHarness(name: string, brainOpts: FakeBrainOpts): Harness {
  const { config, paths } = makeBeckettDir(name);
  const projectDir = makeProjectRepo(name);

  const store = createStore(paths, config);
  store.init();

  const memory = createMemory({ memoryDir: paths.memoryDir, store, logger: log, git: false });
  const brain = new FakeBrain(brainOpts);
  const agency = createAgency(config, paths, store);
  const supervisor = new Tailer(store, config, log.child("supervise"));
  const discord = new FakeDiscord();
  const alarms: SmokeAlarm[] = [];

  let orchestrator!: BeckettOrchestrator;

  // The DriverRegistry — identical fan-out to daemon.ts (refresh spend at progress boundaries,
  // then read-only supervisor tail, then the orchestrator lifecycle hook).
  const registry: DriverRegistry = {
    create: (_kind, worker: Worker) => {
      const driver = createDriver(worker.harness, config, log);
      driver.onEvent((e: WorkerEvent) => {
        if (e.kind === "turn_completed" || e.kind === "file_change" || e.kind === "finished") {
          try {
            worker.spend = driver.getTelemetry();
          } catch {
            /* best-effort */
          }
        }
        try {
          supervisor.ingest(worker, e);
        } catch {
          /* tolerant */
        }
        try {
          orchestrator.onWorkerEvent(worker, e);
        } catch {
          /* tolerant */
        }
      });
      return driver;
    },
  };

  const workerManager = createWorkerManager({
    store,
    config,
    paths,
    drivers: registry,
    resolveRepoRoot: () => projectDir,
    logger: log,
  });

  orchestrator = createOrchestrator({
    store,
    brain,
    workerManager,
    supervisor,
    discord,
    agency,
    memory,
    config,
    paths,
    repoRoot: () => projectDir,
    commitAuthor: { name: "Beckett", email: "beckett@users.noreply.github.com" },
    logger: log,
  });

  supervisor.onAlarm((alarm, worker) => {
    alarms.push(alarm);
    orchestrator.handleAlarm(alarm, worker);
  });
  supervisor.onCheckInFired((checkIn, worker) => orchestrator.handleCheckIn(checkIn, worker));

  return { store, orchestrator, workerManager, supervisor, discord, brain, paths, config, projectDir, alarms };
}

async function waitFor(pred: () => boolean, timeoutMs = 30_000, intervalMs = 25): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(intervalMs);
  }
  return pred();
}

function gitExists(repo: string, rev: string): boolean {
  return Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "--quiet", rev]).success;
}

function gitHasPath(repo: string, branch: string, path: string): boolean {
  return Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", `${branch}:${path}`]).success;
}

/** Open the DB read-only and SELECT (the CLI reads the DB directly — Spec 09). */
function queryDb<T>(dbPath: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

const intake = (text: string): IntakeEvent => ({
  userId: "user_jason",
  channelId: "chan_general",
  msgId: `m_${Math.random().toString(36).slice(2, 8)}`,
  text,
  ts: Date.now(),
});

// =======================================================================================
// 1. HAPPY PATH — task → plan → worker → integrate → review → GATE pass → deliver
// =======================================================================================

test("happy-path: full loop reaches DELIVERED with a real worktree diff + gate/outcome rows", async () => {
  const h = makeHarness("happy", { scenario: "happy-path", checks: ["test -f sum.ts"], nl: ["a sum function exists"] });

  const taskId = await h.orchestrator.submit(intake("add a sum function"));
  const ok = await waitFor(() => h.store.getTask(taskId)?.state === "DELIVERED");

  const task = h.store.getTask(taskId)!;
  expect(ok).toBe(true);
  expect(task.state).toBe("DELIVERED");

  // The single node gated green.
  const nodes = h.store.listNodesForTask(taskId);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.state).toBe("NODE_DONE");

  // Real worktree branch + integration diff (the worker's files merged in).
  const projectBranch = task.project_branch!;
  expect(projectBranch).toBeTruthy();
  expect(gitExists(h.projectDir, projectBranch)).toBe(true);
  expect(gitHasPath(h.projectDir, projectBranch, "sum.ts")).toBe(true);
  expect(gitHasPath(h.projectDir, projectBranch, "sum.test.ts")).toBe(true);

  // GATE pass row + the learned-model worker_outcome (harness,model,task_type,passed,retries,drift,turns).
  const gate = queryDb<{ verdict: string; checks_passed: number; review_passed: number }>(
    h.paths.db,
    "SELECT verdict, checks_passed, review_passed FROM gate_outcomes WHERE node_id = ?",
    [nodes[0]!.id],
  );
  expect(gate.length).toBeGreaterThanOrEqual(1);
  expect(gate[0]!.verdict).toBe("pass");
  expect(gate[0]!.checks_passed).toBe(1);
  expect(gate[0]!.review_passed).toBe(1);

  const outcome = queryDb<{ harness: string; model: string; task_type: string; passed: number; retries: number; drift_events: number; turns: number }>(
    h.paths.db,
    "SELECT harness, model, task_type, passed, retries, drift_events, turns FROM worker_outcomes WHERE node_id = ?",
    [nodes[0]!.id],
  );
  expect(outcome.length).toBeGreaterThanOrEqual(1);
  expect(outcome[0]!.harness).toBe("claude");
  expect(outcome[0]!.passed).toBe(1);
  expect(outcome[0]!.turns).toBeGreaterThan(0);

  // DELIVER posted in the same channel.
  const delivered = h.discord.posts.find((p) => /integration branch/i.test(p.content));
  expect(delivered).toBeTruthy();
  expect(delivered!.channelId).toBe("chan_general");

  h.store.close();
});

// =======================================================================================
// 2. MID-TASK NUDGE — inject mid-run, assert echo ack AND branched output (THE v0 criterion)
// =======================================================================================

test("mid-task-nudge: a mid-run nudge is acked (echo) AND visibly changes worker behavior", async () => {
  const h = makeHarness("nudge", { scenario: "mid-task-nudge", checks: ["test -f a.txt"], nl: ["at least the first file is created"] });

  const taskId = await h.orchestrator.submit(intake("create three files slowly"));

  // Wait for the worker process to be actually RUNNING (not just allocated/spawning) so the
  // nudge is written to a live stdin and lands at the next turn boundary (not buffered).
  await waitFor(() => h.workerManager.live().some((w) => w.state === "running"), 15_000, 10);
  const worker = h.workerManager.live().find((w) => w.state === "running")!;
  expect(worker).toBeTruthy();

  const receipt = await h.orchestrator.nudge(
    worker.id,
    "stop creating files now",
    "user_jason",
    "cli",
  );
  // --replay-user-messages echoed the nudge back = the delivery ack (Spec 02 §4.4).
  expect(receipt.accepted).toBe("delivered");

  // Run finishes (the branch path ends with its own result).
  await waitFor(() => h.store.getTask(taskId)?.state === "DELIVERED");
  const task = h.store.getTask(taskId)!;
  expect(task.state).toBe("DELIVERED");

  // Behavior branched: the worker wrote stop.txt and did NOT create c.txt.
  const branch = task.project_branch!;
  expect(gitHasPath(h.projectDir, branch, "stop.txt")).toBe(true);
  expect(gitHasPath(h.projectDir, branch, "c.txt")).toBe(false);
  // The stop sentinel quotes the nudge text (proves the steer was ingested, not just timed out).
  const show = Bun.spawnSync(["git", "-C", h.projectDir, "show", `${branch}:stop.txt`]).stdout.toString();
  expect(show).toContain("stop creating files now");

  // The nudge was persisted and marked delivered (persist-first, Spec 03 §6).
  const nudges = queryDb<{ status: string; text: string }>(
    h.paths.db,
    "SELECT status, text FROM nudges WHERE worker_id = ?",
    [worker.id],
  );
  expect(nudges.length).toBe(1);
  expect(nudges[0]!.status).toBe("delivered");

  h.store.close();
});

// =======================================================================================
// 3. DRIFT SMOKE-ALARM — no-progress trips an alarm that surfaces; NO auto-kill
// =======================================================================================

test("no-progress: a drift smoke-alarm fires and surfaces, with no auto-kill", async () => {
  const h = makeHarness("drift", { scenario: "no-progress", checks: ["true"], nl: ["the worker explored the repo"] });

  const taskId = await h.orchestrator.submit(intake("look around the repo"));
  await waitFor(() => {
    const s = h.store.getTask(taskId)?.state;
    return s === "DELIVERED" || s === "FAILED" || s === "ABORTED";
  });
  const task = h.store.getTask(taskId)!;

  // A smoke-alarm fired (no_diff_progress and/or repeated_tool_calls) — Spec 03 §2.
  expect(h.alarms.length).toBeGreaterThan(0);
  const kinds = new Set(h.alarms.map((a) => a.kind));
  expect(kinds.has("no_diff_progress") || kinds.has("repeated_tool_calls")).toBe(true);

  // Opus was pulled in to LOOK, and decided "continue" — never killed the worker (no auto-kill).
  expect(h.brain.superviseCalls.length).toBeGreaterThan(0);
  expect(h.brain.superviseCalls.every((d) => d.action === "continue")).toBe(true);

  // No worker was aborted; the run completed on its own and the task delivered.
  const aborted = queryDb<{ c: number }>(
    h.paths.db,
    "SELECT COUNT(*) AS c FROM workers WHERE state = 'aborted'",
  )[0]!.c;
  expect(aborted).toBe(0);
  expect(task.state).toBe("DELIVERED");

  h.store.close();
});
