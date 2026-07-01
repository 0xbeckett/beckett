/**
 * Beckett — orchestrator-level crash-recovery regression test (`tests/recovery.e2e.test.ts`)
 * =======================================================================================
 * BLOCKER 1 regression. Unlike `resume.e2e.test.ts` (which proves only the ClaudeDriver's
 * in-place `--resume`), this drives the REAL spine — Orchestrator + WorkerManager + Tailer +
 * Store — to a mid-run worker, then SIMULATES A DAEMON RESTART by tearing down the first
 * daemon (manager+orchestrator) and constructing a brand-new one over the SAME store + project
 * worktree, exactly as boot would. It then calls {@link BeckettOrchestrator.recover}, which must
 * route the still-`SUPERVISING` node through `recoverDag → resumeNode → dispatch(isResume)` and
 * relaunch the worker via `--resume <session_id>` in its ORIGINAL worktree (Spec 04 §10.2 /
 * Spec 09 §4.3, acceptance: lose ≤1 turn) — never a fresh worktree.
 *
 * Simulating "the daemon died": a thin gated driver wrapper drops every event once the test
 * flips `daemon1Alive=false`, so daemon #1's manager/orchestrator never observe the worker's
 * self-crash (which would otherwise mark the worker `failed` and re-dispatch FRESH instead of
 * exercising recover()). The worktree + the persisted `state=running` worker row + its
 * `session_id` are the durable checkpoint daemon #2 boots from — precisely the daemon-restart
 * contract.
 *
 * On `--resume` the driver sends NO initial prompt, so the fake harness cannot read a
 * `[[scenario:…]]` tag from stdin. We therefore select the scenario with the highest-precedence
 * `--fake-scenario daemon-restart` FLAG via `harness.claude.extra_flags` (passed on both spawn
 * and `--resume`) instead of the `BECKETT_FAKE_SCENARIO` env — bun shares `process.env` across
 * concurrently-running test files, so a global env var would clobber the loop tests' workers.
 */

import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
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
  HarnessDriver,
  DriverKind,
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

