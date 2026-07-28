import { expect, test } from "bun:test";
import { createFrontendScreenshotHook, type FrontendScreenshotDeps, type ScreenshotTicketRef } from "./screenshot.ts";
import type { Logger } from "../types.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;

const TICKET: ScreenshotTicketRef = { id: "tkt-1", identifier: "OPS-1", originChannel: "chan-1" };

interface Harness {
  changedFilesCalls: Array<{ workspace: string; baseRef: string }>;
  serveCalls: string[];
  screenshotCalls: string[];
  attachCalls: Array<{ ticket: ScreenshotTicketRef; png: string }>;
  stopped: number;
}

function makeHook(over: Partial<FrontendScreenshotDeps> = {}): { hook: ReturnType<typeof createFrontendScreenshotHook>; h: Harness } {
  const h: Harness = { changedFilesCalls: [], serveCalls: [], screenshotCalls: [], attachCalls: [], stopped: 0 };
  const deps: FrontendScreenshotDeps = {
    changedFiles: async (workspace, baseRef) => {
      h.changedFilesCalls.push({ workspace, baseRef });
      return ["web/App.tsx"];
    },
    serve: async (repoRoot) => {
      h.serveCalls.push(repoRoot);
      return { url: "http://127.0.0.1:5000/", stop: async () => { h.stopped++; } };
    },
    screenshot: async (url) => {
      h.screenshotCalls.push(url);
      return "/tmp/shot.png";
    },
    attach: async (ticket, png) => {
      h.attachCalls.push({ ticket, png });
    },
    logger: quiet,
    ...over,
  };
  return { hook: createFrontendScreenshotHook(deps), h };
}

test("frontend ticket → serve, screenshot, attach in order", async () => {
  const { hook, h } = makeHook();
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "base9" });
  expect(outcome).toEqual({ status: "attached", pngPath: "/tmp/shot.png" });
  expect(h.changedFilesCalls).toEqual([{ workspace: "/ws", baseRef: "base9" }]);
  expect(h.serveCalls).toEqual(["/ws"]);
  expect(h.screenshotCalls).toEqual(["http://127.0.0.1:5000/"]);
  expect(h.attachCalls).toEqual([{ ticket: TICKET, png: "/tmp/shot.png" }]);
  expect(h.stopped).toBe(1); // local server always torn down
});

test("non-frontend ticket is untouched — no serve, no capture, no attach", async () => {
  const { hook, h } = makeHook({ changedFiles: async () => ["src/dispatch/dispatcher.ts", "README.md"] });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "base9" });
  expect(outcome.status).toBe("skipped");
  expect(h.serveCalls).toEqual([]);
  expect(h.screenshotCalls).toEqual([]);
  expect(h.attachCalls).toEqual([]);
  expect(h.stopped).toBe(0);
});

test("nothing serveable → skipped, no capture/attach", async () => {
  const { hook, h } = makeHook({ serve: async () => null });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "b" });
  expect(outcome.status).toBe("skipped");
  expect(h.screenshotCalls).toEqual([]);
  expect(h.attachCalls).toEqual([]);
});

test("a capture that yields no screenshot skips attach but still stops the server", async () => {
  const { hook, h } = makeHook({ screenshot: async () => null });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "b" });
  expect(outcome.status).toBe("skipped");
  expect(h.attachCalls).toEqual([]);
  expect(h.stopped).toBe(1);
});

test("a throwing screenshot never rejects, is skipped, and still stops the server", async () => {
  const { hook, h } = makeHook({
    screenshot: async () => {
      throw new Error("chromium exploded");
    },
  });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "b" });
  expect(outcome.status).toBe("skipped");
  expect(h.attachCalls).toEqual([]);
  expect(h.stopped).toBe(1); // finally-block teardown ran despite the throw
});

test("a throwing attach never rejects the ticket's finish", async () => {
  const { hook, h } = makeHook({
    attach: async () => {
      throw new Error("discord down");
    },
  });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "b" });
  expect(outcome.status).toBe("skipped");
  expect(h.stopped).toBe(1);
});

test("a changed-files read failure is skipped, not thrown", async () => {
  const { hook, h } = makeHook({
    changedFiles: async () => {
      throw new Error("git gone");
    },
  });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "b" });
  expect(outcome.status).toBe("skipped");
  expect(h.serveCalls).toEqual([]);
});

test("overall timeout is enforced and never rejects", async () => {
  const { hook, h } = makeHook({
    timeoutMs: 20,
    serve: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { url: "http://x/", stop: async () => { h.stopped++; } };
    },
  });
  const outcome = await hook.capture({ ticket: TICKET, workspace: "/ws", baseRef: "b" });
  expect(outcome.status).toBe("skipped");
  if (outcome.status === "skipped") expect(outcome.reason).toContain("timed out");
});
