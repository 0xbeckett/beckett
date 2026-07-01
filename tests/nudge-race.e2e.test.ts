/**
 * Beckett — nudge-vs-finish race regression test (`tests/nudge-race.e2e.test.ts`)
 * =======================================================================================
 * BLOCKER 2 regression. A nudge can arrive (CLI, or an Opus `applyDecision`) in the exact
 * window where the worker has just FINISHED and its node is being driven through the
 * idempotent post-run pipeline (INTEGRATING → REVIEWING → GATING → NODE_DONE). The old
 * `nudge()` unconditionally wrote NUDGING and then restored SUPERVISING, which REGRESSED a
 * node that had already moved on (e.g. GATING → NUDGING → SUPERVISING) — corrupting the FSM
 * and potentially re-opening a done node.
 *
 * This drives the REAL spine to a worker whose result has landed, pins the node at GATING by
 * blocking the scripted Brain's `gate()` (the worker handle is still live — reap happens only
 * after NODE_DONE), then fires a nudge into that window. The guard (orchestrator.ts §nudge,
 * BLOCKER 2c) must: deliver/queue the steer WITHOUT touching the FSM — the node must stay
 * GATING (no NUDGING, no SUPERVISING regression) — and the receipt must come back `queued`
 * (the finished worker's driver buffers it). Releasing the gate then lets the node finish
 * cleanly to NODE_DONE / DELIVERED.
 */

import { test, expect, beforeAll } from "bun:test";
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
import { staffFromPlan } from "../src/brain/plan.ts";
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
  PlanOutput,
  StaffOutput,
  ClarifyOutput,
  WorkerSummary,
  SuperviseDecision,
  NodeRecord,
  ReviewVerdict,
  Escalation,
  PlanNode,
  DiscordGateway,
  ReplyOptions,
  IncomingMessage,
} from "../src/types.ts";

const REPO_ROOT = process.cwd();
const FAKE_HARNESS = join(REPO_ROOT, "src/test/fake-harness.ts");
const SCRATCH = join("/tmp", "beckett-e2e", "nudge-race");
const WRAPPER = join(SCRATCH, "fake-claude.sh");
const log = makeLogger().child("e2e-nudge-race");

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    WRAPPER,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HARNESS)} "$@"\n`,
  );
  chmodSync(WRAPPER, 0o755);
  // Scenario is selected per-worker via the [[scenario:…]] prompt tag (no global env).
  process.env.BECKETT_FAKE_SPEED = "0.6";
});

// =======================================================================================
// Scripted Brain whose gate() BLOCKS until the test releases it, pinning the node at GATING.
// =======================================================================================

class GateBlockingBrain implements Brain {
  gateEntered = false;
  private releaseGate!: () => void;
  private readonly gateReleased = new Promise<void>((r) => (this.releaseGate = r));

  release(): void {
    this.releaseGate();
  }

  async intake(): Promise<HaikuClassification> {
    return { kind: "task", withinPurview: true, escalate: false, ack: "On it." };
  }
  async clarify(): Promise<ClarifyOutput> {
    return { needsClarify: false, assumptions: [] };
  }
  async plan(task: TaskRecord): Promise<PlanOutput> {
    const node: PlanNode = {
      id: "n1",
      title: "Add a sum function [[scenario:happy-path]]",
      intent: task.prompt,
      dependsOn: [],
      scopePaths: ["**"],
      criteria: { checks: ["true"], nl: ["a sum function exists"] },
      suggestedWorker: { harness: "claude", model: "claude-sonnet-4-5", effort: "low" },
      reviewTier: "self",
      envelope: { turnTarget: 6, wallClockSecs: 120 },
    };
    return { summary: "Single-node plan for the nudge-race test.", nodes: [node] };
  }
  async staff(_task: TaskRecord, plan: PlanOutput): Promise<StaffOutput> {
    return staffFromPlan(plan);
  }
  async summarizeWorker(worker: Worker): Promise<WorkerSummary> {
    return {
      workerId: worker.id,
      whatItsDoing: "working",
      recentActions: [],
      currentPlan: "",
      signalsOfDrift: [],
      signalsOfProgress: [],
      blockedOn: null,
    };
  }
  async superviseRead(): Promise<SuperviseDecision> {
    return { action: "continue", reason: "let it run." };
  }
  async gate(node: NodeRecord): Promise<ReviewVerdict> {
    // Pin the node at GATING until the test has fired its racing nudge.
    this.gateEntered = true;
    await this.gateReleased;
    return {
      pass: true,
      criteriaMet: node.criteria.nl.map((c) => ({ criterion: c, met: true })),
      issues: [],
      confidence: 1,
    };
  }
  async deliver(): Promise<string> {
    return "Done — work is on the integration branch.";
  }
  async escalationVoice(e: Escalation): Promise<string> {
    return e.reason;
  }
}

class FakeDiscord implements DiscordGateway {
  readonly posts: { channelId: string; content: string }[] = [];
  private n = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async post(channelId: string, content: string, _opts?: ReplyOptions): Promise<string> {
    this.posts.push({ channelId, content });
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
// Fixture + daemon assembly
// =======================================================================================

function gitSync(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`);
}

