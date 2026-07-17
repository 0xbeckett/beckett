import { expect, test } from "bun:test";
import { parseDiscordTurnOutput } from "./output.ts";

test("only a complete structured delivery object can become Discord text", () => {
  expect(parseDiscordTurnOutput({ decision: "send", message: "the tests pass" })).toEqual({
    decision: "send",
    message: "the tests pass",
  });
  expect(parseDiscordTurnOutput({ decision: "pass", message: null })).toEqual({ decision: "pass", message: null });

  // Assistant scratch text and old sentinel-shaped blobs are not a delivery protocol.
  expect(parseDiscordTurnOutput("I should stay quiet.\nPASS")).toBeNull();
  expect(parseDiscordTurnOutput({ decision: "pass", message: "PASS" })).toBeNull();
  expect(parseDiscordTurnOutput({ decision: "send", message: "" })).toBeNull();
});