const REPO_ROOT = process.cwd();
const FAKE_HARNESS = join(REPO_ROOT, "src/test/fake-harness.ts");
const SCRATCH = join("/tmp", "beckett-e2e", "recovery");
const WRAPPER = join(SCRATCH, "fake-claude.sh");
const log = makeLogger().child("e2e-recovery");

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    WRAPPER,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HARNESS)} "$@"\n`,
  );
  chmodSync(WRAPPER, 0o755);
  process.env.BECKETT_FAKE_SPEED = "0.6";
});

// =======================================================================================
// Scripted zero-cost Brain (single-node plan; never auto-kills) + in-memory Discord
// =======================================================================================

class FakeBrain implements Brain {
  constructor(private readonly checks: string[]) {}
  async intake(): Promise<HaikuClassification> {
    return { kind: "task", withinPurview: true, escalate: false, ack: "On it." };
  }
  async clarify(): Promise<ClarifyOutput> {
    return { needsClarify: false, assumptions: [] };
  }
  async plan(task: TaskRecord): Promise<PlanOutput> {
    const node: PlanNode = {
      id: "n1",
      title: "Multi-step task [[scenario:daemon-restart]]",
      intent: task.prompt,
      dependsOn: [],
      scopePaths: ["**"],
      criteria: { checks: this.checks, nl: ["all three steps complete in the worktree"] },
      suggestedWorker: { harness: "claude", model: "claude-sonnet-5-1", effort: "low" },
      reviewTier: "self",
      envelope: { turnTarget: 6, wallClockSecs: 120 },
    };
    return { summary: "Single-node plan for crash-recovery.", nodes: [node] };
  }
  async staff(_task: TaskRecord, plan: PlanOutput): Promise<StaffOutput> {
    return staffFromPlan(plan);
  }
  async summarizeWorker(worker: Worker): Promise<WorkerSummary> {
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
  async superviseRead(): Promise<SuperviseDecision> {
    return { action: "continue", reason: "real progress, let it run." };
  }
  async gate(node: NodeRecord): Promise<ReviewVerdict> {
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
// Fixture filesystem (created ONCE; daemon #2 reuses the same dirs + db + worktree)
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
      'default_model = "claude-sonnet-5-1"',
      // Select the scenario via the highest-precedence --fake-scenario FLAG (passed on both
      // spawn AND --resume) rather than BECKETT_FAKE_SCENARIO env: bun shares process.env across
      // concurrently-running test files, so a global env var would clobber the loop tests' workers.
      'extra_flags = ["--fake-scenario", "daemon-restart"]',
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

// =======================================================================================
// Daemon assembly (mirrors daemon.ts) — built TWICE over the same store/project, exactly
// as a real restart would. The registry is injected so daemon #1 can use a gated wrapper.
// =======================================================================================

interface Daemon {
  store: ReturnType<typeof createStore>;
  orchestrator: BeckettOrchestrator;
  workerManager: ReturnType<typeof createWorkerManager>;
}

function buildDaemon(opts: {
  config: Config;
  paths: Paths;
  projectDir: string;
  wrapDriver?: (d: HarnessDriver) => HarnessDriver;
}): Daemon {
  const { config, paths, projectDir } = opts;
  const store = createStore(paths, config);
  store.init();

  const memory = createMemory({ memoryDir: paths.memoryDir, store, logger: log, git: false });
  const brain = new FakeBrain(["true"]);
  const agency = createAgency(config, paths, store);
  const supervisor = new Tailer(store, config, log.child("supervise"));
  const discord = new FakeDiscord();

  let orchestrator!: BeckettOrchestrator;

  const registry: DriverRegistry = {
    create: (kind: DriverKind, worker: Worker) => {
      let driver = createDriver(worker.harness, config, log);
      if (opts.wrapDriver) driver = opts.wrapDriver(driver);
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

  return { store, orchestrator, workerManager };
}

async function waitFor(pred: () => boolean, timeoutMs = 30_000, intervalMs = 10): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(intervalMs);
  }
  return pred();
}

function gitHasPath(repo: string, branch: string, path: string): boolean {
  return Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", `${branch}:${path}`]).success;
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
// BLOCKER 1 — orchestrator-level crash recovery resumes via --resume in the SAME worktree
// =======================================================================================

test("daemon-restart: recover() --resumes a mid-run worker in its original worktree (same session_id, ≤1 turn lost)", async () => {
  const { config, paths } = makeBeckettDir();
  const projectDir = makeProjectRepo();

  // ── Daemon #1: drive a worker to mid-run, then "kill the daemon" ────────────────────
  // A gated wrapper that drops all events once daemon1Alive flips — modeling the daemon
  // process dying so it never observes the worker's self-crash (which would mark it failed
  // and re-dispatch fresh, bypassing recover()).
  let daemon1Alive = true;
  const gate = (inner: HarnessDriver): HarnessDriver =>
    new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === "onEvent") {
          return (cb: (e: WorkerEvent) => void) =>
            target.onEvent((e) => {
              if (daemon1Alive) cb(e);
            });
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

  const d1 = buildDaemon({ config, paths, projectDir, wrapDriver: gate });
  const taskId = await d1.orchestrator.submit(intake("do a three-step task"));

  // Wait until the worker is genuinely mid-run: running + session_id persisted + node SUPERVISING.
  await waitFor(() => d1.workerManager.live().some((w) => w.state === "running"));
  const liveWorker = d1.workerManager.live().find((w) => w.state === "running")!;
  expect(liveWorker).toBeTruthy();
  const nodeId = liveWorker.nodeId;

  await waitFor(() => {
    const row = queryDb<{ session_id: string | null; state: string }>(
      paths.db,
      "SELECT session_id, state FROM workers WHERE id = ?",
      [liveWorker.id],
    )[0];
    return Boolean(row?.session_id) && row?.state === "running";
  });
  await waitFor(() => d1.store.getNode(nodeId)?.state === "SUPERVISING");

  // Snapshot the durable "instant of death" checkpoint.
  const beforeRow = queryDb<{ id: string; session_id: string; workspace: string; pid: number | null; state: string }>(
    paths.db,
    "SELECT id, session_id, workspace, pid, state FROM workers WHERE id = ?",
    [liveWorker.id],
  )[0]!;
  const origSession = beforeRow.session_id;
  const origWorkspace = beforeRow.workspace;
  const origWorkerId = beforeRow.id;
  expect(origSession).toBeTruthy();
  expect(beforeRow.state).toBe("running");
  expect(d1.store.getNode(nodeId)?.state).toBe("SUPERVISING");

  // KILL THE DAEMON: daemon #1 stops observing the worker as of now.
  daemon1Alive = false;

  // The orphaned worker writes step-1 then self-crashes (daemon-restart fresh beats). Wait for
  // its pre-crash work to hit the worktree, then for the OS process to actually exit — so the
  // worktree is a quiescent checkpoint daemon #2 can reuse.
  await waitFor(() => existsSync(join(origWorkspace, "step-1.txt")));
  expect(existsSync(join(origWorkspace, "step-1.txt"))).toBe(true);
  expect(existsSync(join(origWorkspace, "step-2.txt"))).toBe(false);

  if (beforeRow.pid) {
    await waitFor(() => {
      try {
        process.kill(beforeRow.pid!, 0);
        return false; // still alive
      } catch {
        return true; // gone
      }
    });
  }

  // Store still reflects the mid-run checkpoint (daemon #1 never recorded the crash).
  const frozen = queryDb<{ state: string; session_id: string }>(
    paths.db,
    "SELECT state, session_id FROM workers WHERE id = ?",
    [origWorkerId],
  )[0]!;
  expect(frozen.state).toBe("running");
  expect(frozen.session_id).toBe(origSession);
  expect(d1.store.getNode(nodeId)?.state).toBe("SUPERVISING");
  d1.store.close();

  // ── Daemon #2: boot over the SAME store + project + worktree and recover() ───────────
  const d2 = buildDaemon({ config, paths, projectDir });
  await d2.orchestrator.recover();

  // recover() routed the SUPERVISING node through resumeNode → --resume.
  expect(d2.orchestrator.resumedWorkers).toBe(1);

  // The resumed worker REUSES the prior row id + worktree (not a fresh dispatch) and keeps the
  // session id — i.e. the recover path reattached, it did not mint a new worker/worktree.
  const resumedRow = queryDb<{ id: string; session_id: string; workspace: string }>(
    paths.db,
    "SELECT id, session_id, workspace FROM workers WHERE node_id = ? ORDER BY spawned_at DESC LIMIT 1",
    [nodeId],
  )[0]!;
  expect(resumedRow.id).toBe(origWorkerId); // SAME worker row — reattach, not re-dispatch
  expect(resumedRow.session_id).toBe(origSession); // SAME session id — --resume <session_id>
  expect(resumedRow.workspace).toBe(origWorkspace); // SAME worktree reused (not a fresh one)

  // Exactly ONE worker row for the node (no duplicate fresh worker minted) and one worktree dir.
  const workerCount = queryDb<{ c: number }>(
    paths.db,
    "SELECT COUNT(*) AS c FROM workers WHERE node_id = ?",
    [nodeId],
  )[0]!.c;
  expect(workerCount).toBe(1);

  // The node completes losing ≤1 turn: step-2 + step-3 are added on top of the surviving step-1.
  const ok = await waitFor(() => d2.store.getTask(taskId)?.state === "DELIVERED");
  expect(ok).toBe(true);
  expect(d2.store.getNode(nodeId)?.state).toBe("NODE_DONE");

  const task = d2.store.getTask(taskId)!;
  const branch = task.project_branch!;
  expect(branch).toBeTruthy();
  expect(gitHasPath(projectDir, branch, "step-1.txt")).toBe(true); // pre-crash work survived
  expect(gitHasPath(projectDir, branch, "step-2.txt")).toBe(true); // resumed turn
  expect(gitHasPath(projectDir, branch, "step-3.txt")).toBe(true); // resumed turn → 0 turns lost

  d2.store.close();
});
