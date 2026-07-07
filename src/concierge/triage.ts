import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../types.ts";

export const TriageVerdictSchema = z.object({
  interject: z.boolean(),
  kind: z.enum(["feature-wish", "bug-report", "question", "task-request", "social", "none"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;

export interface TriageMessage {
  authorDisplayName: string;
  content: string;
  ts: number;
}

export type TriageFn = (
  burst: TriageMessage[],
  transcript: TriageMessage[],
  meta?: { channelId?: string },
) => Promise<TriageVerdict>;

export interface CreateTriageClassifierOptions {
  model: string;
  logger: Logger;
  claudeBin?: string;
  promptPath?: string;
  timeoutMs?: number;
  /**
   * Where the classification runs: `claude` spawns the subscription CLI (the original path);
   * `cerebras` POSTs to Cerebras' OpenAI-compatible API (~1850 tok/s — a scorer this small
   * shouldn't cost Haiku money or Haiku latency). Key rides `CEREBRAS_API_KEY` in
   * `~/.beckett/.env` (read at call time, never config/logs).
   */
  provider?: "claude" | "cerebras";
  /** Test seam / override; defaults to `process.env.CEREBRAS_API_KEY` at call time. */
  apiKey?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
}

const CEREBRAS_ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

const CLOSED: TriageVerdict = {
  interject: false,
  kind: "none",
  confidence: 0,
  reason: "classifier unavailable",
};

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

function formatMessages(messages: TriageMessage[]): string {
  if (messages.length === 0) return "(none)";
  return messages
    .map((m) => `[${fmtTime(m.ts)}] ${m.authorDisplayName}: ${m.content}`)
    .join("\n");
}

export function buildTriagePrompt(
  staticPrompt: string,
  burst: TriageMessage[],
  transcript: TriageMessage[],
): string {
  return `${staticPrompt.trim()}\n\n<context>\nRecent transcript:\n${formatMessages(transcript)}\n</context>\n\n<context>\nBurst to classify:\n${formatMessages(burst)}\n</context>\n`;
}

/**
 * Pull the verdict JSON out of model text that may wrap it in a markdown code fence or stray
 * prose. Haiku fences its output often enough that a strict parse failed closed on every call
 * in prod — the classifier looked "enabled" but could never interject.
 */
export function extractVerdictJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function parseVerdict(stdout: string): TriageVerdict {
  const parsed = JSON.parse(stdout.trim());
  const direct = TriageVerdictSchema.safeParse(parsed);
  if (direct.success) return direct.data;

  if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
    const inner = JSON.parse(extractVerdictJson(parsed.result));
    return TriageVerdictSchema.parse(inner);
  }
  return TriageVerdictSchema.parse(parsed);
}

/** The `claude -p` path: spawn the subscription CLI, read the verdict off stdout. */
async function classifyViaClaude(
  opts: CreateTriageClassifierOptions,
  prompt: string,
  timeoutMs: number,
): Promise<TriageVerdict> {
  const bin = opts.claudeBin ?? "claude";
  const proc = Bun.spawn([bin, "-p", prompt, "--model", opts.model, "--output-format", "json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) throw new Error(`claude triage timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (code !== 0) throw new Error(`claude triage exited ${code}: ${stderr.trim()}`);
    return parseVerdict(stdout);
  } finally {
    clearTimeout(timer);
  }
}

/** The Cerebras path: OpenAI-compatible chat completion; verdict is the message content. */
async function classifyViaCerebras(
  opts: CreateTriageClassifierOptions,
  prompt: string,
  timeoutMs: number,
): Promise<TriageVerdict> {
  const apiKey = opts.apiKey ?? process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("CEREBRAS_API_KEY missing from the environment (~/.beckett/.env)");
  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch(opts.endpoint ?? CEREBRAS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cerebras triage HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("cerebras triage returned no content");
  return TriageVerdictSchema.parse(JSON.parse(extractVerdictJson(content)));
}

export function createTriageClassifier(opts: CreateTriageClassifierOptions): TriageFn {
  const timeoutMs = opts.timeoutMs ?? (opts.provider === "cerebras" ? 15_000 : 30_000);
  const promptPath = opts.promptPath ?? join(import.meta.dir, "triage.md");

  return async (burst, transcript, meta = {}) => {
    const staticPrompt = readFileSync(promptPath, "utf8");
    const prompt = buildTriagePrompt(staticPrompt, burst, transcript);
    try {
      const verdict =
        opts.provider === "cerebras"
          ? await classifyViaCerebras(opts, prompt, timeoutMs)
          : await classifyViaClaude(opts, prompt, timeoutMs);
      opts.logger.info("ambient triage verdict", {
        channel: meta.channelId ?? null,
        kind: verdict.kind,
        confidence: verdict.confidence,
        reason: verdict.reason,
        interject: verdict.interject,
      });
      return verdict;
    } catch (err) {
      const verdict = { ...CLOSED, reason: (err as Error).message || CLOSED.reason };
      opts.logger.warn("ambient triage failed closed", {
        channel: meta.channelId ?? null,
        error: verdict.reason,
      });
      opts.logger.info("ambient triage verdict", {
        channel: meta.channelId ?? null,
        kind: verdict.kind,
        confidence: verdict.confidence,
        reason: verdict.reason,
        interject: verdict.interject,
      });
      return verdict;
    }
  };
}
