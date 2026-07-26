import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import {
  AdvanceOutbox,
  classifyAdvanceError,
  MAX_PERMANENT_ADVANCE_ATTEMPTS,
  type AdvanceOperation,
} from "./advance-outbox.ts";

const quiet = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

/** A logger that records every line so a test can assert warn/info volume. */
function recording(): { logger: Logger; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    info(msg) { infos.push(msg); },
    warn(msg) { warns.push(msg); },
    debug() {},
    error() {},
    child() { return logger; },
  };
  return { logger, warns, infos };
}

/** A tracker error carrying an HTTP status, shaped like `BoredApiError`. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(logger: Logger = quiet): { outbox: AdvanceOutbox; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-advance-outbox-unit-"));
  temps.push(dir);
  const path = join(dir, "advance-outbox.jsonl");
  return { outbox: new AdvanceOutbox(path, logger), path };
}

function op(id: string): AdvanceOperation {
  return {
    id,
    ticketId: `ticket-${id}`,
    state: "done",
    comment: `advance ${id}`,
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

function ids(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as AdvanceOperation).id);
}

test("an append during an in-flight drain survives for the next replay", async () => {
  const { outbox, path } = setup();
  outbox.append(op("old"));

  await outbox.drain(async () => {
    outbox.append(op("new"));
  });

  expect(ids(path)).toEqual(["new"]);
  const applied: string[] = [];
  await outbox.drain(async (queued) => {
    applied.push(queued.id);
  });
  expect(applied).toEqual(["new"]);
});

test("overlapping drains coalesce instead of applying one row twice", async () => {
  const { outbox } = setup();
  outbox.append(op("once"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const applied: string[] = [];

  const first = outbox.drain(async (queued) => {
    applied.push(queued.id);
    await gate;
  });
  const second = outbox.drain(async (queued) => {
    applied.push(`duplicate-${queued.id}`);
  });
  release();

  expect(await first).toBe(1);
  expect(await second).toBe(1);
  expect(applied).toEqual(["once"]);
});

test("an interrupted drain sidecar replays before preserving newly appended rows", async () => {
  const { outbox, path } = setup();
  writeFileSync(`${path}.draining`, JSON.stringify(op("interrupted")) + "\n");
  outbox.append(op("new"));
  const applied: string[] = [];

  await outbox.drain(async (queued) => {
    applied.push(queued.id);
  });

  expect(applied).toEqual(["interrupted"]);
  expect(ids(path)).toEqual(["new"]);
  expect(existsSync(`${path}.draining`)).toBe(false);
});

test("restart recovery deduplicates an operation present in both files", async () => {
  const { outbox, path } = setup();
  writeFileSync(`${path}.draining`, JSON.stringify(op("same")) + "\n");
  outbox.append(op("same"));
  const applied: string[] = [];

  await outbox.drain(async (queued) => {
    applied.push(queued.id);
  });
  await outbox.drain(async (queued) => {
    applied.push(queued.id);
  });

  expect(applied).toEqual(["same"]);
});

test("a done-not-parked 409 is treated as satisfied and dequeued, not retried", async () => {
  const { logger, warns, infos } = recording();
  const { outbox, path } = setup(logger);
  outbox.append(op("80")); // op("80").state === "done"

  const applied = await outbox.drain(async () => {
    // The tracker gate rejects a redundant `done` advance because the run is already done.
    throw httpError(409, "run #80 is done, not parked");
  });

  // The advance is satisfied: counted as applied, removed from the outbox, and never warned about
  // during replay (the only warn is the enqueue notice from append()).
  expect(applied).toBe(1);
  expect(ids(path)).toEqual([]);
  expect(warns).toEqual(["queued tracker advance for retry"]);
  expect(infos.filter((m) => m.includes("already satisfied")).length).toBe(1);
});

test("a permanent 4xx is dropped after a bounded number of attempts with one warn", async () => {
  const { logger, warns } = recording();
  const { outbox, path } = setup(logger);
  outbox.append(op("bad"));

  let calls = 0;
  const drainOnce = () =>
    outbox.drain(async () => {
      calls += 1;
      throw httpError(400, "bad request: state transition not allowed");
    });

  // Retry until it drops. It must give up within the bounded attempt budget.
  for (let i = 0; i < MAX_PERMANENT_ADVANCE_ATTEMPTS + 2 && ids(path).length > 0; i++) {
    await drainOnce();
  }

  expect(ids(path)).toEqual([]);
  expect(calls).toBe(MAX_PERMANENT_ADVANCE_ATTEMPTS);
  // Exactly one visible give-up line — never a per-tick warn (the enqueue notice aside).
  expect(warns.filter((m) => m !== "queued tracker advance for retry")).toEqual([
    "giving up on unresolvable tracker advance",
  ]);
});

test("transient failures keep retrying with the existing per-tick warn", async () => {
  const { logger, warns } = recording();
  const { outbox, path } = setup(logger);
  outbox.append(op("flaky"));

  for (const err of [httpError(503, "service unavailable"), httpError(0, "network error: ECONNREFUSED")]) {
    await outbox.drain(async () => { throw err; });
  }

  // Still queued after repeated transient failures, and each tick surfaced a warn (unbounded retry).
  expect(ids(path)).toEqual(["flaky"]);
  expect(warns.filter((m) => m !== "queued tracker advance for retry")).toEqual([
    "queued tracker advance still failing",
    "queued tracker advance still failing",
  ]);
});

test("classifyAdvanceError distinguishes satisfied, permanent, and transient", () => {
  const done = op("x"); // state: done
  expect(classifyAdvanceError(httpError(409, "run #80 is done, not parked"), done)).toBe("satisfied");
  // The `parked` precondition it merely mentions must NOT read as satisfied for a `parked` advance.
  expect(classifyAdvanceError(httpError(409, "run #80 is done, not parked"), { ...done, state: "parked" }))
    .toBe("permanent");
  expect(classifyAdvanceError(httpError(400, "malformed body"), done)).toBe("permanent");
  expect(classifyAdvanceError(httpError(503, "service unavailable"), done)).toBe("transient");
  expect(classifyAdvanceError(httpError(0, "network error on POST: ECONNREFUSED"), done)).toBe("transient");
  expect(classifyAdvanceError(new Error("something weird"), done)).toBe("transient");
});
