/**
 * Beckett — Generic agent invoke-lane (`src/agent/invoke.ts`)
 * =======================================================================================
 * The missing half of the live-agent registry (issue #55): a runner that takes ANY registered
 * {@link AgentDefinition} — prompt + seat (harness/model/effort) + skills/tools — and actually
 * INVOKES it. Nothing here is hardcoded to a particular agent; the runner reads the definition and
 * spawns the seat. Adding a new agent is `beckett agent add` (pure data) — this runner already
 * knows how to run it, no core edit and no redeploy.
 *
 * The design mirrors the quick lane ({@link ../quick/index.ts}): spawn a one-shot harness with the
 * agent's system prompt appended and its granted tools scoped, block for the text output, and hand
 * that back to the caller. Unlike quick it does NOT own delivery — the CALLER decides what to do
 * with the output. That seam is what lets the daily-shitpost routine drive the `social-media` agent
 * (which AUTHORS a post) and then hand the authored task to the privileged background browser lane,
 * so a headless routine can post to X without a Discord mention token.
 *
 * SEATS ARE REAL (#125). This lane used to REFUSE any agent whose seat wasn't claude — the schema
 * let you register `harness: "pi"` and the runner threw on it. It now spawns whatever the seat
 * names through the shared lane seam ({@link ../drivers/lane.ts}); an agent that names no harness
 * follows `[harness.lanes.agent]` (pi by default), which is also the lever for pinning the whole
 * lane back to claude without touching an agent definition.
 *
 * No secret ever flows through here — credential injection happens downstream in the browser lane,
 * keyed by an entry NAME the caller carries. This runner only turns a definition into a process.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import {
  buildLaneCommand,
  isLaneHarness,
  laneChildEnv,
  parseLaneOutput,
  resolveLaneSeat,
  warnLaneGaps,
  type LaneCommand,
} from "../drivers/lane.ts";
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
 * Build the harness command for an agent seat. The seat's `harness` wins when the definition names
 * one — an agent that says `pi` means it — and an agent that names none follows the lane default
 * (`[harness.lanes.agent]`). `codex` is the one seat this lane still can't spawn: `codex exec` has
 * neither `--append-system-prompt` nor a tool allowlist, so it cannot honor an agent definition at
 * all. That is a harness limitation stated where it applies, not a blanket "claude only" refusal.
 *
 * `tools` (when non-empty) NARROWS the harness's tool surface (`--allowedTools` / pi's `--tools`);
 * empty = harness defaults, the schema convention. Skills are globally available to the harness and
 * named by the agent's prompt, so granting a skill is documentation of intent plus (for skills the
 * harness gates) an allow entry — both flow through the same list.
 */
export function buildAgentCommand(config: Config, def: AgentDefinition, input: string): LaneCommand {
  const seatHarness = def.model.harness;
  if (seatHarness && !isLaneHarness(seatHarness)) {
    throw new Error(
      `agent ${def.id}: harness "${seatHarness}" cannot run in the live-agent lane — ` +
        `codex exec has no --append-system-prompt or tool allowlist, so it cannot honor an agent seat. ` +
        `Use claude or pi.`,
    );
  }
  const seat = resolveLaneSeat(config, "agent", {
    harness: seatHarness,
    model: def.model.model,
    effort: def.model.effort,
  });
  return buildLaneCommand(config, seat, {
    prompt: input,
    appendSystemPrompt: def.systemPrompt,
    output: "text",
    unattended: true,
    allowedTools: def.tools,
  });
}

export function createAgentRunner(deps: CreateAgentRunnerDeps): AgentRunner {
  const { config, logger } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const runsDir = join(paths.beckettDir, "agent-runs");
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });

  function baseEnv(opts: AgentRunOptions): Record<string, string | undefined> {
    const env = laneChildEnv();
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

      let command: LaneCommand;
      try {
        command = buildAgentCommand(config, def, input);
      } catch (err) {
        outcome.error = (err as Error).message;
        return outcome;
      }
      warnLaneGaps(logger, command, { runId, agent: def.id });

      logger.info("agent run starting", {
        runId,
        agent: def.id,
        harness: command.seat.harness,
        model: command.seat.model,
        provider: command.seat.provider || undefined,
        cwd: runDir,
      });
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = spawn({
          cmd: [command.bin, ...command.args],
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
      const parsed = parseLaneOutput(command.seat.harness, "text", stdout);
      // pi exits 0 even when its final turn died on a provider error, so a clean exit code is not
      // by itself evidence the agent ran.
      if (parsed.error) {
        outcome.state = "error";
        outcome.error = `agent failed: ${truncate(parsed.error, 500)}`;
        logger.warn("agent run failed", { runId, agent: def.id, error: parsed.error });
        return outcome;
      }
      const report = parsed.text;
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
