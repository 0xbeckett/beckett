import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ANTHROPIC_USAGE_CACHE_TTL_MS, CODEX_USAGE_STALE_AFTER_MS, SubscriptionLimitsSource, parseClaudeUsage } from "./subscriptions.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const claudeFixture = {
  five_hour: { utilization: 14, resets_at: "2026-07-27T01:50:00Z" }, seven_day: { utilization: 3, resets_at: "2026-08-02T16:00:00Z" },
  limits: [
    { kind: "session", group: "session", percent: 14, severity: "normal", resets_at: "2026-07-27T01:50:00Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 3, severity: "normal", resets_at: "2026-08-02T16:00:00Z" },
    { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { display_name: "Fable" } } },
    { kind: "future_limit", group: "future", percent: null, resets_at: null },
  ],
  extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 0, currency: "USD", decimal_places: 2 },
  spend: null,
};

test("Claude fixture iterates all non-null limits, scopes models, and converts enabled minor-unit overage", () => {
  const parsed = parseClaudeUsage(claudeFixture);
  expect(parsed).toEqual({ available: true, limits: [
    expect.objectContaining({ label: "5h session", percentUsed: 14 }),
    expect.objectContaining({ label: "Weekly", percentUsed: 3 }),
    expect.objectContaining({ label: "Weekly · Fable", percentUsed: 0 }),
  ], overage: { used: 0, limit: 20, currency: "USD" } });
});

test("spend-shaped overage uses its minor-unit exponent only when enabled", () => {
  const payload = { ...claudeFixture, extra_usage: { is_enabled: false }, spend: {
    enabled: true, used: { amount_minor: 125, exponent: 2, currency: "USD" }, limit: { amount_minor: 2000, exponent: 2, currency: "USD" },
  } };
  expect(parseClaudeUsage(payload).overage).toEqual({ used: 1.25, limit: 20, currency: "USD" });
  expect(parseClaudeUsage({ ...payload, spend: { ...payload.spend, enabled: false } }).overage).toBeNull();
});

test("source reads credentials only for its request, caches response, and takes last limits from newest rollout that has one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-subscriptions-")); dirs.push(dir);
  const credentials = join(dir, "credentials.json"); writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "test-secret" } }));
  const sessions = join(dir, "sessions"); mkdirSync(join(sessions, "2026", "07", "27"), { recursive: true });
  const old = join(sessions, "2026", "07", "27", "rollout-old.jsonl");
  const newest = join(sessions, "2026", "07", "27", "rollout-new.jsonl");
  writeFileSync(old, '{"timestamp":"2026-07-27T00:00:00Z","rate_limits":{"primary":{"used_percent":1,"window_minutes":300,"resets_at":1785126463}}}\n');
  writeFileSync(newest, '{"timestamp":"2026-07-27T00:00:00Z","event":"no limits"}\n' +
    '{"timestamp":"2026-07-27T00:05:00Z","rate_limits":{"primary":{"used_percent":34,"window_minutes":300,"resets_at":1785126463},"secondary":{"used_percent":16,"window_minutes":10080,"resets_at":1785542215}}}\n');
  utimesSync(old, new Date("2026-07-27T00:00:00Z"), new Date("2026-07-27T00:00:00Z"));
  utimesSync(newest, new Date("2026-07-27T00:10:00Z"), new Date("2026-07-27T00:10:00Z"));
  let calls = 0; const now = Date.parse("2026-07-27T00:10:00Z");
  const source = new SubscriptionLimitsSource({ credentialsPath: credentials, codexSessionsDir: sessions, now: () => now,
    fetch: (async (_url, init) => { calls++; expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-secret"); return new Response(JSON.stringify(claudeFixture)); }) as typeof fetch });
  const first = await source.collect(); const second = await source.collect();
  expect(calls).toBe(1); expect(ANTHROPIC_USAGE_CACHE_TTL_MS).toBe(300_000);
  expect(first.codex.limits.map((x) => [x.label, x.percentUsed])).toEqual([["5h", 34], ["7d", 16]]);
  expect(first.codex.observedAgeMs).toBe(5 * 60_000); expect(first.codex.stale).toBe(false); expect(second).toEqual(first);
});

test("missing credentials and rollouts with no rate_limits degrade to unavailable without fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-subscriptions-")); dirs.push(dir);
  const sessions = join(dir, "sessions", "2026"); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-empty.jsonl"), '{"timestamp":"2026-07-27T00:00:00Z","event":"no limits"}\n');
  const source = new SubscriptionLimitsSource({ credentialsPath: join(dir, "missing.json"), codexSessionsDir: join(dir, "sessions"), fetch: (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch });
  const limits = await source.collect();
  expect(limits.claude).toEqual({ available: false, limits: [] });
  expect(limits.codex).toEqual({ available: false, limits: [], observedAgeMs: null, stale: false });
  expect(CODEX_USAGE_STALE_AFTER_MS).toBe(30 * 60_000);
});
