/**
 * Coverage for the Discord-origin marker round-trip (closed agent loop). The marker is how a
 * ticket remembers which conversation filed it, so worker/ticket updates can route back. It is
 * stored in the issue description and must survive Plane's HTML escape/unescape verbatim.
 */

import { expect, test } from "bun:test";
import { withOriginMarker, extractOriginMarker } from "./client.ts";
import { serializeCast, parseCast } from "./cast.ts";

const SNOWFLAKE = "1097283746520174592"; // a realistic Discord channel id

test("append → extract recovers the channel and strips the marker", () => {
  const stored = withOriginMarker("Build the thing.", SNOWFLAKE);
  const { channel, description } = extractOriginMarker(stored);
  expect(channel).toBe(SNOWFLAKE);
  expect(description).toBe("Build the thing.");
});

test("no channel is a no-op; nothing to extract later", () => {
  const stored = withOriginMarker("Build the thing.", undefined);
  expect(stored).toBe("Build the thing.");
  expect(extractOriginMarker(stored)).toEqual({ description: "Build the thing." });
});

test("description with no marker extracts cleanly (channel undefined)", () => {
  const { channel, description } = extractOriginMarker("just prose, no marker");
  expect(channel).toBeUndefined();
  expect(description).toBe("just prose, no marker");
});

test("survives an HTML escape/unescape cycle (what Plane does to description_html)", () => {
  // extractOriginMarker runs on htmlToText's DECODED output, so the marker is back to literal
  // angle brackets before the regex sees it — mirror that here to prove the round-trip holds.
  const stored = withOriginMarker("Ship it.", SNOWFLAKE);
  const escaped = stored.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const decoded = escaped.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  expect(extractOriginMarker(decoded).channel).toBe(SNOWFLAKE);
});

test("marker coexists with a cast block + criteria without corrupting either", () => {
  const description = serializeCast(
    { implement: { harness: "codex" } },
    ["does the thing", "tests pass"],
    "Prose body here.",
  );
  const stored = withOriginMarker(description, SNOWFLAKE);

  // The loop's reader strips the marker first, THEN parses cast/criteria off what remains.
  const { channel, description: cleaned } = extractOriginMarker(stored);
  expect(channel).toBe(SNOWFLAKE);

  const parsed = parseCast(cleaned);
  expect(parsed.casting).toEqual({ implement: { harness: "codex" } });
  expect(parsed.criteria).toEqual(["does the thing", "tests pass"]);
  expect(parsed.body).toBe("Prose body here.");
  // And the marker never leaks into the worker-facing body.
  expect(parsed.body).not.toContain("beckett-origin");
});
