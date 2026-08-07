/**
 * Discord `--ping` target resolution + mention rendering (issue #10)
 * =======================================================================================
 * The one shared place `--ping <target>` gets turned into a real, notifying Discord mention.
 * Every CLI surface that accepts `--ping` (discord reply/ack, task create/start, …) resolves
 * through {@link resolvePingTargets} once at send time, then renders with {@link renderMentions}.
 * Kept out of each call site because the resolution rules (id / `<@id>` / identity-map name) and
 * the render rules (dedupe, order-preserving, skip-if-already-in-body) must behave identically
 * everywhere a ping shows up, not just wherever they were implemented first.
 */

import { loadIdentities } from "./identity.ts";

const SNOWFLAKE = /^\d{1,20}$/;
const MENTION_BLOB = /^<@!?(\d{1,20})>$/;

/**
 * Resolve `--ping` targets to Discord user ids, in first-seen order, deduped. Accepts (in order
 * of preference) a raw snowflake, an already-wrapped `<@id>`/`<@!id>` blob, or a name known to the
 * identity map (`known_name` / `preferred_address` / `display_name`, case-insensitive).
 *
 * Throws — rather than dropping the target or sending a broken `<@name>` into the channel — when
 * any target resolves to nothing, naming every unresolved target and every name on file so the
 * caller can fix a typo immediately.
 */
export function resolvePingTargets(targets: string[], identitiesFile: string): string[] {
  const map = loadIdentities(identitiesFile);
  const byName = new Map<string, string>();
  for (const [id, identity] of Object.entries(map)) {
    for (const name of [identity.known_name, identity.preferred_address, identity.display_name]) {
      if (name) byName.set(name.toLowerCase(), id);
    }
  }

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const target = raw.trim();
    const wrapped = target.match(MENTION_BLOB)?.[1];
    const id = wrapped ?? (SNOWFLAKE.test(target) ? target : byName.get(target.toLowerCase()));
    if (!id) {
      unresolved.push(raw);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push(id);
  }

  if (unresolved.length > 0) {
    const known = [...new Set(byName.keys())].sort();
    throw new Error(
      `unknown --ping target${unresolved.length > 1 ? "s" : ""}: ${unresolved.join(", ")}` +
        (known.length > 0 ? ` — known names: ${known.join(", ")}` : " — no names are known yet"),
    );
  }
  return resolved;
}

/**
 * Prepend resolved mentions to outgoing message content: one space-joined line of `<@id>`
 * mentions (deduped, order-preserving), a newline, then the body unchanged. A mention already
 * present verbatim in the body is not added a second time. Returns `body` unchanged when there is
 * nothing left to add.
 */
export function renderMentions(body: string, userIds: string[]): string {
  const seen = new Set<string>();
  const line: string[] = [];
  for (const id of userIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const mention = `<@${id}>`;
    if (body.includes(mention)) continue;
    line.push(mention);
  }
  if (line.length === 0) return body;
  return `${line.join(" ")}\n${body}`;
}
