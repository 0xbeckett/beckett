import { expect, test } from "bun:test";
import { trackerKind } from "./client.ts";

test("tracker selector defaults to Plane and accepts bored", () => {
  expect(trackerKind({})).toBe("plane");
  expect(trackerKind({ BECKETT_TRACKER: "bored" })).toBe("bored");
  expect(trackerKind({ BECKETT_TRACKER: " PLANE " })).toBe("plane");
});

test("tracker selector rejects an accidental backend name", () => {
  expect(() => trackerKind({ BECKETT_TRACKER: "other" })).toThrow('BECKETT_TRACKER must be "plane" or "bored"');
});
