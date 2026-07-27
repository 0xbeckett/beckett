import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserLeaseCapExceededError,
  createBetterWrightRuntime,
  type BetterWrightClient,
} from "./betterwright.ts";
import type { BrowserHostSettings, BrowserLease } from "./runtime.ts";
import type { Logger } from "../types.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

interface RunCall {
  code: string;
  session: string;
  approvedDownloads: boolean;
  seq: number;
}

interface FakeResult {
  ok?: boolean;
  result?: unknown;
  error?: string;
  events?: unknown[];
  artifacts?: Array<Record<string, unknown>>;
  pages?: Array<Record<string, unknown>>;
  console?: unknown[];
  durationMs?: number;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A configurable stand-in for the betterwright client — no real browser. */
class FakeBetterWright implements BetterWrightClient {
  downloadPolicy: "ask" | "allow" | "deny" = "ask";
  closed = false;
  readonly closedSessions: string[] = [];
  readonly calls: RunCall[] = [];
  private seq = 0;

  constructor(
    private readonly handler?: (call: RunCall) => Promise<FakeResult> | FakeResult,
  ) {}

  async run(code: string, options?: { session?: string; approvedDownloads?: boolean }): Promise<unknown> {
    const call: RunCall = {
      code,
      session: options?.session ?? "default",
      approvedDownloads: options?.approvedDownloads ?? false,
      seq: this.seq++,
    };
    this.calls.push(call);
    const raw = this.handler ? await this.handler(call) : {};
    return {
      ok: raw.ok ?? true,
      result: raw.result ?? null,
      error: raw.error,
      events: raw.events ?? [`${call.session}:evt`],
      artifacts: raw.artifacts ?? [],
      pages: raw.pages ?? [{ url: "about:blank", title: "", active: true }],
      console: raw.console ?? [],
      durationMs: raw.durationMs ?? 1,
    };
  }

  async closeSession(session?: string): Promise<unknown> {
    this.closedSessions.push(session ?? "default");
    return { ok: true, closed: true, pagesClosed: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "beckett-bw-adapter-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function settingsFor(): BrowserHostSettings {
  return {
    profileDir: join(scratch, "profile"),
    artifactsRoot: join(scratch, "artifacts"),
    headless: true,
    viewportWidth: 1440,
    viewportHeight: 900,
    launchTimeoutMs: 30_000,
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 30_000,
    evalTimeoutMs: 60_000,
    maxOutputChars: 24_000,
  };
}

function leaseFor(runId: string): BrowserLease {
  return {
    runId,
    channelId: null,
    artifactsDir: join(scratch, "artifacts", runId),
    controlToken: "test-control-token-0123456789abcdef0123456789abcdef",
  };
}

test("two leases acquired back to back are both live, each on its own session", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
  });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    expect(runtime.hasLease("alpha")).toBe(true);
    expect(runtime.hasLease("beta")).toBe(true);
    expect(runtime.sessions().sort()).toEqual(["alpha", "beta"]);
    // Each lease warmed its own session — no cross-session bleed.
    const warmSessions = fake.calls.filter((call) => call.code.includes("page.url()")).map((call) => call.session);
    expect(warmSessions.sort()).toEqual(["alpha", "beta"]);
  } finally {
    await runtime.stop();
  }
});

test("calls within one lease stay strictly ordered", async () => {
  const gate = deferred<void>();
  const fake = new FakeBetterWright(async (call) => {
    if (call.code.includes("FIRST")) await gate.promise;
    return {};
  });
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    const first = runtime.evaluate("alpha", "return 'FIRST'");
    const second = runtime.evaluate("alpha", "return 'SECOND'");
    // Second must not reach the client until first resolves — same lane.
    await Bun.sleep(20);
    expect(fake.calls.some((call) => call.code.includes("SECOND"))).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    const evalCalls = fake.calls.filter((call) => call.code.includes("return '"));
    expect(evalCalls.map((call) => call.code)).toEqual(["return 'FIRST'", "return 'SECOND'"]);
  } finally {
    await runtime.stop();
  }
});

