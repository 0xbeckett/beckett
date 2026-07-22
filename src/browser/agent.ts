/**
 * Beckett's dedicated background browser agent (issue #58).
 *
 * Browser / computer-use work never runs inline in an intake turn: the concierge dispatches a
 * self-contained task here and returns immediately. The agent drives the persistent BetterWright
 * browser through multi-leg `claude -p` sessions; when only a human can unblock it (a
 * verification code, a missing credential, a genuine disambiguation) it parks the session,
 * surfaces ONE question to the originating channel, and later resumes the same session with the
 * answer. Every terminal state — completion, failure, timeout, daemon death — reports back to
 * the concierge as an update turn, backed by a durable run ledger so a crash can never strand
 * the person in silence. Credentials come from the jingle keychain and are injected below the
 * model's transcript as a `secrets` object (see {@link BrowserAgent.evalSecrets}).
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";
import type { BrowserRuntime } from "./runtime.ts";
import type { KeychainEntrySecrets, KeychainReader } from "../secret/keychain-read.ts";

export type BrowserAgentState = "running" | "waiting" | "done" | "error" | "timeout" | "cancelled";

export interface BrowserAgentRun {
  runId: string;
  task: string;
  channelId: string;
  requesterId: string;
  /** Jingle entry backing this run's `secrets` object; the name only — values stay in memory. */
  credsEntry: string | null;
  startedAt: number;
  finishedAt: number | null;
  state: BrowserAgentState;
  result: string | null;
  sessionId: string;
  proofFiles: string[];
  question: string | null;
  questionMessageId: string | null;
  /** Outcome reached the concierge as an update turn; undelivered runs re-report after a restart. */
  outcomeDelivered: boolean;
}

export interface BrowserAgentQuestion {
  text: string;
  screenshot: string;
}

export interface CreateBrowserAgentDeps {
  config: Config;
  logger: Logger;
  browser: BrowserRuntime;
  keychain?: KeychainReader;
  /** Surface one blocking question to the origin channel; resolves to the Discord anchor id. */
  onQuestion: (run: BrowserAgentRun, question: BrowserAgentQuestion) => Promise<string>;
  /** Report a terminal run to the concierge (update turn). Throwing keeps the run undelivered. */
  onOutcome: (run: BrowserAgentRun) => void | Promise<void>;
  spawn?: typeof Bun.spawn;
}

export interface BrowserAgentStats {
  running: number;
  waiting: number;
  runs: (Pick<BrowserAgentRun, "runId" | "state" | "startedAt" | "finishedAt" | "credsEntry" | "question"> & {
    task: string;
  })[];
}

/** One redacted line of a run's activity journal (journal.jsonl in the run directory). */
export interface BrowserJournalEvent {
  ts: number;
  kind: "dispatched" | "leg" | "eval" | "steer" | "question" | "finished";
  [key: string]: unknown;
}

export interface BrowserEvalRecord {
  ok: boolean;
  ms: number;
  url?: string;
  title?: string;
  pages?: number;
  screenshots?: number;
  error?: string;
}

export interface BrowserRunInspection {
  run: Pick<BrowserAgentRun, "runId" | "state" | "task" | "channelId" | "startedAt" | "finishedAt" | "question" | "result" | "proofFiles">;
  journal: BrowserJournalEvent[];
  /** Fresh screenshot of the live page, when the run still holds the browser lease. */
  screenshot: string | null;
}

