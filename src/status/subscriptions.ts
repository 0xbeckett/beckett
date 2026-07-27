/** Best-effort subscription-capacity sources for the status dashboard. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubscriptionLimits } from "./types.ts";

/** The dashboard ticks every minute; subscription data only needs one OAuth request per five minutes. */
export const ANTHROPIC_USAGE_CACHE_TTL_MS = 5 * 60_000;
/** Codex rollouts are observations, not live data; call them stale after thirty minutes. */
export const CODEX_USAGE_STALE_AFTER_MS = 30 * 60_000;
const MAX_CODEX_ROLLOUT_FILES = 40;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface SubscriptionLimitsSourceDeps {
  credentialsPath?: string;
  codexSessionsDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Reads local credentials/rollouts and makes the one bounded Anthropic request; never throws. */
export class SubscriptionLimitsSource {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private anthopicCache: { expiresAt: number; value: SubscriptionLimits["claude"] } | null = null;
  private readonly credentialsPath: string;
  private readonly codexSessionsDir: string;

  constructor(deps: SubscriptionLimitsSourceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.credentialsPath = deps.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
    this.codexSessionsDir = deps.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  }

  async collect(): Promise<SubscriptionLimits> {
    const [claude, codex] = await Promise.all([this.collectClaude(), Promise.resolve(this.collectCodex())]);
    return { claude, codex };
  }

  private async collectClaude(): Promise<SubscriptionLimits["claude"]> {
    const now = this.now();
    if (this.anthopicCache && now < this.anthopicCache.expiresAt) return this.anthopicCache.value;
    try {
      // Deliberately local to this request: the OAuth token is neither logged nor cached.
      const token = credentialToken(this.credentialsPath);
      if (!token) return { available: false, limits: [] };
      const response = await this.fetchImpl(ANTHROPIC_USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { available: false, limits: [] };
      const value = parseClaudeUsage(await response.json());
      this.anthopicCache = { expiresAt: now + ANTHROPIC_USAGE_CACHE_TTL_MS, value };
      return value;
    } catch {
      return { available: false, limits: [] };
    }
  }

  private collectCodex(): SubscriptionLimits["codex"] {
    try {
      const files = rolloutFiles(this.codexSessionsDir);
      for (const file of files) {
        const hit = lastRateLimits(readFileSync(file, "utf8"));
        if (!hit) continue;
        const observedAt = hit.observedAt ?? statSync(file).mtimeMs;
        const ageMs = Math.max(0, this.now() - observedAt);
        return {
          available: true,
          observedAgeMs: ageMs,
          stale: ageMs > CODEX_USAGE_STALE_AFTER_MS,
          limits: [hit.primary, hit.secondary].flatMap((window) => window ? [{
            label: windowLabel(window.window_minutes), percentUsed: window.used_percent,
            resetsAt: unixIso(window.resets_at), severity: null,
          }] : []),
        };
      }
    } catch { /* missing or changed local Codex state is simply unavailable */ }
    return { available: false, limits: [], observedAgeMs: null, stale: false };
  }
}

export function parseClaudeUsage(value: unknown): SubscriptionLimits["claude"] {
  const body = record(value);
  const rawLimits = Array.isArray(body?.limits) ? body.limits : null;
  if (!body || !rawLimits) return { available: false, limits: [] };
  const limits = rawLimits.flatMap((raw) => {
    const item = record(raw);
    const percent = number(item?.percent);
    if (!item || percent === null) return [];
    const scope = record(item.scope);
    const model = record(scope?.model);
    const displayName = string(model?.display_name);
    const kind = string(item.kind) ?? "limit";
    const group = string(item.group);
    return [{
      label: claudeLabel(kind, group, displayName), percentUsed: percent,
      resetsAt: iso(item.resets_at), severity: string(item.severity),
    }];
  });
  const extra = record(body.extra_usage);
  const spend = record(body.spend);
  // Older/current OAuth payload variants expose this same pool as extra_usage or spend.
  const overage = extra?.is_enabled === true ? moneyPool(extra) : spend?.enabled === true ? spendPool(spend) : null;
  return { available: true, limits, overage };
}

function credentialToken(path: string): string | null {
  try {
    const credentials = record(JSON.parse(readFileSync(path, "utf8")));
    const oauth = record(credentials?.claudeAiOauth);
    return string(oauth?.accessToken);
  } catch { return null; }
}

function moneyPool(value: Record<string, unknown>) {
  const exponent = number(value.exponent) ?? number(value.decimal_places) ?? 2;
  const limit = number(value.monthly_limit);
  const used = number(value.used_credits);
  if (limit === null || used === null) return null;
  const divisor = 10 ** exponent;
  return { used: used / divisor, limit: limit / divisor, currency: string(value.currency) ?? "USD" };
}
function spendPool(value: Record<string, unknown>) {
  const used = record(value.used); const limit = record(value.limit);
  const exponent = number(limit?.exponent) ?? number(used?.exponent) ?? 2;
  const usedMinor = number(used?.amount_minor); const limitMinor = number(limit?.amount_minor);
  if (usedMinor === null || limitMinor === null) return null;
  return { used: usedMinor / 10 ** exponent, limit: limitMinor / 10 ** exponent, currency: string(limit?.currency) ?? string(used?.currency) ?? "USD" };
}

function claudeLabel(kind: string, group: string | null, model: string | null): string {
  // limits[] is authoritative and deliberately remains open-ended for new kinds/scopes.
  const base = kind === "session" ? "5h session" : group === "weekly" ? "Weekly" : words(kind);
  return model ? `${base} · ${model}` : base;
}

function rolloutFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(child);
    }
  };
  if (!existsSync(dir)) return [];
  walk(dir);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, MAX_CODEX_ROLLOUT_FILES);
}

