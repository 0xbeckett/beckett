/**
 * Beckett quick agents - the no-ticket lane.
 *
 * Browser work is deliberately different from the other one-shot errands: it detaches
 * immediately, leases the warm persistent browser, may park for a screenshot-backed human
 * answer, then resumes the same Claude session. The model sees one BetterWright code tool.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";
import type { BrowserRuntime } from "../browser/runtime.ts";

export interface QuickAgentDef {
  name: string;
  description: string;
  promptFile: string;
  browser?: boolean;
}

export const QUICK_AGENTS: readonly QuickAgentDef[] = [
  {
    name: "computer-use",
    description:
      "autonomously completes work in a persistent real browser, including signed-in sites, parallel tabs, and screenshot proof",
    promptFile: "computer-use.md",
    browser: true,
  },
  {
    name: "quick-code",
    description:
      "small coding errands in a scratch dir: one-off scripts, file transforms, snippets, conversions - never project repos",
    promptFile: "quick-code.md",
  },
  {
    name: "repo-explorer",
    description:
      "shallow-clones a repo and returns a tight brief answering your question - so you never read a whole codebase yourself",
    promptFile: "repo-explorer.md",
  },
] as const;

export function findAgent(name: string): QuickAgentDef | undefined {
  return QUICK_AGENTS.find((agent) => agent.name === name);
}

export type QuickRunState = "running" | "waiting" | "done" | "error" | "timeout";

export interface QuickRun {
  runId: string;
  agent: string;
  task: string;
  channelId: string | null;
  requesterId: string | null;
  startedAt: number;
  finishedAt: number | null;
  state: QuickRunState;
  result: string | null;
  detached: boolean;
  sessionId: string | null;
  proofFiles: string[];
  question: string | null;
  questionMessageId: string | null;
}

export interface QuickQuestion {
  text: string;
  screenshot: string;
}

export type QuickRunOutcome =
  | { done: true; state: Exclude<QuickRunState, "running" | "waiting">; result: string; runId: string; proofFiles: string[] }
  | { detached: true; runId: string };

export interface CreateQuickRunnerDeps {
  config: Config;
  logger: Logger;
  browser?: BrowserRuntime;
  onDetachedResult: (run: QuickRun) => void | Promise<void>;
  onQuestion?: (run: QuickRun, question: QuickQuestion) => Promise<string>;
  spawn?: typeof Bun.spawn;
}

export interface QuickRunner {
  agents(): { name: string; description: string }[];
  run(agentName: string, task: string, channelId: string | null, requesterId?: string | null): Promise<QuickRunOutcome>;
  resume(runId: string, answer: string): Promise<void>;
  stats(): { running: number; waiting: number; runs: Pick<QuickRun, "runId" | "agent" | "state" | "startedAt">[] };
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

interface BrowserAgentResult {
  status: "completed" | "needs_input" | "failed";
  summary: string;
  question: string | null;
  proofApplicable: boolean;
}

interface LiveRun {
  run: QuickRun;
  agent: QuickAgentDef;
  runDir: string;
  systemPrompt: string;
  child: ReturnType<typeof Bun.spawn> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  questionTimer: ReturnType<typeof setTimeout> | null;
  sensitiveInputs: string[];
}

const PROMPTS_DIR = join(import.meta.dir, "agents");
const BROWSER_MCP_PATH = join(import.meta.dir, "..", "browser", "mcp.ts");
const QUICK_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60_000;

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

export function createQuickRunner(deps: CreateQuickRunnerDeps): QuickRunner {
  const { config, logger, browser } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const quickDir = join(paths.beckettDir, "quick");
  mkdirSync(quickDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(quickDir)) {
    const path = join(quickDir, entry);
    try {
      if (Date.now() - lstatSync(path).mtimeMs > QUICK_ARTIFACT_RETENTION_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or unreadable old artifact should not block boot.
    }
  }
  const controlSocket = join(paths.beckettDir, "control.sock");
  const live = new Map<string, LiveRun>();
  const recent: QuickRun[] = [];

  function clearTimers(entry: LiveRun): void {
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    if (entry.questionTimer) clearTimeout(entry.questionTimer);
    entry.hardTimer = null;
    entry.questionTimer = null;
  }

  async function finalize(
    entry: LiveRun,
    state: "done" | "error" | "timeout",
    result: string,
    captureProof = false,
  ): Promise<void> {
    const { run } = entry;
    if (run.state !== "running" && run.state !== "waiting") return;
    run.state = state;
    run.result = entry.agent.browser ? redactKnownBrowserInputs(result, entry.sensitiveInputs) : result;
    run.finishedAt = Date.now();
    clearTimers(entry);
    entry.child = null;
    if (entry.agent.browser && browser?.hasLease(run.runId)) {
      try {
        run.proofFiles = await browser.release(run.runId, state === "done" && captureProof);
      } catch (error) {
        logger.warn("browser lease release failed", { runId: run.runId, error: String(error) });
      }
    }
    if (entry.agent.browser && state === "done" && captureProof && run.proofFiles.length === 0) {
      run.state = "error";
      run.result = `${run.result}\n\nThe page reported success, but Beckett could not capture completion proof. Treat the outcome as unverified.`;
    }
    live.delete(run.runId);
    recent.push(run);
    while (recent.length > 20) recent.shift();
    logger.info("quick run finished", {
      runId: run.runId,
      agent: run.agent,
      state: run.state,
      secs: Math.round((run.finishedAt - run.startedAt) / 1000),
      detached: run.detached,
      proofFiles: run.proofFiles.length,
    });
    if (run.detached) {
      // Delivery owns its own reconnect/outbox behavior. Never let Discord availability hold the
      // browser lease, quick-run cleanup, or daemon shutdown open indefinitely.
      void Promise.resolve(deps.onDetachedResult(run)).catch((error) =>
        logger.error("quick detached-result delivery failed", { runId: run.runId, error: String(error) }),
      );
    }
  }

  async function parkForQuestion(entry: LiveRun, result: BrowserAgentResult): Promise<void> {
    const { run } = entry;
    const question = redactKnownBrowserInputs(result.question?.trim() ?? "", entry.sensitiveInputs).trim();
    if (!question) {
      await finalize(entry, "error", "Browser agent requested input without saying what it needs.");
      return;
    }
    if (!run.channelId || !browser || !deps.onQuestion) {
      await finalize(entry, "error", `${result.summary}\nBlocked question: ${question}`);
      return;
    }
    try {
      const screenshot = await browser.capture(run.runId, "question");
      run.state = "waiting";
      run.question = question;
      run.detached = true;
      entry.questionTimer = setTimeout(() => {
        void finalize(
          entry,
          "timeout",
          `Timed out waiting ${config.quick.browser_question_wait_secs}s for an answer to: ${question}`,
        );
      }, config.quick.browser_question_wait_secs * 1000);
      const messageId = await deps.onQuestion(run, { text: question, screenshot });
      // Shutdown or the wait deadline may have finalized the run while Discord was posting.
      if (run.state !== "waiting" || !browser.hasLease(run.runId)) return;
      run.questionMessageId = messageId;
      logger.info("browser run waiting for user input", {
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
    const { run, agent, runDir, systemPrompt } = entry;
    run.state = "running";
    run.question = null;
    run.questionMessageId = null;
    const browserLeg = !!agent.browser;
    const args = [
      "-p",
      browserLeg
        ? resume
          ? "Continue the browser task using the user's answer supplied on stdin."
          : "Complete the browser task supplied on stdin."
        : input,
      "--output-format",
      browserLeg ? "json" : "text",
      "--permission-mode",
      config.harness.claude.permission_mode,
      "--model",
      config.quick.model,
    ];
    if (config.quick.effort) args.push("--effort", config.quick.effort);

    if (browserLeg) {
      args.push(
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
      );
      if (resume) args.push("--resume", run.sessionId!);
      else args.push("--session-id", run.sessionId!);
    } else {
      args.push("--append-system-prompt", systemPrompt);
    }

    logger.info("quick run leg starting", { runId: run.runId, agent: run.agent, resume, cwd: runDir });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = spawn({
        cmd: [config.harness.claude.bin, ...args],
        cwd: runDir,
        stdin: browserLeg ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: baseEnv(),
      });
      entry.child = child;
      if (browserLeg) {
        const inputSink = child.stdin;
        if (!inputSink || typeof inputSink === "number") throw new Error("browser agent stdin pipe was not created");
        inputSink.write(input);
        inputSink.end();
      }
    } catch (error) {
      return finalize(entry, "error", `quick spawn failed: ${(error as Error).message}`);
    }

    entry.hardTimer = setTimeout(() => {
      if (run.state !== "running" || entry.child !== child) return;
      logger.warn("quick run hit active-leg timeout - killing", { runId: run.runId, agent: run.agent });
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
          `Agent exited with code ${code}${stderr.trim() ? ` - ${truncate(stderr.trim(), 500)}` : ""}`,
        );
        return;
      }
      if (!browserLeg) {
        const report = stdout.trim();
        await finalize(entry, report ? "done" : "error", report || "Agent exited cleanly but produced no report.");
        return;
      }
      let parsed: BrowserAgentResult;
      try {
        parsed = parseBrowserResult(stdout);
      } catch (error) {
        await finalize(entry, "error", `Browser agent returned invalid structured output: ${(error as Error).message}`);
        return;
      }
      if (parsed.status === "needs_input") {
        await parkForQuestion(entry, parsed);
      } else if (parsed.status === "failed") {
        await finalize(entry, "error", parsed.summary);
      } else {
        await finalize(entry, "done", parsed.summary, parsed.proofApplicable);
      }
    })().catch((error) => finalize(entry, "error", `Run collapsed: ${String(error)}`));
  }

  return {
    agents() {
      return QUICK_AGENTS.map((agent) => ({ name: agent.name, description: agent.description }));
    },

    async run(agentName, task, channelId, requesterId = null) {
      if (!config.quick.enabled) throw new Error("quick agents are disabled ([quick] enabled=false)");
      const agent = findAgent(agentName);
      if (!agent) throw new Error(`unknown quick agent "${agentName}" (use ${QUICK_AGENTS.map((a) => a.name).join("|")})`);
      if (!task.trim()) throw new Error("quick run needs a non-empty task");
      if (live.size >= config.quick.max_concurrent) {
        throw new Error(`quick lane is full (${live.size}/${config.quick.max_concurrent} running) - retry shortly or file a ticket`);
      }
      if (agent.browser && !browser) throw new Error("computer-use unavailable - persistent browser runtime is not wired");
      if (agent.browser && [...live.values()].some((entry) => entry.agent.browser)) {
        throw new Error("computer-use is already working or waiting for an answer - retry after it finishes");
      }

      const runId = randomUUID();
      const runDir = join(quickDir, runId);
      const artifactsDir = join(runDir, "artifacts");
      const browserControlToken = agent.browser ? randomBytes(32).toString("base64url") : null;
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const systemPrompt = readFileSync(join(PROMPTS_DIR, agent.promptFile), "utf8");
      const run: QuickRun = {
        runId,
        agent: agent.name,
        task,
        channelId,
        requesterId,
        startedAt: Date.now(),
        finishedAt: null,
        state: "running",
        result: null,
        detached: !!agent.browser,
        sessionId: agent.browser ? randomUUID() : null,
        proofFiles: [],
        question: null,
        questionMessageId: null,
      };
      const entry: LiveRun = {
        run,
        agent,
        runDir,
        systemPrompt,
        child: null,
        hardTimer: null,
        questionTimer: null,
        sensitiveInputs: [],
      };

      if (agent.browser) {
        try {
          await browser!.acquire({ runId, channelId, artifactsDir, controlToken: browserControlToken! });
          writeFileSync(
            join(runDir, "mcp.json"),
            browserMcpConfig(
              runId,
              browserControlToken!,
              controlSocket,
              config.quick.browser_eval_timeout_ms,
              config.quick.browser_max_output_chars,
            ),
            { mode: 0o600 },
          );
        } catch (error) {
          if (browser!.hasLease(runId)) await browser!.release(runId, false).catch(() => undefined);
          throw error;
        }
      }
      live.set(runId, entry);
      const settled = spawnLeg(entry, task, false);

      // Browser work never parks the Concierge's turn. Questions and final proof route directly.
      if (agent.browser) return { detached: true, runId };

      await Promise.race([settled, Bun.sleep(config.quick.sync_wait_secs * 1000)]);
      if (run.state !== "running") {
        return {
          done: true,
          state: run.state as "done" | "error" | "timeout",
          result: run.result ?? "",
          runId,
          proofFiles: run.proofFiles,
        };
      }
      run.detached = true;
      logger.info("quick run detached - result will arrive as an update turn", { runId });
      return { detached: true, runId };
    },

    async resume(runId, answer) {
      const entry = live.get(runId);
      if (!entry || !entry.agent.browser || entry.run.state !== "waiting") {
        throw new Error(`browser run ${runId} is not waiting for an answer`);
      }
      if (!answer.trim()) throw new Error("browser answer cannot be empty");
      entry.sensitiveInputs.push(answer.trim());
      if (entry.questionTimer) clearTimeout(entry.questionTimer);
      entry.questionTimer = null;
      void spawnLeg(entry, answer, true);
    },

    stats() {
      const all = [...[...live.values()].map((entry) => entry.run), ...recent];
      return {
        running: [...live.values()].filter((entry) => entry.run.state === "running").length,
        waiting: [...live.values()].filter((entry) => entry.run.state === "waiting").length,
        runs: all.map((run) => ({ runId: run.runId, agent: run.agent, state: run.state, startedAt: run.startedAt })),
      };
    },

    async stopAll() {
      await Promise.all(
        [...live.values()].map(async (entry) => {
          try {
            entry.child?.kill("SIGTERM");
          } catch {
            // best effort
          }
          await finalize(entry, "error", "Daemon shut down before the run finished.");
        }),
      );
    },
  };
}

function parseBrowserResult(stdout: string): BrowserAgentResult {
  const envelope = JSON.parse(stdout.trim()) as {
    structured_output?: unknown;
    result?: string;
  };
  let value = envelope.structured_output;
  if (value === undefined && envelope.result) value = JSON.parse(envelope.result);
  if (!value || typeof value !== "object") throw new Error("missing structured_output");
  const result = value as Partial<BrowserAgentResult>;
  if (!(["completed", "needs_input", "failed"] as unknown[]).includes(result.status)) {
    throw new Error(`unknown status ${String(result.status)}`);
  }
  if (typeof result.summary !== "string" || !result.summary.trim()) throw new Error("missing summary");
  if (result.question !== null && typeof result.question !== "string") throw new Error("invalid question");
  if (typeof result.proofApplicable !== "boolean") throw new Error("missing proofApplicable");
  return result as BrowserAgentResult;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

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