export interface BrowserAgent {
  run(
    task: string,
    opts: { channelId: string; requesterId: string; credsEntry?: string | null; context?: string | null },
  ): Promise<{ runId: string }>;
  resume(runId: string, answer: string): Promise<void>;
  /**
   * Mid-run guidance from the dispatcher. A running run gets the note appended to its next
   * browser tool result ("queued"); a run parked on a question is resumed with the note framed
   * as steering rather than an answer ("resumed").
   */
  steer(runId: string, note: string): Promise<"queued" | "resumed">;
  /** Cancel a live run: kill the active leg, release the browser, report state "cancelled". */
  stop(runId: string, reason?: string): Promise<void>;
  /** Pop queued steering notes for delivery in the current eval's tool result. */
  drainSteers(runId: string): string[];
  /** Journal one browser evaluation (called by the daemon's browser.eval boundary). */
  recordEval(runId: string, record: BrowserEvalRecord): void;
  /** A run's state, redacted journal tail, and (live) a fresh screenshot — for `browser watch`. */
  inspect(runId: string, opts?: { tail?: number; screenshot?: boolean }): Promise<BrowserRunInspection | null>;
  /**
   * Resolve the `secrets` values for one evaluation of a live run: the entry's static fields
   * plus a freshly minted `totp` code when the entry stores a seed. Returns null when the run
   * has no keychain entry. Values are for injection + redaction only — never log or persist.
   */
  evalSecrets(runId: string): Promise<Record<string, string> | null>;
  /** Report runs a dead daemon stranded; call once at boot, after the concierge can take turns. */
  recover(): Promise<void>;
  stats(): BrowserAgentStats;
  stopAll(): Promise<void>;
}

export const BROWSER_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "question", "proofApplicable"],
  properties: {
    status: { type: "string", enum: ["completed", "needs_input", "failed"] },
    summary: { type: "string", description: "Concise user-facing outcome or progress." },
    question: {
      type: ["string", "null"],
      description: "One blocking question when status is needs_input; otherwise null.",
    },
    proofApplicable: { type: "boolean", description: "Whether the result has a visible browser state worth proving." },
  },
} as const;

interface BrowserLegResult {
  status: "completed" | "needs_input" | "failed";
  summary: string;
  question: string | null;
  proofApplicable: boolean;
}

interface LiveRun {
  run: BrowserAgentRun;
  runDir: string;
  systemPrompt: string;
  child: ReturnType<typeof Bun.spawn> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  questionTimer: ReturnType<typeof setTimeout> | null;
  sensitiveInputs: string[];
  secrets: KeychainEntrySecrets | null;
  /** Dispatcher guidance waiting for the next browser eval to carry it into the transcript. */
  pendingSteers: string[];
}

const PROMPT_PATH = join(import.meta.dir, "agent.md");
const BROWSER_MCP_PATH = join(import.meta.dir, "mcp.ts");
const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const LEDGER_FINISHED_CAP = 50;
const OUTCOME_RETRY_MS = 30_000;

function browserMcpConfig(
  runId: string,
  controlToken: string,
  socket: string,
  timeoutMs: number,
  maxOutputChars: number,
): string {
  return JSON.stringify({
    mcpServers: {
      browser: {
        command: process.execPath,
        args: [BROWSER_MCP_PATH],
        env: {
          BECKETT_CONTROL_SOCKET: socket,
          BECKETT_BROWSER_RUN_ID: runId,
          BECKETT_BROWSER_CONTROL_TOKEN: controlToken,
          BECKETT_BROWSER_EVAL_TIMEOUT_MS: String(timeoutMs + 30_000),
          BECKETT_BROWSER_MAX_OUTPUT_CHARS: String(maxOutputChars),
        },
      },
    },
  });
}

/** Frame dispatch-time conversation background so it informs the run without competing with the task. */
export function contextPreamble(context: string): string {
  return (
    `Background from the requesting conversation (context to inform your choices — the task ` +
    `above is what you must actually do):\n${context}`
  );
}

