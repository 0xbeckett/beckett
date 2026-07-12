import { z } from "zod";
import type { Config } from "./types.ts";
import { childEnv } from "./env.ts";

export type SubscriptionProvider = "claude" | "codex";
export type SubscriptionUsageStatus = "ok" | "disconnected" | "unavailable";
export type SubscriptionUsageReason =
  | "not-connected"
  | "not-subscription"
  | "command-failed"
  | "timeout"
  | "malformed-response"
  | "no-usage-windows";

export type UsageReset =
  | { kind: "timestamp"; at: number }
  | { kind: "label"; text: string }
  | null;

export interface UsageWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  reset: UsageReset;
}

export interface SubscriptionCredits {
  unlimited: boolean;
  balance?: string;
  resetCount?: number;
}

/** Render-neutral subscription data. Raw CLI output and account email never leave this module. */
export interface SubscriptionUsage {
  provider: SubscriptionProvider;
  plan: string | null;
  status: SubscriptionUsageStatus;
  reason?: SubscriptionUsageReason;
  windows: UsageWindow[];
  credits?: SubscriptionCredits;
  observedAt: number;
}

export interface SubscriptionUsageReader {
  readAll(): Promise<SubscriptionUsage[]>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type CommandRunner = (
  argv: string[],
  opts: { env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<CommandResult>;

export interface CodexRpcSnapshot {
  account: unknown;
  rateLimits: unknown;
}

export type CodexRpcReader = (
  bin: string,
  opts: { env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<CodexRpcSnapshot>;

export interface SubscriptionUsageDeps {
  commandRunner?: CommandRunner;
  codexRpc?: CodexRpcReader;
  now?: () => number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
// `/usage` starts a full Claude session, unlike the lightweight auth-status probe.
const CLAUDE_USAGE_TIMEOUT_MS = 30_000;

const USAGE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

/** Provider probes get auth/config paths, never the daemon's Discord/Plane/GitHub/Gmail secrets. */
export function usageProbeEnv(env: Record<string, string | undefined> = childEnv()): Record<string, string | undefined> {
  return Object.fromEntries(USAGE_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
}

const ClaudeAuthSchema = z
  .object({
    loggedIn: z.boolean(),
    subscriptionType: z.string().nullable().optional(),
  })
  .passthrough();

const ClaudeResultSchema = z
  .object({
    type: z.literal("result"),
    is_error: z.boolean(),
    num_turns: z.number().int().nonnegative(),
    duration_api_ms: z.number().nonnegative().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    result: z.string(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative().optional(),
        output_tokens: z.number().nonnegative().optional(),
        cache_creation_input_tokens: z.number().nonnegative().optional(),
        cache_read_input_tokens: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const CodexAccountSchema = z
  .object({
    account: z
      .object({
        type: z.string(),
        planType: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

const CodexWindowSchema = z
  .object({
    usedPercent: z.number().finite().min(0).max(100),
    windowDurationMins: z.number().finite().positive().nullable().optional(),
    resetsAt: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

const CodexRateLimitsSchema = z
  .object({
    rateLimits: z
      .object({
        primary: CodexWindowSchema.nullable().optional(),
        secondary: CodexWindowSchema.nullable().optional(),
        credits: z
          .object({
            hasCredits: z.boolean(),
            unlimited: z.boolean(),
            balance: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        planType: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable(),
    rateLimitResetCredits: z
      .object({
        availableCount: z.number().int().nonnegative(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

function report(
  provider: SubscriptionProvider,
  status: SubscriptionUsageStatus,
  observedAt: number,
  reason?: SubscriptionUsageReason,
): SubscriptionUsage {
  return { provider, plan: null, status, ...(reason ? { reason } : {}), windows: [], observedAt };
}

function safePlan(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(value)) return null;
  return value
    .split(/([ ._-]+)/)
    .map((part) => (/^[A-Za-z0-9]/.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function usageTokenCount(usage: z.infer<typeof ClaudeResultSchema>["usage"]): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function claudeWindowLabel(raw: string): string | null {
  const value = raw.replace(/[^A-Za-z0-9 ()_-]/g, " ").replace(/\s+/g, " ").trim();
  if (!/^(?:session|week(?: \([A-Za-z0-9 _-]{1,40}\))?)$/i.test(value)) return null;
  return value[0]!.toUpperCase() + value.slice(1);
}

const CLAUDE_RESET_DATE_RE =
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) at (?:[1-9]|1[0-2])(?::[0-5]\d)? ?(?:am|pm)(?: \((?:UTC|GMT|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)\))?$/i;

function claudeResetLabel(raw: string): string | null {
  if (/[\u0000-\u001f\u007f<>@`]/.test(raw)) return null;
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value || value.length > 100 || !CLAUDE_RESET_DATE_RE.test(value)) return null;
  return value;
}

/** Parse the human-readable plan-limit rows nested in Claude's structured result envelope. */
export function parseClaudeUsageResult(raw: string): UsageWindow[] | null {
  const parsed = ClaudeResultSchema.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  const result = parsed.data;
  if (
    result.is_error ||
    result.num_turns !== 0 ||
    (result.duration_api_ms ?? 0) !== 0 ||
    (result.total_cost_usd ?? 0) !== 0 ||
    usageTokenCount(result.usage) !== 0
  ) {
    return null;
  }

  const windows: UsageWindow[] = [];
  for (const rawLine of result.result.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^Current\s+(.+?):\s*(\d+(?:\.\d+)?)%\s+used\s*(?:\u00b7|-)\s*resets\s+(.+)$/i.exec(line);
    if (!match) continue;
    const usedPercent = Number(match[2]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const resetLabel = claudeResetLabel(match[3]!);
    const label = claudeWindowLabel(match[1]!);
    if (!label || !resetLabel) continue;
    windows.push({
      label,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      reset: { kind: "label", text: resetLabel },
    });
  }
  return windows.length > 0 ? windows : null;
}

async function defaultCommandRunner(
  argv: string[],
  opts: { env: Record<string, string | undefined>; timeoutMs: number },
): Promise<CommandResult> {
  let timedOut = false;
  try {
    const proc = Bun.spawn({
      cmd: argv,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }, opts.timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      settled = true;
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
      if (!settled) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
        await Promise.race([proc.exited.catch(() => -1), new Promise((resolve) => setTimeout(resolve, 250))]);
      }
    }
  } catch {
    return { code: 127, stdout: "", stderr: "", timedOut };
  }
}

export async function readClaudeSubscriptionUsage(
  config: Config,
  deps: SubscriptionUsageDeps = {},
): Promise<SubscriptionUsage> {
  const observedAt = (deps.now ?? Date.now)();
  const run = deps.commandRunner ?? defaultCommandRunner;
  const authTimeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const usageTimeoutMs = deps.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS;
  const env = usageProbeEnv();
  const bin = config.harness.claude.bin;

  let auth: CommandResult;
  try {
    auth = await run([bin, "auth", "status", "--json"], { env, timeoutMs: authTimeoutMs });
  } catch {
    return report("claude", "unavailable", observedAt, "command-failed");
  }
  if (auth.timedOut) return report("claude", "unavailable", observedAt, "timeout");
  if (auth.code !== 0) return report("claude", "unavailable", observedAt, "command-failed");
  const authResult = ClaudeAuthSchema.safeParse(parseJson(auth.stdout));
  if (!authResult.success) return report("claude", "unavailable", observedAt, "malformed-response");
  if (!authResult.data.loggedIn) return report("claude", "disconnected", observedAt, "not-connected");

  let usage: CommandResult;
  try {
    usage = await run(
      [bin, "--safe-mode", "--no-session-persistence", "--max-turns", "0", "-p", "/usage", "--output-format", "json"],
      { env, timeoutMs: usageTimeoutMs },
    );
  } catch {
    return report("claude", "unavailable", observedAt, "command-failed");
  }
  if (usage.timedOut) return report("claude", "unavailable", observedAt, "timeout");
  if (usage.code !== 0) return report("claude", "unavailable", observedAt, "command-failed");
  const windows = parseClaudeUsageResult(usage.stdout);
  if (!windows) return report("claude", "unavailable", observedAt, "no-usage-windows");

  return {
    provider: "claude",
    plan: safePlan(authResult.data.subscriptionType),
    status: "ok",
    windows,
    observedAt,
  };
}

class RpcTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError("RPC timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface RpcLineReader {
  reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  };
  decoder: TextDecoder;
  buffer: string;
}

async function nextRpcLine(state: RpcLineReader, deadline: number): Promise<Record<string, unknown>> {
  for (;;) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      const value = parseJson(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RpcTimeoutError("RPC timed out");
    const chunk = await withTimeout(state.reader.read(), remaining);
    if (chunk.done || !chunk.value) throw new Error("Codex app-server closed before replying");
    state.buffer += state.decoder.decode(chunk.value, { stream: true });
  }
}

function writeRpc(sink: unknown, message: Record<string, unknown>): void {
  const writable = sink as { write?: (text: string) => unknown; flush?: () => unknown } | undefined;
  if (!writable?.write) throw new Error("Codex app-server stdin is not writable");
  writable.write(`${JSON.stringify(message)}\n`);
  writable.flush?.();
}

async function stopRpcProcess(proc: { kill: (signal?: NodeJS.Signals) => void; exited: Promise<number> }): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
    await Promise.race([
      proc.exited.catch(() => -1),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }
}

/** Query the documented, stable Codex account RPCs without opening a model turn. */
export async function queryCodexAppServer(
  bin: string,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<CodexRpcSnapshot> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const proc = Bun.spawn({
    cmd: [bin, "app-server", "--stdio"],
    env: opts.env ?? usageProbeEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrDrain = new Response(proc.stderr).text().catch(() => "");
  const state: RpcLineReader = {
    reader: proc.stdout.getReader(),
    decoder: new TextDecoder(),
    buffer: "",
  };

  try {
    writeRpc(proc.stdin, {
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "beckett", title: "Beckett", version: "1" },
      },
    });
    for (;;) {
      const message = await nextRpcLine(state, deadline);
      if (message.id !== 1) continue;
      if (message.error) throw new Error("Codex app-server initialization failed");
      break;
    }

    writeRpc(proc.stdin, { method: "initialized" });
    writeRpc(proc.stdin, { method: "account/read", id: 2, params: { refreshToken: false } });
    writeRpc(proc.stdin, { method: "account/rateLimits/read", id: 3 });

    let account: unknown;
    let rateLimits: unknown;
    while (account === undefined || rateLimits === undefined) {
      const message = await nextRpcLine(state, deadline);
      if (message.id !== 2 && message.id !== 3) continue;
      if (message.error) throw new Error("Codex account RPC failed");
      if (message.id === 2) account = message.result;
      else rateLimits = message.result;
    }
    return { account, rateLimits };
  } finally {
    await stopRpcProcess(proc);
    await Promise.race([
      state.reader.cancel().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    await Promise.race([stderrDrain, new Promise((resolve) => setTimeout(resolve, 250))]);
  }
}

function durationLabel(minutes: number): string {
  if (minutes === 300) return "5-hour window";
  if (minutes === 10_080) return "Weekly window";
  if (Number.isInteger(minutes / 1_440)) return `${minutes / 1_440}-day window`;
  if (Number.isInteger(minutes / 60)) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function codexWindow(value: z.infer<typeof CodexWindowSchema>, fallbackLabel: string): UsageWindow {
  return {
    label: value.windowDurationMins ? durationLabel(value.windowDurationMins) : fallbackLabel,
    usedPercent: value.usedPercent,
    remainingPercent: 100 - value.usedPercent,
    reset: value.resetsAt ? { kind: "timestamp", at: value.resetsAt } : null,
  };
}

/** Normalize the two structured Codex account responses and discard sensitive account fields. */
export function parseCodexSubscriptionUsage(
  snapshot: CodexRpcSnapshot,
  observedAt: number = Date.now(),
): SubscriptionUsage {
  const account = CodexAccountSchema.safeParse(snapshot.account);
  if (!account.success) return report("codex", "unavailable", observedAt, "malformed-response");
  if (!account.data.account) return report("codex", "disconnected", observedAt, "not-connected");
  if (account.data.account.type !== "chatgpt") {
    return report("codex", "disconnected", observedAt, "not-subscription");
  }

  const rate = CodexRateLimitsSchema.safeParse(snapshot.rateLimits);
  if (!rate.success || !rate.data.rateLimits) {
    return report("codex", "unavailable", observedAt, "malformed-response");
  }
  const limits = rate.data.rateLimits;
  const windows = [
    limits.primary ? codexWindow(limits.primary, "Primary window") : null,
    limits.secondary ? codexWindow(limits.secondary, "Secondary window") : null,
  ].filter((window): window is UsageWindow => window !== null);
  if (windows.length === 0) return report("codex", "unavailable", observedAt, "no-usage-windows");

  const credits = limits.credits;
  const resetCount = rate.data.rateLimitResetCredits?.availableCount;
  const safeBalance = credits?.balance && /^\d+(?:\.\d+)?$/.test(credits.balance) ? credits.balance : undefined;
  const normalizedCredits = credits || resetCount !== undefined
    ? {
        unlimited: credits?.unlimited ?? false,
        ...(safeBalance !== undefined ? { balance: safeBalance } : {}),
        ...(resetCount !== undefined ? { resetCount } : {}),
      }
    : undefined;

  return {
    provider: "codex",
    plan: safePlan(account.data.account.planType ?? limits.planType),
    status: "ok",
    windows,
    ...(normalizedCredits ? { credits: normalizedCredits } : {}),
    observedAt,
  };
}

export async function readCodexSubscriptionUsage(
  config: Config,
  deps: SubscriptionUsageDeps = {},
): Promise<SubscriptionUsage> {
  const observedAt = (deps.now ?? Date.now)();
  const readRpc = deps.codexRpc ?? queryCodexAppServer;
  try {
    const snapshot = await readRpc(config.harness.codex.bin, {
      env: usageProbeEnv(),
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return parseCodexSubscriptionUsage(snapshot, observedAt);
  } catch (error) {
    return report(
      "codex",
      "unavailable",
      observedAt,
      error instanceof RpcTimeoutError ? "timeout" : "command-failed",
    );
  }
}

export async function readAllSubscriptionUsage(
  config: Config,
  deps: SubscriptionUsageDeps = {},
): Promise<SubscriptionUsage[]> {
  const providers: Array<[SubscriptionProvider, Promise<SubscriptionUsage>]> = [
    ["claude", readClaudeSubscriptionUsage(config, deps)],
    ["codex", readCodexSubscriptionUsage(config, deps)],
  ];
  const settled = await Promise.allSettled(providers.map(([, promise]) => promise));
  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : report(providers[index]![0], "unavailable", (deps.now ?? Date.now)(), "command-failed"),
  );
}

export function createSubscriptionUsageReader(
  config: Config,
  deps: SubscriptionUsageDeps = {},
): SubscriptionUsageReader {
  return { readAll: () => readAllSubscriptionUsage(config, deps) };
}
