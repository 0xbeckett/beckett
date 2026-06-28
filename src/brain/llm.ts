/**
 * Beckett — the brain's ONLY model boundary (`src/brain/llm.ts`)
 * =======================================================================================
 * Every LLM call Beckett makes passes through here. Nothing else in the codebase shells out
 * to `claude`. Two surfaces:
 *
 *   - {@link callJSON} — a one-shot, schema-validated decision. Runs
 *       `claude -p <prompt> --model <id> --output-format json --json-schema <inline-json>
 *        --append-system-prompt <sys> --max-turns 1 --disallowedTools <…> --permission-mode dontAsk`
 *     reads `result.structured_output`, and validates it with the caller's zod schema
 *     (Spec 06 §3.3). Stateless ⇒ safe to retry: transient failures back off (≤N), a schema
 *     miss is re-issued once more forcefully (Spec 06 §3.4).
 *   - {@link callText} — a one-shot free-text reply (the persona voice roles, Spec 06 §4.7).
 *     Same invocation minus `--json-schema`; returns `result.result`.
 *
 * Subscription auth ONLY (Spec 00 §4): we run **non-bare** so `claude` uses the `~/.claude`
 * subscription login, and we defensively strip `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from the
 * child env so a stray key can never silently flip a brain call onto API billing. We never
 * read those keys for any other purpose and never set them.
 *
 * Brain calls need NO tools (pure reasoning over injected context), so the full tool set is
 * denied and turns are capped at 1 (Spec 06 §3.3).
 */

import type { Logger } from "../types.ts";

/** Tools denied on every brain call — judgment is pure reasoning (Spec 06 §3.3). */
const DISALLOWED_TOOLS = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch";

/** Default brain-call retry budget (Spec 06 §9 `brain_retry_max`). */
export const BRAIN_RETRY_MAX = 3;

/** Appended to the system prompt when a schema attempt failed, to re-issue more forcefully. */
const SCHEMA_REMINDER =
  "\n\n---\n\nIMPORTANT: Your previous answer did not satisfy the required output schema. " +
  "Respond with ONLY a single JSON object that exactly matches the schema — no prose, no code " +
  "fences, every required field present and correctly typed.";

/** Truncate noisy stderr for error messages. */
function tail(s: string, max = 600): string {
  const t = s.trim();
  return t.length <= max ? t : "…" + t.slice(t.length - max);
}

/** Why a brain call failed — drives the per-role degradation in Spec 06 §3.4. */
export type BrainErrorKind = "schema" | "transient" | "rate_limit";

/** A classified brain-call failure. Callers degrade per role (continue / escalate / fallback). */
export class BrainCallError extends Error {
  constructor(
    message: string,
    readonly kind: BrainErrorKind,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BrainCallError";
  }
}

/** Retry tunables (from `config.retry`; backoff applies to transient/rate-limit only). */
export interface RetryOpts {
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

const DEFAULT_RETRY: RetryOpts = {
  maxRetries: BRAIN_RETRY_MAX,
  backoffBaseMs: 2000,
  backoffMaxMs: 300000,
};

/** Shared dependencies threaded into every role function (Spec 06 §3.2). */
export interface RoleDeps {
  /** claude binary (config.harness.claude.bin). */
  bin: string;
  /** Retry policy derived from config.retry. */
  retry: RetryOpts;
  logger: Logger;
}

// =======================================================================================
// child-process plumbing
// =======================================================================================

interface RawRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Build the child env: inherit the parent (so `~/.claude` subscription auth resolves) but
 * strip the forbidden API keys so a brain call can NEVER run on API billing (Spec 00 §4).
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

/** Spawn `claude` once, fully buffering stdout/stderr (brain calls are one-shot, non-stream). */
async function spawnClaude(bin: string, args: string[]): Promise<RawRun> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });
  } catch (err) {
    // bin missing / not executable — transient from the caller's view (retryable, then escalate).
    throw new BrainCallError(`failed to spawn ${bin}: ${(err as Error).message}`, "transient", err);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Parse the single JSON result object claude prints with `--output-format json`. */
function parseResultObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new BrainCallError("claude produced no output", "transient");
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Tolerate stray trailing lines: scan from the end for the last parseable JSON object.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!) as Record<string, unknown>;
      } catch {
        /* keep scanning */
      }
    }
    throw new BrainCallError("claude output was not valid JSON", "transient");
  }
}

