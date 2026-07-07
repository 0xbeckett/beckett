/**
 * Beckett — quick agents (`src/quick/index.ts`)
 * =======================================================================================
 * The NO-TICKET lane: short-lived specialist `claude -p` harnesses the Concierge
 * dispatches for errands that are too heavy to answer inline but too light for a Plane
 * ticket — a web errand, a small coding task, a repo brief. The Concierge runs
 * `beckett quick <agent> "<task>"` from its Bash tool; the CLI rides the control bus to the
 * daemon, which owns the child process.
 *
 * Return-path contract (sync with timeout detach):
 *   - The bus call blocks up to `quick.sync_wait_secs`. If the agent finishes in time, the
 *     result text returns as the CLI's stdout — same turn, no extra machinery.
 *   - Past the wait, the call returns `{ detached: true, runId }` and the run keeps going;
 *     when it finishes, `onDetachedResult` fires and the Concierge injects the result as an
 *     update turn (the same path ticket milestones use), which relays it to the channel.
 *   - `quick.hard_timeout_secs` is the backstop: the child is killed and the (detached or
 *     not) result says so. A quick agent can never become an orphaned grinder.
 *
 * Isolation: each run gets a scratch cwd `<beckettDir>/quick/<runId>/` — quick agents never
 * work in `~/beckett` or `~/Projects` (their prompts forbid it; the scratch cwd makes the
 * easy path the safe path). The `computer-use` agent additionally gets a Playwright MCP
 * server (`--mcp-config`) — the ONE exception to the Concierge session's MCP-free rule
 * (OPS-43), which is preserved: the MCP rides the ephemeral child, never the Concierge.
 *
 * Subscription-auth only: children get `childEnv()` (API-key overrides stripped), exactly
 * like the Concierge session and ticket workers.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";

// =======================================================================================
// Agent registry
// =======================================================================================

export interface QuickAgentDef {
  name: string;
  /** One-line menu entry — shown by `beckett quick list` and quoted in the Concierge skill. */
  description: string;
  /** System-prompt file beside this module (delivered via --append-system-prompt). */
  promptFile: string;
  /** Attach the Playwright MCP server to this agent's harness. */
  browser?: boolean;
}

/** The v1 roster. Adding an agent = one .md prompt + one entry here. */
export const QUICK_AGENTS: readonly QuickAgentDef[] = [
  {
    name: "computer-use",
    description:
      "drives a real browser (Playwright): look something up on a live site, fill a form, check a dashboard, sign up for a service",
    promptFile: "computer-use.md",
    browser: true,
  },
  {
    name: "quick-code",
    description:
      "small coding errands in a scratch dir: one-off scripts, file transforms, snippets, conversions — never project repos",
    promptFile: "quick-code.md",
  },
  {
    name: "repo-explorer",
    description:
      "shallow-clones a repo and returns a tight brief answering your question — so you never read a whole codebase yourself",
    promptFile: "repo-explorer.md",
  },
] as const;

export function findAgent(name: string): QuickAgentDef | undefined {
  return QUICK_AGENTS.find((a) => a.name === name);
}

// =======================================================================================
// Runs
// =======================================================================================

export type QuickRunState = "running" | "done" | "error" | "timeout";

export interface QuickRun {
  runId: string;
  agent: string;
  task: string;
  /** Discord channel the request came from — the detached result routes back here. */
  channelId: string | null;
  startedAt: number;
  finishedAt: number | null;
  state: QuickRunState;
  /** The agent's final text (its report), or the error/timeout note. */
  result: string | null;
  /** True once the sync wait elapsed and the caller was released. */
  detached: boolean;
}

/** What the bus call resolves with inside the sync window / at detach. */
export type QuickRunOutcome =
  | { done: true; state: Exclude<QuickRunState, "running">; result: string; runId: string }
  | { detached: true; runId: string };

export interface CreateQuickRunnerDeps {
  config: Config;
  logger: Logger;
  /** Fires when a run that outlived its sync wait finishes (or times out/errors). */
  onDetachedResult: (run: QuickRun) => void;
  /** Test seam: spawn override. Defaults to Bun.spawn of the configured claude bin. */
  spawn?: typeof Bun.spawn;
}

export interface QuickRunner {
  agents(): { name: string; description: string }[];
  run(agentName: string, task: string, channelId: string | null): Promise<QuickRunOutcome>;
  /** Live + recently finished runs, for `beckett status`. */
  stats(): { running: number; runs: Pick<QuickRun, "runId" | "agent" | "state" | "startedAt">[] };
  /** Best-effort kill of live children (daemon shutdown). */
  stopAll(): void;
}

const PROMPTS_DIR = join(import.meta.dir, "agents");

/** Playwright MCP config JSON for a run (written into the run's scratch dir). */
function browserMcpConfig(command: string[]): string {
  const [cmd, ...args] = command;
  return JSON.stringify({ mcpServers: { playwright: { command: cmd, args } } });
}

