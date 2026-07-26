import { expect, test } from "bun:test";
import { withinRateLimit, WATCH_RATE_LIMIT } from "./rate-limit.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function agoMs(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

test("allows a post when there is no history", () => {
  expect(withinRateLimit([], NOW)).toBe(true);
});

test("blocks a second post within the same hour (max 1/hour)", () => {
  expect(WATCH_RATE_LIMIT.maxPerHour).toBe(1);
  const posts = [{ postedAt: agoMs(10 * 60_000) }];
  expect(withinRateLimit(posts, NOW)).toBe(false);
});

test("allows a post once the hourly window has passed", () => {
  const posts = [{ postedAt: agoMs(HOUR + 60_000) }];
  expect(withinRateLimit(posts, NOW)).toBe(true);
});

test("blocks a 4th post within a rolling 24h even if each is an hour apart (max 3/24h)", () => {
  expect(WATCH_RATE_LIMIT.maxPer24h).toBe(3);
  const posts = [agoMs(3 * HOUR), agoMs(6 * HOUR), agoMs(9 * HOUR)].map((postedAt) => ({ postedAt }));
  expect(withinRateLimit(posts, NOW)).toBe(false);
});

test("allows a post once enough 24h-old entries have rolled off", () => {
  const posts = [agoMs(DAY + HOUR), agoMs(6 * HOUR), agoMs(9 * HOUR)].map((postedAt) => ({ postedAt }));
  expect(withinRateLimit(posts, NOW)).toBe(true);
});

test("the hourly cap bites even when the 24h cap has room", () => {
  const posts = [{ postedAt: agoMs(5 * 60_000) }]; // one post 5 minutes ago, well under 3/24h
  expect(withinRateLimit(posts, NOW)).toBe(false);
});

test("ignores malformed timestamps rather than crashing or over-counting", () => {
  const posts = [{ postedAt: "not-a-date" }, { postedAt: agoMs(HOUR + 60_000) }];
  expect(withinRateLimit(posts, NOW)).toBe(true);
});
