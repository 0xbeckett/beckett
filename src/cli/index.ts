#!/usr/bin/env bun
/**
 * Beckett — the `beckett` CLI (`src/cli/index.ts`)
 * =======================================================================================
 * The canonical off-Discord management surface (Spec 10). A short-lived process — NOT the
 * daemon — that either reads the DB/JSONL directly (read commands; work daemon-down) or pokes
 * the unix socket and exits (write/control commands). Two channels, split by read vs. write,
 * exactly as Spec 01 §7 fixes.
 *
 *   READ  (no daemon hop): ps · tail · status · tasks · logs · mem · doctor
 *   WRITE (unix socket):   nudge · pause · resume · abort · ask-plan · reload · daemon stop
 *   LOCAL (no IPC):        daemon start (foreground dev run)
 *
 * Id scheme (Spec 10 §2): the persisted ids are Spec-09 opaque (`task_…`/`node_…`/`wk_…`);
 * the human display ids (`42`, `42.1`, `w-7f3a`) are a presentation layer this CLI derives
 * over them (created-at rank for tasks, 1-based index within a task for nodes, `w-`+suffix for
 * workers). Both forms are accepted by the resolver so copy-paste always works. See the report
 * note on Foundation contract-gap #1 (no `nodes.idx`/`workers.short_id` columns).
 *
 * Import style: explicit `.ts` extensions (Foundation contract).
 */

import { existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath, isAbsolute, basename, relative } from "node:path";
import { listMarkdownFiles, splitFrontmatter } from "../util/markdown.ts";
import { userInfo } from "node:os";
import { Database } from "bun:sqlite";
import type {
  Config,
  Paths,
  TaskRow,
  NodeRow,
  WorkerRow,
  NudgeRow,
  CriteriaRow,
  EscalationRow,
  EventRecord,
  IpcResponse,
  IpcCmd,
  NudgeReceipt,
  Checkpoint,
  AbortState,
  StatusReport,
} from "../types.ts";
import { TASK_TERMINAL, TaskState } from "../types.ts";
import { loadConfig, defaultConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { openReadOnly } from "../persistence/store.ts";
import { readEvents, type EventQuery } from "../persistence/events.ts";
import { UnixIpcClient } from "../ipc/client.ts";
import { makeRequest, IpcError, EXIT, PROTO } from "../ipc/protocol.ts";

const CLI_VERSION = "0.1.0";
const WORKER_TERMINAL_STATES = ["done", "failed", "aborted"];

// =======================================================================================
// Arg parsing
// =======================================================================================

/** Flags that consume the following token (or `--flag=value`) as a value. */
const VALUE_FLAGS = new Set([
  "socket", "db", "timeout", "interval", "since", "until", "limit", "reason", "msg",
  "filter", "decisions", "user", "state", "kind", "level", "tag",
]);

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Parse `argv` into positionals + flags. Global and command flags are parsed uniformly;
 * each command reads the flags it cares about. `--flag=value`, `--flag value`, and boolean
 * `--flag` / `-x` are all supported. `--` ends flag parsing (rest are positionals).
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (onlyPositional) {
      positional.push(tok);
      continue;
    }
    if (tok === "--") {
      onlyPositional = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, true);
        }
      } else {
        flags.set(body, true);
      }
    } else if (tok.startsWith("-") && tok.length > 1) {
      // short flags — boolean only in this CLI (each char is its own flag).
      for (const ch of tok.slice(1)) flags.set(ch, true);
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

/** Read a flag's string value, honoring an optional long↔short alias. */
function flagStr(p: ParsedArgs, name: string, alias?: string): string | undefined {
  const v = p.flags.get(name) ?? (alias ? p.flags.get(alias) : undefined);
  return typeof v === "string" ? v : undefined;
}

/** Is a boolean flag present (set to true, or given any value)? */
function flagBool(p: ParsedArgs, name: string, alias?: string): boolean {
  return p.flags.has(name) || (alias !== undefined && p.flags.has(alias));
}

function flagInt(p: ParsedArgs, name: string, fallback: number): number {
  const v = flagStr(p, name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// =======================================================================================
// Global context (paths, config, output mode)
// =======================================================================================

interface GlobalOpts {
  json: boolean;
  color: boolean;
  quiet: boolean;
  yes: boolean;
  timeout: number;
}

interface Ctx {
  global: GlobalOpts;
  paths: Paths;
  config: Config;
  userId: string;
}

/** Load config (non-fatal for read commands, Spec 10 §1.3) and resolve all paths + flags. */
function buildContext(p: ParsedArgs): Ctx {
  let config: Config;
  try {
    config = loadConfig();
  } catch {
    config = defaultConfig(); // invalid/missing config must not break the read path
  }
  const paths = buildPaths(config, process.env);

  const dbFlag = flagStr(p, "db");
  if (dbFlag) paths.db = isAbsolute(dbFlag) ? dbFlag : resolvePath(dbFlag);
  const socketFlag = flagStr(p, "socket");
  if (socketFlag) paths.socket = isAbsolute(socketFlag) ? socketFlag : resolvePath(socketFlag);

  const noColor =
    flagBool(p, "no-color") || process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
  const json = flagBool(p, "json");

  const global: GlobalOpts = {
    json,
    color: flagBool(p, "color") || (!noColor && !json),
    quiet: flagBool(p, "quiet", "q"),
    yes: flagBool(p, "yes", "y"),
    timeout: flagInt(p, "timeout", 5000),
  };

  return {
    global,
    paths,
    config,
    userId: userInfo().username || process.env.USER || "unknown",
  };
}

// =======================================================================================
// Color + formatting
// =======================================================================================

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

function paint(ctx: Ctx, code: string, s: string): string {
  return ctx.global.color ? `${code}${s}${C.reset}` : s;
}
const bold = (ctx: Ctx, s: string) => paint(ctx, C.bold, s);
const dim = (ctx: Ctx, s: string) => paint(ctx, C.dim, s);

/** Semantic color for a worker/task/node state label (color is never load-bearing). */
function stateColor(ctx: Ctx, state: string): string {
  const s = state.toLowerCase();
  if (/(done|delivered|node_done|green|ok)/.test(s)) return paint(ctx, C.green, state);
  if (/(queued|paused|nudging|review|gat|block|ready)/.test(s)) return paint(ctx, C.yellow, state);
  if (/(fail|abort|error)/.test(s)) return paint(ctx, C.red, state);
  return state;
}

/** Humanize an age in ms → "4s" / "22s" / "5m" / "1h04m" / "2d". */
function humanizeAge(ms: number): string {
  if (ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** Parse a "since" window like `30m`, `6h`, `2d`, or an ISO date → epoch ms. */
function parseSince(spec: string | undefined, fallbackMs: number): number {
  if (!spec) return Date.now() - fallbackMs;
  const m = spec.match(/^(\d+)(s|m|h|d)$/);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    const unit = m[2]!;
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const t = Date.parse(spec);
  return Number.isFinite(t) ? t : Date.now() - fallbackMs;
}

/** Render an aligned text table (headers + rows). Strips ANSI when measuring widths. */
function renderTable(ctx: Ctx, headers: string[], rows: string[][]): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  const headerLine = headers.map((h, i) => bold(ctx, pad(h, widths[i]!))).join("  ");
  const body = rows.map((r) => r.map((c, i) => pad(c ?? "", widths[i]!)).join("  ")).join("\n");
  return rows.length ? `${headerLine}\n${body}` : headerLine;
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}

// =======================================================================================
// Read layer — typed queries against the read-only DB (Spec 09 §7)
// =======================================================================================

/** Open the DB read-only; returns null if no DB file exists yet (fresh box). */
function openDb(ctx: Ctx): Database | null {
  if (!existsSync(ctx.paths.db)) return null;
  return openReadOnly(ctx.paths.db);
}

const NOT_TERMINAL_WORKER = `state NOT IN ('done','failed','aborted')`;

function allTasksByRank(db: Database): TaskRow[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks ORDER BY created_at, id").all();
}
function nodesForTask(db: Database, taskId: string): NodeRow[] {
  return db
    .query<NodeRow, [string]>("SELECT * FROM nodes WHERE task_id = ? ORDER BY created_at, id")
    .all(taskId);
}
function workersForNode(db: Database, nodeId: string): WorkerRow[] {
  return db
    .query<WorkerRow, [string]>("SELECT * FROM workers WHERE node_id = ? ORDER BY spawned_at")
    .all(nodeId);
}
function liveWorkerForNode(db: Database, nodeId: string): WorkerRow | null {
  return (
    db
      .query<WorkerRow, [string]>(
        `SELECT * FROM workers WHERE node_id = ? AND ${NOT_TERMINAL_WORKER} ORDER BY spawned_at DESC LIMIT 1`,
      )
      .get(nodeId) ?? null
  );
}
function lastWorkerForNode(db: Database, nodeId: string): WorkerRow | null {
  return (
    db
      .query<WorkerRow, [string]>("SELECT * FROM workers WHERE node_id = ? ORDER BY spawned_at DESC LIMIT 1")
      .get(nodeId) ?? null
  );
}
function liveWorkersForTask(db: Database, taskId: string): WorkerRow[] {
  return db
    .query<WorkerRow, [string]>(
      `SELECT * FROM workers WHERE task_id = ? AND ${NOT_TERMINAL_WORKER} ORDER BY spawned_at`,
    )
    .all(taskId);
}
function getTaskRow(db: Database, id: string): TaskRow | null {
  return db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
}
function getNodeRow(db: Database, id: string): NodeRow | null {
  return db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(id) ?? null;
}
function getWorkerRow(db: Database, id: string): WorkerRow | null {
  return db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE id = ?").get(id) ?? null;
}
function queuedNudgeCount(db: Database, workerId: string): number {
  const r = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM nudges WHERE worker_id = ? AND status = 'queued'",
    )
    .get(workerId);
  return r?.n ?? 0;
}
function criteriaForNode(db: Database, nodeId: string): CriteriaRow | null {
  return db.query<CriteriaRow, [string]>("SELECT * FROM criteria WHERE node_id = ?").get(nodeId) ?? null;
}
function openEscalationsForTask(db: Database, taskId: string): EscalationRow[] {
  return db
    .query<EscalationRow, [string]>("SELECT * FROM escalations WHERE task_id = ? AND state = 'open'")
    .all(taskId);
}

// =======================================================================================
// Id resolver (Spec 10 §2)
// =======================================================================================

type Resolved =
  | { kind: "task"; task: TaskRow }
  | { kind: "node"; node: NodeRow }
  | { kind: "worker"; worker: WorkerRow };

class Refs {
  private readonly ranked: TaskRow[];
  private readonly rankById = new Map<string, number>();

  constructor(private readonly db: Database) {
    this.ranked = allTasksByRank(db);
    this.ranked.forEach((t, i) => this.rankById.set(t.id, i + 1));
  }

  /** Display id for a task (created-at rank, 1-based). */
  taskDisplay(taskId: string): string {
    return String(this.rankById.get(taskId) ?? "?");
  }

  /** Display id for a node (`<taskRank>.<nodeIdx>`). */
  nodeDisplay(node: NodeRow): string {
    const siblings = nodesForTask(this.db, node.task_id);
    const idx = siblings.findIndex((n) => n.id === node.id) + 1;
    return `${this.taskDisplay(node.task_id)}.${idx || "?"}`;
  }

  /** Display id for a worker (`w-<suffix>` over the canonical `wk_<suffix>`). */
  workerDisplay(workerId: string): string {
    return "w-" + workerId.replace(/^wk_/, "");
  }

  /** Resolve a human ref to a concrete row. Throws {@link IpcError} (exit 2/4) on failure. */
  resolve(ref: string): Resolved {
    // Canonical Spec-09 ids (what JSON output prints) resolve directly.
    if (ref.startsWith("task_")) {
      const task = getTaskRow(this.db, ref);
      if (!task) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no task ${ref}`);
      return { kind: "task", task };
    }
    if (ref.startsWith("node_")) {
      const node = getNodeRow(this.db, ref);
      if (!node) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no node ${ref}`);
      return { kind: "node", node };
    }
    if (ref.startsWith("wk_")) {
      const worker = getWorkerRow(this.db, ref);
      if (!worker) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no worker ${ref}`);
      return { kind: "worker", worker };
    }
    // Display forms (Spec 10 §2).
    if (/^\d+$/.test(ref)) {
      const task = this.ranked[Number.parseInt(ref, 10) - 1];
      if (!task) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no task ${ref}`);
      return { kind: "task", task };
    }
    if (/^\d+\.\d+$/.test(ref)) {
      const [r, i] = ref.split(".").map((x) => Number.parseInt(x, 10)) as [number, number];
      const task = this.ranked[r - 1];
      if (!task) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no task ${r}`);
      const node = nodesForTask(this.db, task.id)[i - 1];
      if (!node) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no node ${ref}`);
      return { kind: "node", node };
    }
    if (/^w-[0-9a-z]+$/i.test(ref)) {
      const worker = getWorkerRow(this.db, "wk_" + ref.slice(2));
      if (!worker) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no worker ${ref}`);
      return { kind: "worker", worker };
    }
    throw new IpcError(
      EXIT.USAGE,
      "usage",
      `unrecognized id '${ref}' — expected 42, 42.1, or w-7f3a`,
    );
  }
}

/**
 * Resolve a write target to one or more live workers (Spec 10 §2, §5.1 fan-out).
 * `allowTask` gates whether a task ref fans out (nudge/abort) or is rejected (pause/resume).
 */
function resolveTargetWorkers(
  db: Database,
  refs: Refs,
  ref: string,
  opts: { allowTask: boolean; all: boolean },
): WorkerRow[] {
  const r = refs.resolve(ref);
  if (r.kind === "worker") return [r.worker];
  if (r.kind === "node") {
    const w = liveWorkerForNode(db, r.node.id);
    if (!w) {
      throw new IpcError(
        EXIT.NOT_FOUND,
        "not_found",
        `node ${refs.nodeDisplay(r.node)} has no live worker (state: ${r.node.state})`,
      );
    }
    return [w];
  }
  // task ref
  if (!opts.allowTask) {
    throw new IpcError(
      EXIT.USAGE,
      "usage",
      `pick a worker; 'beckett ps ${ref}' lists them`,
    );
  }
  const live = liveWorkersForTask(db, r.task.id);
  if (live.length === 0) {
    throw new IpcError(EXIT.NOT_FOUND, "not_found", `task ${refs.taskDisplay(r.task.id)} has no live workers`);
  }
  if (live.length === 1 || opts.all) return live;
  const ids = live.map((w) => refs.workerDisplay(w.id)).join(", ");
  throw new IpcError(
    EXIT.REJECTED,
    "ambiguous",
    `task ${refs.taskDisplay(r.task.id)} has ${live.length} live workers: ${ids} — pass one, or --all`,
  );
}

// =======================================================================================
// Write/control commands (unix socket)
// =======================================================================================

async function ipcSend(ctx: Ctx, cmd: IpcCmd, args: Record<string, unknown>): Promise<IpcResponse> {
  const client = new UnixIpcClient({ socketPath: ctx.paths.socket, timeoutMs: ctx.global.timeout });
  return client.send(makeRequest(cmd, args, ctx.userId));
}

/** Translate a daemon `ok:false` envelope into an {@link IpcError} so main() prints it uniformly. */
function ensureOk(res: IpcResponse): IpcResponse {
  if (!res.ok) {
    const e = res.error;
    throw new IpcError(
      (e?.exit as (typeof EXIT)[keyof typeof EXIT]) ?? EXIT.RUNTIME,
      e?.kind ?? "internal",
      e?.message ?? "daemon rejected the command",
    );
  }
  return res;
}

/** Emit the daemon envelope verbatim for --json write commands (Spec 10 §3.2). */
function emitWriteJson(res: IpcResponse): void {
  out(JSON.stringify(res));
}

async function cmdNudge(ctx: Ctx, db: Database, p: ParsedArgs): Promise<number> {
  const ref = p.positional[1];
  const msg = p.positional[2] ?? flagStr(p, "msg");
  if (!ref) throw new IpcError(EXIT.USAGE, "usage", `usage: beckett nudge <task|worker> "<msg>"`);
  if (!msg || !msg.trim()) throw new IpcError(EXIT.USAGE, "usage", "nudge message is required");

  const refs = new Refs(db);
  const all = flagBool(p, "all");
  const workers = resolveTargetWorkers(db, refs, ref, { allowTask: true, all });
  const res = await ipcSend(ctx, "nudge", {
    workerIds: workers.map((w) => w.id),
    text: msg,
    source: "cli",
  });
  if (ctx.global.json) {
    emitWriteJson(res);
    return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
  }
  ensureOk(res);
  const receipts = (res.data as NudgeReceipt[] | undefined) ?? [];
  const wait = flagBool(p, "wait");
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i]!;
    let r = receipts[i];
    const disp = refs.workerDisplay(w.id);
    // --wait: poll the read path until the queue for this worker drains (Spec 10 §5.1).
    if (wait && r?.accepted === "queued") {
      r = (await waitForNudgeDrain(ctx, db, w.id)) ? { accepted: "delivered", at: Date.now() } : r;
    }
    if (r?.accepted === "delivered") {
      out(paint(ctx, C.green, `✓ nudge ${disp} (${w.harness}) delivered — lands next turn boundary`));
    } else {
      out(paint(ctx, C.yellow, `• nudge ${disp} (${w.harness}) queued — applies at next turn end (resume)`));
    }
  }
  return EXIT.OK;
}

/** Poll the read-only nudge queue until a worker has no queued nudges (or --timeout). */
async function waitForNudgeDrain(ctx: Ctx, db: Database, workerId: string): Promise<boolean> {
  const deadline = Date.now() + ctx.global.timeout;
  while (Date.now() < deadline) {
    if (queuedNudgeCount(db, workerId) === 0) return true;
    await Bun.sleep(250);
  }
  return queuedNudgeCount(db, workerId) === 0;
}

async function cmdPauseResume(ctx: Ctx, db: Database, p: ParsedArgs, cmd: "pause" | "resume"): Promise<number> {
  const ref = p.positional[1];
  if (!ref) throw new IpcError(EXIT.USAGE, "usage", `usage: beckett ${cmd} <worker>`);
  const refs = new Refs(db);
  const [worker] = resolveTargetWorkers(db, refs, ref, { allowTask: false, all: false });
  const res = await ipcSend(ctx, cmd, { workerId: worker!.id });
  if (ctx.global.json) {
    emitWriteJson(res);
    return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
  }
  ensureOk(res);
  const disp = refs.workerDisplay(worker!.id);
  const nodeDisp = refs.nodeDisplay(getNodeRow(db, worker!.node_id) ?? ({} as NodeRow));
  if (cmd === "pause") {
    const cp = res.data as Checkpoint | undefined;
    const files = cp?.diffStat.files ?? 0;
    const added = cp?.counters.diffLines.added ?? 0;
    const removed = cp?.counters.diffLines.removed ?? 0;
    out(
      paint(ctx, C.green, `✓ paused ${disp} (${nodeDisp})`) +
        ` — diff captured: ${files} files / +${added} -${removed} · resume with \`beckett resume ${disp}\``,
    );
  } else {
    const d = res.data as { state?: string; drained?: number } | undefined;
    out(paint(ctx, C.green, `✓ resumed ${disp} (${nodeDisp})`) + ` — back to ${d?.state ?? "running"} · ${d?.drained ?? 0} queued nudges drained`);
  }
  return EXIT.OK;
}