test("different leases run concurrently instead of queueing behind each other", async () => {
  const gate = deferred<void>();
  const fake = new FakeBetterWright(async (call) => {
    if (call.code.includes("SLOW")) await gate.promise;
    return {};
  });
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    const slowAlpha = runtime.evaluate("alpha", "return 'SLOW'");
    // Beta's call completes while alpha is still blocked — lanes are independent.
    const quickBeta = await runtime.evaluate("beta", "return 'QUICK'");
    expect(quickBeta.value).toBeNull();
    expect(fake.calls.some((call) => call.code.includes("QUICK"))).toBe(true);
    gate.resolve();
    await slowAlpha;
  } finally {
    await runtime.stop();
  }
});

test("the per-lease event ring does not leak across leases", async () => {
  const fake = new FakeBetterWright((call) => ({ events: [`${call.session}#${call.seq}`] }));
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    const a = await runtime.evaluate("alpha", "return 1");
    const b = await runtime.evaluate("beta", "return 2");
    expect(a.events.every((event) => event.startsWith("alpha#"))).toBe(true);
    expect(b.events.every((event) => event.startsWith("beta#"))).toBe(true);
    expect(a.events.some((event) => event.startsWith("beta#"))).toBe(false);
    expect(b.events.some((event) => event.startsWith("alpha#"))).toBe(false);
  } finally {
    await runtime.stop();
  }
});

test("proof capture is per-lease and lands under each lease's own artifacts dir", async () => {
  const shot = join(scratch, "capture.png");
  writeFileSync(shot, PNG_SIGNATURE);
  const fake = new FakeBetterWright((call) => {
    if (call.code.includes("screenshot(")) {
      return { result: { kind: "proof" }, artifacts: [{ kind: "proof", media: `MEDIA:${shot}` }] };
    }
    return {};
  });
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    const alphaProof = await runtime.capture("alpha", "proof-auto");
    const betaProof = await runtime.capture("beta", "proof-auto");
    expect(alphaProof).toContain(join("artifacts", "alpha"));
    expect(betaProof).toContain(join("artifacts", "beta"));
    expect(alphaProof).not.toBe(betaProof);
    expect(readFileSync(alphaProof).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    // The screenshot request rode each lease's own session.
    const shotSessions = fake.calls.filter((call) => call.code.includes("screenshot(")).map((call) => call.session);
    expect(shotSessions.sort()).toEqual(["alpha", "beta"]);
  } finally {
    await runtime.stop();
  }
});

test("acquiring past the default cap of 3 throws a catchable error rather than hanging", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, { createBrowser: () => fake });
  try {
    expect(runtime.maxConcurrentLeases).toBe(3);
    await runtime.acquire(leaseFor("one"));
    await runtime.acquire(leaseFor("two"));
    await runtime.acquire(leaseFor("three"));
    let caught: unknown;
    try {
      await runtime.acquire(leaseFor("four"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserLeaseCapExceededError);
    expect((caught as BrowserLeaseCapExceededError).cap).toBe(3);
    expect(runtime.hasLease("four")).toBe(false);
    // A slot frees up on release, so the same runtime keeps serving.
    await runtime.release("one", false);
    await runtime.acquire(leaseFor("four"));
    expect(runtime.hasLease("four")).toBe(true);
  } finally {
    await runtime.stop();
  }
});

test("the cap is configurable via BECKETT_BROWSER_MAX_LEASES", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    env: { BECKETT_BROWSER_MAX_LEASES: "2" },
  });
  try {
    expect(runtime.maxConcurrentLeases).toBe(2);
    await runtime.acquire(leaseFor("one"));
    await runtime.acquire(leaseFor("two"));
    await expect(runtime.acquire(leaseFor("three"))).rejects.toBeInstanceOf(BrowserLeaseCapExceededError);
  } finally {
    await runtime.stop();
  }
});

test("the kill switch pins the cap to one lease and restores the old busy error", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    env: { BECKETT_BROWSER_SINGLE_LEASE: "1" },
  });
  try {
    expect(runtime.maxConcurrentLeases).toBe(1);
    await runtime.acquire(leaseFor("solo"));
    await expect(runtime.acquire(leaseFor("second"))).rejects.toThrow("busy with run solo");
    expect(runtime.hasLease("second")).toBe(false);
  } finally {
    await runtime.stop();
  }
});