/** The one line the first leg gets about its credentials: field NAMES only, never values. */
export function secretsPreamble(secrets: KeychainEntrySecrets): string {
  const fields = secrets.fields.filter((field) => field !== "totp").map((field) => `secrets.${field}`);
  if (secrets.hasTotp) fields.push("secrets.totp (a fresh one-time code each script)");
  return (
    `Credentials for this task are pre-loaded from the keychain entry "${secrets.entry}" as a ` +
    `read-only \`secrets\` object inside every betterwright_browser script: ${fields.join(", ")}. ` +
    `Use them directly in browser code; their values are injected outside your view — never ask ` +
    `for them, and never return, log, or screenshot them.`
  );
}

export function createBrowserAgent(deps: CreateBrowserAgentDeps): BrowserAgent {
  const { config, logger, browser, keychain } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const agentDir = join(paths.beckettDir, "browser-agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(agentDir)) {
    if (entry === "runs.json") continue;
    const path = join(agentDir, entry);
    try {
      if (Date.now() - lstatSync(path).mtimeMs > ARTIFACT_RETENTION_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or unreadable old artifact should not block boot.
    }
  }
  const controlSocket = join(paths.beckettDir, "control.sock");
  const ledgerPath = join(agentDir, "runs.json");
  const live = new Map<string, LiveRun>();
  const finished: BrowserAgentRun[] = [];
  /** Runs a dead daemon left live on disk; {@link recover} turns them into error outcomes. */
  const orphans: BrowserAgentRun[] = [];
  let outcomeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  loadLedger();

  function loadLedger(): void {
    try {
      if (!existsSync(ledgerPath)) return;
      const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (typeof value.runId !== "string" || typeof value.channelId !== "string" || typeof value.requesterId !== "string") continue;
        const run: BrowserAgentRun = {
          runId: value.runId,
          task: typeof value.task === "string" ? value.task : "",
          channelId: value.channelId,
          requesterId: value.requesterId,
          credsEntry: typeof value.credsEntry === "string" ? value.credsEntry : null,
          startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
          finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : null,
          state: (["running", "waiting", "done", "error", "timeout", "cancelled"] as const).includes(value.state as BrowserAgentState)
            ? (value.state as BrowserAgentState)
            : "error",
          result: typeof value.result === "string" ? value.result : null,
          sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
          proofFiles: Array.isArray(value.proofFiles)
            ? value.proofFiles.filter((path): path is string => typeof path === "string")
            : [],
          question: typeof value.question === "string" ? value.question : null,
          questionMessageId: typeof value.questionMessageId === "string" ? value.questionMessageId : null,
          outcomeDelivered: value.outcomeDelivered === true,
        };
        // A Claude session and browser lease do not survive the daemon, so a run that was live
        // when the process died is terminal now — it just has not told anyone yet.
        if (run.state === "running" || run.state === "waiting") orphans.push(run);
        else finished.push(run);
      }
    } catch (error) {
      logger.warn("browser agent ledger read failed", { error: String(error) });
    }
  }

  function persistLedger(): void {
    while (finished.length > LEDGER_FINISHED_CAP) {
      const evictable = finished.findIndex((run) => run.outcomeDelivered);
      finished.splice(evictable >= 0 ? evictable : 0, 1);
    }
    const records = [...[...live.values()].map((entry) => entry.run), ...finished];
    const temp = `${ledgerPath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, ledgerPath);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* absent */ }
      logger.warn("browser agent ledger write failed", { error: String(error) });
    }
  }

  function scheduleOutcomeRetry(): void {
    if (stopping || outcomeRetryTimer) return;
    outcomeRetryTimer = setTimeout(() => {
      outcomeRetryTimer = null;
      for (const run of finished) {
        if (!run.outcomeDelivered) void deliverOutcome(run);
      }
    }, OUTCOME_RETRY_MS);
  }

  async function deliverOutcome(run: BrowserAgentRun): Promise<void> {
    try {
      await deps.onOutcome(run);
      run.outcomeDelivered = true;
      persistLedger();
    } catch (error) {
      logger.warn("browser agent outcome delivery failed; will retry", {
        runId: run.runId,
        error: String(error),
      });
      scheduleOutcomeRetry();
    }
  }

  function clearTimers(entry: LiveRun): void {
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    if (entry.questionTimer) clearTimeout(entry.questionTimer);
    entry.hardTimer = null;
    entry.questionTimer = null;
  }

  /**
   * Append one redacted event to the run's activity journal. The journal is the observability
   * surface behind `beckett browser watch`: best-effort, never load-bearing for the run itself.
   */
  function journal(runId: string, sensitiveInputs: readonly string[], event: Omit<BrowserJournalEvent, "ts">): void {
    try {
      const line = redactKnownBrowserInputs(JSON.stringify({ ts: Date.now(), ...event }), sensitiveInputs);
      appendFileSync(join(agentDir, runId, "journal.jsonl"), line + "\n", { mode: 0o600 });
    } catch (error) {
      logger.warn("browser journal write failed", { runId, error: String(error) });
    }
  }

  function readJournal(runId: string, tail: number, sensitiveInputs: readonly string[]): BrowserJournalEvent[] {
    try {
      const lines = readFileSync(join(agentDir, runId, "journal.jsonl"), "utf8").trim().split("\n");
      return lines
        .slice(-Math.max(1, tail))
        .map((line) => {
          try {
            return JSON.parse(redactKnownBrowserInputs(line, sensitiveInputs)) as BrowserJournalEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is BrowserJournalEvent => event !== null);
    } catch {
      return [];
    }
  }

  async function finalize(entry: LiveRun, state: "done" | "error" | "timeout" | "cancelled", result: string, captureProof = false): Promise<void> {
    const { run } = entry;
    if (run.state !== "running" && run.state !== "waiting") return;
    run.state = state;
    run.result = redactKnownBrowserInputs(result, entry.sensitiveInputs);
    run.finishedAt = Date.now();
    clearTimers(entry);
    entry.child = null;
    entry.secrets = null;
    if (browser.hasLease(run.runId)) {
      try {
        run.proofFiles = await browser.release(run.runId, state === "done" && captureProof);
      } catch (error) {
        logger.warn("browser lease release failed", { runId: run.runId, error: String(error) });
      }
    }
    if (state === "done" && captureProof && run.proofFiles.length === 0) {
      run.state = "error";
      run.result = `${run.result}\n\nThe page reported success, but Beckett could not capture completion proof. Treat the outcome as unverified.`;
    }
    live.delete(run.runId);
    finished.push(run);
    persistLedger();
    journal(run.runId, entry.sensitiveInputs, { kind: "finished", state: run.state, result: run.result });
    logger.info("browser agent run finished", {
      runId: run.runId,
      state: run.state,
      secs: Math.round((run.finishedAt - run.startedAt) / 1000),
      proofFiles: run.proofFiles.length,
    });
    // Outcome delivery owns its own retry/ledger durability. Never let Discord or concierge
    // availability hold the browser lease, run cleanup, or daemon shutdown open.
    void deliverOutcome(run);
  }

  async function parkForQuestion(entry: LiveRun, result: BrowserLegResult): Promise<void> {
    const { run } = entry;
    const question = redactKnownBrowserInputs(result.question?.trim() ?? "", entry.sensitiveInputs).trim();
    if (!question) {
      await finalize(entry, "error", "The browser agent requested input without saying what it needs.");
      return;
    }
    try {
      const screenshot = await browser.capture(run.runId, "question");
      run.state = "waiting";
      run.question = question;
      entry.questionTimer = setTimeout(() => {
        void finalize(
          entry,
          "timeout",
          `Timed out waiting ${config.quick.browser_question_wait_secs}s for an answer to: ${question}`,
        );
      }, config.quick.browser_question_wait_secs * 1000);
      persistLedger();
      journal(run.runId, entry.sensitiveInputs, { kind: "question", text: question });
      const messageId = await deps.onQuestion(run, { text: question, screenshot });
      // Shutdown or the wait deadline may have finalized the run while Discord was posting.
      if (run.state !== "waiting" || !browser.hasLease(run.runId)) return;
      run.questionMessageId = messageId;
      persistLedger();
      logger.info("browser agent waiting for user input", {
        runId: run.runId,
        channelId: run.channelId,
        questionMessageId: run.questionMessageId,
      });
    } catch (error) {
      await finalize(entry, "error", `Could not ask the browser question: ${(error as Error).message}`);
    }
  }

  function baseEnv(): Record<string, string | undefined> {
    const env = childEnv();
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    return env;
  }

  function spawnLeg(entry: LiveRun, input: string, resume: boolean): Promise<void> {
    const { run, runDir, systemPrompt } = entry;
    run.state = "running";
    run.question = null;
    run.questionMessageId = null;
    persistLedger();
    journal(run.runId, entry.sensitiveInputs, { kind: "leg", resume });
    const args = [
      "-p",
      resume
        ? "Continue the browser task using the user's answer supplied on stdin."
        : "Complete the browser task supplied on stdin.",
      "--output-format",
      "json",
      "--permission-mode",
      config.harness.claude.permission_mode,
      "--model",
      config.quick.model,
      "--system-prompt",
      systemPrompt,
      "--json-schema",
      JSON.stringify(BROWSER_RESULT_SCHEMA),
      "--mcp-config",
      join(runDir, "mcp.json"),
      "--strict-mcp-config",
      "--no-chrome",
      "--tools",
      "mcp__browser__betterwright_browser",
    ];
    if (config.quick.effort) args.push("--effort", config.quick.effort);
    args.push(resume ? "--resume" : "--session-id", run.sessionId);

    logger.info("browser agent leg starting", { runId: run.runId, resume, cwd: runDir });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = spawn({
        cmd: [config.harness.claude.bin, ...args],
        cwd: runDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: baseEnv(),
      });
      entry.child = child;
      const inputSink = child.stdin;
      if (!inputSink || typeof inputSink === "number") throw new Error("browser agent stdin pipe was not created");
      inputSink.write(input);
      inputSink.end();
    } catch (error) {
      return finalize(entry, "error", `browser agent spawn failed: ${(error as Error).message}`);
    }

    entry.hardTimer = setTimeout(() => {
      if (run.state !== "running" || entry.child !== child) return;
      logger.warn("browser agent hit active-leg timeout - killing", { runId: run.runId });
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      void finalize(
        entry,
        "timeout",
        `Active browser work timed out after ${config.quick.hard_timeout_secs}s and was killed.`,
      );
    }, config.quick.hard_timeout_secs * 1000);

    return (async () => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text().catch(() => ""),
        new Response(child.stderr as ReadableStream).text().catch(() => ""),
        child.exited,
      ]);
      if (entry.child !== child || run.state !== "running") return;
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
      entry.hardTimer = null;
      entry.child = null;
      if (code !== 0) {
        await finalize(
          entry,
          "error",
          `The browser agent exited with code ${code}${stderr.trim() ? ` - ${truncate(stderr.trim(), 500)}` : ""}`,
        );
        return;
      }
      let parsed: BrowserLegResult;
      try {
        parsed = parseBrowserResult(stdout);
      } catch (error) {
        await finalize(entry, "error", `The browser agent returned invalid structured output: ${(error as Error).message}`);
        return;
      }
      if (parsed.status === "needs_input") {
        await parkForQuestion(entry, parsed);
      } else if (parsed.status === "failed") {
        await finalize(entry, "error", parsed.summary);
      } else {
        await finalize(entry, "done", parsed.summary, parsed.proofApplicable);
      }
    })().catch((error) => finalize(entry, "error", `Browser agent run collapsed: ${String(error)}`));
  }

  return {
    async run(task, opts) {
      if (stopping) throw new Error("the browser agent is shutting down");
      if (!task.trim()) throw new Error("the browser agent needs a non-empty task");
      if (!opts.channelId || !opts.requesterId) {
        throw new Error("browser tasks need an origin channel and an authenticated requester");
      }
      if (live.size > 0) {
        throw new Error("the browser agent is already working or waiting for an answer - retry after it finishes");
      }
      const credsEntry = opts.credsEntry?.trim() || null;
      let secrets: KeychainEntrySecrets | null = null;
      if (credsEntry) {
        if (!keychain) throw new Error("keychain credentials are unavailable - jingle reader is not wired");
        // Resolve before anything spawns so a bad entry fails the dispatch instantly instead of
        // surfacing minutes later from inside the run.
        secrets = await keychain.read(credsEntry);
      }

      const runId = randomUUID();
      const runDir = join(agentDir, runId);
      const artifactsDir = join(runDir, "artifacts");
      const controlToken = randomBytes(32).toString("base64url");
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const systemPrompt = readFileSync(PROMPT_PATH, "utf8");
      const run: BrowserAgentRun = {
        runId,
        task,
        channelId: opts.channelId,
        requesterId: opts.requesterId,
        credsEntry,
        startedAt: Date.now(),
        finishedAt: null,
        state: "running",
        result: null,
        sessionId: randomUUID(),
        proofFiles: [],
        question: null,
        questionMessageId: null,
        outcomeDelivered: false,
      };
      const entry: LiveRun = {
        run,
        runDir,
        systemPrompt,
        child: null,
        hardTimer: null,
        questionTimer: null,
        sensitiveInputs: secrets ? Object.values(secrets.values) : [],
        secrets,
        pendingSteers: [],
      };

      try {
        await browser.acquire({ runId, channelId: opts.channelId, artifactsDir, controlToken });
        writeFileSync(
          join(runDir, "mcp.json"),
          browserMcpConfig(
            runId,
            controlToken,
            controlSocket,
            config.quick.browser_eval_timeout_ms,
            config.quick.browser_max_output_chars,
          ),
          { mode: 0o600 },
        );
      } catch (error) {
        if (browser.hasLease(runId)) await browser.release(runId, false).catch(() => undefined);
        throw error;
      }
      live.set(runId, entry);
      const context = opts.context?.trim() || null;
      let input = task;
      if (context) input += `\n\n${contextPreamble(context)}`;
      if (secrets) input += `\n\n${secretsPreamble(secrets)}`;
      journal(runId, entry.sensitiveInputs, { kind: "dispatched", task, context: context !== null });
      void spawnLeg(entry, input, false);
      return { runId };
    },

    async resume(runId, answer) {
      const entry = live.get(runId);
      if (!entry || entry.run.state !== "waiting") {
        throw new Error(`browser run ${runId} is not waiting for an answer`);
      }
      if (!answer.trim()) throw new Error("browser answer cannot be empty");
      entry.sensitiveInputs.push(answer.trim());
      if (entry.questionTimer) clearTimeout(entry.questionTimer);
      entry.questionTimer = null;
      void spawnLeg(entry, answer, true);
    },

    async steer(runId, note) {
      const entry = live.get(runId);
      if (!entry) throw new Error(`browser run ${runId} is not live`);
      const trimmed = note.trim();
      if (!trimmed) throw new Error("a steering note cannot be empty");
      if (entry.run.state === "waiting") {
        // The run is parked on a question. Steering outranks waiting: resume the same session
        // with the note framed as guidance, and let the agent re-ask if it is still blocked.
        if (entry.questionTimer) clearTimeout(entry.questionTimer);
        entry.questionTimer = null;
        journal(runId, entry.sensitiveInputs, { kind: "steer", note: trimmed, delivery: "resumed" });
        void spawnLeg(
          entry,
          `STEERING from the dispatcher (not an answer to your question): ${trimmed}\n\n` +
            `Apply this guidance to the task. If it resolves what you were asking, continue; if you ` +
            `are still blocked on the same fact, finish with needs_input and ask again.`,
          true,
        );
        return "resumed";
      }
      entry.pendingSteers.push(trimmed);
      journal(runId, entry.sensitiveInputs, { kind: "steer", note: trimmed, delivery: "queued" });
      return "queued";
    },

    async stop(runId, reason) {
      const entry = live.get(runId);
      if (!entry) throw new Error(`browser run ${runId} is not live`);
      try {
        entry.child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      entry.child = null;
      await finalize(entry, "cancelled", reason?.trim() || "The run was stopped by the dispatcher before it finished.");
    },

    drainSteers(runId) {
      const entry = live.get(runId);
      if (!entry || entry.pendingSteers.length === 0) return [];
      const notes = entry.pendingSteers.splice(0);
      journal(runId, entry.sensitiveInputs, { kind: "steer", delivered: notes.length, delivery: "eval" });
      return notes;
    },

    recordEval(runId, record) {
      const entry = live.get(runId);
      if (!entry) return;
      journal(runId, entry.sensitiveInputs, { kind: "eval", ...record });
    },

    async inspect(runId, opts) {
      const entry = live.get(runId);
      const run = entry?.run ?? finished.find((candidate) => candidate.runId === runId);
      if (!run) return null;
      const sensitiveInputs = entry?.sensitiveInputs ?? [];
      let screenshot: string | null = null;
      // A fresh screenshot needs the lease; a parked or between-legs run can always serve one,
      // and a capture racing the agent's own eval just queues behind it in the worker.
      if (opts?.screenshot !== false && entry && browser.hasLease(runId)) {
        try {
          screenshot = await browser.capture(runId, "watch");
        } catch (error) {
          logger.warn("browser watch screenshot failed", { runId, error: String(error) });
        }
      }
      return {
        run: {
          runId: run.runId,
          state: run.state,
          task: run.task,
          channelId: run.channelId,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          question: run.question,
          result: run.result,
          proofFiles: run.proofFiles,
        },
        journal: readJournal(runId, opts?.tail ?? 20, sensitiveInputs),
        screenshot,
      };
    },

    async evalSecrets(runId) {
      const entry = live.get(runId);
      if (!entry?.secrets) return null;
      const values = { ...entry.secrets.values };
      if (entry.secrets.hasTotp && keychain) {
        const code = await keychain.totp(entry.secrets.entry);
        values.totp = code;
        // A minted code is as sensitive as a password until it expires; redact it from any
        // summary or question this run later surfaces.
        if (!entry.sensitiveInputs.includes(code)) entry.sensitiveInputs.push(code);
      }
      return values;
    },

    async recover() {
      for (const run of orphans.splice(0)) {
        run.state = "error";
        run.finishedAt = run.finishedAt ?? Date.now();
        run.result =
          run.result ??
          "The daemon restarted while this browser task was in flight; the session could not be recovered. Dispatch it again to retry.";
        run.outcomeDelivered = false;
        finished.push(run);
        logger.warn("browser agent recovered an orphaned run", { runId: run.runId, channelId: run.channelId });
      }
      persistLedger();
      for (const run of [...finished]) {
        if (!run.outcomeDelivered) await deliverOutcome(run);
      }
    },

    stats() {
      const all = [...[...live.values()].map((entry) => entry.run), ...finished];
      return {
        running: [...live.values()].filter((entry) => entry.run.state === "running").length,
        waiting: [...live.values()].filter((entry) => entry.run.state === "waiting").length,
        runs: all.map((run) => ({
          runId: run.runId,
          state: run.state,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          credsEntry: run.credsEntry,
          question: run.question,
          task: truncate(run.task, 140),
        })),
      };
    },

    async stopAll() {
      stopping = true;
      if (outcomeRetryTimer) clearTimeout(outcomeRetryTimer);
      outcomeRetryTimer = null;
      await Promise.all(
        [...live.values()].map(async (entry) => {
          try {
            entry.child?.kill("SIGTERM");
          } catch {
            // best effort
          }
          await finalize(entry, "error", "The daemon shut down before the browser task finished.");
        }),
      );
    },
  };
}

function parseBrowserResult(stdout: string): BrowserLegResult {
  const envelope = JSON.parse(stdout.trim()) as {
    structured_output?: unknown;
    result?: string;
  };
  let value = envelope.structured_output;
  if (value === undefined && envelope.result) value = JSON.parse(envelope.result);
  if (!value || typeof value !== "object") throw new Error("missing structured_output");
  const result = value as Partial<BrowserLegResult>;
  if (!(["completed", "needs_input", "failed"] as unknown[]).includes(result.status)) {
    throw new Error(`unknown status ${String(result.status)}`);
  }
  if (typeof result.summary !== "string" || !result.summary.trim()) throw new Error("missing summary");
  if (result.question !== null && typeof result.question !== "string") throw new Error("invalid question");
  if (typeof result.proofApplicable !== "boolean") throw new Error("missing proofApplicable");
  return result as BrowserLegResult;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

/**
 * Scrub every human-supplied answer (passwords, OTPs, recovery codes) and keychain value from a
 * model-facing or user-facing string. Exact inputs are always redacted; token extraction also
 * catches a secret quoted inside a longer sentence.
 */
export function redactKnownBrowserInputs(text: string, inputs: readonly string[]): string {
  const candidates = new Set<string>();
  const looksSensitive = (value: string): boolean => {
    if (/^\d{4,12}$/.test(value)) return true;
    if (value.length < 6) return false;
    const hasLetter = /[a-z]/i.test(value);
    const hasDigit = /\d/.test(value);
    const hasSymbol = /[^a-z0-9\s]/i.test(value);
    return value.length >= 12 || (hasLetter && hasDigit) || hasSymbol;
  };
  for (const input of inputs) {
    const trimmed = input.trim();
    if (trimmed) candidates.add(trimmed);
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) candidates.add(candidate);
    }
    for (const part of trimmed.split(/\s+/)) {
      const candidate = part.replace(/^[`'"([{]+|[`'"\])},.!?;:]+$/g, "");
      if (candidate.length >= 3) candidates.add(candidate);
    }
    for (const token of trimmed.match(/[a-z0-9][a-z0-9_!@#$%^&*()+={}\[\]:;,.?~/-]{3,}/gi) ?? []) {
      if (looksSensitive(token)) candidates.add(token);
    }
  }
  return [...candidates]
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, secret) => redacted.replace(new RegExp(escapeRegex(secret), "gi"), "[redacted]"), text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values too short to redact would mangle unrelated text; nothing the vault holds is this short. */
const MIN_REDACTABLE_SECRET_CHARS = 4;

/** Scrub known secret VALUES from a plain string (error messages, console lines). */
export function redactSecretText(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of [...values].filter((value) => value.length >= MIN_REDACTABLE_SECRET_CHARS).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(value).join("[redacted]");
    // Values also appear JSON-escaped inside stringified eval payloads.
    const encoded = JSON.stringify(value).slice(1, -1);
    if (encoded !== value) redacted = redacted.split(encoded).join("[redacted]");
  }
  return redacted;
}

/**
 * Scrub known secret values from a JSON-serializable payload (a browser eval result) before it
 * reaches the model transcript. The daemon injects `secrets` below the model's view; this is the
 * matching guarantee that an echoed value (console.log, page text, thrown error) never surfaces.
 */
export function redactSecretValues<T>(payload: T, values: readonly string[]): T {
  if (values.every((value) => value.length < MIN_REDACTABLE_SECRET_CHARS)) return payload;
  return JSON.parse(redactSecretText(JSON.stringify(payload), values)) as T;
}
