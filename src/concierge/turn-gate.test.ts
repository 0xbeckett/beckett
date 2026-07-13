/**
 * TurnGate (OPS-80 §9.3): the cross-session concurrency cap. The properties that matter — the
 * limit is never overshot (even through the release→waiter handoff), waiters wake FIFO, release
 * is idempotent, and `saturated()` tells the fast-ack path the truth.
 */
import { expect, test } from "bun:test";
import { TurnGate } from "./turn-gate.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("bounds concurrent holders to the limit", async () => {
  const gate = new TurnGate(2);
  let active = 0;
  let peak = 0;
  const work = async () => {
    const release = await gate.acquire();
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
    release();
  };
  await Promise.all([work(), work(), work(), work(), work()]);
  expect(peak).toBe(2);
  expect(gate.stats()).toEqual({ limit: 2, active: 0, waiting: 0 });
});

test("a released slot hands off to the oldest waiter without overshooting", async () => {
  const gate = new TurnGate(1);
  const order: string[] = [];
  const first = await gate.acquire();
  const second = gate.acquire().then((r) => {
    order.push("second");
    return r;
  });
  const third = gate.acquire().then((r) => {
    order.push("third");
    return r;
  });
  expect(gate.stats().waiting).toBe(2);
  first();
  // A fresh acquire racing the handoff must queue behind the existing waiters, not steal the slot.
  const fourth = gate.acquire().then((r) => {
    order.push("fourth");
    return r;
  });
  (await second)();
  (await third)();
  (await fourth)();
  expect(order).toEqual(["second", "third", "fourth"]);
  expect(gate.stats()).toEqual({ limit: 1, active: 0, waiting: 0 });
});

test("release is idempotent — a double call frees exactly one slot", async () => {
  const gate = new TurnGate(1);
  const release = await gate.acquire();
  release();
  release();
  expect(gate.stats().active).toBe(0);
  const again = await gate.acquire();
  expect(gate.saturated()).toBeTrue();
  again();
});

test("saturated() flips exactly at the limit", async () => {
  const gate = new TurnGate(2);
  expect(gate.saturated()).toBeFalse();
  const a = await gate.acquire();
  expect(gate.saturated()).toBeFalse();
  const b = await gate.acquire();
  expect(gate.saturated()).toBeTrue();
  a();
  expect(gate.saturated()).toBeFalse();
  b();
});

test("rejects a nonsensical limit", () => {
  expect(() => new TurnGate(0)).toThrow();
  expect(() => new TurnGate(1.5)).toThrow();
});
