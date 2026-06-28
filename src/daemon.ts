/**
 * Beckett — the daemon entrypoint (`src/daemon.ts`)
 * =======================================================================================
 * The long-running process (Spec 01 §1/§5). It implements the §5.1 startup sequence exactly,
 * wires every module into a running whole, owns the live worker handles, and drives the
 * graceful §5.2 shutdown. It is the SOLE writer to SQLite + the JSONL audit log; the CLI reads
 * the DB directly and mutates only through the IPC socket this process binds.
 *
 * Startup (Spec 01 §5.1):
 *   1. load .env + config        (loadConfig — subscription-auth safe)
 *   2. open DB (WAL) + migrate   (Store.init)
 *   3. open audit + daemon.start
 *   4. bind IPC socket           (unlink stale; UnixIpcServer)
 *   5. RECOVERY HOOK             (Orchestrator.recover — re-drive non-terminal tasks)
 *   6. connect Discord gateway
 *   7. rehydrate scheduler       (recover() re-ticks the DAGs; check-ins re-arm per worker)
 *   8. daemon.ready
 *
 * Shutdown (Spec 01 §5.2, on SIGTERM/SIGINT): stop intake → checkpoint (session_ids already
 * persisted on change) → detach (leave JSONL resumable) → flush audit (daemon.stop) → close DB
 * + unlink socket → disconnect Discord → exit 0. A SIGKILL mid-turn is also recoverable because
 * session_id + node/task state are persisted on every change, not on exit.
 */

import { loadConfig } from "./config.ts";
import { buildPaths } from "./paths.ts";
import { log as rootLog, setLogLevel, addLogSink } from "./log.ts";
import { createStore } from "./persistence/store.ts";
import { createMemory } from "./memory/index.ts";
import { createBrain } from "./brain/index.ts";
import { createAgency } from "./agency/index.ts";
import { Tailer } from "./supervise/tailer.ts";
import { createWorkerManager, type DriverRegistry } from "./worker/manager.ts";
import { createDriver } from "./drivers/index.ts";
import { createDiscordGateway } from "./discord/gateway.ts";
import { createIpcServer, okResponse, errorResponse } from "./ipc/server.ts";
import { createOrchestrator, type BeckettOrchestrator } from "./state/orchestrator.ts";
import type {
  Config,
  Paths,
  Logger,
  Worker,
  WorkerEvent,
  IncomingMessage,
  IntakeEvent,
  IpcRequest,
  IpcResponse,
  NudgeReceipt,
  AbortState,
  StatusReport,
  QueuedNudge,
} from "./types.ts";

/** The assembled, running daemon. */
class BeckettDaemon {
  private readonly config: Config;
  private readonly paths: Paths;
  private readonly logger: Logger;
  private readonly startedAt = Date.now();

  private store!: ReturnType<typeof createStore>;
  private supervisor!: Tailer;
  private orchestrator!: BeckettOrchestrator;
  private workerManager!: ReturnType<typeof createWorkerManager>;
  private discord!: ReturnType<typeof createDiscordGateway>;
  private ipc!: ReturnType<typeof createIpcServer>;

  private shuttingDown = false;
  private resumedWorkers = 0;

  // Discord log mirror (live telemetry to a dedicated channel; DISCORD_LOG_CHANNEL_ID).
  private logMirrorTimer?: ReturnType<typeof setInterval>;
  private logMirrorBuf: string[] = [];
  private logMirrorFlushing = false;
  private stopLogSink?: () => void;

  constructor() {
    this.config = loadConfig();
    this.paths = buildPaths(this.config);
    this.logger = rootLog.child("daemon");
  }

  // ── startup (Spec 01 §5.1) ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // 1–2. config is loaded in the ctor; open the DB (WAL) + migrate to head.
    this.store = createStore(this.paths, this.config);
    this.store.init();

    // 3. open audit + daemon.start.
    this.store.appendEvent({ type: "daemon.start", payload: { pid: process.pid, bun: Bun.version } });
    this.logger.info("daemon starting", { pid: process.pid, beckettDir: this.paths.beckettDir });

    // Build the module graph (dependency-inverted; see Spec 16 module interfaces).
    const memory = createMemory({ memoryDir: this.paths.memoryDir, store: this.store, logger: this.logger });
    const brain = createBrain({ config: this.config, paths: this.paths, logger: this.logger });
    const agency = createAgency(this.config, this.paths, this.store);
    this.supervisor = new Tailer(this.store, this.config, this.logger.child("supervise"));

