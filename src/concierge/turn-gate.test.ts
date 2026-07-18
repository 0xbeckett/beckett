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

test("a priority acquire jumps ahead of earlier normal waiters (issue #120)", async () => {
  const gate = new TurnGate(1);
  const order: string[] = [];
  const holder = await gate.acquire();
  const normalA = gate.acquire().then((r) => {
    order.push("normalA");
    return r;
  });
  const normalB = gate.acquire().then((r) => {
    order.push("normalB");
    return r;
  });
  const person = gate.acquire(true).then((r) => {
    order.push("person");
    return r;
  });
  expect(gate.stats().waiting).toBe(3);
  holder();
  (await person)();
  (await normalA)();
  (await normalB)();
  expect(order).toEqual(["person", "normalA", "normalB"]);
  expect(gate.stats()).toEqual({ limit: 1, active: 0, waiting: 0 });
});

test("FIFO holds among same-class waiters — priority behind earlier priority, normal behind normal", async () => {
  const gate = new TurnGate(1);
  const order: string[] = [];
  const holder = await gate.acquire();
  const track = (name: string, priority: boolean) =>
    gate.acquire(priority).then((r) => {
      order.push(name);
      return r;
    });
  const normal1 = track("normal1", false);
  const person1 = track("person1", true);
  const normal2 = track("normal2", false);
  const person2 = track("person2", true);
  holder();
  (await person1)();
  (await person2)();
  (await normal1)();
  (await normal2)();
  expect(order).toEqual(["person1", "person2", "normal1", "normal2"]);
});

test("a priority waiter takes a released slot by direct handoff without overshooting", async () => {
  const gate = new TurnGate(1);
  const first = await gate.acquire();
  let personIn = false;
  const person = gate.acquire(true).then((r) => {
    personIn = true;
    return r;
  });
  expect(gate.saturated()).toBeTrue();
  first();
  // The handoff keeps the slot occupied — a racing fresh acquire must queue, not steal it.
  const thief = gate.acquire().then((r) => r);
  const release = await person;
  expect(personIn).toBeTrue();
  expect(gate.saturated()).toBeTrue();
  release();
  (await thief)();
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
