/**
 * Per-person memory books over the canonical MemoryStore markdown graph.
 *
 * A person file is `people/<discord-user-id>.md` — a `person`-type node whose NAME is the Discord
 * snowflake, so "who is this id" is one file lookup and everything I know about them lives in it:
 * how they want to be addressed, the free-text notes that used to sit in `identities.json`, and
 * `[[wikilinks]]` out to the memories that are really about them. Sibling to the open-loop ledger
 * (`loops.ts`) and the calibration ledger (`calibration.ts`) — same markdown substrate, same
 * `MemoryStore.remember` write path, same "invalid files are simply absent" tolerance.
 *
 * The division of labour with `src/discord/identity.ts` is deliberate and load-bearing:
 * `identities.json` stays the STRUCTURED, fast id → address map that the per-turn stamp reads on
 * every single turn (it must never parse markdown), and this module is the standing home for
 * everything else. The json points at the file; the file holds the knowledge.
 *
 * PRIVACY: person files are written at `visibility: owner` by default and never public. They are
 * exactly where contact info and real-world identity accumulate, so they must not reach MEMORY.md
 * (public-only) or a non-owner recall. Every read here gates through `canView` like any other node.
 */

import type { MemoryNode } from "../types.ts";
import type { MemoryStore } from "./index.ts";
import { type Audience, canView, SELF_AUDIENCE } from "./search.ts";

/** A Discord snowflake — also the person node's name, hence `people/<discord-user-id>.md`. */
const SNOWFLAKE = /^\d{1,20}$/;

/** How many body lines the session-start block renders before collapsing to a pointer. */
const PERSON_BLOCK_LINES = 24;

export interface PersonEntry {
  node: MemoryNode;
  /** The Discord user id this file is about — the node name, so the join with the turn stamp is exact. */
  discordId: string;
  /** What to call them, mirrored from `identities.json` so the file reads standalone. */
  address?: string;
  /** Live Discord display name last seen, mirrored for the same reason. */
  displayName?: string;
  /** True only for the configured owner (mirrors `UserIdentity.is_owner`). */
  isOwner: boolean;
  /** The memory book itself: notes, history, `[[links]]` to related memories. */
  notes: string;
}

export interface ListPeopleOptions {
  discordId?: string;
  audience?: Audience;
}

/**
 * Read person files directly from the store's freshly-built graph — no ranking, Moss, embeddings,
 * or model path. A `person` node whose name is not a snowflake (a legacy hand-written person note)
 * is deliberately absent: this collection is keyed on the Discord id, exactly like the turn stamp.
 * Sorted by id so output is deterministic.
 */
export function listPeople(store: MemoryStore, opts: ListPeopleOptions = {}): PersonEntry[] {
  const entries: PersonEntry[] = [];
  for (const node of store.buildGraph().nodes.values()) {
    const entry = asPerson(node);
    if (!entry || !canView(node, opts.audience)) continue;
    if (opts.discordId && entry.discordId !== opts.discordId) continue;
    entries.push(entry);
  }
  return entries.sort((a, b) => a.discordId.localeCompare(b.discordId));
}

/** One person's file, or null when there is none (or the audience may not see it). */
export function getPerson(
  store: MemoryStore,
  discordId: string,
  audience: Audience = SELF_AUDIENCE,
): PersonEntry | null {
  if (!SNOWFLAKE.test(discordId)) return null;
  return listPeople(store, { discordId, audience })[0] ?? null;
}

/**
 * Render the compact, bounded block that loads a speaker's memory book into the session they're
 * talking in — the same shape (and the same tolerances) as the per-channel calibration bar.
 * Scoped HARD to one Discord id: nobody else's file can appear. Empty string (no tag) when this id
 * has no file, so a turn for an unknown person is byte-identical to what it was before. The
 * `try/catch` is load-bearing: a broken or absent memory directory must NEVER break a turn.
 */
export function renderPersonBlock(
  store: MemoryStore | null | undefined,
  discordId: string | null | undefined,
  audience: Audience = SELF_AUDIENCE,
): string {
  if (!store || !discordId) return "";
  try {
    const person = getPerson(store, discordId, audience);
    // An empty book says nothing the turn stamp doesn't already carry — render no block at all
    // rather than an empty tag the model has to read past.
    if (!person || !person.notes.trim()) return "";
    // Address only — deliberately NOT `role:owner`. Authority is the live, code-stamped turn
    // header; a stored file must never be able to assert it (doctrine: "the stamp is authority").
    const header = person.address ? `address:${JSON.stringify(person.address)}` : "";
    const all = person.notes.split("\n");
    const lines = all.slice(0, PERSON_BLOCK_LINES);
    if (all.length > lines.length) {
      lines.push(`+${all.length - lines.length} more lines — run \`beckett recall ${discordId}\``);
    }
    const open = `<person user:${discordId}${header ? ` ${header}` : ""}>`;
    return `${open}\n${lines.join("\n").trim()}\n</person>`;
  } catch {
    // A broken memory directory must never keep a turn from being answered.
    return "";
  }
}