async function cmdAbort(ctx: Ctx, db: Database, p: ParsedArgs): Promise<number> {
  const ref = p.positional[1];
  if (!ref) throw new IpcError(EXIT.USAGE, "usage", `usage: beckett abort <task|worker>`);
  const refs = new Refs(db);
  const all = flagBool(p, "all");
  const workers = resolveTargetWorkers(db, refs, ref, { allowTask: true, all: true });
  const isTask = refs.resolve(ref).kind === "task";
  const reason = flagStr(p, "reason") ?? `aborted via CLI by ${ctx.userId}`;

  // Confirmation (destructive — Spec 10 §6).
  if (!ctx.global.yes) {
    if (!process.stdin.isTTY) {
      err("refusing to abort without confirmation; pass --yes");
      return EXIT.USER_ABORT;
    }
    const names = workers.map((w) => `${refs.workerDisplay(w.id)} (${w.harness})`).join(", ");
    err(paint(ctx, C.yellow, `⚠ Abort ${workers.length} worker(s): ${names}?`));
    err("  Partial work is preserved on each branch; nodes may re-dispatch (retry ≤3).");
    const ans = prompt("  Continue? [y/N]");
    if (!ans || !/^y(es)?$/i.test(ans.trim())) return EXIT.USER_ABORT;
  }

  const res = await ipcSend(ctx, "abort", { workerIds: workers.map((w) => w.id), reason });
  if (ctx.global.json) {
    emitWriteJson(res);
    return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
  }
  ensureOk(res);
  const states = (res.data as AbortState[] | undefined) ?? [];
  if (isTask && all && workers.length > 1) {
    const ids = workers.map((w) => refs.workerDisplay(w.id)).join(", ");
    out(paint(ctx, C.green, `✓ aborted task ${ref}`) + ` — ${workers.length} workers stopped (${ids}), diffs preserved, task marked aborted`);
  } else {
    workers.forEach((w, i) => {
      const a = states[i];
      out(
        paint(ctx, C.green, `✓ aborted ${refs.workerDisplay(w.id)}`) +
          ` — diff preserved on ${w.branch} · session saved · reason: "${a?.reason ?? reason}"`,
      );
    });
  }
  return EXIT.OK;
}

async function cmdAskPlan(ctx: Ctx, db: Database, p: ParsedArgs): Promise<number> {
  const ref = p.positional[1];
  if (!ref) throw new IpcError(EXIT.USAGE, "usage", `usage: beckett ask-plan <worker>`);
  const refs = new Refs(db);
  const [worker] = resolveTargetWorkers(db, refs, ref, { allowTask: false, all: false });
  const wait = flagBool(p, "wait");
  const res = await ipcSend(ctx, "ask_plan", { workerId: worker!.id, wait });
  if (ctx.global.json) {
    emitWriteJson(res);
    return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
  }
  ensureOk(res);
  const disp = refs.workerDisplay(worker!.id);
  const data = res.data as (NudgeReceipt & { plan?: string }) | undefined;
  if (data?.accepted === "delivered") {
    out(paint(ctx, C.green, `✓ asked ${disp} (${worker!.harness}) — plan request delivered`));
  } else {
    out(paint(ctx, C.yellow, `• asked ${disp} (${worker!.harness}) — queued for next turn end`));
  }
  if (wait && data?.plan) out(`  plan: ${data.plan}`);
  return EXIT.OK;
}

async function cmdReload(ctx: Ctx, p: ParsedArgs): Promise<number> {
  const res = await ipcSend(ctx, "reload", {});
  if (ctx.global.json) {
    emitWriteJson(res);
    return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
  }
  ensureOk(res);
  const d = res.data as { applied?: string[]; ignored?: string[] } | undefined;
  out(paint(ctx, C.green, "✓ reloaded config"));
  if (d?.applied?.length) out("  applied: " + d.applied.join(", "));
  if (d?.ignored?.length) out("  ignored (restart required): " + d.ignored.join(", "));
  return EXIT.OK;
}

// =======================================================================================
// daemon <start|stop|status>
// =======================================================================================

