/**
 * SessionPool (OPS-80 §9.3): per-channel session routing, true cross-channel concurrency, the
 * fixed-session legacy mode, launch-failure recovery, meta correlation, and the live-child
 * economics (LRU recycle under the cap).
 */
import { expect, test } from "bun:test";
import { SessionPool, GLOBAL_SCOPE, type PoolSession } from "./session-pool.ts";
import { ConciergeSession, type TurnMessage } from "./index.ts";
import { TurnGate } from "./turn-gate.ts";
import { validateConfig } from "../config.ts";

interface FakeSession extends PoolSession {
  scope: string;
  asks: TurnMessage[];
  startCalls: number;
  stopCalls: number;
  recycles: string[];
  meta: unknown;
  live: boolean;
  depth: number;
  resolveAsk: (reply: string) => void;
}

function fakeSession(scope: string, opts: { deferAsks?: boolean } = {}): FakeSession {
  let pendingResolve: ((reply: string) => void) | null = null;
  const s: FakeSession = {
    scope,
    asks: [],
    startCalls: 0,
    stopCalls: 0,
    recycles: [],
    meta: null,
    live: true,
    depth: 0,
    resolveAsk: (reply: string) => pendingResolve?.(reply),
    start: async () => {
      s.startCalls += 1;
    },
    stop: async () => {
      s.stopCalls += 1;
    },
    ask: (m: TurnMessage) => {
      s.asks.push(m);
      if (!opts.deferAsks) return Promise.resolve(`reply:${scope}`);
      return new Promise<string>((resolve) => {
        pendingResolve = resolve;
      });
    },
    queueDepth: () => s.depth,
    currentSessionId: () => `sid-${scope}`,
    getCurrentMeta: () => s.meta,
    stats: () => ({ scope }),
    recycle: (reason: string) => {
      s.recycles.push(reason);
      s.live = false;
    },
    hasLiveChild: () => s.live,
  };
  return s;
}

function pool(opts: {
  scope?: "channel" | "global";
  maxLive?: number;
  fixed?: PoolSession;
  defer?: boolean;
  made?: FakeSession[];
}) {
  const made = opts.made ?? [];
  return new SessionPool({
    scope: opts.scope ?? "channel",
    maxLiveSessions: opts.maxLive ?? 6,
    idleRecycleMs: 0,
    makeSession: (scope) => {
      const s = fakeSession(scope, { deferAsks: opts.defer ?? false });
      made.push(s);
      return s;
    },
    ...(opts.fixed ? { fixedSession: opts.fixed } : {}),
  });
}

test("channel scope: each channel gets its own started session; repeat use reuses it", async () => {
  const made: FakeSession[] = [];
  const p = pool({ made });
  await p.ask("chan-a", "hi a");
  await p.ask("chan-b", "hi b");
  await p.ask("chan-a", "again a");
  expect(made.map((s) => s.scope).sort()).toEqual(["chan-a", "chan-b"]);
  expect(made.find((s) => s.scope === "chan-a")!.asks).toEqual(["hi a", "again a"]);
  expect(made.find((s) => s.scope === "chan-a")!.startCalls).toBe(1);
  expect(p.sessionIdFor("chan-b")).toBe("sid-chan-b");
});

test("global scope: every channel collapses to one session", async () => {
  const made: FakeSession[] = [];
  const p = pool({ scope: "global", made });
  await p.ask("chan-a", "one");
  await p.ask("chan-b", "two");
  expect(made).toHaveLength(1);
  expect(made[0]!.scope).toBe(GLOBAL_SCOPE);
  expect(made[0]!.asks).toEqual(["one", "two"]);
});

test("a slow turn in one channel does not block another channel's turn", async () => {
  const made: FakeSession[] = [];
  const p = pool({ made, defer: true });
  const slow = p.ask("chan-slow", "long think");
  // chan-slow's ask is admitted but unresolved; chan-fast must complete independently.
  const fastPool = p.ask("chan-fast", "quick one");
  await new Promise((r) => setTimeout(r, 0)); // let both asks pass their session-ready await
  expect(made.find((s) => s.scope === "chan-slow")!.asks).toEqual(["long think"]);
  made.find((s) => s.scope === "chan-fast")!.resolveAsk("done fast");
  expect(await fastPool).toBe("done fast");
  made.find((s) => s.scope === "chan-slow")!.resolveAsk("done slow");
  expect(await slow).toBe("done slow");
});

test("fixed session: all scopes route to it; warm() starts it exactly once", async () => {
  const fixed = fakeSession(GLOBAL_SCOPE);
  const made: FakeSession[] = [];
  const p = pool({ fixed, made });
  await p.warm("anything");
  await p.warm("anything-else");
  await p.ask("chan-a", "one");
  await p.ask("chan-b", "two");
  expect(fixed.startCalls).toBe(1);
  expect(fixed.asks).toEqual(["one", "two"]);
  expect(made).toHaveLength(0); // the factory is never consulted
});