export function createQuickRunner(deps: CreateQuickRunnerDeps): QuickRunner {
  const { config, logger, onDetachedResult } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const quickDir = join(buildPaths(config).beckettDir, "quick");
  const live = new Map<string, { run: QuickRun; child: ReturnType<typeof Bun.spawn> }>();
  /** Ring of finished runs kept for status (bounded, in-memory only — runs are ephemeral). */
  const recent: QuickRun[] = [];

  function finish(run: QuickRun, state: Exclude<QuickRunState, "running">, result: string): void {
    if (run.state !== "running") return; // already settled (e.g. timeout raced normal exit)
    run.state = state;
    run.result = result;
    run.finishedAt = Date.now();
    live.delete(run.runId);
    recent.push(run);
    while (recent.length > 20) recent.shift();
    logger.info("quick run finished", {
      runId: run.runId,
      agent: run.agent,
      state,
      secs: Math.round((run.finishedAt - run.startedAt) / 1000),
      detached: run.detached,
    });
    if (run.detached) {
      try {
        onDetachedResult(run);
      } catch (err) {
        logger.error("quick detached-result delivery failed", { runId: run.runId, err: String(err) });
      }
    }
  }

  return {
    agents() {
      return QUICK_AGENTS.map((a) => ({ name: a.name, description: a.description }));
    },

    async run(agentName, task, channelId) {
      if (!config.quick.enabled) throw new Error("quick agents are disabled ([quick] enabled=false)");
      const agent = findAgent(agentName);
      if (!agent) {
        const names = QUICK_AGENTS.map((a) => a.name).join("|");
        throw new Error(`unknown quick agent "${agentName}" (use ${names})`);
      }
      if (!task.trim()) throw new Error("quick run needs a non-empty task");
      if (live.size >= config.quick.max_concurrent) {
        throw new Error(
          `quick lane is full (${live.size}/${config.quick.max_concurrent} running) — retry shortly or file a ticket`,
        );
      }

      const runId = randomUUID().slice(0, 8);
      const runDir = join(quickDir, runId);
      mkdirSync(runDir, { recursive: true });
      const systemPrompt = readFileSync(join(PROMPTS_DIR, agent.promptFile), "utf8");

      const args = [
        "-p",
        task,
        "--output-format",
        "text",
        "--permission-mode",
        config.harness.claude.permission_mode,
        "--model",
        config.quick.model,
        "--append-system-prompt",
        systemPrompt,
      ];
      if (config.quick.effort) args.push("--effort", config.quick.effort);
      if (agent.browser) {
        const mcpPath = join(runDir, "mcp.json");
        writeFileSync(mcpPath, browserMcpConfig(config.quick.browser_mcp_command));
        args.push("--mcp-config", mcpPath);
      }

      // Same PATH help the Concierge session gives its child: the daemon's PATH may lack the
      // user-level bin dirs `claude`/`beckett`/`npx` live in under systemd.
      const env = childEnv();
      const home = process.env.HOME ?? "";
      const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
      env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;

      const run: QuickRun = {
        runId,
        agent: agent.name,
        task,
        channelId,
        startedAt: Date.now(),
        finishedAt: null,
        state: "running",
        result: null,
        detached: false,
      };

      logger.info("quick run starting", { runId, agent: agent.name, channelId, cwd: runDir });
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = spawn({
          cmd: [config.harness.claude.bin, ...args],
          cwd: runDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
      } catch (err) {
        throw new Error(`quick spawn failed: ${(err as Error).message}`);
      }
      live.set(runId, { run, child });

      // Hard backstop: a quick agent past the cap is killed, and that IS its result.
      const hardTimer = setTimeout(() => {
        if (run.state !== "running") return;
        logger.warn("quick run hit hard timeout — killing", { runId, agent: agent.name });
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(run, "timeout", `timed out after ${config.quick.hard_timeout_secs}s and was killed — no result produced`);
      }, config.quick.hard_timeout_secs * 1000);

      // Settle path: collect stdout (the agent's final report under --output-format text),
      // then classify by exit code. stderr is kept for the error note only.
      const settled = (async () => {
        const [outText, errText, code] = await Promise.all([
          new Response(child.stdout as ReadableStream).text().catch(() => ""),
          new Response(child.stderr as ReadableStream).text().catch(() => ""),
          child.exited,
        ]);
        clearTimeout(hardTimer);
        if (run.state !== "running") return; // hard timeout won the race
        const report = outText.trim();
        if (code === 0 && report) finish(run, "done", report);
        else if (code === 0) finish(run, "error", "agent exited cleanly but produced no report");
        else finish(run, "error", `agent exited with code ${code}${errText.trim() ? ` — ${truncate(errText.trim(), 400)}` : ""}`);
      })();
      void settled.catch((err) => {
        clearTimeout(hardTimer);
        finish(run, "error", `run collapsed: ${String(err)}`);
      });

      // Sync window: resolve with the result if it lands in time, else release the caller.
      await Promise.race([settled, Bun.sleep(config.quick.sync_wait_secs * 1000)]);
      // Decide on RUN STATE, not on which promise won — if the run settled at all (even by a
      // photo-finish with the sleep), the caller gets the result and no detached path fires.
      // No await between this check and the detached flag, so finish() can't interleave.
      if (run.state !== "running") {
        return { done: true, state: run.state, result: run.result ?? "", runId };
      }
      run.detached = true;
      logger.info("quick run detached — result will arrive as an update turn", { runId });
      return { detached: true, runId };
    },

    stats() {
      const all = [...[...live.values()].map((l) => l.run), ...recent];
      return {
        running: live.size,
        runs: all.map((r) => ({ runId: r.runId, agent: r.agent, state: r.state, startedAt: r.startedAt })),
      };
    },

    stopAll() {
      for (const { run, child } of live.values()) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
        finish(run, "error", "daemon shut down before the run finished");
      }
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
