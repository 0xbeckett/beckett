import { expect, test } from "bun:test";
import { BoredApiError, BoredClient } from "./client.ts";
import type { Config } from "../types.ts";

const quiet = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as never;
})();
const config = {
  plane: {
    base_url: "https://plane.test", workspace_slug: "beckett", poll_secs: 5, default_board: "ops",
    boards: { ops: { project_slug: "ops", state_map: {
      backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", cancelled: "Cancelled",
    } } },
  },
} as unknown as Config;
const ticket = (state: string = "todo") => ({
  ref: "#1", title: "Ticket", body: "work", criteria: ["works"], state, needs: [],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

function privateReq(client: BoredClient, method: string, path: string): Promise<unknown> {
  return (client as unknown as { req(method: string, path: string): Promise<unknown> }).req(method, path);
}
function captureRetryDelays(client: BoredClient): number[] {
  const delays: number[] = [];
  (client as unknown as { sleep(ms: number): Promise<void> }).sleep = async (ms) => { delays.push(ms); };
  return delays;
}

test("bored defaults to the managed loopback service", () => {
  const client = new BoredClient({ config, logger: quiet, fetch });
  expect((client as unknown as { apiBase: string }).apiBase).toBe("http://127.0.0.1:7770");
});

test("req retries transient 5xx responses and not caller errors", async () => {
  let calls = 0;
  const retrying = (async () => {
    calls++;
    return calls === 1 ? new Response("try later", { status: 503, headers: { "Retry-After": "0" } }) : Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const client = new BoredClient({ config, logger: quiet, fetch: retrying });
  const delays = captureRetryDelays(client);
  await expect(privateReq(client, "GET", "/health")).resolves.toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(delays).toEqual([0]);

  const rejected = new BoredClient({ config, logger: quiet, fetch: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch });
  await expect(privateReq(rejected, "GET", "/health")).rejects.toBeInstanceOf(BoredApiError);
});

test("list, create, state, journal comments, and cancellation use bored HTTP endpoints", async () => {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let current = ticket();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ method, path: u.pathname, body });
    if (method === "GET" && u.pathname === "/tickets") return Response.json({ tickets: [current] });
    if (method === "POST" && u.pathname === "/tickets") return Response.json({ ticket: current });
    if (method === "GET" && u.pathname === "/tickets/%231") return Response.json({ ticket: current });
    if (method === "POST" && u.pathname === "/tickets/%231/staff") {
      current = ticket("in_progress"); return Response.json({ ticket: current });
    }
    if (method === "POST" && u.pathname === "/tickets/%231/pause") return Response.json({ ticket: ticket("in_review") });
    if (method === "POST" && u.pathname === "/tickets/%231/cancel") return Response.json({ ticket: ticket("cancelled") });
    if (method === "POST" && u.pathname === "/tickets/%231/nudge") return Response.json({ receipt: { target: "implement#v1" } });
    if (method === "GET" && u.pathname === "/tickets/%231/events") return Response.json({ events: [
      { seq: 7, timestamp: "2026-01-01T00:00:01Z", type: "nudge_delivered", text: "ship it" },
    ] });
    if (method === "GET" && u.pathname === "/health") return Response.json({ ok: true });
    throw new Error(`unexpected bored route: ${method} ${u.pathname}`);
  }) as unknown as typeof fetch;
  const client = new BoredClient({ config, logger: quiet, fetch: fetchImpl });

  await expect(client.listIssues()).resolves.toMatchObject([{ id: "#1", identifier: "#1" }]);
  const created = await client.createIssue({ title: "Ticket", body: "work", criteria: ["works"], casting: { implement: { harness: "pi" } }, state: "in_progress" });
  expect(created.state).toBe("in_progress");
  expect(requests.find((request) => request.method === "POST" && request.path === "/tickets")?.body).toMatchObject({
    title: "Ticket", criteria: ["works"], autoStaff: false,
  });
  await client.setState("#1", "in_review");
  await client.setState("#1", "cancelled");
  await expect(client.addComment("#1", "status")).resolves.toMatchObject({ body: "status", author: "beckett" });
  await expect(client.listComments("#1")).resolves.toEqual([{
    id: "#1:event:7", ticketId: "#1", author: "bored", body: "ship it", createdAt: "2026-01-01T00:00:01Z",
  }]);
  await expect(client.setState("#1", "done")).rejects.toMatchObject({ status: 501 });
  expect(requests.map((request) => `${request.method} ${request.path}`)).toContain("POST /tickets/%231/staff");
});
