import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../types.ts";

export const TriageVerdictSchema = z.object({
  interject: z.boolean(),
  kind: z.enum(["feature-wish", "bug-report", "question", "task-request", "none"]),
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
}

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
  return `${staticPrompt.trim()}\n\nRecent transcript:\n${formatMessages(transcript)}\n\nBurst to classify:\n${formatMessages(burst)}\n`;
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

export function createTriageClassifier(opts: CreateTriageClassifierOptions): TriageFn {
  const bin = opts.claudeBin ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const promptPath = opts.promptPath ?? join(import.meta.dir, "triage.md");

  return async (burst, transcript, meta = {}) => {
    const staticPrompt = readFileSync(promptPath, "utf8");
    const prompt = buildTriagePrompt(staticPrompt, burst, transcript);
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

      const verdict = parseVerdict(stdout);
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
    } finally {
      clearTimeout(timer);
    }
  };
}