async function cmdDaemon(ctx: Ctx, p: ParsedArgs): Promise<number> {
  const sub = p.positional[1] ?? "start";
  if (sub === "start" || sub === undefined) {
    return daemonStart();
  }
  if (sub === "status") {
    return daemonStatus(ctx);
  }
  if (sub === "stop") {
    if (!ctx.global.yes) {
      if (!process.stdin.isTTY) {
        err("refusing to stop the daemon without confirmation; pass --yes");
        return EXIT.USER_ABORT;
      }
      err(paint(ctx, C.yellow, "⚠ Stop the daemon? Live workers will be detached (resume-safe). "));
      const ans = prompt("  Continue? [y/N]");
      if (!ans || !/^y(es)?$/i.test(ans.trim())) return EXIT.USER_ABORT;
    }
    const res = await ipcSend(ctx, "shutdown", {});
    if (ctx.global.json) {
      emitWriteJson(res);
      return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
    }
    ensureOk(res);
    const d = res.data as { checkpointed?: number } | undefined;
    out(paint(ctx, C.green, "✓ daemon stopped gracefully") + ` — ${d?.checkpointed ?? 0} workers checkpointed, socket unlinked`);
    return EXIT.OK;
  }
  throw new IpcError(EXIT.USAGE, "usage", `unknown daemon subcommand '${sub}' — start|stop|status`);
}