    const projectRoot = process.env.BECKETT_PROJECT ?? this.paths.projects;

    // The DriverRegistry the WorkerManager pulls drivers from. Each created driver's normalized
    // event stream is fanned out to (a) the read-only Supervisor tail and (b) the Orchestrator's
    // lifecycle hook. We refresh the worker's live spend from the driver at progress boundaries so
    // the Supervisor's diff-progress alarm reads ground truth (Spec 02 §7 / Spec 03 §1.4).
    const registry: DriverRegistry = {
      create: (_kind, worker: Worker) => {
        const driver = createDriver(worker.harness, this.config, this.logger);
        driver.onEvent((e: WorkerEvent) => {
          if (e.kind === "turn_completed" || e.kind === "file_change" || e.kind === "finished") {
            try {
              worker.spend = driver.getTelemetry();
            } catch {
              /* telemetry best-effort */
            }
          }
          try {
            this.supervisor.ingest(worker, e);
          } catch (err) {
            this.logger.debug("supervisor ingest threw", { error: String(err) });
          }
          try {
            this.orchestrator.onWorkerEvent(worker, e);
          } catch (err) {
            this.logger.debug("orchestrator onWorkerEvent threw", { error: String(err) });
          }
        });
        return driver;
      },
    };

    this.workerManager = createWorkerManager({
      store: this.store,
      config: this.config,
      paths: this.paths,
      drivers: registry,
      resolveRepoRoot: () => projectRoot,
      logger: this.logger,
    });

    this.discord = createDiscordGateway({ config: this.config, logger: this.logger });

    this.orchestrator = createOrchestrator({
      store: this.store,
      brain,
      workerManager: this.workerManager,
      supervisor: this.supervisor,
      discord: this.discord,
      agency,
      memory,
      config: this.config,
      paths: this.paths,
      repoRoot: () => projectRoot,
      commitAuthor: { name: agency.identity.name, email: agency.identity.github.noreplyEmail },
      logger: this.logger,
    });

    // Route the Supervisor's two "go look" triggers into the Orchestrator (Spec 03 §3/§4).
    this.supervisor.onAlarm((alarm, worker) => this.orchestrator.handleAlarm(alarm, worker));
    this.supervisor.onCheckInFired((checkIn, worker) => this.orchestrator.handleCheckIn(checkIn, worker));

    // 4. bind IPC (unlink stale socket inside start()).
    this.ipc = createIpcServer({ socketPath: this.paths.socket, logger: this.logger });
    await this.ipc.start((req) => this.handleIpc(req));

    // 5–7. RECOVERY HOOK → re-drive non-terminal tasks + re-tick their DAGs (Spec 04 §10).
    await this.orchestrator.recover();

    // 6. connect Discord (after recovery so re-driven tasks can post). Tolerate a missing token in
    //    dev/test: the daemon stays up; intake/IPC still work once a token is configured.
    try {
      await this.discord.start();
      this.discord.onMessage((m) => this.onDiscordMessage(m));
      this.startLogMirror();
    } catch (err) {
      this.logger.warn("discord gateway not connected (continuing headless)", {
        error: (err as Error).message,
      });
    }

    // 8. ready.
    this.store.appendEvent({ type: "daemon.ready", payload: { pid: process.pid } });
    this.logger.info("daemon ready", { socket: this.paths.socket });

