/**
 * Beckett v2 — worker registry + watcher (`src/shell/registry.ts`)
 * =======================================================================================
 * Holds the live worker handles (salvaged Claude driver), allocates worktrees + the
 * per-worktree scope-guard hook, normalizes driver telemetry into compact digests on disk
 * (`~/.beckett/workers/<id>/{events.jsonl,status.json}`), computes smoke-alarms, and injects
 * compact *signals* into the parent via `onSignal` (Spec 04 §4). This is the "watcher" — the
 * parent reads digests via `worker status`, never raw logs.
 *
 * Claude workers only for now (the steerable primary). codex/pi via sandcastle is Phase 4.
 */

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createDriver } from "../drivers/index.ts";
import { createWorktree, mergeBranch, commitWorktree, readDiffStat, excludeFromGit } from "../worker/worktree.ts";
import { scopeGuardSpec } from "../hooks/scope-guard.ts";
import { renderClaudeSettings } from "../hooks/registry.ts";
import { workerId as mintWorkerId } from "../ids.ts";
import type {
  Config,
  Paths,
  Logger,
  Harness,
  HarnessDriver,
  WorkerEvent,
  FileScope,
  ResourceEnvelope,
  NudgeReceipt,
} from "../types.ts";

export interface SpawnArgs {
  harness?: Harness; // default "claude"
  task: string; // the brief
  systemAppend?: string; // criteria + scope + persona for the worker
  repoRoot: string; // project git repo the work happens in
  baseRef?: string; // branch/ref to fork from (default "HEAD")
  scope: FileScope;
  envelope?: Partial<ResourceEnvelope>;
  model?: string;
}

export interface WorkerDigest {
  workerId: string;
  harness: string;
  state: string;
  turns: number;
  toolCalls: number;
  lastAction: string;
  diff: { added: number; removed: number; files: number };
  alarms: { kind: string; firedAt: number; detail: string }[];
  envelope: { turnCap: number; wallClockS: number; over: boolean };
  blocked?: string;
  branch: string;
  workspace: string;
}

interface WorkerRec {
  id: string;
  harness: Harness;
  driver: HarnessDriver;
  sessionId: string;
  branch: string;
  workspace: string;
  repoRoot: string;
  baseSha: string; // commit the worktree branched from — diff against this to count committed work too
  scope: FileScope;
  envelope: ResourceEnvelope;
  state: string;
  spawnedAt: number;
  lastActivity: number;
  lastAction: string;
  turns: number;
  toolCalls: number;
  diff: { added: number; removed: number; files: number };
  lastDiffGrowthTurn: number;
  alarms: { kind: string; firedAt: number; detail: string }[];
  blocked?: string;
  checkinTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_ENVELOPE: ResourceEnvelope = {
  effort: "medium",
  turnCap: 40,
  wallClockS: 1800,
  network: false,
};

export class Registry {
  private readonly workers = new Map<string, WorkerRec>();
  private readonly doneSchemaPath: string;

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly logger: Logger,
    private readonly onSignal: (text: string) => void,
  ) {
    this.doneSchemaPath = join(this.paths.beckettDir, "worker-done.schema.json");
    this.ensureDoneSchema();
  }

  liveCount(): number {
    let n = 0;
    for (const w of this.workers.values()) if (!isTerminal(w.state)) n++;
    return n;
  }

  async spawn(a: SpawnArgs): Promise<{ workerId: string; sessionId: string; branch: string; workspace: string }> {
    const cap = this.config.concurrency.max_workers;
    if (this.liveCount() >= cap) {
      throw new Error(`concurrency cap reached (${cap} live workers)`);
    }
    const id = mintWorkerId();
    const branch = `beckett/${id}`;
    const workspace = join(a.repoRoot, ".beckett", "worktrees", id);
    const envelope: ResourceEnvelope = { ...DEFAULT_ENVELOPE, ...a.envelope };
    const model = a.model ?? this.config.harness.claude.default_model;
    const harness: Harness = a.harness ?? "claude";
    if (harness !== "claude") {
      throw new Error(`harness "${harness}" not wired yet (sandcastle codex/pi is Phase 4)`);
    }

    const baseRef = a.baseRef ?? "HEAD";
    const baseSha = await resolveRef(a.repoRoot, baseRef);
    await createWorktree({ repoRoot: a.repoRoot, workspace, branch, baseRef });

    // Keep Beckett's per-worktree tooling out of git so it never gets committed into the worker's
    // branch (and thus never conflicts when several branches integrate — the scope-guard settings
    // would otherwise add/add-conflict on the 2nd merge).
    await excludeFromGit(workspace, [".claude/settings.json", ".beckett/"]);

    // Install the per-worktree scope-guard PreToolUse hook (Spec 04 §3).
    this.writeScopeGuard(workspace, a.scope.ownedGlobs);

    const driver = createDriver(harness, this.config, this.logger.child(`drv:${id}`));
    const rec: WorkerRec = {
      id,
      harness,
      driver,
      sessionId: "",
      branch,
      workspace,
      repoRoot: a.repoRoot,
      baseSha,
      scope: a.scope,
      envelope,
      state: "spawning",
      spawnedAt: Date.now(),
      lastActivity: Date.now(),
      lastAction: "(spawning)",
      turns: 0,
      toolCalls: 0,
      diff: { added: 0, removed: 0, files: 0 },
      lastDiffGrowthTurn: 0,
      alarms: [],
    };
    this.workers.set(id, rec);
    driver.onEvent((e) => this.onWorkerEvent(rec, e));

    const res = await driver.spawn({
      workerId: id,
      prompt: a.task,
      systemAppend: a.systemAppend ?? "",
      workspace,
      scope: a.scope,
      envelope,
      model,
      doneSchemaPath: this.doneSchemaPath,
    });
    rec.sessionId = res.sessionId;
    rec.state = "running";
    this.writeStatus(rec);
    this.logger.info("worker spawned", { id, branch, workspace, model });
    return { workerId: id, sessionId: res.sessionId, branch, workspace };
  }

