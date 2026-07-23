/**
 * Beckett — Memory-agent recall (`src/memory/agent-recall.ts`)
 * =======================================================================================
 * Issue #26: the in-house memory agent that replaces pure score-ranked recall with agentic
 * note-passing. The shape (design agreed in-channel):
 *
 *   1. moss/grep pulls the top ~15 candidate notes fast (the retriever stays the agent's
 *      *eyes*, not the final judge). We do NOT feed the whole corpus every turn — it does not
 *      scale. Retrieval + the fail-closed visibility gate run in {@link MemoryStore.recall}
 *      (see index.ts) BEFORE this module ever sees a candidate.
 *   2. A small LLM agent reads ONLY those gated candidates against the question and either
 *      passes a concise note ("here's what's relevant to what they asked…") or returns a clean
 *      PASS when nothing genuinely adds — the same instinct as an ambient PASS.
 *   3. The caller can probe further: {@link AgentRecallSession.followUp} re-asks the agent
 *      (the "is that all?" round), so recall is conversational, not one-shot.
 *
 * HARD RUNTIME CONSTRAINT (from ro): the agent invokes its model through `claude -p` or the
 * `pi` CLI — NEVER the Anthropic API. {@link claudeInvoker} / {@link piInvoker} spawn the
 * subscription CLIs with API-auth env stripped by {@link childEnv} (src/env.ts), exactly like
 * the triage classifier (src/concierge/triage.ts) and the worker drivers (src/drivers/*).
 *
 * Non-negotiables honored here:
 *   - **Visibility is not this module's job.** It only ever receives already-gated candidates;
 *     it cannot widen access. The gate is enforced in code, fail-closed, in recall (index.ts).
 *   - **No fabrication.** The agent's cited note ids are intersected with the candidate set —
 *     a hallucinated id is dropped, and if nothing survives the answer degrades to a clean PASS.
 *   - **Never goes dark.** If the model CLI is unavailable or errors, {@link agentRecall} falls
 *     back to the moss ranking (candidate order) instead of failing recall.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../env.ts";
import { freshnessLabel } from "./freshness.ts";
import type { Logger, ScoredNode } from "../types.ts";
import { log as rootLog } from "../log.ts";

// =======================================================================================
// Seats + tunables
// =======================================================================================

/** The two benchmarked model seats (issue #26). `luna` is cost-effective; `haiku` is the
 *  faster/cheaper Claude lane. Which one takes the seat is decided on real benchmark numbers. */
export type MemoryAgentSeat = "luna" | "haiku";

/** How many gated candidates the agent reads (the "top ~15" from the design). */
export const AGENT_CANDIDATE_K = 15;

/** Default per-call model timeout — a small read-and-rank turn should be quick. */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Model ids per seat. luna runs through pi (openai-codex OAuth); haiku through `claude -p`. */
const LUNA_MODEL = "gpt-5.6-luna";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// =======================================================================================
// Public shapes
// =======================================================================================

/** One model turn: the raw text the CLI produced + how long it took (for latency stats). */
export interface ModelResult {
  text: string;
  latencyMs: number;
}

/**
 * Invoke a model with a system + user prompt and return its text. This is the ONLY surface the
 * agent talks to a model through, so a test can inject a deterministic invoker and production
 * uses {@link claudeInvoker} / {@link piInvoker} (CLI only, never the API).
 */
export type ModelInvoker = (
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
) => Promise<ModelResult>;

/** The agent's verdict for one question against the candidate set. */
export interface AgentAnswer {
  /** true ⇒ the agent passed a relevant note; false ⇒ a clean PASS (nothing added). */
  relevant: boolean;
  /** The concise prose note ("here's what's relevant…"); empty string on PASS. */
  note: string;
  /** Candidate note ids the agent ranked as relevant, most-relevant first. A strict subset of
   *  the candidates it was given — hallucinated ids are dropped before this is returned. */
  noteIds: string[];
  /** true ⇒ the model was unavailable/errored and we fell back to the moss ranking (never dark). */
  fallback: boolean;
  /** Wall-clock of the model turn (0 on the pre-model short-circuit / fallback with no call). */
  latencyMs: number;
}

/** A conversational recall exchange: the first answer + a probing follow-up round. */
export interface AgentRecallSession {
  answer: AgentAnswer;
  /** Ask the agent a follow-up over the SAME candidates ("is that all?"), carrying the prior
   *  exchange so it can reconsider. Returns a fresh {@link AgentAnswer}. */
  followUp(question: string): Promise<AgentAnswer>;
}

/** Dependencies for {@link agentRecall} — all optional; production wires the seat's invoker. */
export interface AgentRecallDeps {
  /** Which seat to use when {@link invoke} is not supplied. Default `luna`. */
  seat?: MemoryAgentSeat;
  /** Injected model invoker (tests / a pre-built seat). Overrides {@link seat}. */
  invoke?: ModelInvoker;
  /** Per-call model timeout. */
  timeoutMs?: number;
  logger?: Logger;
}

// =======================================================================================
// The agent
// =======================================================================================

