import { expect, test } from "bun:test";
import { createTrackerClient } from "./client.ts";
import { BoredClient } from "../bored/client.ts";
import { validateConfig } from "../config.ts";

test("createTrackerClient constructs the bored client (the one tracker)", () => {
  const client = createTrackerClient({ config: validateConfig({}) });
  expect(client).toBeInstanceOf(BoredClient);
  expect(client.board()).toBe("ops");
});

test("createTrackerClient scopes to the requested board", () => {
  const client = createTrackerClient({ config: validateConfig({}), board: "int" });
  expect(client.board()).toBe("int");
});
