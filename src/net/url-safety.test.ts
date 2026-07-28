import { expect, test } from "bun:test";
import { isInternalUrl, isExternalHttpUrl } from "./url-safety.ts";

// ── isInternalUrl: every prohibited host form the Discord boundary redacts ────────────────────

test("isInternalUrl flags localhost and loopback host forms", () => {
  expect(isInternalUrl("http://localhost:5173/")).toBe(true);
  expect(isInternalUrl("http://127.0.0.1:8080")).toBe(true);
  expect(isInternalUrl("http://127.42.9.1/tickets")).toBe(true);
  expect(isInternalUrl("http://[::1]:3000")).toBe(true);
  expect(isInternalUrl("http://0.0.0.0/")).toBe(true);
  expect(isInternalUrl("http://worker.local/preview")).toBe(true);
  expect(isInternalUrl("http://local/")).toBe(true);
});

test("isInternalUrl flags every RFC-1918 private IPv4 range", () => {
  expect(isInternalUrl("http://10.0.0.5/")).toBe(true);
  expect(isInternalUrl("http://192.168.1.9:5173")).toBe(true);
  expect(isInternalUrl("http://172.16.0.1/")).toBe(true);
  expect(isInternalUrl("http://172.31.255.255/")).toBe(true);
  // 172.15 and 172.32 are public — the range is 16–31 only.
  expect(isInternalUrl("http://172.15.0.1/")).toBe(false);
  expect(isInternalUrl("http://172.32.0.1/")).toBe(false);
  // 192.167 is public — only 192.168 is private.
  expect(isInternalUrl("http://192.167.1.1/")).toBe(false);
});

test("isInternalUrl leaves public hosts and non-URLs alone", () => {
  expect(isInternalUrl("https://beckett.0xbeckett.me")).toBe(false);
  expect(isInternalUrl("https://my-branch-preview.0xbeckett.me/route")).toBe(false);
  expect(isInternalUrl("https://github.com/org/repo/pull/1")).toBe(false);
  expect(isInternalUrl("just some prose, not a url")).toBe(false);
  expect(isInternalUrl("8.8.8.8")).toBe(false); // bare host, not a URL
});

// ── isExternalHttpUrl: the gate a preview URL must pass before it is surfaced ─────────────────

test("isExternalHttpUrl accepts a public http(s) preview URL", () => {
  expect(isExternalHttpUrl("https://foo-preview.0xbeckett.me")).toBe(true);
  expect(isExternalHttpUrl("http://example.com/preview")).toBe(true);
});

test("isExternalHttpUrl fails closed on internal hosts and non-http schemes", () => {
  expect(isExternalHttpUrl("http://localhost:5173/")).toBe(false);
  expect(isExternalHttpUrl("http://127.0.0.1:8080")).toBe(false);
  expect(isExternalHttpUrl("http://10.1.2.3/")).toBe(false);
  expect(isExternalHttpUrl("ftp://example.com/x")).toBe(false);
  expect(isExternalHttpUrl("ws://preview.0xbeckett.me")).toBe(false);
  expect(isExternalHttpUrl("not a url at all")).toBe(false);
  expect(isExternalHttpUrl("")).toBe(false);
});