function makeBeckettDir(): { config: Config; paths: Paths } {
  const beckettDir = join(SCRATCH, "beckett");
  mkdirSync(join(beckettDir, "memory"), { recursive: true });
  writeFileSync(
    join(beckettDir, "config.toml"),
    [
      "[harness.claude]",
      `bin = ${JSON.stringify(WRAPPER)}`,
      'default_model = "claude-sonnet-4-5"',
      "extra_flags = []",
      "",
      "[concurrency]",
      "max_workers = 4",
    ].join("\n"),
  );
  writeFileSync(join(beckettDir, ".env"), "");
  writeFileSync(join(beckettDir, "persona.md"), "I am Beckett.\n");
  writeFileSync(join(beckettDir, "memory", "MEMORY.md"), "# Memory index\n");
  const env = { ...process.env, BECKETT_DIR: beckettDir } as Record<string, string>;
  const config = loadConfig({ env });
  const paths = buildPaths(config, env);
  return { config, paths };
}

function makeProjectRepo(): string {
  const dir = join(SCRATCH, "project");
  mkdirSync(dir, { recursive: true });
  gitSync(["init", "-q", "-b", "main"], dir);
  gitSync(["config", "user.email", "test@beckett.local"], dir);
  gitSync(["config", "user.name", "Beckett Test"], dir);
  writeFileSync(join(dir, "README.md"), "# project\n");
  gitSync(["add", "-A"], dir);
  gitSync(["commit", "-q", "-m", "init"], dir);
  return dir;
}

interface Daemon {
  store: ReturnType<typeof createStore>;
  orchestrator: BeckettOrchestrator;
  workerManager: ReturnType<typeof createWorkerManager>;
  brain: GateBlockingBrain;
  paths: Paths;
}

function buildDaemon(): Daemon {
  const { config, paths } = makeBeckettDir();
  const projectDir = makeProjectRepo();

  const store = createStore(paths, config);
  store.init();

  const memory = createMemory({ memoryDir: paths.memoryDir, store, logger: log, git: false });
  const brain = new GateBlockingBrain();
  const agency = createAgency(config, paths, store);
  const supervisor = new Tailer(store, config, log.child("supervise"));
  const discord = new FakeDiscord();

  let orchestrator!: BeckettOrchestrator;

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

  supervisor.onAlarm((alarm: SmokeAlarm, worker: Worker) => orchestrator.handleAlarm(alarm, worker));
  supervisor.onCheckInFired((checkIn, worker) => orchestrator.handleCheckIn(checkIn, worker));

  return { store, orchestrator, workerManager, brain, paths };
}

async function waitFor(pred: () => boolean, timeoutMs = 30_000, intervalMs = 10): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(intervalMs);
  }
  return pred();
}

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
// BLOCKER 2 — a nudge racing a finished worker must NOT regress the node FSM
// =======================================================================================

test("nudge-vs-finish: a late nudge into a GATING node is queued without regressing the FSM", async () => {
  const d = buildDaemon();

  const taskId = await d.orchestrator.submit(intake("add a sum function"));

  // Capture the worker while it is still running, then let it finish.
  await waitFor(() => d.workerManager.live().some((w) => w.state === "running"));
  const worker = d.workerManager.live().find((w) => w.state === "running")!;
  expect(worker).toBeTruthy();
  const workerId = worker.id;
  const nodeId = worker.nodeId;

  // The worker's result lands; handleFinished walks INTEGRATING → REVIEWING → GATING and BLOCKS
  // inside the scripted gate(). The node is now pinned at GATING with the worker already finished
  // (finishedWorkers has it) but its handle still live (reap only runs after NODE_DONE).
  await waitFor(() => d.brain.gateEntered && d.store.getNode(nodeId)?.state === "GATING");
  expect(d.store.getNode(nodeId)?.state).toBe("GATING");
  expect(d.workerManager.get(workerId)).toBeTruthy(); // handle still live → nudge() won't throw

  // FIRE THE RACING NUDGE into the finish window.
  const receipt = await d.orchestrator.nudge(workerId, "actually, also handle negatives", "user_jason", "cli");

  // The steer is accepted-but-buffered (the finished worker's driver queues it), and CRUCIALLY the
  // node FSM was NOT touched: it must still be GATING — no NUDGING write, no SUPERVISING regression.
  expect(receipt.accepted).toBe("queued");
  expect(d.store.getNode(nodeId)?.state).toBe("GATING");

  // The nudge persisted (persist-first) but stayed 'queued' — it never drove the FSM.
  const nudges = queryDb<{ status: string; node_id: string }>(
    d.paths.db,
    "SELECT status, node_id FROM nudges WHERE worker_id = ?",
    [workerId],
  );
  expect(nudges.length).toBe(1);
  expect(nudges[0]!.status).toBe("queued");

  // The node never visited NUDGING during the race (it was already finished/gating).
  const nudgingStates = queryDb<{ c: number }>(
    d.paths.db,
    "SELECT COUNT(*) AS c FROM nodes WHERE id = ? AND state = 'NUDGING'",
    [nodeId],
  )[0]!.c;
  expect(nudgingStates).toBe(0);

  // Release the gate; the node finishes cleanly to NODE_DONE / DELIVERED.
  d.brain.release();
  const ok = await waitFor(() => d.store.getTask(taskId)?.state === "DELIVERED");
  expect(ok).toBe(true);
  expect(d.store.getNode(nodeId)?.state).toBe("NODE_DONE");

  d.store.close();
});