test("a failed launch surfaces to the caller and the next ask retries fresh", async () => {
  let attempts = 0;
  const made: FakeSession[] = [];
  const p = new SessionPool({
    scope: "channel",
    maxLiveSessions: 6,
    idleRecycleMs: 0,
    makeSession: (scope) => {
      attempts += 1;
      const s = fakeSession(scope);
      if (attempts === 1) s.start = async () => Promise.reject(new Error("spawn failed"));
      made.push(s);
      return s;
    },
  });
  await expect(p.ask("chan-a", "first")).rejects.toThrow("spawn failed");
  expect(await p.ask("chan-a", "second")).toBe("reply:chan-a");
  expect(attempts).toBe(2);
});

test("currentMetas reports every executing turn; tracksMeta spots meta-blind fakes", async () => {
  const made: FakeSession[] = [];
  const p = pool({ made });
  await p.ask("chan-a", "x");
  await p.ask("chan-b", "y");
  made[0]!.meta = { channelId: "chan-a", messageId: "m1" };
  made[1]!.meta = { channelId: "chan-b", messageId: "m2" };
  expect(p.currentMetas()).toHaveLength(2);
  expect(p.tracksMeta()).toBeTrue();

  const blind = fakeSession(GLOBAL_SCOPE);
  delete (blind as Partial<FakeSession>).getCurrentMeta;
  const p2 = pool({ fixed: blind });
  expect(p2.tracksMeta()).toBeFalse();
});

test("live-child cap recycles the least-recently-used idle session, never a busy one", async () => {
  const made: FakeSession[] = [];
  const p = pool({ made, maxLive: 2 });
  await p.ask("chan-a", "a");
  await p.ask("chan-b", "b");
  const a = made.find((s) => s.scope === "chan-a")!;
  const b = made.find((s) => s.scope === "chan-b")!;
  b.depth = 1; // busy — must never be recycled
  await p.ask("chan-c", "c"); // third live child; cap is 2 → LRU idle (chan-a) recycles
  expect(a.recycles).toHaveLength(1);
  expect(b.recycles).toHaveLength(0);
  expect(made.find((s) => s.scope === "chan-c")!.recycles).toHaveLength(0);
});

test("stopAll stops every session and refuses new scopes", async () => {
  const made: FakeSession[] = [];
  const p = pool({ made });
  await p.ask("chan-a", "a");
  await p.ask("chan-b", "b");
  await p.stopAll();
  expect(made.every((s) => s.stopCalls === 1)).toBeTrue();
  expect(() => p.sessionFor("chan-c")).toThrow("stopped");
});

test("stats aggregates per-scope session stats under perSession", async () => {
  const p = pool({ made: [] });
  await p.ask("chan-a", "a");
  const stats = p.stats() as { sessions: number; perSession: Record<string, unknown> };
  expect(stats.sessions).toBe(1);
  expect(Object.keys(stats.perSession)).toEqual(["chan-a"]);
});

// ── the gate inside real ConciergeSessions (pump integration, no child spawned) ──────────────

test("a shared TurnGate serializes turns across two real sessions at limit 1", async () => {
  const config = validateConfig({});
  const gate = new TurnGate(1);
  const events: string[] = [];
  const makePatched = (name: string) => {
    const s = new ConciergeSession({ config, scope: name, gate });
    (s as unknown as { runTurn(m: TurnMessage): Promise<string> }).runTurn = async (m: TurnMessage) => {
      events.push(`${name}:start:${String(m)}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`${name}:end:${String(m)}`);
      return `${name}-reply`;
    };
    return s;
  };
  const a = makePatched("a");
  const b = makePatched("b");
  const [ra, rb] = await Promise.all([a.ask("1"), b.ask("2")]);
  expect(ra).toBe("a-reply");
  expect(rb).toBe("b-reply");
  // With one slot, the two turns never interleave: each start is followed by its own end.
  for (let i = 0; i < events.length; i += 2) {
    expect(events[i]!.replace(":start:", ":end:")).toBe(events[i + 1]!);
  }
});

test("with two slots, turns in different sessions genuinely overlap", async () => {
  const config = validateConfig({});
  const gate = new TurnGate(2);
  let active = 0;
  let peak = 0;
  const makePatched = (name: string) => {
    const s = new ConciergeSession({ config, scope: name, gate });
    (s as unknown as { runTurn(m: TurnMessage): Promise<string> }).runTurn = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return `${name}-reply`;
    };
    return s;
  };
  const sessions = [makePatched("a"), makePatched("b"), makePatched("c")];
  await Promise.all(sessions.map((s, i) => s.ask(String(i))));
  expect(peak).toBe(2);
});