    this.installSignalHandlers();
  }

  // ── Discord inbound routing (Spec 05 §2.2) ────────────────────────────────────────────

  private async onDiscordMessage(m: IncomingMessage): Promise<void> {
    if (this.shuttingDown || m.authorIsBot) return;
    try {
      // Awaiting-reply resolution takes precedence over a fresh mention (Spec 05 §4/§5).
      if (await this.orchestrator.handleReply(m)) return;
      if (m.mentionsBot) {
        const evt: IntakeEvent = {
          userId: m.userId,
          channelId: m.channelId,
          msgId: m.messageId,
          text: stripMention(m.content),
          ts: m.createdAt,
        };
        await this.orchestrator.submit(evt);
      }
    } catch (err) {
      this.logger.error("inbound message handling failed", { error: (err as Error).message });
    }
  }

  // ── IPC dispatch (Spec 10 §8.4) ───────────────────────────────────────────────────────

  private async handleIpc(req: IpcRequest): Promise<IpcResponse> {
    if (this.shuttingDown && req.cmd !== "status") {
      return errorResponse(req.request_id, "illegal_state", "daemon is shutting down", 5);
    }
    try {
      switch (req.cmd) {
        case "nudge": {
          const ids = asStringArray(req.args.workerIds, req.args.workerId);
          const text = String(req.args.text ?? "");
          const source = (req.args.source as QueuedNudge["source"]) ?? "cli";
          if (!text.trim()) return errorResponse(req.request_id, "usage", "nudge text required", 2);
          const receipts: NudgeReceipt[] = [];
          for (const id of ids) receipts.push(await this.orchestrator.nudge(id, text, req.user_id, source));
          return okResponse(req.request_id, receipts);
        }
        case "pause": {
          const id = String(req.args.workerId ?? "");
          return okResponse(req.request_id, await this.orchestrator.pause(id));
        }
        case "resume": {
          const id = String(req.args.workerId ?? "");
          await this.orchestrator.resumeWorker(id);
          return okResponse(req.request_id, { resumed: true });
        }
        case "abort": {
          const ids = asStringArray(req.args.workerIds, req.args.workerId);
          const reason = String(req.args.reason ?? "aborted via CLI");
          const states: AbortState[] = [];
          for (const id of ids) states.push(await this.orchestrator.abort(id, reason));
          return okResponse(req.request_id, states);
        }
        case "ask_plan": {
          const id = String(req.args.workerId ?? "");
          return okResponse(req.request_id, await this.orchestrator.askPlan(id, Boolean(req.args.wait)));
        }
        case "reload": {
          // Persona + memory hot-reload by mtime already; config is re-read on next boot. v0 ack.
          this.logger.info("reload requested (persona/memory are hot; config reloads on restart)");
          return okResponse(req.request_id, { reloaded: true });
        }
        case "status":
          return okResponse(req.request_id, this.buildStatus());
        case "shutdown": {
          this.logger.info("shutdown requested via IPC");
          setTimeout(() => void this.shutdown(0), 50);
          return okResponse(req.request_id, { stopping: true });
        }
        default:
          return errorResponse(req.request_id, "usage", `unknown command "${req.cmd}"`, 2);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const notFound = /no live worker|unknown worker/i.test(msg);
      return errorResponse(req.request_id, notFound ? "not_found" : "internal", msg, notFound ? 4 : 1);
    }
  }

  private buildStatus(): StatusReport {
    let queuedNodes = 0;
    for (const t of this.store.listActiveTasks()) {
      for (const n of this.store.listNodesForTask(t.id)) {
        if (n.state === "READY" || n.state === "BLOCKED") queuedNodes++;
      }
    }
    return {
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
      bunVersion: Bun.version,
      liveWorkers: this.workerManager.liveCount(),
      queuedNodes,
      activeTasks: this.store.listActiveTasks().length,
      discord: {
        connected: this.discord.isConnected(),
        lastEventAgeMs: this.discord.lastEventAgeMs(),
      },
      recovery: { recovering: false, resumedWorkers: this.resumedWorkers },
    };
  }

  // ── shutdown (Spec 01 §5.2) ───────────────────────────────────────────────────────────

  private installSignalHandlers(): void {
    const onSignal = (sig: string) => {
      this.logger.info("signal received", { sig });
      void this.shutdown(0);
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
  }

  /**
   * Mirror structured logs to a dedicated Discord channel (DISCORD_LOG_CHANNEL_ID) for live
   * debugging visibility, separate from task channels (sparseness still applies there). Logs are
   * batched into code-block chunks and flushed on a timer to stay within Discord rate limits.
   */
  private startLogMirror(): void {
    const channelId = process.env.DISCORD_LOG_CHANNEL_ID?.trim();
    if (!channelId) return;
    const MAX_BUF = 1000;
    this.stopLogSink = addLogSink((rec) => {
      if (rec.component === "daemon.logmirror") return; // never mirror the mirror's own plumbing
      const f: Record<string, unknown> = { ...rec };
      delete f.level;
      delete f.ts;
      delete f.component;
      delete f.msg;
      const extra = Object.keys(f).length ? " " + JSON.stringify(f) : "";
      const t = String(rec.ts).slice(11, 19);
      let line = `${t} ${rec.level.toUpperCase().padEnd(5)} ${rec.component}: ${rec.msg}${extra}`;
      if (line.length > 600) line = line.slice(0, 597) + "...";
      this.logMirrorBuf.push(line);
      if (this.logMirrorBuf.length > MAX_BUF) this.logMirrorBuf.splice(0, this.logMirrorBuf.length - MAX_BUF);
    });
    this.logMirrorTimer = setInterval(() => void this.flushLogMirror(channelId), 2500);
    this.logger.child("logmirror").info("log mirror active", { channelId });
  }

  private async flushLogMirror(channelId: string): Promise<void> {
    if (this.logMirrorFlushing || this.logMirrorBuf.length === 0 || !this.discord.isConnected()) return;
    this.logMirrorFlushing = true;
    try {
      for (let posted = 0; posted < 3 && this.logMirrorBuf.length > 0; posted++) {
        let chunk = "";
        while (this.logMirrorBuf.length > 0 && chunk.length + this.logMirrorBuf[0]!.length + 1 < 1850) {
          chunk += this.logMirrorBuf.shift()! + "\n";
        }
        if (!chunk) chunk = this.logMirrorBuf.shift()!.slice(0, 1850) + "\n";
        await this.discord.post(channelId, "```\n" + chunk + "```");
      }
    } catch {
      /* drop this batch on error — mirroring must never crash the loop */
    } finally {
      this.logMirrorFlushing = false;
    }
  }

  async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true; // 1. stop intake / new IPC dispatch
    this.logger.info("graceful shutdown starting");

    // Stop the log mirror first so teardown logs aren't posted after Discord closes.
    if (this.logMirrorTimer) clearInterval(this.logMirrorTimer);
    if (this.stopLogSink) this.stopLogSink();

    // 2–3. Checkpoint: session_ids + node/worker state are already persisted on change. Stop the
    //      supervisor's timers so they don't fire during teardown (Spec 03). 4. Detach: leave each
    //      worker's on-disk JSONL intact and resumable — we do NOT kill them here; the OS reaps the
    //      child group on exit and recovery re-drives from the persisted session (Spec 01 §5.2).
    try {
      this.supervisor.stop();
    } catch {
      /* best-effort */
    }

    // 6. disconnect Discord.
    try {
      await this.discord.stop();
    } catch {
      /* best-effort */
    }

    // 5. flush audit, close DB, unlink socket.
    try {
      this.store.appendEvent({ type: "daemon.stop", payload: { pid: process.pid } });
    } catch {
      /* best-effort */
    }
    try {
      await this.ipc.stop();
    } catch {
      /* best-effort */
    }
    try {
      this.store.close();
    } catch {
      /* best-effort */
    }

    this.logger.info("graceful shutdown complete");
    process.exit(code);
  }
}