test("the kill switch also engages via the singleLease dep override", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    singleLease: true,
    // A higher configured cap must not override the kill switch.
    maxLeases: 5,
  });
  try {
    expect(runtime.maxConcurrentLeases).toBe(1);
  } finally {
    await runtime.stop();
  }
});

test("one lease tripping the profile budget does not blind or kill another", async () => {
  let profileSize = 10;
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    measureProfileBytes: async () => profileSize,
    maxProfileGrowthBytes: 100,
    maxProfileBytes: 10_000,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha")); // baseline 10
    profileSize = 200;
    await runtime.acquire(leaseFor("beta")); // baseline 200

    // alpha's growth 200-10 = 190 exceeds its 100-byte allowance → alpha is blocked.
    await expect(runtime.evaluate("alpha", "return 1")).rejects.toThrow("profile storage budget exceeded");
    // beta acquired at 200; growth 0 is within budget → beta keeps working.
    const betaResult = await runtime.evaluate("beta", "return 2");
    expect(betaResult.value).toBeNull();

    // alpha stays tripped; beta is still not blinded by alpha's breach.
    await expect(runtime.evaluate("alpha", "return 3")).rejects.toThrow("profile storage budget exceeded");
    const betaAgain = await runtime.evaluate("beta", "return 4");
    expect(betaAgain.value).toBeNull();
  } finally {
    await runtime.stop();
  }
});

test("the global profile ceiling binds every lease regardless of its own baseline", async () => {
  let profileSize = 10;
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    measureProfileBytes: async () => profileSize,
    maxProfileGrowthBytes: 10_000,
    maxProfileBytes: 500,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha"));
    // Push the shared profile past the absolute ceiling; the growth allowance is huge,
    // so only the global ceiling can catch this.
    profileSize = 600;
    await expect(runtime.evaluate("alpha", "return 1")).rejects.toThrow("profile storage budget exceeded");
  } finally {
    await runtime.stop();
  }
});

describe("the per-session download approval gate", () => {
  test("approval is sent per call, does not leak, and survives another lease's release", async () => {
    const fake = new FakeBetterWright();
    const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
      createBrowser: () => fake,
      maxLeases: 5,
    });
    try {
      await runtime.acquire(leaseFor("alpha"));
      await runtime.acquire(leaseFor("beta"));
      runtime.approveDownloads("alpha");
      await runtime.evaluate("alpha", "return 'A'");
      await runtime.evaluate("beta", "return 'B'");

      // Approval is transport metadata on this run, not a mutable worker-wide
      // policy. Beta never receives alpha's approval.
      const alphaCall = fake.calls.find((call) => call.code === "return 'A'");
      const betaCall = fake.calls.find((call) => call.code === "return 'B'");
      expect(alphaCall?.approvedDownloads).toBe(true);
      expect(betaCall?.approvedDownloads).toBe(false);
      expect(fake.downloadPolicy).toBe("ask");

      // Releasing alpha must neither restart the worker nor affect beta's own
      // approval bit; beta can still run with its explicit approval.
      runtime.approveDownloads("beta");
      await runtime.release("alpha", false);
      await runtime.evaluate("beta", "return 'B after alpha release'");
      const betaAfterRelease = fake.calls.find((call) => call.code === "return 'B after alpha release'");
      expect(betaAfterRelease?.approvedDownloads).toBe(true);
      expect(fake.downloadPolicy).toBe("ask");
    } finally {
      await runtime.stop();
    }
  });
});

test("releasing a lease closes only its own betterwright session", async () => {
  const fake = new FakeBetterWright();
  const runtime = createBetterWrightRuntime(settingsFor(), quietLog, {
    createBrowser: () => fake,
    maxLeases: 5,
  });
  try {
    await runtime.acquire(leaseFor("alpha"));
    await runtime.acquire(leaseFor("beta"));
    await runtime.release("alpha", false);
    expect(fake.closedSessions).toEqual(["alpha"]);
    expect(runtime.hasLease("alpha")).toBe(false);
    expect(runtime.hasLease("beta")).toBe(true);
  } finally {
    await runtime.stop();
  }
});
