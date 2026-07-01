/**
 * Coverage for PlaneClient's HTTP reliability wrapper: bounded retry on transient failures, no
 * retry on caller errors.
 */

import { expect, test } from "bun:test";
import { PlaneApiError, PlaneClient } from "./client.ts";
import type { Config } from "../types.ts";

const quiet = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

const config = {
  plane: {
    base_url: "https://plane.test",
    workspace_slug: "beckett",
    project_slug: "ops",
    state_map: {
      backlog: "Backlog",
      todo: "Todo",
      in_progress: "In Progress",
      in_review: "In Review",
      done: "Done",
      cancelled: "Cancelled",
    },
  },
} as unknown as Config;

function privateReq(client: PlaneClient, method: string, path: string): Promise<unknown> {
  return (client as unknown as { req(method: string, path: string): Promise<unknown> }).req(method, path);
}

test("req retries transient 5xx responses", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("try later", { status: 503, headers: { "Retry-After": "0" } });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ config, token: "tok", logger: quiet, fetch: fetchImpl });

  await expect(privateReq(client, "GET", "https://plane.test/x")).resolves.toEqual({ ok: true });
  expect(calls).toBe(2);
});

test("req does not retry non-transient 4xx responses", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("bad", { status: 400 });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ config, token: "tok", logger: quiet, fetch: fetchImpl });

  await expect(privateReq(client, "GET", "https://plane.test/x")).rejects.toBeInstanceOf(PlaneApiError);
  expect(calls).toBe(1);
});
