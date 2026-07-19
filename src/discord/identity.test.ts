/**
 * Tests for the Discord identity map (OPS-42) — the per-user known/preferred name store.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIdentities,
  saveIdentities,
  getIdentity,
  upsertIdentity,
  resolveAddress,
  ensureSeeded,
} from "./identity.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-identity-"));
  file = join(dir, "identities.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "111111111111111111";
const ALICE = "222222222222222222";

test("missing file loads as an empty map, never throws", () => {
  expect(loadIdentities(file)).toEqual({});
  expect(getIdentity(file, ALICE)).toBeUndefined();
});

test("corrupt file degrades to empty rather than throwing", () => {
  writeFileSync(file, "{ not json ][", "utf8");
  expect(loadIdentities(file)).toEqual({});
  writeFileSync(file, JSON.stringify([1, 2, 3]), "utf8"); // array, not an object
  expect(loadIdentities(file)).toEqual({});
});

test("upsert creates then merges, only touching supplied fields", () => {
  upsertIdentity(file, ALICE, { display_name: "alice#0" }, 1000);
  let rec = getIdentity(file, ALICE)!;
  expect(rec.display_name).toBe("alice#0");
  expect(rec.created_at).toBe(1000);

  // Refresh display name later — must NOT clobber a preferred_address we set in between.
  upsertIdentity(file, ALICE, { preferred_address: "Ali" }, 2000);
  upsertIdentity(file, ALICE, { display_name: "alice#1" }, 3000);
  rec = getIdentity(file, ALICE)!;
  expect(rec.preferred_address).toBe("Ali");
  expect(rec.display_name).toBe("alice#1");
  expect(rec.created_at).toBe(1000); // preserved
  expect(rec.updated_at).toBe(3000);
});

test("empty-string patch clears a field", () => {
  upsertIdentity(file, ALICE, { preferred_address: "Ali" });
  upsertIdentity(file, ALICE, { preferred_address: "" });
  expect(getIdentity(file, ALICE)!.preferred_address).toBeUndefined();
});

test("upsert trims and skips no-op writes (updated_at unchanged when nothing changes)", () => {
  upsertIdentity(file, ALICE, { preferred_address: "  Ali  " }, 1000);
  expect(getIdentity(file, ALICE)!.preferred_address).toBe("Ali");
  const rec = upsertIdentity(file, ALICE, { preferred_address: "Ali" }, 5000);
  expect(rec.updated_at).toBe(1000); // no change → timestamp not bumped
});

test("upsert rejects a non-snowflake id", () => {
  expect(() => upsertIdentity(file, "not-an-id", { known_name: "x" })).toThrow();
});

test("resolveAddress priority: preferred → known (never the raw display name)", () => {
  expect(resolveAddress(undefined)).toBeUndefined();
  // A display name alone is NOT a deliberate address — resolveAddress stays undefined.
  expect(resolveAddress({ display_name: "d", created_at: 0, updated_at: 0 })).toBeUndefined();
  expect(resolveAddress({ known_name: "k", display_name: "d", created_at: 0, updated_at: 0 })).toBe(
    "k",
  );
  expect(
    resolveAddress({
      preferred_address: "p",
      known_name: "k",
      display_name: "d",
      created_at: 0,
      updated_at: 0,
    }),
  ).toBe("p");
});

test("ensureSeeded leaves a fresh map empty without a configured owner", () => {
  const oldId = process.env.DISCORD_OWNER_ID;
  const oldName = process.env.DISCORD_OWNER_NAME;
  delete process.env.DISCORD_OWNER_ID;
  delete process.env.DISCORD_OWNER_NAME;
  try {
    expect(ensureSeeded(file, undefined, undefined, 1000)).toBe(false);
    expect(loadIdentities(file)).toEqual({});
  } finally {
    if (oldId === undefined) delete process.env.DISCORD_OWNER_ID;
    else process.env.DISCORD_OWNER_ID = oldId;
    if (oldName === undefined) delete process.env.DISCORD_OWNER_NAME;
    else process.env.DISCORD_OWNER_NAME = oldName;
  }
});

test("ensureSeeded derives the initial identity from the configured owner", () => {
  ensureSeeded(file, OWNER, "Owner Name", 1000);
  const owner = getIdentity(file, OWNER)!;
  expect(owner.is_owner).toBe(true);
  expect(owner.known_name).toBe("Owner Name");

  // A user renaming themselves later must survive a re-seed.
  upsertIdentity(file, OWNER, { preferred_address: "boss" }, 2000);
  expect(ensureSeeded(file, OWNER, "Owner Name", 3000)).toBe(false);
  const after = getIdentity(file, OWNER)!;
  expect(after.preferred_address).toBe("boss");
  expect(after.is_owner).toBe(true);
});

test("ensureSeeded uses owner environment configuration by default", () => {
  const oldId = process.env.DISCORD_OWNER_ID;
  const oldName = process.env.DISCORD_OWNER_NAME;
  process.env.DISCORD_OWNER_ID = OWNER;
  process.env.DISCORD_OWNER_NAME = "Configured Owner";
  try {
    expect(ensureSeeded(file, undefined, undefined, 1000)).toBe(true);
    const owner = getIdentity(file, OWNER)!;
    expect(owner.is_owner).toBe(true);
    expect(owner.known_name).toBe("Configured Owner");
  } finally {
    if (oldId === undefined) delete process.env.DISCORD_OWNER_ID;
    else process.env.DISCORD_OWNER_ID = oldId;
    if (oldName === undefined) delete process.env.DISCORD_OWNER_NAME;
    else process.env.DISCORD_OWNER_NAME = oldName;
  }
});

test("ensureSeeded stamps ownership onto a pre-existing plain entry", () => {
  upsertIdentity(file, OWNER, { display_name: "owner-display" }, 1000);
  ensureSeeded(file, OWNER, "Owner Name", 2000);
  const owner = getIdentity(file, OWNER)!;
  expect(owner.is_owner).toBe(true);
  expect(owner.known_name).toBe("Owner Name"); // filled since none was chosen
});

test("save/load round-trips and writes a real file", () => {
  saveIdentities(file, { [ALICE]: { known_name: "Alice", created_at: 1, updated_at: 2 } });
  expect(existsSync(file)).toBe(true);
  expect(loadIdentities(file)[ALICE]!.known_name).toBe("Alice");
  // A garbage key in the payload is dropped on load.
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw["bad key!"] = { known_name: "nope", created_at: 0, updated_at: 0 };
  writeFileSync(file, JSON.stringify(raw), "utf8");
  expect(loadIdentities(file)["bad key!"]).toBeUndefined();
});
