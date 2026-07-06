/**
 * Coverage for the federation gateway primitive — the trusted-peer exemption to the
 * bot-ignore guard, and the per-channel runaway backstop. Both are pure, so no live
 * gateway / discord.js is involved.
 */

import { test, expect } from "bun:test";
import { isFederatedPeer, PeerBurstLimiter } from "./federation.ts";

const OWN = "100000000000000001";
const PEER = "200000000000000002";
const STRANGER = "300000000000000003";

test("an unlisted bot is not a peer (default behavior: ignored)", () => {
  expect(isFederatedPeer(STRANGER, OWN, new Set([PEER]))).toBe(false);
});

test("a listed peer is a peer", () => {
  expect(isFederatedPeer(PEER, OWN, new Set([PEER]))).toBe(true);
});

test("we are never our own peer, even if our id is mistakenly listed", () => {
  expect(isFederatedPeer(OWN, OWN, new Set([OWN, PEER]))).toBe(false);
});

test("empty allowlist means no peers (inert default)", () => {
  expect(isFederatedPeer(PEER, OWN, new Set())).toBe(false);
});

test("pre-ready (own id unknown) still matches a listed peer", () => {
  expect(isFederatedPeer(PEER, undefined, new Set([PEER]))).toBe(true);
});

test("burst limiter allows up to the cap, then drops within the window", () => {
  let now = 1_000_000;
  const lim = new PeerBurstLimiter(3, 60_000, () => now);
  expect(lim.allow("c")).toBe(true);
  expect(lim.allow("c")).toBe(true);
  expect(lim.allow("c")).toBe(true);
  expect(lim.allow("c")).toBe(false); // 4th within the minute is dropped
});

test("burst limiter is per-channel", () => {
  let now = 1_000_000;
  const lim = new PeerBurstLimiter(1, 60_000, () => now);
  expect(lim.allow("a")).toBe(true);
  expect(lim.allow("b")).toBe(true); // different channel has its own budget
  expect(lim.allow("a")).toBe(false);
});

test("burst budget refills once the window slides past old hits", () => {
  let now = 1_000_000;
  const lim = new PeerBurstLimiter(2, 60_000, () => now);
  expect(lim.allow("c")).toBe(true);
  expect(lim.allow("c")).toBe(true);
  expect(lim.allow("c")).toBe(false);
  now += 60_001; // slide fully past the window
  expect(lim.allow("c")).toBe(true);
});

test("a dropped (over-cap) message does not extend the window", () => {
  let now = 1_000_000;
  const lim = new PeerBurstLimiter(1, 60_000, () => now);
  expect(lim.allow("c")).toBe(true); // hit at t=1_000_000
  now += 30_000;
  expect(lim.allow("c")).toBe(false); // dropped — must NOT record t=1_030_000
  now += 30_001; // now 60_001 past the ONLY real hit
  expect(lim.allow("c")).toBe(true); // budget freed because the drop wasn't counted
});