/** Strip a leading Discord mention (`<@123>` / `<@!123>`) so the brief is clean (Spec 05 §2.1). */
export function stripMention(content: string): string {
  return content.replace(/^\s*<@!?\d+>\s*/, "").trim();
}

/** Coerce IPC worker-id args (single or array form, per the CLI) into a string list. */
function asStringArray(arr: unknown, single: unknown): string[] {
  if (Array.isArray(arr)) return arr.map((x) => String(x)).filter(Boolean);
  if (typeof single === "string" && single) return [single];
  return [];
}

/** Boot the daemon (the systemd `ExecStart` / `beckett daemon start` entrypoint, Spec 01 §5.3). */
export async function main(): Promise<void> {
  const config = loadConfig();
  buildPaths(config); // resolve once to validate paths early
  const levelEnv = process.env.BECKETT_LOG_LEVEL;
  if (levelEnv === "debug" || levelEnv === "info" || levelEnv === "warn" || levelEnv === "error") {
    setLogLevel(levelEnv);
  }
  const daemon = new BeckettDaemon();
  try {
    await daemon.start();
  } catch (err) {
    rootLog.error("daemon failed to start", { error: (err as Error).message });
    process.exit(1);
  }
}

export { BeckettDaemon };

if (import.meta.main) {
  void main();
}