  status(workerId?: string): WorkerDigest[] {
    const recs = workerId ? [this.workers.get(workerId)].filter(Boolean) as WorkerRec[] : [...this.workers.values()];
    return recs.map((w) => this.digest(w));
  }

  /** Resolve once a worker reaches a terminal state (done/failed/aborted) — for the flow runner. */
  async waitFor(workerId: string, pollMs = 2000): Promise<WorkerDigest> {
    for (;;) {
      const rec = this.workers.get(workerId);
      if (!rec) throw new Error(`unknown worker ${workerId}`);
      if (isTerminal(rec.state)) return this.digest(rec);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  recentEvents(workerId: string, lastN = 50): unknown[] {
    const rec = this.workers.get(workerId);
    if (!rec) throw new Error(`unknown worker ${workerId}`);
    const file = join(this.workerDir(workerId), "events.jsonl");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-lastN).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  }

  async nudge(workerId: string, text: string): Promise<NudgeReceipt> {
    const rec = this.req(workerId);
    return rec.driver.sendNudge(text);
  }

  async abort(workerId: string, reason: string): Promise<{ state: string; sessionId: string }> {
    const rec = this.req(workerId);
    await rec.driver.abort(reason);
    rec.state = "aborted";
    this.writeStatus(rec);
    return { state: rec.state, sessionId: rec.sessionId };
  }

  scheduleCheckin(workerId: string, opts: { afterTurns?: number; afterSecs?: number; reason: string }): void {
    const rec = this.req(workerId);
    if (rec.checkinTimer) clearTimeout(rec.checkinTimer);
    const ms = opts.afterSecs ? opts.afterSecs * 1000 : (opts.afterTurns ?? 5) * 30_000;
    rec.checkinTimer = setTimeout(() => {
      this.signal(`[checkin ${workerId}] ${opts.reason} (turns=${rec.turns}, ${rec.lastAction})`);
    }, ms);
  }

  /** Merge a worker's branch into a target branch (INTEGRATE / one-worker delivery). */
  async integrate(workerIds: string[], targetBranch: string): Promise<unknown> {
    const results: unknown[] = [];
    for (const id of workerIds) {
      const rec = this.req(id);
      await commitWorktree(rec.workspace, `beckett(${id}): work`, {
        name: this.config.identity.github_user,
        email: `${this.config.identity.github_user}@users.noreply.github.com`,
      });
      const merge = await mergeBranch(rec.repoRoot, rec.branch, targetBranch);
      results.push({ workerId: id, branch: rec.branch, ...merge });
    }
    return results;
  }

  async stopAll(): Promise<void> {
    for (const rec of this.workers.values()) {
      if (rec.checkinTimer) clearTimeout(rec.checkinTimer);
    }
    // Leave worker processes resumable on disk (Spec 01 §5.2) — do not kill on graceful stop.
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────

  private onWorkerEvent(rec: WorkerRec, e: WorkerEvent): void {
    rec.lastActivity = Date.now();
    switch (e.kind) {
      case "session_started":
        rec.sessionId = e.sessionId;
        break;
      case "turn_completed":
        rec.turns++;
        this.refreshDiff(rec);
        this.checkAlarms(rec);
        break;
      case "tool_call":
        rec.toolCalls++;
        rec.lastAction = `${e.tool} ${shortInput(e.input)}`;
        break;
      case "hook_decision":
        if (e.decision === "deny") {
          this.fire(rec, "scope_violation", e.reason ?? "write denied by scope-guard");
        }
        break;
      case "finished":
        rec.state = e.status === "success" ? "done" : "failed";
        this.writeStatus(rec);
        this.signal(`[done ${rec.id}] ${e.status} (${e.subtype}) — turns=${rec.turns}, diff +${rec.diff.added}/-${rec.diff.removed} in ${rec.diff.files} files`);
        break;
      case "error":
        rec.blocked = e.message;
        this.fire(rec, "blocked", e.message);
        break;
    }
    this.appendEvent(rec, e);
    this.writeStatus(rec);
  }

  private checkAlarms(rec: WorkerRec): void {
    const K = this.config.supervise.drift_no_progress_turns;
    if (rec.turns - rec.lastDiffGrowthTurn >= K) {
      this.fire(rec, "no_diff_progress", `${rec.turns - rec.lastDiffGrowthTurn} turns, no diff growth`);
    }
    const factor = this.config.supervise.overrun_factor;
    if (rec.turns > rec.envelope.turnCap * factor) {
      this.fire(rec, "over_envelope", `turns ${rec.turns} > ${rec.envelope.turnCap}×${factor}`);
    }
    if ((Date.now() - rec.spawnedAt) / 1000 > rec.envelope.wallClockS * factor) {
      this.fire(rec, "over_envelope", `wall-clock over ${rec.envelope.wallClockS}s×${factor}`);
    }
  }

  private refreshDiff(rec: WorkerRec): void {
    void readDiffStat(rec.workspace, rec.baseSha)
      .then((d) => {
        const grew = d.added + d.removed > rec.diff.added + rec.diff.removed;
        rec.diff = d;
        if (grew) rec.lastDiffGrowthTurn = rec.turns;
        this.writeStatus(rec);
      })
      .catch(() => {
        /* diff best-effort */
      });
  }

  private fire(rec: WorkerRec, kind: string, detail: string): void {
    const last = rec.alarms.filter((a) => a.kind === kind).at(-1);
    const cooldownMs = 120_000;
    if (last && Date.now() - last.firedAt < cooldownMs) return; // debounce per-kind
    const alarm = { kind, firedAt: Date.now(), detail };
    rec.alarms.push(alarm);
    this.writeStatus(rec);
    this.signal(`[signal ${rec.id}] ${kind}: ${detail} (turns=${rec.turns}, ${rec.lastAction})`);
  }

  private signal(text: string): void {
    this.logger.info("signal -> parent", { text });
    try {
      this.onSignal(text);
    } catch (err) {
      this.logger.warn("signal injection failed", { error: String(err) });
    }
  }

  private digest(w: WorkerRec): WorkerDigest {
    const factor = this.config.supervise.overrun_factor;
    return {
      workerId: w.id,
      harness: w.harness,
      state: w.state,
      turns: w.turns,
      toolCalls: w.toolCalls,
      lastAction: w.lastAction,
      diff: w.diff,
      alarms: w.alarms.slice(-6),
      envelope: {
        turnCap: w.envelope.turnCap,
        wallClockS: w.envelope.wallClockS,
        over: w.turns > w.envelope.turnCap * factor,
      },
      blocked: w.blocked,
      branch: w.branch,
      workspace: w.workspace,
    };
  }

  private req(workerId: string): WorkerRec {
    const rec = this.workers.get(workerId);
    if (!rec) throw new Error(`unknown worker ${workerId}`);
    return rec;
  }

  private workerDir(id: string): string {
    const dir = join(this.paths.beckettDir, "workers", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private appendEvent(rec: WorkerRec, e: WorkerEvent): void {
    try {
      appendFileSync(join(this.workerDir(rec.id), "events.jsonl"), JSON.stringify(e) + "\n");
    } catch {
      /* telemetry best-effort */
    }
  }

  private writeStatus(rec: WorkerRec): void {
    try {
      writeFileSync(join(this.workerDir(rec.id), "status.json"), JSON.stringify(this.digest(rec), null, 2));
    } catch {
      /* best-effort */
    }
  }

  private writeScopeGuard(workspace: string, owned: string[]): void {
    try {
      const scriptPath = join(import.meta.dir, "..", "hooks", "scope-guard.ts");
      const settings = renderClaudeSettings([scopeGuardSpec(scriptPath, workspace, owned)]);
      const dir = join(workspace, ".claude");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
    } catch (err) {
      this.logger.warn("could not install scope-guard", { error: String(err) });
    }
  }

  private ensureDoneSchema(): void {
    try {
      mkdirSync(this.paths.beckettDir, { recursive: true });
      if (!existsSync(this.doneSchemaPath)) {
        writeFileSync(
          this.doneSchemaPath,
          JSON.stringify(
            {
              type: "object",
              properties: {
                summary: { type: "string" },
                criteriaMet: { type: "boolean" },
                notes: { type: "string" },
              },
              required: ["summary"],
            },
            null,
            2,
          ),
        );
      }
    } catch {
      /* best-effort */
    }
  }
}

function isTerminal(state: string): boolean {
  return state === "done" || state === "failed" || state === "aborted";
}

/** Resolve a ref to a commit SHA in a repo (the worktree's diff baseline). */
async function resolveRef(repoRoot: string, ref: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "-C", repoRoot, "rev-parse", ref], { stdout: "pipe", stderr: "ignore" });
    const sha = (await new Response(proc.stdout).text()).trim();
    return sha || ref;
  } catch {
    return ref;
  }
}

function shortInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? "";
    return String(v).slice(0, 80);
  }
  return String(input ?? "").slice(0, 80);
}