/** Map a result `subtype` / stderr to a {@link BrainErrorKind}. */
function classify(subtype: string | undefined, stderr: string): BrainErrorKind {
  const hay = `${subtype ?? ""} ${stderr}`.toLowerCase();
  if (subtype === "error_max_structured_output_retries") return "schema";
  if (hay.includes("rate") || hay.includes("429") || hay.includes("overloaded")) return "rate_limit";
  return "transient";
}

function backoffMs(attempt: number, retry: RetryOpts): number {
  const ms = retry.backoffBaseMs * 2 ** attempt;
  const capped = Math.min(ms, retry.backoffMaxMs);
  // small jitter so concurrent looks don't thunder
  return capped + Math.floor(Math.random() * Math.min(500, capped));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// =======================================================================================
// callJSON — the structured decision boundary
// =======================================================================================

export interface CallJSONOptions<T> {
  bin: string;
  model: string;
  /** Layers 1–3 (persona + role + memory) → `--append-system-prompt` (Spec 06 §3.2). */
  system: string;
  /** Layers 4–5 (state + question) → the `-p` positional user prompt. */
  prompt: string;
  /** The JSON Schema sent to claude via `--json-schema` (literal Spec schema). */
  jsonSchema: Record<string, unknown>;
  /** Validate + narrow the parsed `structured_output`; MUST throw on invalid. */
  validate: (raw: unknown) => T;
  /** Short identifier for the temp file + logs (e.g. "plan", "intake"). */
  schemaName: string;
  retry?: RetryOpts;
  logger: Logger;
}

/**
 * One schema-validated brain decision. Passes the JSON Schema inline to --json-schema, runs the
 * one-shot `claude -p` invocation, reads `structured_output`, and validates it. Retries
 * transient/rate-limit failures with backoff; re-issues a schema miss once more forcefully
 * (Spec 06 §3.3/§3.4). Throws {@link BrainCallError} when the budget is exhausted — callers
 * degrade per role.
 */
export async function callJSON<T>(opts: CallJSONOptions<T>): Promise<T> {
  const retry = opts.retry ?? DEFAULT_RETRY;
  let systemExtra = "";
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    try {
      // claude's --json-schema takes the schema JSON INLINE as the arg value (verified on
      // claude 2.1.195; passing a file path fails with "--json-schema is not valid JSON").
      const args = [
        "-p",
        opts.prompt,
        "--model",
        opts.model,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(opts.jsonSchema),
        "--append-system-prompt",
        opts.system + systemExtra,
        // No --max-turns: a --json-schema call needs a turn to think AND a turn to emit the
        // StructuredOutput tool call; capping at 1 made every structured call error_max_turns.
        // Let it run to completion (it stops on its own once the schema is satisfied).
        "--disallowedTools",
        DISALLOWED_TOOLS,
        "--permission-mode",
        "dontAsk",
      ];

      const run = await spawnClaude(opts.bin, args);

      // A non-zero exit with no usable stdout is a process-level failure (transient).
      if (run.exitCode !== 0 && !run.stdout.trim()) {
        throw new BrainCallError(
          `claude exited ${run.exitCode}: ${tail(run.stderr)}`,
          classify(undefined, run.stderr),
        );
      }

      const result = parseResultObject(run.stdout);
      const subtype = typeof result.subtype === "string" ? result.subtype : undefined;

      if (subtype === "error_max_structured_output_retries") {
        systemExtra = SCHEMA_REMINDER;
        throw new BrainCallError("schema never satisfied", "schema");
      }
      if (result.is_error === true && subtype !== "success") {
        throw new BrainCallError(`claude error (${subtype ?? "unknown"})`, classify(subtype, run.stderr));
      }

      const structured = result.structured_output;
      if (structured === undefined || structured === null) {
        systemExtra = SCHEMA_REMINDER;
        throw new BrainCallError("result had no structured_output", "schema");
      }

      // Validate against the caller's zod schema (throws on mismatch).
      try {
        return opts.validate(structured);
      } catch (verr) {
        systemExtra = SCHEMA_REMINDER;
        throw new BrainCallError(`structured_output failed validation: ${(verr as Error).message}`, "schema");
      }
    } catch (err) {
      lastErr = err;
      const kind = err instanceof BrainCallError ? err.kind : "schema";
      opts.logger.warn("brain callJSON attempt failed", {
        schema: opts.schemaName,
        model: opts.model,
        attempt,
        kind,
        error: (err as Error).message,
      });
      if (attempt < retry.maxRetries) {
        if (kind !== "schema") await sleep(backoffMs(attempt, retry));
        continue;
      }
    }
  }

  if (lastErr instanceof BrainCallError) throw lastErr;
  throw new BrainCallError(
    `brain callJSON(${opts.schemaName}) exhausted retries`,
    "transient",
    lastErr,
  );
}