/**
 * Run the memory agent over pre-gated candidates. `candidates` MUST already be filtered by the
 * fail-closed visibility gate (they come straight from `recall().hits`) — this module trusts
 * that and never re-derives access. Returns a session so the caller can probe with a follow-up.
 */
export async function agentRecall(
  candidates: ScoredNode[],
  question: string,
  deps: AgentRecallDeps = {},
): Promise<AgentRecallSession> {
  const logger = deps.logger ?? rootLog.child("memory.agent");
  const invoke = deps.invoke ?? seatInvoker(deps.seat ?? "luna", deps.timeoutMs, logger);
  const candidateIds = candidates.map((c) => c.node.name);

  // No candidates ⇒ nothing to read; a clean PASS without spending a model call.
  if (candidates.length === 0 || !question.trim()) {
    const empty: AgentAnswer = { relevant: false, note: "", noteIds: [], fallback: false, latencyMs: 0 };
    return { answer: empty, followUp: async () => empty };
  }

  const system = systemPrompt();
  const candidateBlock = renderCandidates(candidates);
  const transcript: TranscriptTurn[] = [];

  const ask = async (userQuestion: string): Promise<AgentAnswer> => {
    const userPrompt = buildUserPrompt(candidateBlock, userQuestion, transcript);
    let raw: ModelResult;
    try {
      raw = await invoke(system, userPrompt);
    } catch (err) {
      logger.warn("memory agent: model invocation failed — falling back to moss ranking", {
        err: String(err),
      });
      return fallbackAnswer(candidateIds);
    }
    const parsed = parseAgentOutput(raw.text);
    if (!parsed) {
      logger.warn("memory agent: unparseable model output — falling back to moss ranking", {
        sample: raw.text.slice(0, 200),
      });
      return { ...fallbackAnswer(candidateIds), latencyMs: raw.latencyMs };
    }
    // Anti-fabrication: keep only ids that were actually offered as candidates, in the agent's
    // order. A hallucinated id is silently dropped; if nothing survives it is a clean PASS.
    const allowed = new Set(candidateIds);
    const noteIds = dedupe(parsed.noteIds.filter((id) => allowed.has(id)));
    const relevant = parsed.relevant && noteIds.length > 0;
    const note = relevant ? parsed.note.trim() : ""; // never surface prose on a PASS
    transcript.push({ question: userQuestion, relevant, note, noteIds });
    return { relevant, note, noteIds, fallback: false, latencyMs: raw.latencyMs };
  };

  const answer = await ask(question);
  return { answer, followUp: (q: string) => ask(q) };
}

/** The moss-ranking fallback: recall degrades to the retriever's order, never dark, no prose. */
function fallbackAnswer(candidateIds: string[]): AgentAnswer {
  return {
    relevant: candidateIds.length > 0,
    note: "",
    noteIds: candidateIds.slice(0, 5),
    fallback: true,
    latencyMs: 0,
  };
}

// =======================================================================================
// Prompting
// =======================================================================================

interface TranscriptTurn {
  question: string;
  relevant: boolean;
  note: string;
  noteIds: string[];
}

let cachedSystemPrompt: string | undefined;

/** The agent's static instructions. Loaded from a sibling `.md` so it is easy to tune. */
function systemPrompt(): string {
  return (cachedSystemPrompt ??= readFileSync(join(import.meta.dir, "agent-recall.md"), "utf8").trim());
}

