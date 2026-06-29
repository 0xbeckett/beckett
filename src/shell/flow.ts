/**
 * Beckett v2 — the flow runner (`src/shell/flow.ts`)
 * =======================================================================================
 * The HEAVY-PATH substrate. When Beckett judges a task big enough to warrant several workers
 * in some parallel/sequential shape (Spec 02 dynamic effort), it doesn't hand-orchestrate turn
 * by turn — it *writes a flow script* (`flows/<name>.js`) and runs it. The script gets a small
 * `flow` API (worker / parallel / sequence / integrate / nudge / log) and the runner drives the
 * very same {@link Registry} the parent uses, so workers still get worktrees, scope-guards, and
 * telemetry.
 *
 * Every step is journaled to `~/.beckett/flows/<runId>/journal.jsonl` keyed by a deterministic
 * position key, so a flow is **resumable**: re-running with `resume` returns completed steps from
 * the journal instantly and only the unfinished tail re-executes. That's what makes a long
 * multi-worker job survive a shell restart — the same idea as the parent's worker ledger
 * (`beckett work ls`), one level up.
 *
 * Flow scripts are written by Beckett itself (the trusted parent) and run in-process here.
 *
 *   // flows/build-x.js
 *   export const meta = { name: 'build-x', description: 'api + ui + tests' };
 *   export default async function (flow) {
 *     const [api, ui] = await flow.parallel([
 *       (f) => f.worker({ task: 'build the API',  repo, owned: ['api/**'],  desc: 'api' }),
 *       (f) => f.worker({ task: 'build the UI',   repo, owned: ['web/**'],  desc: 'ui'  }),
 *     ]);
 *     const tests = await flow.worker({ task: 'write integration tests', repo, owned: ['test/**'] });
 *     await flow.integrate([api.workerId, ui.workerId, tests.workerId], 'main');
 *     flow.log('shipped');
 *   }
 */

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger, Effort } from "../types.ts";
import type { Registry, WorkerDigest } from "./registry.ts";

/** A worker spawned from inside a flow (a friendlier shape than the raw SpawnArgs). */
export interface FlowWorkerSpec {
  task: string;
  repo: string; // repoRoot
  owned?: string[]; // ownedGlobs (default ["**"])
  desc?: string; // scope description
  base?: string; // baseRef
  model?: string;
  system?: string; // systemAppend
  effort?: Effort;
  turnCap?: number;
  wallS?: number;
  network?: boolean;
}

/** The API handed to a flow script. */
export interface FlowApi {
  /** Spawn one worker and resolve with its final digest when it reaches a terminal state. */
  worker(spec: FlowWorkerSpec): Promise<WorkerDigest>;
  /** Run thunks concurrently (a barrier — awaits all). Each thunk gets its own keyed sub-API. */
  parallel<T>(thunks: Array<(f: FlowApi) => Promise<T>>): Promise<T[]>;
  /** Run thunks one after another. Each thunk gets its own keyed sub-API. */
  sequence<T>(thunks: Array<(f: FlowApi) => Promise<T>>): Promise<T[]>;
  /** Merge worker branches into a target branch (default "main"). */
  integrate(workerIds: string[], targetBranch?: string): Promise<unknown>;
  /** Live mid-task steer of a still-running worker (not journaled — live-only side effect). */
  nudge(workerId: string, text: string): Promise<unknown>;
  /** Emit a progress line (logged + surfaced to the parent as a `[flow …]` signal). */
  log(msg: string): void;
  /** The args object passed to `flow run --args` (or undefined). */
  args: unknown;
}

interface RunStatus {
  runId: string;
  script: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
  steps: number;
  error?: string;
  meta?: { name?: string; description?: string };
}

export interface FlowRunOpts {
  runId: string;
  args?: unknown;
  resume?: boolean;
}

export class FlowRunner {
  constructor(
    private readonly registry: Registry,
    private readonly flowsDir: string, // ~/.beckett/flows
    private readonly logger: Logger,
    private readonly onSignal: (text: string) => void,
  ) {}

