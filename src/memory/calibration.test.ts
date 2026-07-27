/** Per-channel calibration ledger reads/writes stay in the canonical MemoryStore. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type MemoryStore } from "./index.ts";
import { createCalibration, listCalibration, renderCalibrationBlock } from "./calibration.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): { memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-calibration-"));
  dirs.push(dir);
  return { memory: createMemory({ memoryDir: dir, logger: quiet, git: false }), dir };
}

async function seed(
  memory: MemoryStore,
  name: string,
  channel: string,
  about: string,
  kind = "veto",
  observed = "2026-07-27",
  extra: Record<string, unknown> = {},
) {
  await memory.remember({
    op: "create",
    name,
    type: "calibration",
    description: `[${kind}] ${about}`,
    body: "",
    metadata: { kind, channel, about, reason: `reason for ${name}`, created: `${observed}T00:00:00.000Z`, ...extra },
    source: `source-for-${name}`,
    reason: "test",
  });
}

test("lists valid records most-recent-first and ignores malformed ones", async () => {
  const { memory, dir } = store();
  await seed(memory, "old", "111", "class-a", "veto", "2026-07-01");
  await seed(memory, "new", "111", "class-b", "hit", "2026-07-20");
  await seed(memory, "mid", "111", "class-c", "veto", "2026-07-10");
  // Valid memory markdown but an invalid calibration contract (no channel) — one bad file cannot poison reads.
  writeFileSync(
    join(dir, "calibration", "bad.md"),
    "---\nname: bad\ndescription: broken record\nmetadata:\n  type: calibration\n  kind: veto\n  about: nope\n  reason: no channel\n---\n",
  );

  const records = listCalibration(memory, { audience: SELF_AUDIENCE });
  expect(records.map((r) => r.node.name)).toEqual(["new", "mid", "old"]);
  expect(records.map((r) => r.observed)).toEqual(["2026-07-20", "2026-07-10", "2026-07-01"]);
});

test("--channel and --about filters narrow the list", async () => {
  const { memory } = store();
  await seed(memory, "a-here", "111", "replay-missed", "veto", "2026-07-02");
  await seed(memory, "b-here", "111", "localhost-links", "veto", "2026-07-03");
  await seed(memory, "c-there", "222", "replay-missed", "veto", "2026-07-04");

  expect(listCalibration(memory, { channel: "111", audience: SELF_AUDIENCE }).map((r) => r.node.name)).toEqual([
    "b-here", "a-here",
  ]);
  expect(listCalibration(memory, { about: "replay-missed", audience: SELF_AUDIENCE }).map((r) => r.node.name)).toEqual([
    "c-there", "a-here",
  ]);
  expect(
    listCalibration(memory, { channel: "111", about: "replay-missed", audience: SELF_AUDIENCE }).map((r) => r.node.name),
  ).toEqual(["a-here"]);
});

test("renderCalibrationBlock is channel-scoped, bounded to 10, and empty when the channel has none", async () => {
  const { memory } = store();
  // Records in another channel must never appear.
  await seed(memory, "other-room", "999", "elsewhere", "veto", "2026-06-01");
  expect(renderCalibrationBlock(memory, "111")).toBe("");

  for (let i = 0; i < 12; i++) {
    await seed(memory, `rec-${String(i).padStart(2, "0")}`, "111", `class-${i}`, "veto", `2026-07-${String(i + 1).padStart(2, "0")}`);
  }
  const block = renderCalibrationBlock(memory, "111");
  expect(block.startsWith("<calibration>")).toBe(true);
  expect(block.endsWith("</calibration>")).toBe(true);
  expect(block).not.toContain("elsewhere");
  const bodyLines = block.split("\n").slice(1, -1);
  expect(bodyLines).toHaveLength(11); // 10 records + the overflow pointer
  expect(bodyLines[10]).toBe("+2 more — run `beckett calibration`");
  // Newest first: 2026-07-12 leads.
  expect(bodyLines[0]).toMatch(/^- \[veto\] 2026-07-12 class-11 — "/);
});

test("a malformed or unreadable memory directory makes the block render empty rather than throwing", () => {
  // A store pointed at a path that cannot be read as a memory tree must never throw out of the
  // renderer — a broken directory can never stop a chat session from launching.
  const broken = {
    buildGraph() {
      throw new Error("memory directory is on fire");
    },
  } as unknown as MemoryStore;
  expect(() => renderCalibrationBlock(broken, "111")).not.toThrow();
  expect(renderCalibrationBlock(broken, "111")).toBe("");
  // A null store or a missing channel id short-circuits to "" too.
  expect(renderCalibrationBlock(null, "111")).toBe("");
});

test("calibration reads use recall's fail-closed visibility gate", async () => {
  const { memory } = store();
  await seed(memory, "public-rec", "111", "public-class");
  await seed(memory, "owner-rec", "111", "owner-class", "veto", "2026-07-27", { visibility: "owner" });
  await seed(memory, "dm-rec", "111", "dm-class", "veto", "2026-07-27", { visibility: "dm", dm_with: "881122334455667788" });

  expect(listCalibration(memory, { channel: "111" }).map((r) => r.node.name)).toEqual(["public-rec"]);
  expect(listCalibration(memory, { channel: "111", audience: SELF_AUDIENCE }).map((r) => r.node.name).sort()).toEqual([
    "owner-rec", "public-rec",
  ]);
  expect(renderCalibrationBlock(memory, "111")).not.toContain("dm-class");
});

test("createCalibration writes a conventional record through MemoryStore with provenance", async () => {
  const { memory, dir } = store();
  const entry = await createCalibration(memory, {
    kind: "veto",
    channel: "1520986792373911622",
    about: "Replay Killed Routine Run", // slugified on write
    reason: "nah its fine",
    source: "https://discord.com/channels/x/y/z",
    observed: "2026-07-27",
    by: "1151230208783945818",
    byName: "ro",
  });
  expect(entry.kind).toBe("veto");
  expect(entry.about).toBe("replay-killed-routine-run");
  expect(entry.channel).toBe("1520986792373911622");
  expect(entry.observed).toBe("2026-07-27");

  const raw = readFileSync(entry.node.path, "utf8");
  expect(raw).toContain("type: calibration");
  expect(raw).toContain("kind: veto");
  expect(raw).toContain("about: replay-killed-routine-run");
  expect(raw).toContain("source_name: ro");

  // Re-read from a cold store: the record round-trips and the source link landed in metadata.source.
  const fresh = createMemory({ memoryDir: dir, logger: quiet, git: false });
  const reread = listCalibration(fresh, { channel: "1520986792373911622", audience: SELF_AUDIENCE });
  expect(reread).toHaveLength(1);
  expect(reread[0]!.source).toBe("https://discord.com/channels/x/y/z");
});

test("createCalibration rejects missing required fields", async () => {
  const { memory } = store();
  const base = { kind: "veto" as const, channel: "111", about: "x", reason: "y", source: "z" };
  expect(createCalibration(memory, { ...base, channel: "  " })).rejects.toThrow("--channel is required");
  expect(createCalibration(memory, { ...base, about: "  " })).rejects.toThrow("--about is required");
  expect(createCalibration(memory, { ...base, reason: "  " })).rejects.toThrow("--reason is required");
  expect(createCalibration(memory, { ...base, source: "  " })).rejects.toThrow("--source is required");
});
