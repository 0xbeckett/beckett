/** Per-person memory books (`people/<discord-user-id>.md`) live in the canonical MemoryStore. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type MemoryStore } from "./index.ts";
import { getPerson, listPeople, renderPersonBlock, upsertPerson } from "./people.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";

const OWNER = "1151230208783945818";
const WORM = "324777864375566338";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): { memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-people-"));
  dirs.push(dir);
  return { memory: createMemory({ memoryDir: dir, logger: quiet, git: false }), dir };
}

test("a person file lands at people/<discord-user-id>.md and round-trips through a cold store", async () => {
  const { memory, dir } = store();
  const entry = await upsertPerson(memory, {
    discordId: OWNER,
    address: "Jason",
    displayName: "ro",
    isOwner: true,
    note: "GitHub @frgmt0 — attribution only.",
    links: ["jason-design-taste"],
    today: "2026-07-27",
  });
  expect(entry.node.path).toBe(join(dir, "people", `${OWNER}.md`));

  const raw = readFileSync(entry.node.path, "utf8");
  expect(raw).toContain(`name: "${OWNER}"`); // all-digit names MUST stay quoted strings
  expect(raw).toContain("type: person");
  expect(raw).toContain("address: Jason");
  expect(raw).toContain("role: owner");
  expect(raw).toContain("[[jason-design-taste]]");

  // A cold store re-reads it as a person entry — the file is canonical, nothing is cached.
  const fresh = createMemory({ memoryDir: dir, logger: quiet, git: false });
  const reread = getPerson(fresh, OWNER)!;
  expect(reread.discordId).toBe(OWNER);
  expect(reread.address).toBe("Jason");
  expect(reread.displayName).toBe("ro");
  expect(reread.isOwner).toBe(true);
  expect(reread.notes).toContain("**Note (2026-07-27):** GitHub @frgmt0 — attribution only.");
});

test("upsert preserves existing body content and appends the new note under it", async () => {
  const { memory } = store();
  await upsertPerson(memory, { discordId: WORM, address: "angry worm", note: "first thing", today: "2026-07-01" });
  const after = await upsertPerson(memory, { discordId: WORM, note: "second thing", today: "2026-07-02" });

  expect(after.notes).toContain("**Note (2026-07-01):** first thing");
  expect(after.notes).toContain("**Note (2026-07-02):** second thing");
  expect(after.notes.indexOf("first thing")).toBeLessThan(after.notes.indexOf("second thing"));
  // A patch that names no address must not lose the one already recorded.
  expect(after.address).toBe("angry worm");
});

test("person files are owner-scoped and never reach the public index", async () => {
  const { memory, dir } = store();
  await upsertPerson(memory, { discordId: OWNER, address: "Jason", note: "email lives here, not in channel" });

  // No audience ⇒ fail-closed: nothing comes back.
  expect(listPeople(memory)).toEqual([]);
  expect(listPeople(memory, { audience: SELF_AUDIENCE }).map((p) => p.discordId)).toEqual([OWNER]);
  expect(getPerson(memory, OWNER, { viewerId: "x", viewerRole: "member", context: "guild" })).toBeNull();

  const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(index).not.toContain(OWNER);
  expect(index).not.toContain("email lives here");
});

test("listPeople ignores person nodes that aren't keyed on a Discord id, and malformed files", async () => {
  const { memory, dir } = store();
  await upsertPerson(memory, { discordId: WORM, address: "angry worm" });
  // A legacy prose person note (name is not a snowflake) is not a per-id memory book.
  await memory.remember({
    op: "create",
    name: "jason",
    type: "person",
    description: "legacy hand-written person note",
    body: "",
    source: "manual",
    reason: "test",
  });
  // Valid memory markdown, wrong type — one odd file cannot poison reads.
  writeFileSync(
    join(dir, "people", "not-a-person.md"),
    "---\nname: not-a-person\ndescription: broken\nmetadata:\n  type: reference\n---\n",
  );

  expect(listPeople(memory, { audience: SELF_AUDIENCE }).map((p) => p.discordId)).toEqual([WORM]);
  expect(getPerson(memory, "jason")).toBeNull();
  expect(getPerson(memory, "not-a-snowflake")).toBeNull();
});

test("renderPersonBlock is id-scoped, bounded, and empty for an unknown id or broken store", async () => {
  const { memory } = store();
  await upsertPerson(memory, { discordId: OWNER, address: "Jason", isOwner: true, note: "owner note" });
  await upsertPerson(memory, { discordId: WORM, address: "angry worm", note: "worm note" });

  const block = renderPersonBlock(memory, OWNER);
  expect(block.startsWith(`<person user:${OWNER} address:"Jason">`)).toBe(true);
  // The file describes the person; it never asserts authority — that is the live turn stamp's job.
  expect(block).not.toContain("role:owner");
  expect(block.endsWith("</person>")).toBe(true);
  expect(block).toContain("owner note");
  // Nobody else's file can ride along.
  expect(block).not.toContain("worm note");

  // An id with no file renders nothing, so the turn is byte-identical to before.
  expect(renderPersonBlock(memory, "999888777666555444")).toBe("");
  expect(renderPersonBlock(memory, null)).toBe("");
  expect(renderPersonBlock(null, OWNER)).toBe("");

  const broken = {
    buildGraph() {
      throw new Error("memory directory is on fire");
    },
  } as unknown as MemoryStore;
  expect(() => renderPersonBlock(broken, OWNER)).not.toThrow();
  expect(renderPersonBlock(broken, OWNER)).toBe("");
});

test("renderPersonBlock collapses an overlong book to a bounded excerpt plus a pointer", async () => {
  const { memory } = store();
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  await upsertPerson(memory, { discordId: WORM, address: "angry worm", note: long });

  const lines = renderPersonBlock(memory, WORM).split("\n");
  // <person …>, 24 body lines, the pointer, </person>
  expect(lines).toHaveLength(27);
  expect(lines[25]).toBe(`+18 more lines — run \`beckett recall ${WORM}\``);
});

test("upsertPerson rejects a non-snowflake id", async () => {
  const { memory } = store();
  expect(upsertPerson(memory, { discordId: "not-an-id" })).rejects.toThrow("invalid discord id");
});