/** Foreground dev run: exec the daemon entrypoint with bun, inheriting stdio (Spec 10 §7.2). */
async function daemonStart(): Promise<number> {
  const daemonPath = new URL("../daemon.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, daemonPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  await proc.exited;
  return proc.exitCode ?? 0;
}

async function daemonStatus(ctx: Ctx): Promise<number> {
  let res: IpcResponse;
  try {
    res = await ipcSend(ctx, "status", {});
  } catch (e) {
    if (e instanceof IpcError && e.exit === EXIT.DAEMON_DOWN) {
      if (ctx.global.json) out(JSON.stringify({ ok: false, error: { code: EXIT.DAEMON_DOWN, kind: "daemon_down", message: "daemon: not running" } }));
      else out("daemon: not running");
      return EXIT.DAEMON_DOWN;
    }
    throw e;
  }
  if (ctx.global.json) {
    emitWriteJson(res);
    return res.ok ? EXIT.OK : (res.error?.exit ?? EXIT.RUNTIME);
  }
  ensureOk(res);
  const s = res.data as StatusReport;
  out(
    paint(ctx, C.green, "daemon: running") +
      ` · pid ${s.pid} · uptime ${humanizeAge(s.uptimeMs)} · bun ${s.bunVersion}`,
  );
  out(`  workers   ${s.liveWorkers} live (cap ${ctx.config.concurrency.max_workers})        queue   ${s.queuedNodes}`);
  const disc = s.discord.connected
    ? `connected (last event ${s.discord.lastEventAgeMs === null ? "—" : humanizeAge(s.discord.lastEventAgeMs)} ago)`
    : "disconnected";
  out(`  discord   ${disc}      tasks   ${s.activeTasks} active`);
  out(`  recovery  ${s.recovery.recovering ? "in progress" : "clean"} (re-attached ${s.recovery.resumedWorkers} workers)`);
  return EXIT.OK;
}

// =======================================================================================
// Read commands
// =======================================================================================

function daemonDownBanner(ctx: Ctx): void {
  if (ctx.global.quiet || ctx.global.json) return;
  if (!existsSync(ctx.paths.socket)) {
    err(dim(ctx, `daemon: not running — data is a snapshot as of ${new Date().toISOString()}`));
  }
}

function readPayload(ctx: Ctx, data: unknown): void {
  out(JSON.stringify({ ok: true, data, as_of: Date.now() }));
}

async function cmdPs(ctx: Ctx, db: Database | null, p: ParsedArgs): Promise<number> {
  const refs = db ? new Refs(db) : null;
  const taskRef = p.positional[1];
  const workersView = flagBool(p, "workers", "w");
  const includeAll = flagBool(p, "all", "a");
  const watch = flagBool(p, "watch", "W");
  const interval = flagInt(p, "interval", 2) * 1000;

  const render = (): { code: number } => {
    if (!db || !refs) {
      if (ctx.global.json) readPayload(ctx, { tasks: [], workers: [] });
      else if (!ctx.global.quiet) out(dim(ctx, "no database yet — nothing running"));
      return { code: EXIT.OK };
    }
    const tasks = (taskRef ? [refs.resolve(taskRef)].flatMap((r) => (r.kind === "task" ? [r.task] : [])) : allTasksByRank(db).filter((t) => !TASK_TERMINAL.has(t.state)));

    if (workersView) return renderWorkersView(ctx, db, refs, tasks, includeAll);
    return renderTreeView(ctx, db, refs, tasks, includeAll);
  };

  if (!watch) return render().code;
  return runWatchLoop(ctx, () => {
    process.stdout.write("\x1b[2J\x1b[H");
    render();
  }, interval);
}

function renderTreeView(ctx: Ctx, db: Database, refs: Refs, tasks: TaskRow[], includeAll: boolean): { code: number } {
  const jsonTasks: unknown[] = [];
  const rows: string[][] = [];
  let nNodes = 0, nWorkers = 0, running = 0, paused = 0;

  for (const t of tasks) {
    rows.push([refs.taskDisplay(t.id), stateColor(ctx, t.state.toLowerCase()), "", "", "", "", "", "", "", ""]);
    const nodes = nodesForTask(db, t.id);
    const jnodes: unknown[] = [];
    for (const n of nodes) {
      const w = lastWorkerForNode(db, n.id);
      const live = w && !WORKER_TERMINAL_STATES.includes(w.state);
      if (!includeAll && !live && n.state !== "READY" && n.state !== "BLOCKED") {
        // default view: show active nodes + their workers; skip terminal noise unless --all
      }
      nNodes++;
      if (w) {
        nWorkers++;
        if (w.state === "running") running++;
        if (w.state === "paused") paused++;
      }
      rows.push([
        "",
        "",
        `└─ ${refs.nodeDisplay(n)}`,
        w ? refs.workerDisplay(w.id) : "—",
        w ? `${w.harness}/${w.model}` : "—",
        w ? stateColor(ctx, w.state) : stateColor(ctx, n.state.toLowerCase()),
        w ? String(w.turns) : "—",
        w ? `+${w.diff_added} / ${w.diff_files}f` : "—",
        w ? humanizeAge(Date.now() - w.last_activity_ts) : "—",
        n.title,
      ]);
      jnodes.push({ node: refs.nodeDisplay(n), nodeId: n.id, state: n.state, title: n.title, worker: w ? { id: w.id, display: refs.workerDisplay(w.id), harness: w.harness, model: w.model, state: w.state, turns: w.turns } : null });
    }
    jsonTasks.push({ task: refs.taskDisplay(t.id), taskId: t.id, state: t.state, prompt: t.prompt, nodes: jnodes });
  }

  if (ctx.global.json) {
    readPayload(ctx, { tasks: jsonTasks });
    return { code: EXIT.OK };
  }
  if (tasks.length === 0) {
    if (!ctx.global.quiet) out(dim(ctx, "nothing running"));
    return { code: EXIT.OK };
  }
  out(renderTable(ctx, ["TASK", "STATE", "NODE", "WORKER", "HARNESS", "STATE", "TURNS", "DIFF", "ACT", "WHAT"], rows));
  if (!ctx.global.quiet) {
    out("");
    out(dim(ctx, `${tasks.length} tasks · ${nNodes} nodes · ${nWorkers} workers (${running} running, ${paused} paused) · cap ${ctx.config.concurrency.max_workers}`));
  }
  return { code: EXIT.OK };
}

function renderWorkersView(ctx: Ctx, db: Database, refs: Refs, tasks: TaskRow[], includeAll: boolean): { code: number } {
  const rows: string[][] = [];
  const json: unknown[] = [];
  for (const t of tasks) {
    for (const n of nodesForTask(db, t.id)) {
      const ws = includeAll ? workersForNode(db, n.id) : workersForNode(db, n.id).filter((w) => !WORKER_TERMINAL_STATES.includes(w.state));
      for (const w of ws) {
        const q = queuedNudgeCount(db, w.id);
        rows.push([
          refs.workerDisplay(w.id), refs.taskDisplay(t.id), refs.nodeDisplay(n),
          `${w.harness}/${w.model}`, stateColor(ctx, w.state), String(w.turns),
          String(w.tool_calls), `+${w.diff_added} / ${w.diff_files}f`,
          w.scope_violations > 0 ? paint(ctx, C.red, `${w.scope_violations} viol`) : "—",
          q > 0 ? `${q}q` : "0", humanizeAge(Date.now() - w.last_activity_ts),
        ]);
        json.push({ worker: refs.workerDisplay(w.id), workerId: w.id, task: refs.taskDisplay(t.id), node: refs.nodeDisplay(n), harness: w.harness, model: w.model, state: w.state, turns: w.turns, toolCalls: w.tool_calls, queuedNudges: q });
      }
    }
  }
  if (ctx.global.json) {
    readPayload(ctx, { workers: json });
    return { code: EXIT.OK };
  }
  if (rows.length === 0) {
    if (!ctx.global.quiet) out(dim(ctx, "no workers"));
    return { code: EXIT.OK };
  }
  out(renderTable(ctx, ["WORKER", "TASK", "NODE", "HARNESS", "STATE", "TURNS", "TOOLS", "DIFF", "SCOPE", "NUDGES", "ACT"], rows));
  return { code: EXIT.OK };
}

function cmdTasks(ctx: Ctx, db: Database | null, p: ParsedArgs): number {
  if (!db) {
    if (ctx.global.json) readPayload(ctx, { tasks: [] });
    else if (!ctx.global.quiet) out(dim(ctx, "no database yet"));
    return EXIT.OK;
  }
  const refs = new Refs(db);
  const includeAll = flagBool(p, "all", "a");
  const since = parseSince(flagStr(p, "since"), 7 * 86_400_000);
  const userFilter = flagStr(p, "user");
  const stateFilter = flagStr(p, "state");
  const limit = flagInt(p, "limit", 50);

  let tasks = allTasksByRank(db);
  if (!includeAll) tasks = tasks.filter((t) => !TASK_TERMINAL.has(t.state));
  else tasks = tasks.filter((t) => t.updated_at >= since);
  if (userFilter) tasks = tasks.filter((t) => t.user_id === userFilter);
  if (stateFilter) {
    const wanted = new Set(stateFilter.split(",").map((s) => s.trim().toUpperCase()));
    tasks = tasks.filter((t) => wanted.has(t.state.toUpperCase()));
  }
  tasks = tasks.slice(-limit);

  if (ctx.global.json) {
    readPayload(ctx, {
      tasks: tasks.map((t) => ({ task: refs.taskDisplay(t.id), taskId: t.id, state: t.state, prompt: t.prompt, userId: t.user_id, channelId: t.channel_id, createdAt: t.created_at, updatedAt: t.updated_at })),
    });
    return EXIT.OK;
  }
  const rows = tasks.map((t) => {
    const closed = TASK_TERMINAL.has(t.state);
    const nodeCount = nodesForTask(db, t.id).length;
    return [
      refs.taskDisplay(t.id), stateColor(ctx, t.state.toLowerCase()),
      humanizeAge(Date.now() - t.created_at) + " ago",
      closed ? humanizeAge(Date.now() - t.updated_at) + " ago" : "—",
      t.user_id, String(nodeCount), t.channel_id,
      t.prompt.length > 48 ? t.prompt.slice(0, 47) + "…" : t.prompt,
    ];
  });
  if (rows.length === 0) {
    if (!ctx.global.quiet) out(dim(ctx, "no tasks"));
    return EXIT.OK;
  }
  out(renderTable(ctx, ["TASK", "STATE", "OPENED", "CLOSED", "BY", "NODES", "CHANNEL", "SUMMARY"], rows));
  if (!ctx.global.quiet) {
    out("");
    const active = tasks.filter((t) => !TASK_TERMINAL.has(t.state)).length;
    out(dim(ctx, `${tasks.length} tasks (${active} active)`));
  }
  return EXIT.OK;
}

function cmdStatus(ctx: Ctx, db: Database | null, p: ParsedArgs): number {
  if (!db) {
    if (ctx.global.json) readPayload(ctx, { tasks: [] });
    else if (!ctx.global.quiet) out(dim(ctx, "no database yet"));
    return EXIT.OK;
  }
  const refs = new Refs(db);
  const taskRef = p.positional[1];

  if (!taskRef) {
    // Fleet overview — one line per active task.
    const tasks = allTasksByRank(db).filter((t) => !TASK_TERMINAL.has(t.state));
    if (ctx.global.json) {
      readPayload(ctx, { tasks: tasks.map((t) => ({ task: refs.taskDisplay(t.id), taskId: t.id, state: t.state, prompt: t.prompt })) });
      return EXIT.OK;
    }
    const rows = tasks.map((t) => [refs.taskDisplay(t.id), stateColor(ctx, t.state.toLowerCase()), humanizeAge(Date.now() - t.created_at) + " ago", t.prompt.length > 56 ? t.prompt.slice(0, 55) + "…" : t.prompt]);
    if (rows.length === 0) out(dim(ctx, "no active tasks"));
    else out(renderTable(ctx, ["TASK", "STATE", "OPENED", "SUMMARY"], rows));
    return EXIT.OK;
  }

  const r = refs.resolve(taskRef);
  if (r.kind !== "task") throw new IpcError(EXIT.USAGE, "usage", "status takes a task id");
  const t = r.task;
  const nodes = nodesForTask(db, t.id);
  const decisionsN = flagInt(p, "decisions", 5);

  if (ctx.global.json) {
    readPayload(ctx, {
      task: { task: refs.taskDisplay(t.id), taskId: t.id, state: t.state, prompt: t.prompt, userId: t.user_id, channelId: t.channel_id, createdAt: t.created_at },
      nodes: nodes.map((n) => {
        const w = lastWorkerForNode(db, n.id);
        return { node: refs.nodeDisplay(n), nodeId: n.id, title: n.title, state: n.state, attempts: n.attempts, worker: w ? { display: refs.workerDisplay(w.id), state: w.state, turns: w.turns } : null };
      }),
      escalations: openEscalationsForTask(db, t.id),
    });
    return EXIT.OK;
  }

  out(
    `${bold(ctx, "Task " + refs.taskDisplay(t.id))}  ·  state: ${stateColor(ctx, t.state.toLowerCase())}  ·  opened ${humanizeAge(Date.now() - t.created_at)} ago by ${t.user_id}  ·  ${t.channel_id}`,
  );
  out(`  "${t.prompt}"`);
  out("");
  out(bold(ctx, `DAG (${nodes.length} nodes)`));
  const nodeRows = nodes.map((n) => {
    const w = lastWorkerForNode(db, n.id);
    return [
      refs.nodeDisplay(n), n.title, w ? refs.workerDisplay(w.id) : "—",
      stateColor(ctx, n.state.toLowerCase()),
      `${n.attempts}/${ctx.config.retry.max_redispatch}`,
      w ? `${w.state} (${w.turns} turns)` : "—",
    ];
  });
  out(renderTable(ctx, ["NODE", "LABEL", "WORKER", "STATE", "RETRIES", "WORKER-STATE"], nodeRows));

  // Acceptance criteria for the first non-terminal node (or first node).
  const focus = nodes.find((n) => n.state !== "NODE_DONE" && n.state !== "NODE_FAILED") ?? nodes[0];
  if (focus) {
    const crit = criteriaForNode(db, focus.id);
    out("");
    out(bold(ctx, `Acceptance (${refs.nodeDisplay(focus)})`));
    if (crit) {
      let checks: string[] = [];
      let nls: string[] = [];
      try { checks = JSON.parse(crit.checks_json) as string[]; } catch { /* tolerate */ }
      try { nls = JSON.parse(crit.nl_criteria) as string[]; } catch { /* tolerate */ }
      for (const c of checks) out(`  · exec   ${c}`);
      for (const n of nls) out(`  · nl     "${n}"`);
      if (!checks.length && !nls.length) out(dim(ctx, "  (no criteria recorded)"));
    } else {
      out(dim(ctx, "  (no criteria recorded)"));
    }
  }

  // Recent supervise decisions from the event log (Spec 09 §3.3).
  const decisions = readEvents(ctx.paths.eventsDir, { taskId: t.id, types: ["supervise.decision"], limit: decisionsN });
  out("");
  out(bold(ctx, "Recent supervise decisions"));
  if (decisions.length === 0) out(dim(ctx, "  none"));
  for (const d of decisions) {
    const pl = d.payload as { action?: string; reason?: string };
    out(`  ${new Date(d.ts).toLocaleTimeString()}  ${pl.action ?? "decision"}  ${d.worker_id ? refs.workerDisplay(d.worker_id) : ""}  ${pl.reason ?? ""}`);
  }

  const esc = openEscalationsForTask(db, t.id);
  out("");
  out(esc.length ? bold(ctx, `Escalations: ${esc.length} open`) : "Escalations: none");
  for (const e of esc) out(`  ${e.origin}: ${e.reason}`);
  return EXIT.OK;
}

// =======================================================================================
// tail / logs (event-log readers)
// =======================================================================================

/** Pretty one-line render of an audit/worker event (Spec 10 §4.2/§4.5). */
function renderEventLine(ctx: Ctx, refs: Refs | null, rec: EventRecord, prefix?: string): string {
  const time = new Date(rec.ts).toLocaleTimeString();
  const pl = rec.payload as Record<string, unknown>;
  const wd = rec.worker_id && refs ? refs.workerDisplay(rec.worker_id) : (rec.worker_id ?? "");
  const detail = (() => {
    switch (rec.type) {
      case "worker.tool_call": return `◇ tool  ${String(pl.tool ?? "")}`;
      case "worker.turn_completed": return `▸ turn complete`;
      case "worker.file_change": return `✎ files  ${Array.isArray(pl.paths) ? (pl.paths as unknown[]).length : ""}`;
      case "worker.finished": return `■ finished ${String(pl.status ?? "")}`;
      case "nudge.delivered": return paint(ctx, C.cyan, `⚑ nudge delivered`);
      case "nudge.enqueued": return paint(ctx, C.cyan, `⚑ nudge queued (${String(pl.source ?? "")})`);
      case "supervise.decision": return `◆ ${String(pl.action ?? "decision")}  ${String(pl.reason ?? "")}`;
      case "supervise.smoke_alarm": return paint(ctx, C.yellow, `⚠ alarm ${String(pl.kind ?? "")}`);
      default: return dim(ctx, `· ${rec.type}`);
    }
  })();
  const head = prefix ? `${prefix} ` : "";
  return `${head}${dim(ctx, time)}  ${wd ? dim(ctx, wd) + "  " : ""}${detail}`;
}

async function cmdTail(ctx: Ctx, db: Database | null, p: ParsedArgs): Promise<number> {
  const ref = p.positional[1];
  if (!ref) throw new IpcError(EXIT.USAGE, "usage", "usage: beckett tail <task|worker>");
  if (!db) {
    if (!ctx.global.quiet) out(dim(ctx, "no database yet"));
    return EXIT.OK;
  }
  const refs = new Refs(db);
  const r = refs.resolve(ref);

  // Determine the worker id set to follow.
  let workerIds: string[];
  if (r.kind === "worker") workerIds = [r.worker.id];
  else if (r.kind === "node") {
    const w = liveWorkerForNode(db, r.node.id) ?? lastWorkerForNode(db, r.node.id);
    if (!w) throw new IpcError(EXIT.NOT_FOUND, "not_found", `node ${refs.nodeDisplay(r.node)} has no worker`);
    workerIds = [w.id];
  } else {
    workerIds = liveWorkersForTask(db, r.task.id).map((w) => w.id);
    if (workerIds.length === 0) workerIds = nodesForTask(db, r.task.id).flatMap((n) => { const w = lastWorkerForNode(db, n.id); return w ? [w.id] : []; });
  }

  const since = flagInt(p, "since", 20);
  const follow = !flagBool(p, "no-follow", "n");
  const raw = flagBool(p, "raw");
  const filter = flagStr(p, "filter");
  const filterKinds = filter ? new Set(filter.split(",").map((s) => s.trim())) : null;
  const multi = workerIds.length > 1;

  const wantKind = (rec: EventRecord): boolean => {
    if (!filterKinds) return true;
    const map: Record<string, string> = { "worker.tool_call": "tool", "worker.turn_completed": "turn", "worker.file_change": "plan", "worker.finished": "result", "error": "error" };
    const k = map[rec.type] ?? (rec.type.includes("text") ? "text" : rec.type);
    return filterKinds.has(k);
  };

  const collect = (): EventRecord[] => {
    const all: EventRecord[] = [];
    for (const wid of workerIds) all.push(...readEvents(ctx.paths.eventsDir, { workerId: wid }));
    all.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    return all.filter(wantKind);
  };

  const emit = (rec: EventRecord): void => {
    if (ctx.global.json) { out(JSON.stringify(rec)); return; }
    if (raw) { out(JSON.stringify(rec)); return; }
    const prefix = multi && refs ? `[${refs.workerDisplay(rec.worker_id ?? "")}]` : undefined;
    out(renderEventLine(ctx, refs, rec, prefix));
  };

  // Backfill the last N events.
  const backfill = collect();
  const seen = new Set<string>(backfill.map((r) => r.id));
  const head = backfill.slice(Math.max(0, backfill.length - since));
  for (const rec of head) emit(rec);

  if (!follow) return EXIT.OK;
  return runWatchLoop(ctx, () => {
    for (const rec of collect()) {
      if (!seen.has(rec.id)) { seen.add(rec.id); emit(rec); }
    }
  }, 1000);
}

function cmdLogs(ctx: Ctx, p: ParsedArgs): number | Promise<number> {
  const since = parseSince(flagStr(p, "since"), 15 * 60_000);
  const follow = flagBool(p, "follow", "f");
  const taskFilter = flagStr(p, "task");
  const workerFilter = flagStr(p, "worker");
  const kindFilter = flagStr(p, "kind");
  const limit = flagInt(p, "limit", 200);

  const db = openDb(ctx);
  const refs = db ? new Refs(db) : null;

  // Resolve display refs in filters → canonical ids.
  let taskId: string | undefined;
  let workerId: string | undefined;
  if (taskFilter && refs) { const r = refs.resolve(taskFilter); if (r.kind === "task") taskId = r.task.id; }
  if (workerFilter && refs) { const r = refs.resolve(workerFilter); if (r.kind === "worker") workerId = r.worker.id; }

  const kinds = kindFilter ? new Set(kindFilter.split(",").map((s) => s.trim())) : null;
  const matchKind = (rec: EventRecord): boolean => {
    if (!kinds) return true;
    const prefix = rec.type.split(".")[0]!;
    const aliases: Record<string, string> = { state: "task", dispatch: "worker", supervise_decision: "supervise", nudge: "nudge", abort: "worker", escalate: "escalation", error: "error", daemon: "daemon" };
    for (const k of kinds) {
      if (rec.type.startsWith(k)) return true;
      if (aliases[k] && rec.type.startsWith(aliases[k])) return true;
    }
    return false;
  };

  const q: EventQuery = { since, taskId, workerId };

  const emit = (rec: EventRecord): void => {
    if (ctx.global.json) { out(JSON.stringify(rec)); return; }
    const time = new Date(rec.ts).toLocaleTimeString();
    const wd = rec.worker_id && refs ? refs.workerDisplay(rec.worker_id) : (rec.worker_id ?? "");
    const pl = rec.payload as Record<string, unknown>;
    const summary = Object.entries(pl).slice(0, 4).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ");
    out(`${dim(ctx, time)}  ${rec.type.padEnd(26)}  ${wd ? wd + "  " : ""}${dim(ctx, summary)}`);
  };

  const initial = readEvents(ctx.paths.eventsDir, q).filter(matchKind);
  const seen = new Set<string>(initial.map((r) => r.id));
  for (const rec of initial.slice(Math.max(0, initial.length - limit))) emit(rec);

  if (!follow) return EXIT.OK;
  return runWatchLoop(ctx, () => {
    for (const rec of readEvents(ctx.paths.eventsDir, q).filter(matchKind)) {
      if (!seen.has(rec.id)) { seen.add(rec.id); emit(rec); }
    }
  }, 1000);
}

// =======================================================================================
// mem (markdown knowledge-graph browser, Spec 10 §4.6 — pure file read, no daemon)
// =======================================================================================

interface MemNote { path: string; name: string; kind: string; tags: string[]; body: string; mtime: number; frontmatter: Record<string, string>; }

function listMemFiles(memoryDir: string): string[] {
  return listMarkdownFiles(memoryDir, { recursive: true, excludeBasenames: ["MEMORY.md"] });
}

function parseMemNote(path: string): MemNote {
  const { frontmatter, body } = splitFrontmatter(readFileSync(path, "utf8"));
  const fm: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const eq = line.indexOf(":");
    if (eq > 0) fm[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const tags = (fm.tags ?? "").replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  return { path, name: basename(path, ".md"), kind: fm.kind ?? fm.type ?? "note", tags, body, mtime: statSync(path).mtimeMs, frontmatter: fm };
}

function cmdMem(ctx: Ctx, p: ParsedArgs): number {
  const sub = p.positional[1] ?? "list";
  const memoryDir = ctx.paths.memoryDir;
  const files = listMemFiles(memoryDir);
  const notes = files.map(parseMemNote);

  if (sub === "list") {
    const tagFilter = flagStr(p, "tag");
    const kindFilter = flagStr(p, "kind");
    let sel = notes;
    if (tagFilter) sel = sel.filter((n) => n.tags.includes(tagFilter));
    if (kindFilter) sel = sel.filter((n) => n.kind === kindFilter);
    if (ctx.global.json) { readPayload(ctx, { notes: sel.map((n) => ({ name: n.name, kind: n.kind, tags: n.tags, path: relative(memoryDir, n.path), mtime: n.mtime })) }); return EXIT.OK; }
    const rows = sel.map((n) => [n.name, n.kind, n.tags.join(","), `${(n.body.match(/\[\[[^\]]+\]\]/g) ?? []).length} links`, humanizeAge(Date.now() - n.mtime) + " ago"]);
    if (rows.length === 0) out(dim(ctx, "no memory notes"));
    else out(renderTable(ctx, ["NAME", "KIND", "TAGS", "LINKS", "UPDATED"], rows));
    return EXIT.OK;
  }

  if (sub === "search") {
    const query = (p.positional[2] ?? "").toLowerCase();
    if (!query) throw new IpcError(EXIT.USAGE, "usage", "usage: beckett mem search <query>");
    const limit = flagInt(p, "limit", 10);
    const hits = notes
      .map((n) => { const hay = (n.body + " " + JSON.stringify(n.frontmatter)).toLowerCase(); const count = hay.split(query).length - 1; return { n, count }; })
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    if (ctx.global.json) { readPayload(ctx, { query, hits: hits.map((h) => ({ name: h.n.name, kind: h.n.kind, score: h.count, path: relative(memoryDir, h.n.path) })) }); return EXIT.OK; }
    out(`${bold(ctx, "QUERY")} "${query}"  ·  ${hits.length} hits`);
    out("");
    for (const h of hits) {
      const idx = h.n.body.toLowerCase().indexOf(query);
      const snip = idx >= 0 ? h.n.body.slice(Math.max(0, idx - 20), idx + 40).replace(/\n/g, " ") : "";
      out(`${relative(memoryDir, h.n.path).padEnd(36)}  ${h.n.kind.padEnd(10)}  ${dim(ctx, "…" + snip + "…")}`);
    }
    return EXIT.OK;
  }

  if (sub === "show") {
    const nameArg = (p.positional[2] ?? "").replace(/^\[\[|\]\]$/g, "");
    if (!nameArg) throw new IpcError(EXIT.USAGE, "usage", "usage: beckett mem show <name>");
    const note = notes.find((n) => n.name === nameArg || relative(memoryDir, n.path) === nameArg || relative(memoryDir, n.path) === nameArg + ".md");
    if (!note) throw new IpcError(EXIT.NOT_FOUND, "not_found", `no memory note '${nameArg}'`);
    if (flagBool(p, "raw")) { out(readFileSync(note.path, "utf8")); return EXIT.OK; }
    if (ctx.global.json) { readPayload(ctx, { name: note.name, kind: note.kind, tags: note.tags, frontmatter: note.frontmatter, body: note.body }); return EXIT.OK; }
    out(bold(ctx, relative(memoryDir, note.path)));
    out(dim(ctx, `  kind: ${note.kind} · tags: [${note.tags.join(", ")}] · updated ${humanizeAge(Date.now() - note.mtime)} ago`));
    out("");
    out(note.body.trim());
    if (flagBool(p, "links")) {
      const outLinks = [...new Set((note.body.match(/\[\[([^\]]+)\]\]/g) ?? []).map((l) => l.replace(/[[\]]/g, "")))];
      const backlinks = notes.filter((n) => n.name !== note.name && n.body.includes(`[[${note.name}]]`)).map((n) => n.name);
      out("");
      out(`→ links: ${outLinks.join(", ") || "none"}      ← backlinks: ${backlinks.join(", ") || "none"}`);
    }
    return EXIT.OK;
  }

  throw new IpcError(EXIT.USAGE, "usage", `unknown mem subcommand '${sub}' — list|search|show`);
}

// =======================================================================================
// doctor (local + daemon checks, Spec 10 §4.7)
// =======================================================================================

async function cmdDoctor(ctx: Ctx, p: ParsedArgs): Promise<number> {
  type Check = { name: string; status: "OK" | "WARN" | "FAIL" | "SKIP"; detail: string };
  const checks: Check[] = [];

  // daemon up + health
  try {
    const res = await ipcSend(ctx, "status", {});
    if (res.ok) {
      const s = res.data as StatusReport;
      checks.push({ name: "daemon", status: "OK", detail: `up · pid ${s.pid} · uptime ${humanizeAge(s.uptimeMs)}` });
      checks.push({ name: "discord", status: s.discord.connected ? "OK" : "WARN", detail: s.discord.connected ? `connected · last event ${s.discord.lastEventAgeMs === null ? "—" : humanizeAge(s.discord.lastEventAgeMs)} ago` : "not connected" });
    } else {
      checks.push({ name: "daemon", status: "FAIL", detail: res.error?.message ?? "status rejected" });
    }
  } catch (e) {
    const down = e instanceof IpcError && e.exit === EXIT.DAEMON_DOWN;
    checks.push({ name: "daemon", status: down ? "WARN" : "FAIL", detail: down ? "not running" : String((e as Error).message) });
    checks.push({ name: "discord", status: "SKIP", detail: "daemon down" });
  }

  // claude auth
  checks.push(await checkBin(ctx.config.harness.claude.bin, ".claude", "claude auth"));
  // codex auth
  if (ctx.config.harness.codex.enabled) checks.push(await checkBin(ctx.config.harness.codex.bin, ".codex", "codex auth"));
  else checks.push({ name: "codex auth", status: "WARN", detail: "disabled in config (harness.codex.enabled = false) — v0 Claude-only" });

  // config valid
  try { loadConfig(); checks.push({ name: "config", status: "OK", detail: `${ctx.paths.configFile} valid` }); }
  catch (e) { checks.push({ name: "config", status: "FAIL", detail: String((e as Error).message).split("\n")[0]! }); }

  // db ok
  if (existsSync(ctx.paths.db)) {
    try {
      const db = openReadOnly(ctx.paths.db);
      const r = db.query<{ v: string }, []>("PRAGMA integrity_check").get();
      const wal = db.query<{ v: string }, []>("PRAGMA journal_mode").get();
      const ok = (r as { integrity_check?: string } | null)?.integrity_check === "ok" || (r?.v === "ok");
      checks.push({ name: "database", status: ok ? "OK" : "WARN", detail: `${basename(ctx.paths.db)} · ${(wal as { journal_mode?: string } | null)?.journal_mode ?? "?"} · integrity ${ok ? "ok" : "?"}` });
      db.close();
    } catch (e) { checks.push({ name: "database", status: "FAIL", detail: String((e as Error).message) }); }
  } else {
    checks.push({ name: "database", status: "WARN", detail: "no beckett.db yet (daemon not initialized)" });
  }

  // memory
  const memIndex = join(ctx.paths.memoryDir, "MEMORY.md");
  checks.push({ name: "memory", status: existsSync(memIndex) ? "OK" : "WARN", detail: existsSync(memIndex) ? `${listMemFiles(ctx.paths.memoryDir).length} notes` : "no MEMORY.md index" });

  if (flagBool(p, "fix")) err(dim(ctx, "--fix: not yet implemented (deferred to Spec 12)"));

  const anyFail = checks.some((c) => c.status === "FAIL");
  if (ctx.global.json) { readPayload(ctx, { checks }); return anyFail ? EXIT.RUNTIME : EXIT.OK; }

  for (const c of checks) {
    const mark = c.status === "OK" ? paint(ctx, C.green, "✓") : c.status === "WARN" ? paint(ctx, C.yellow, "⚠") : c.status === "SKIP" ? dim(ctx, "·") : paint(ctx, C.red, "✗");
    out(`  ${mark} ${c.name.padEnd(16)} ${c.detail}`);
  }
  out("");
  out(anyFail ? paint(ctx, C.red, "problems found.") : "no problems.");
  return anyFail ? EXIT.RUNTIME : EXIT.OK;
}

async function checkBin(bin: string, credDir: string, name: string): Promise<{ name: string; status: "OK" | "WARN" | "FAIL" | "SKIP"; detail: string }> {
  const onPath = await binOnPath(bin);
  const creds = existsSync(join(userInfo().homedir, credDir));
  if (onPath && creds) return { name, status: "OK", detail: `ok · ~/${credDir} present` };
  if (!onPath) return { name, status: "FAIL", detail: `${bin} not on PATH` };
  return { name, status: "WARN", detail: `~/${credDir} not found — run \`${bin}\` login` };
}

async function binOnPath(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch { return false; }
}

// =======================================================================================
// Watch/follow loop
// =======================================================================================

/** Poll `tick` every `intervalMs` until SIGINT (exit 0 cleanly, Spec 10 §3.4). */
async function runWatchLoop(ctx: Ctx, tick: () => void, intervalMs: number): Promise<number> {
  let stop = false;
  const onSig = () => { stop = true; };
  process.on("SIGINT", onSig);
  try {
    while (!stop) {
      await Bun.sleep(intervalMs);
      if (stop) break;
      tick();
    }
  } finally {
    process.off("SIGINT", onSig);
  }
  return EXIT.OK;
}

// =======================================================================================
// Help / version
// =======================================================================================

const HELP = `beckett — agentic coworker management CLI (Spec 10)

usage: beckett [global-flags] <command> [args]

read commands (no daemon needed):
  ps [task]                 live tasks/nodes/workers   (-w workers, -a all, -W watch)
  tail <task|worker>        stream a worker's recent events   (--since N, -n no-follow, --raw)
  status [task]             detailed task snapshot / fleet overview
  tasks                     task ledger   (-a all, --since, --state, --user)
  logs                      daemon audit stream   (-f follow, --task, --worker, --kind)
  mem <list|search|show>    browse the knowledge graph
  doctor                    health checks

write commands (unix socket; fail if daemon down):
  nudge <task|worker> "<msg>"   soft steer   (--all, --wait)
  pause <worker>                checkpoint + hold
  resume <worker>               unpause
  abort <task|worker>           hard-stop + capture   (--yes, --reason)
  ask-plan <worker>             probe current plan   (--wait)
  reload                        re-read config

daemon:
  daemon start [--foreground]   run the daemon (foreground dev run)
  daemon stop  [--yes]          graceful shutdown
  daemon status                 ping the daemon

global flags: --json --no-color --color -q/--quiet -y/--yes --socket <p> --db <p> --timeout <ms> -h -V`;

// =======================================================================================
// Dispatch
// =======================================================================================

async function dispatch(p: ParsedArgs): Promise<number> {
  if (flagBool(p, "version", "V")) {
    out(`beckett ${CLI_VERSION} · ipc proto ${PROTO}`);
    return EXIT.OK;
  }
  const command = p.positional[0];
  if (!command || flagBool(p, "help", "h")) {
    out(HELP);
    return command ? EXIT.OK : EXIT.USAGE;
  }

  const ctx = buildContext(p);

  switch (command) {
    case "help": {
      out(HELP);
      return EXIT.OK;
    }
    // ── read ──
    case "ps": { const db = openDb(ctx); daemonDownBanner(ctx); return cmdPs(ctx, db, p); }
    case "tail": { const db = openDb(ctx); return cmdTail(ctx, db, p); }
    case "status": { const db = openDb(ctx); daemonDownBanner(ctx); return cmdStatus(ctx, db, p); }
    case "tasks": { const db = openDb(ctx); return cmdTasks(ctx, db, p); }
    case "logs": return cmdLogs(ctx, p);
    case "mem": return cmdMem(ctx, p);
    case "doctor": return cmdDoctor(ctx, p);
    // ── write ──
    case "nudge": return withDb(ctx, (db) => cmdNudge(ctx, db, p));
    case "pause": return withDb(ctx, (db) => cmdPauseResume(ctx, db, p, "pause"));
    case "resume": return withDb(ctx, (db) => cmdPauseResume(ctx, db, p, "resume"));
    case "abort": return withDb(ctx, (db) => cmdAbort(ctx, db, p));
    case "ask-plan":
    case "ask_plan": return withDb(ctx, (db) => cmdAskPlan(ctx, db, p));
    case "reload": return cmdReload(ctx, p);
    // ── daemon ──
    case "daemon": return cmdDaemon(ctx, p);
    default:
      err(`unknown command '${command}' — run 'beckett help'`);
      return EXIT.USAGE;
  }
}

/** Write commands need the DB to resolve human ids → canonical ids before the socket hop. */
async function withDb<T>(ctx: Ctx, fn: (db: Database) => Promise<T>): Promise<T> {
  const db = openDb(ctx);
  if (!db) {
    // No DB means the daemon was never initialized. If the socket is also gone, the headline
    // failure for a write command is "daemon not running" (exit 3, Spec 10 §8.5).
    if (!existsSync(ctx.paths.socket)) {
      throw new IpcError(EXIT.DAEMON_DOWN, "daemon_down", "daemon not running — start it with 'beckett daemon start'");
    }
    throw new IpcError(EXIT.NOT_FOUND, "not_found", "no beckett.db — nothing to target (is the daemon initialized?)");
  }
  return fn(db);
}

// =======================================================================================
// Entry
// =======================================================================================

async function main(): Promise<void> {
  const p = parseArgs(process.argv.slice(2));
  try {
    const code = await dispatch(p);
    process.exit(code);
  } catch (e) {
    const json = flagBool(p, "json");
    if (e instanceof IpcError) {
      if (json) out(JSON.stringify({ ok: false, error: { code: e.exit, kind: e.kind, message: e.message } }));
      else err(e.message);
      process.exit(e.exit);
    }
    const msg = (e as Error)?.message ?? String(e);
    if (json) out(JSON.stringify({ ok: false, error: { code: EXIT.RUNTIME, kind: "internal", message: msg } }));
    else err(`beckett: ${msg}`);
    process.exit(EXIT.RUNTIME);
  }
}

void main();