type RateWindow = { used_percent: number; window_minutes: number; resets_at: number };
function lastRateLimits(text: string): { primary: RateWindow | null; secondary: RateWindow | null; observedAt: number | null } | null {
  let result: { primary: RateWindow | null; secondary: RateWindow | null; observedAt: number | null } | null = null;
  for (const line of text.split("\n")) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const rate = findRateLimits(parsed);
      if (!rate) continue;
      const obj = record(rate);
      result = { primary: rateWindow(obj?.primary), secondary: rateWindow(obj?.secondary), observedAt: findTimestamp(parsed) };
    } catch { /* crash-truncated JSONL tail is ignored */ }
  }
  return result;
}

function findRateLimits(value: unknown): unknown | null {
  const obj = record(value);
  if (!obj) return null;
  if (record(obj.rate_limits)) return obj.rate_limits;
  for (const child of Object.values(obj)) { const found = findRateLimits(child); if (found) return found; }
  return null;
}
function findTimestamp(value: unknown): number | null {
  const obj = record(value);
  if (!obj) return null;
  for (const key of ["timestamp", "created_at", "ts"]) {
    const v = obj[key]; const parsed = typeof v === "number" ? v * (v < 10_000_000_000 ? 1_000 : 1) : Date.parse(String(v));
    if (Number.isFinite(parsed)) return parsed;
  }
  for (const child of Object.values(obj)) { const found = findTimestamp(child); if (found !== null) return found; }
  return null;
}
function rateWindow(value: unknown): RateWindow | null {
  const obj = record(value); const used_percent = number(obj?.used_percent); const window_minutes = number(obj?.window_minutes); const resets_at = number(obj?.resets_at);
  return used_percent === null || window_minutes === null || resets_at === null ? null : { used_percent, window_minutes, resets_at };
}
function windowLabel(minutes: number): string { return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`; }
function unixIso(seconds: number): string | null { const date = new Date(seconds * 1_000); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
function iso(value: unknown): string | null { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null; }
function words(value: string): string { return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function string(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