  /** List every flow run on disk (newest first) — backs `beckett flow ls`. */
  list(): RunStatus[] {
    if (!existsSync(this.flowsDir)) return [];
    return readdirSync(this.flowsDir)
      .map((id) => join(this.flowsDir, id, "status.json"))
      .filter((f) => existsSync(f))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(f, "utf8")) as RunStatus;
        } catch {
          return null;
        }
      })
      .filter((s): s is RunStatus => s !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Full record for one run (status + journal) — backs `beckett flow show`. */
  show(runId: string): { status: RunStatus | null; journal: unknown[] } {
    const dir = join(this.flowsDir, runId);
    let status: RunStatus | null = null;
    try {
      status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as RunStatus;
    } catch {
      /* none */
    }
    const jf = join(dir, "journal.jsonl");
    const journal = existsSync(jf)
      ? readFileSync(jf, "utf8").trim().split("\n").filter(Boolean).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        })
      : [];
    return { status, journal };
  }

  /**
   * Execute a flow script. Returns the script's return value. Journals each step so a re-run with
   * `resume: true` replays completed steps from disk and only the tail re-executes.
   */
  async run(scriptPath: string, opts: FlowRunOpts): Promise<unknown> {
    const dir = join(this.flowsDir, opts.runId);
    mkdirSync(dir, { recursive: true });
    const journalPath = join(dir, "journal.jsonl");
    const statusPath = join(dir, "status.json");

    // Load any prior journal (resume) into a key→result map.
    const cached = new Map<string, unknown>();
    if (opts.resume && existsSync(journalPath)) {
      for (const line of readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as { key: string; result: unknown };
          cached.set(e.key, e.result);
        } catch {
          /* skip */
        }
      }
    }

    const mod = (await import(pathToFileURL(scriptPath).href)) as {
      default?: (f: FlowApi) => Promise<unknown>;
      meta?: { name?: string; description?: string };
    };
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new Error(`flow ${scriptPath}: needs a default-exported async function (flow) => {…}`);
    }

    let steps = 0;
    const status: RunStatus = {
      runId: opts.runId,
      script: scriptPath,
      state: "running",
      startedAt: Date.now(),
      steps: 0,
      meta: mod.meta,
    };
    const writeStatus = () => writeFileSync(statusPath, JSON.stringify(status, null, 2));
    writeStatus();

    const record = (key: string, kind: string, result: unknown) => {
      cached.set(key, result);
      appendFileSync(journalPath, JSON.stringify({ key, kind, result, at: Date.now() }) + "\n");
      steps++;
      status.steps = steps;
      writeStatus();
    };

    const makeApi = (prefix: string): FlowApi => {
      let counter = 0;
      const nextKey = (kind: string) => `${prefix}${kind}${counter++}`;
      const api: FlowApi = {
        worker: async (spec) => {
          const key = nextKey("w");
          if (cached.has(key)) {
            this.logger.info("flow step cached", { runId: opts.runId, key });
            return cached.get(key) as WorkerDigest;
          }
          const sp = await this.registry.spawn({
            task: spec.task,
            repoRoot: spec.repo,
            baseRef: spec.base,
            systemAppend: spec.system,
            model: spec.model,
            scope: {
              ownedGlobs: spec.owned ?? ["**"],
              readGlobs: null,
              description: spec.desc ?? "",
            },
            envelope: {
              effort: spec.effort,
              turnCap: spec.turnCap,
              wallClockS: spec.wallS,
              network: Boolean(spec.network),
            },
          });
          this.onSignal(`[flow ${opts.runId}] spawned ${sp.workerId} — ${spec.desc || spec.task}`.slice(0, 200));
          const digest = await this.registry.waitFor(sp.workerId);
          record(key, "worker", digest);
          return digest;
        },
        parallel: async (thunks) => {
          const key = nextKey("p");
          return Promise.all(thunks.map((t, i) => t(makeApi(`${key}/${i}/`))));
        },
        sequence: async (thunks) => {
          const key = nextKey("s");
          const out: unknown[] = [];
          for (let i = 0; i < thunks.length; i++) out.push(await thunks[i]!(makeApi(`${key}/${i}/`)));
          return out as never;
        },
        integrate: async (workerIds, targetBranch = "main") => {
          const key = nextKey("i");
          if (cached.has(key)) return cached.get(key);
          const res = await this.registry.integrate(workerIds, targetBranch);
          record(key, "integrate", res);
          return res;
        },
        nudge: (workerId, text) => this.registry.nudge(workerId, text),
        log: (msg) => {
          this.logger.info("flow log", { runId: opts.runId, msg });
          this.onSignal(`[flow ${opts.runId}] ${msg}`.slice(0, 200));
        },
        args: opts.args,
      };
      return api;
    };

    try {
      const result = await fn(makeApi(""));
      status.state = "done";
      status.endedAt = Date.now();
      writeStatus();
      this.onSignal(`[flow done ${opts.runId}] ${status.meta?.name ?? scriptPath} — ${steps} steps`);
      return result;
    } catch (err) {
      status.state = "failed";
      status.endedAt = Date.now();
      status.error = String((err as Error).message);
      writeStatus();
      this.onSignal(`[flow failed ${opts.runId}] ${status.error}`.slice(0, 200));
      throw err;
    }
  }
}