/** Render candidates as a compact, id-labeled block the agent ranks/quotes from. */
function renderCandidates(candidates: ScoredNode[]): string {
  const now = Date.now();
  return candidates
    .map((c, i) => {
      const n = c.node;
      const body = n.body.trim();
      return [
        // The date + age ride every candidate: notes are dated OBSERVATIONS — the agent
        // anchors old ones to their time and lets the newer observation win on conflict.
        `[${i + 1}] id: ${n.name}  (type: ${n.type}, observed: ${n.updated.slice(0, 10)} — ${freshnessLabel(n.updated, now)})`,
        `description: ${n.description}`,
        body ? `body: ${truncate(body, 1200)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function buildUserPrompt(candidateBlock: string, question: string, transcript: TranscriptTurn[]): string {
  const parts: string[] = [];
  parts.push("# Candidate notes (the ONLY notes you may cite — cite by their `id`)");
  parts.push(candidateBlock);
  if (transcript.length > 0) {
    parts.push("\n# Earlier in this recall conversation");
    for (const t of transcript) {
      parts.push(`Q: ${t.question}`);
      parts.push(
        t.relevant
          ? `A: {"relevant": true, "noteIds": ${JSON.stringify(t.noteIds)}, "note": ${JSON.stringify(t.note)}}`
          : `A: {"relevant": false, "noteIds": [], "note": ""}`,
      );
    }
  }
  parts.push("\n# Question");
  parts.push(question);
  parts.push(
    '\nReply with ONLY a JSON object: {"relevant": boolean, "noteIds": string[], "note": string}. ' +
      "`noteIds` are candidate ids ranked most-relevant first (empty on a PASS). Return a PASS " +
      "(relevant=false, empty noteIds, empty note) when no candidate genuinely answers the question.",
  );
  return parts.join("\n");
}

// =======================================================================================
// Output parsing
// =======================================================================================

interface ParsedOutput {
  relevant: boolean;
  noteIds: string[];
  note: string;
}

/** Lenient parse of the model's JSON verdict: raw, ```json-fenced, or a trailing object. */
export function parseAgentOutput(text: string): ParsedOutput | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const relevant = o.relevant === true;
  const noteIds = Array.isArray(o.noteIds)
    ? o.noteIds.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
  const note = typeof o.note === "string" ? o.note : "";
  return { relevant, noteIds, note };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 1. whole message is JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // 2. a ```json … ``` fenced block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  // 3. the last balanced {...} object in the text
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try {
      return JSON.parse(trimmed.slice(open, close + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

// =======================================================================================
// CLI invokers (subscription CLIs ONLY — never the Anthropic API)
// =======================================================================================

/** Build the invoker for a seat. */
export function seatInvoker(seat: MemoryAgentSeat, timeoutMs = DEFAULT_TIMEOUT_MS, logger?: Logger): ModelInvoker {
  return seat === "haiku" ? claudeInvoker(HAIKU_MODEL, timeoutMs, logger) : piInvoker(LUNA_MODEL, timeoutMs, logger);
}

/** The model id a seat resolves to (for reporting/telemetry). */
export function seatModel(seat: MemoryAgentSeat): string {
  return seat === "haiku" ? HAIKU_MODEL : LUNA_MODEL;
}

/**
 * `claude -p` invoker — the subscription CLI, API auth stripped (childEnv strips ANTHROPIC_* /
 * CLAUDE_CODE_*). Mirrors the triage classifier's invocation (src/concierge/triage.ts). Tools
 * disabled, thinking disabled: this is a bounded read-and-rank turn, not an agentic session.
 */
export function claudeInvoker(model: string, timeoutMs = DEFAULT_TIMEOUT_MS, logger?: Logger): ModelInvoker {
  return async (system, user) => {
    const started = performance.now();
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        user,
        "--model",
        model,
        "--output-format",
        "json",
        "--system-prompt",
        system,
        "--tools",
        "",
        "--no-session-persistence",
        "--safe-mode",
        "--disable-slash-commands",
        "--no-chrome",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: childEnv({ CLAUDE_CODE_DISABLE_THINKING: "1" }),
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const latencyMs = performance.now() - started;
    if (proc.signalCode === "SIGKILL") throw new Error(`claude recall timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (code !== 0) throw new Error(`claude recall exited ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 400)}`);
    logger?.debug("memory agent: claude turn", { latencyMs: Math.round(latencyMs) });
    return { text: claudeResultText(stdout), latencyMs };
  };
}

/** Pull the assistant's final text out of `claude -p --output-format json`. */
function claudeResultText(stdout: string): string {
  try {
    const obj = JSON.parse(stdout) as { result?: unknown };
    if (typeof obj.result === "string") return obj.result;
  } catch {
    /* fall through to raw */
  }
  return stdout;
}

/**
 * `pi` invoker for the luna seat — pi drives gpt-5.6-luna through the ChatGPT/Codex OAuth
 * (`openai-codex` provider); the child env strips API keys so it uses the pi login only. Mirrors
 * the PiDriver's argv (src/drivers/pi.ts): `--mode json` one-shot, extensions/skills/themes off.
 */
export function piInvoker(model: string, timeoutMs = DEFAULT_TIMEOUT_MS, logger?: Logger): ModelInvoker {
  return async (system, user) => {
    const started = performance.now();
    const home = process.env.HOME ?? "";
    const pathPrefix = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    const env = childEnv({ PATH: process.env.PATH ? `${pathPrefix}:${process.env.PATH}` : pathPrefix });
    const proc = Bun.spawn(
      [
        "pi",
        "-p",
        "--mode",
        "json",
        "--no-extensions",
        "--no-skills",
        "--no-themes",
        "--provider",
        "openai-codex",
        "--model",
        model,
        "--thinking",
        "low",
        "--append-system-prompt",
        system,
        user,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env,
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const latencyMs = performance.now() - started;
    if (proc.signalCode === "SIGKILL") throw new Error(`pi recall timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (code !== 0) throw new Error(`pi recall exited ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 400)}`);
    logger?.debug("memory agent: pi turn", { latencyMs: Math.round(latencyMs) });
    return { text: piAssistantText(stdout), latencyMs };
  };
}

/** Pull the last completed assistant message text out of pi's `--mode json` NDJSON stream. */
function piAssistantText(stdout: string): string {
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "message_end") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;
    const parts: string[] = [];
    if (Array.isArray(message.content)) {
      for (const raw of message.content) {
        const block = raw as Record<string, unknown>;
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
    const joined = parts.join("").trim();
    if (joined) text = joined; // keep the LAST non-empty assistant message
  }
  return text;
}

// =======================================================================================
// Small utilities
// =======================================================================================

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}
