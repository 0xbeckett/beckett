/**
 * Beckett — Generic agent invoke-lane (`src/agent/invoke.ts`)
 * =======================================================================================
 * The missing half of the live-agent registry (issue #55): a runner that takes ANY registered
 * {@link AgentDefinition} — prompt + seat (harness/model/effort) + skills/tools — and actually
 * INVOKES it. Nothing here is hardcoded to a particular agent; the runner reads the definition and
 * spawns the seat. Adding a new agent is `beckett agent add` (pure data) — this runner already
 * knows how to run it, no core edit and no redeploy.
 *
 * The design mirrors the quick lane ({@link ../quick/index.ts}): spawn `claude -p` with the agent's
 * system prompt appended and its granted tools scoped, block for the text output, and hand that back
 * to the caller. Unlike quick it does NOT own delivery — the CALLER decides what to do with the
 * output. That seam is what lets the daily-shitpost routine drive the `social-media` agent (which
 * AUTHORS a post) and then hand the authored task to the Concierge to run with its own browser, so a
 * headless routine can post to X without a Discord mention token.
 *
 * No secret ever flows through here — credential injection happens downstream in the browser lane,
 * keyed by an entry NAME the caller carries. This runner only turns a definition into a process.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";
import type { AgentDefinition } from "./types.ts";

/** Default hard cap — authoring/short work is fast; a runaway harness must never wedge a caller. */
export const AGENT_RUN_TIMEOUT_SECS = 240;

export type AgentRunState = "done" | "error" | "timeout";

export interface AgentRunOutcome {
  runId: string;
  agentId: string;
  state: AgentRunState;
  /** The agent's stdout report (trimmed). Empty on error/timeout. */
  output: string;
  /** Populated on a non-`done` state so the caller can log/surface why. */
  error?: string;
}

export interface AgentRunOptions {
  /** Origin channel the invocation is attributed to (exposed to the agent via env). */
  channelId?: string | null;
  /** Authenticated requester the invocation is attributed to (exposed via env). */
  requesterId?: string | null;
  /** Override the hard timeout (seconds). */
  timeoutSecs?: number;
}

export interface CreateAgentRunnerDeps {
  config: Config;
  logger: Logger;
  /** Injectable for tests. */
  spawn?: typeof Bun.spawn;
}

export interface AgentRunner {
  /** Run `def` on `input` and resolve with its output. Never throws for a normal agent failure. */
  run(def: AgentDefinition, input: string, opts?: AgentRunOptions): Promise<AgentRunOutcome>;
}

/**
 * Build the harness argv for an agent seat. Only `claude` can be spawned in this lane today (the
 * backbone harness); `codex`/`pi` are valid seats in the schema but not yet spawnable here — the
 * throw is the clean seam where that support slots in without any caller change.
 *
 * `tools` (when non-empty) NARROWS the harness's tool surface via `--allowedTools`; empty = harness
 * defaults, the schema convention. Skills are globally available to the harness and named by the
 * agent's prompt, so granting a skill is documentation of intent plus (for skills the harness gates)
 * an allow entry — both flow through the same list.
 */
export function buildAgentArgs(
  config: Config,
  def: AgentDefinition,
  input: string,
): { bin: string; args: string[] } {
  if (def.model.harness !== "claude") {
    throw new Error(
      `agent ${def.id}: harness "${def.model.harness}" is not spawnable in the live-agent lane yet (only claude)`,
    );
  }
  const args = [
    "-p",
    input,
    "--output-format",
    "text",
    "--permission-mode",
    config.harness.claude.permission_mode,
    "--model",
    def.model.model || config.harness.claude.default_model,
    "--append-system-prompt",
    def.systemPrompt,
  ];
  if (def.model.effort) args.push("--effort", def.model.effort);
  if (def.tools.length > 0) args.push("--allowedTools", def.tools.join(","));
  return { bin: config.harness.claude.bin, args };
}

export function createAgentRunner(deps: CreateAgentRunnerDeps): AgentRunner {
  const { config, logger } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const runsDir = join(paths.beckettDir, "agent-runs");
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });

  function baseEnv(opts: AgentRunOptions): Record<string, string | undefined> {
    const env = childEnv();
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    // Expose the origin so an agent that wants to route a confirmation back knows where to.
    if (opts.channelId) env.BECKETT_ORIGIN_CHANNEL_ID = opts.channelId;
    if (opts.requesterId) env.BECKETT_ORIGIN_REQUESTER_ID = opts.requesterId;
    return env;
  }

  return {
    async run(def, input, opts = {}) {
      const runId = randomUUID();
      const outcome: AgentRunOutcome = { runId, agentId: def.id, state: "error", output: "" };
      if (!input.trim()) {
        outcome.error = "agent run needs a non-empty input";
        return outcome;
      }

      const runDir = join(runsDir, runId);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });

      let bin: string;
      let args: string[];
      try {
        ({ bin, args } = buildAgentArgs(config, def, input));
      } catch (err) {
        outcome.error = (err as Error).message;
        return outcome;
      }

      logger.info("agent run starting", { runId, agent: def.id, model: def.model.model, cwd: runDir });
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = spawn({
          cmd: [bin, ...args],
          cwd: runDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: baseEnv(opts),
        });
      } catch (err) {
        outcome.error = `agent spawn failed: ${(err as Error).message}`;
        return outcome;
      }

      const timeoutSecs = opts.timeoutSecs ?? AGENT_RUN_TIMEOUT_SECS;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, timeoutSecs * 1000);

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text().catch(() => ""),
        new Response(child.stderr as ReadableStream).text().catch(() => ""),
        child.exited,
      ]);
      clearTimeout(timer);

      if (timedOut) {
        outcome.state = "timeout";
        outcome.error = `agent run timed out after ${timeoutSecs}s and was killed`;
        logger.warn("agent run timed out", { runId, agent: def.id, timeoutSecs });
        return outcome;
      }
      if (code !== 0) {
        outcome.state = "error";
        outcome.error = `agent exited with code ${code}${stderr.trim() ? ` — ${truncate(stderr.trim(), 500)}` : ""}`;
        logger.warn("agent run failed", { runId, agent: def.id, code });
        return outcome;
      }
      const report = stdout.trim();
      if (!report) {
        outcome.state = "error";
        outcome.error = "agent exited cleanly but produced no output";
        return outcome;
      }
      outcome.state = "done";
      outcome.output = report;
      logger.info("agent run finished", { runId, agent: def.id, chars: report.length });
      return outcome;
    },
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
