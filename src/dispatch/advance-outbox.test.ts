import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { AdvanceOutbox, type AdvanceOperation } from "./advance-outbox.ts";

const quiet = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { outbox: AdvanceOutbox; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-advance-outbox-unit-"));
  temps.push(dir);
  const path = join(dir, "advance-outbox.jsonl");
  return { outbox: new AdvanceOutbox(path, quiet), path };
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