// =======================================================================================
// callText — the free-text voice boundary
// =======================================================================================

export interface CallTextOptions {
  bin: string;
  model: string;
  system: string;
  prompt: string;
  retry?: RetryOpts;
  logger: Logger;
}

/**
 * One free-text brain reply (delivery / escalation voice — Spec 06 §4.7). Same one-shot
 * invocation as {@link callJSON} minus `--json-schema`; returns the model's `result` text.
 * Retries transient/rate-limit failures with backoff. Throws {@link BrainCallError} on
 * exhaustion — voice callers fall back to a plain (non-persona) string so a message is never
 * dropped (Spec 00 no-silent-failure).
 */
export async function callText(opts: CallTextOptions): Promise<string> {
  const retry = opts.retry ?? DEFAULT_RETRY;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    try {
      const args = [
        "-p",
        opts.prompt,
        "--model",
        opts.model,
        "--output-format",
        "json",
        "--append-system-prompt",
        opts.system,
        // No --max-turns — let the call run to completion (see callJSON).
        "--disallowedTools",
        DISALLOWED_TOOLS,
        "--permission-mode",
        "dontAsk",
      ];

      const run = await spawnClaude(opts.bin, args);
      if (run.exitCode !== 0 && !run.stdout.trim()) {
        throw new BrainCallError(
          `claude exited ${run.exitCode}: ${tail(run.stderr)}`,
          classify(undefined, run.stderr),
        );
      }

      const result = parseResultObject(run.stdout);
      const subtype = typeof result.subtype === "string" ? result.subtype : undefined;
      if (result.is_error === true && subtype !== "success") {
        throw new BrainCallError(`claude error (${subtype ?? "unknown"})`, classify(subtype, run.stderr));
      }
      const text = result.result;
      if (typeof text !== "string" || !text.trim()) {
        throw new BrainCallError("result had no text", "transient");
      }
      return text.trim();
    } catch (err) {
      lastErr = err;
      const kind = err instanceof BrainCallError ? err.kind : "transient";
      opts.logger.warn("brain callText attempt failed", {
        model: opts.model,
        attempt,
        kind,
        error: (err as Error).message,
      });
      if (attempt < retry.maxRetries) {
        await sleep(backoffMs(attempt, retry));
        continue;
      }
    }
  }

  if (lastErr instanceof BrainCallError) throw lastErr;
  throw new BrainCallError("brain callText exhausted retries", "transient", lastErr);
}