export interface UpsertPersonInput {
  /** Discord user id — becomes the node name, and therefore `people/<id>.md`. */
  discordId: string;
  /** What to call them (mirrors `identities.json`'s resolved address). */
  address?: string;
  /** Live Discord display name (mirrors `identities.json`). */
  displayName?: string;
  /** Mark the configured owner. */
  isOwner?: boolean;
  /**
   * Free text to record. Appended as a dated note UNDER whatever the file already says — a person
   * file accretes, it is never overwritten by the next thing someone types.
   */
  note?: string;
  /** Node names to link as related memories; materialized as `[[links]]` in the body. */
  links?: string[];
  /** Logged into the memory git commit, like remember's reason. */
  reason?: string;
  /** Testable clock for the dated note stamp. */
  today?: string;
}

/**
 * Create or update a person file through MemoryStore (which owns markdown rendering, atomic
 * writes, backlinks, the index and the git commit). Creating is idempotent and additive: an
 * existing file keeps its whole authored body, and a `note` is appended to it rather than
 * replacing it. Visibility is forced to `owner` — this is where contact info and real-world
 * identity land, and neither may ever reach the public index.
 */
export async function upsertPerson(store: MemoryStore, input: UpsertPersonInput): Promise<PersonEntry> {
  const discordId = input.discordId?.trim() ?? "";
  if (!SNOWFLAKE.test(discordId)) throw new Error(`invalid discord id: ${input.discordId}`);
  const existing = getPerson(store, discordId, SELF_AUDIENCE);

  const address = input.address?.trim() || existing?.address;
  const displayName = input.displayName?.trim() || existing?.displayName;
  const isOwner = input.isOwner ?? existing?.isOwner ?? false;

  const metadata: Record<string, unknown> = { discord_id: discordId, visibility: "owner" };
  if (address) metadata.address = address;
  if (displayName) metadata.display_name = displayName;
  if (isOwner) metadata.role = "owner";

  const note = input.note?.trim();
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  // Every note is DATED — a person file is a ledger of observations, not a set of eternal claims.
  // A multi-line note gets the stamp on its own line so a whole section still reads as prose.
  const stamped = note ? `**Note (${today}):**${note.includes("\n") ? "\n\n" : " "}${note}` : "";
  const kept = existing?.notes.trim() ?? "";
  const links = (input.links ?? [])
    .filter((l) => /^[a-z0-9-]+$/.test(l))
    .map((l) => `[[${l}]]`)
    // A link the book already carries is not restated — same rule as remember's applyLinks.
    .filter((wl) => !kept.includes(wl) && !stamped.includes(wl));
  const body = [kept, stamped, ...new Set(links)].filter(Boolean).join("\n\n");

  const node = await store.remember({
    op: existing ? "update" : "create",
    name: discordId,
    type: "person",
    // Never empty (remember rejects that) and never a raw address alone — the id keeps two
    // people with the same nickname from colliding on remember's similarity dedup.
    description: describePerson(discordId, address, displayName, isOwner),
    metadata,
    body,
    source: "manual",
    reason: input.reason ?? "person file via CLI",
  });
  const entry = asPerson(node);
  if (!entry) throw new Error(`person file '${discordId}' could not be read after write`);
  return entry;
}

/** The one-line hook: who this id is, in the terms the turn stamp uses. */
function describePerson(
  discordId: string,
  address: string | undefined,
  displayName: string | undefined,
  isOwner: boolean,
): string {
  const who = address || displayName || "unnamed";
  return `${who}${isOwner ? " (owner)" : ""} — person file for discord user ${discordId}`;
}

/** Parse a graph node into a person entry, or null if it fails the record contract. */
function asPerson(node: MemoryNode): PersonEntry | null {
  if (node.phantom || node.type !== "person") return null;
  // The name IS the Discord id; a person node named anything else is a legacy prose note, not a
  // per-id memory book, and must never be returned for an id lookup.
  if (!SNOWFLAKE.test(node.name)) return null;
  const m = node.metadata;
  const address = typeof m.address === "string" && m.address.trim() ? m.address.trim() : undefined;
  const displayName =
    typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : undefined;
  return {
    node,
    discordId: node.name,
    ...(address ? { address } : {}),
    ...(displayName ? { displayName } : {}),
    isOwner: m.role === "owner",
    notes: node.body,
  };
}
