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
    poll_secs: 5,
    default_board: "ops",
    boards: {
      ops: {
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
    },
  },
} as unknown as Config;

function configWithBoards(): Config {
  return {
    plane: {
      base_url: "https://plane.test",
      workspace_slug: "beckett",
      poll_secs: 5,
      default_board: "ops",
      boards: {
        ops: config.plane.boards.ops!,
        vid: {
          project_slug: "VID",
          state_map: {
            backlog: "Ideas",
            todo: "Scripting",
            in_progress: "Production",
            in_review: "Review",
            done: "Published",
            cancelled: "Shelved",
          },
        },
        vidpip: {
          project_slug: "VIDPIP",
          state_map: config.plane.boards.ops!.state_map,
        },
      },
    },
  } as unknown as Config;
}

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

/** Avoid real backoff waits while preserving the retry path and recording its delays. */
function captureRetryDelays(client: PlaneClient): number[] {
  const delays: number[] = [];
  (client as unknown as { sleep(ms: number): Promise<void> }).sleep = async (ms) => {
    delays.push(ms);
  };
  return delays;
}

test("req absorbs a 429 burst with capped exponential backoff and jitter", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 6) return new Response("rate limited", { status: 429 });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ config, token: "tok", logger: quiet, fetch: fetchImpl });
  const delays = captureRetryDelays(client);

  await expect(privateReq(client, "GET", "https://plane.test/x")).resolves.toEqual({ ok: true });
  expect(calls).toBe(7);
  expect(delays).toHaveLength(6);
  // Each window is exponential with up to 25% jitter; the last is capped at 30 seconds.
  expect(delays[0]).toBeGreaterThanOrEqual(1_000);
  expect(delays[0]).toBeLessThanOrEqual(1_250);
  expect(delays[1]).toBeGreaterThanOrEqual(2_000);
  expect(delays[1]).toBeLessThanOrEqual(2_500);
  expect(delays[4]).toBeGreaterThanOrEqual(16_000);
  expect(delays[4]).toBeLessThanOrEqual(20_000);
  expect(delays[5]).toBe(30_000);
});

test("provisioning creates a missing board/project workflow once and backs off on 429", async () => {
  const provisioningConfig = {
    plane: {
      base_url: "https://plane.test",
      workspace_slug: "beckett",
      poll_secs: 5,
      default_board: "int",
      boards: {
        int: {
          project_slug: "INT",
          state_map: {
            backlog: "Backlog", todo: "Todo", design: "Design", design_review: "Design Review",
            in_progress: "In Progress", in_review: "Review", done: "Done", cancelled: "Cancelled",
          },
        },
      },
    },
  } as unknown as Config;
  let project: { id: string; name: string; identifier: string } | null = null;
  const states: Array<{ id: string; name: string; group: string }> = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let projectLists = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    if (u.pathname.endsWith("/projects/") && method === "GET") {
      projectLists++;
      if (projectLists === 1) return new Response("slow down", { status: 429 });
      return Response.json({ results: project ? [project] : [] });
    }
    if (u.pathname.endsWith("/projects/") && method === "POST") {
      writes.push({ path: u.pathname, body: JSON.parse(String(init?.body)) });
      project = { id: "int-project", name: "INT", identifier: "INT" };
      return Response.json(project);
    }
    if (u.pathname.endsWith("/projects/int-project/states/") && method === "GET") return Response.json({ results: states });
    if (u.pathname.endsWith("/projects/int-project/states/") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      writes.push({ path: u.pathname, body });
      const state = { id: `s${states.length + 1}`, name: body.name, group: body.group };
      states.push(state);
      return Response.json(state);
    }
    throw new Error(`unexpected Plane route: ${method} ${u}`);
  }) as unknown as typeof fetch;

  const client = new PlaneClient({ config: provisioningConfig, token: "tok", logger: quiet, fetch: fetchImpl });
  const delays = captureRetryDelays(client);
  await expect(client.ensureProvisioned()).resolves.toEqual({
    projectCreated: true,
    statesCreated: ["Backlog", "Todo", "Design", "Design Review", "In Progress", "Review", "Done", "Cancelled"],
  });
  expect(delays[0]).toBeGreaterThanOrEqual(1_000);
  expect(writes[0]).toMatchObject({ body: { name: "INT", identifier: "INT" } });
  expect(writes.slice(1).map((w) => w.body)).toEqual([
    { name: "Backlog", group: "backlog" }, { name: "Todo", group: "unstarted" },
    { name: "Design", group: "started" }, { name: "Design Review", group: "unstarted" },
    { name: "In Progress", group: "started" }, { name: "Review", group: "started" },
    { name: "Done", group: "completed" }, { name: "Cancelled", group: "cancelled" },
  ]);

  // A fresh client represents the next deploy: it observes the same resources and sends no POSTs.
  const writesBeforeRerun = writes.length;
  const rerun = new PlaneClient({ config: provisioningConfig, token: "tok", logger: quiet, fetch: fetchImpl });
  await expect(rerun.ensureProvisioned()).resolves.toEqual({ projectCreated: false, statesCreated: [] });
  expect(writes).toHaveLength(writesBeforeRerun);
});

test("list, show, create, comment, and state calls retry their first 429", async () => {
  const attempts = new Map<string, number>();
  const issue = {
    id: "t1",
    name: "Ticket",
    description_html: "",
    state: "s1",
    project: "p1",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const key = `${method} ${u}`;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    if (count === 1) return new Response("rate limited", { status: 429 });

    const path = new URL(u).pathname;
    if (path.endsWith("/projects/")) {
      return Response.json({ results: [{ id: "p1", identifier: "OPS", name: "ops" }] });
    }
    if (path.endsWith("/states/")) {
      return Response.json({
        results: [
          { id: "s1", name: "Backlog" },
          { id: "s2", name: "Todo" },
          { id: "s3", name: "In Progress" },
          { id: "s4", name: "In Review" },
          { id: "s5", name: "Done" },
          { id: "s6", name: "Cancelled" },
        ],
      });
    }
    if (path.endsWith("/issues/t1/comments/")) {
      return method === "POST"
        ? Response.json({ id: "c1", comment_html: "<p>hello</p>", issue: "t1", created_at: "2026-01-01T00:00:00Z" })
        : Response.json({ results: [] });
    }
    if (path.endsWith("/issues/t1/") && method === "PATCH") return new Response(null, { status: 204 });
    if (path.endsWith("/issues/t1/")) return Response.json(issue);
    if (path.endsWith("/issues/")) return method === "POST" ? Response.json(issue) : Response.json({ results: [issue] });
    throw new Error(`unexpected Plane route: ${key}`);
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ config, token: "tok", logger: quiet, fetch: fetchImpl });
  captureRetryDelays(client);

  await expect(client.listIssues()).resolves.toHaveLength(1);
  await expect(client.getIssue("t1")).resolves.toMatchObject({ id: "t1" });
  await expect(client.createIssue({ title: "Ticket" })).resolves.toMatchObject({ id: "t1" });
  await expect(client.listComments("t1")).resolves.toEqual([]);
  await expect(client.addComment("t1", "hello")).resolves.toMatchObject({ id: "c1" });
  await expect(client.setState("t1", "done")).resolves.toBeUndefined();

  for (const route of [
    { method: "GET", path: "/projects/p1/issues/" },
    { method: "GET", path: "/projects/p1/issues/t1/" },
    { method: "POST", path: "/projects/p1/issues/" },
    { method: "GET", path: "/projects/p1/issues/t1/comments/" },
    { method: "POST", path: "/projects/p1/issues/t1/comments/" },
    { method: "PATCH", path: "/projects/p1/issues/t1/" },
  ]) {
    const calls = [...attempts.entries()].find(
      ([key]) => key.startsWith(`${route.method} `) && key.includes(route.path),
    );
    expect(calls?.[1]).toBe(2);
  }
});

// ── issue #33: the polling diet's client half ───────────────────────────────────────────────

/** Routing fetch fake: bootstrap (projects + states) plus caller-supplied routes, logging URLs. */
function dietFetch(route: (url: string) => Response | null, calls: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/states/")) {
      return Response.json({
        results: [
          { id: "s1", name: "Backlog" },
          { id: "s2", name: "Todo" },
          { id: "s3", name: "In Progress" },
          { id: "s4", name: "In Review" },
          { id: "s5", name: "Done" },
          { id: "s6", name: "Cancelled" },
        ],
      });
    }
    if (u.includes("/projects/") && !u.includes("/issues/")) {
      return Response.json({ results: [{ id: "p1", identifier: "OPS", name: "ops" }] });
    }
    return route(u) ?? Response.json({ results: [] });
  }) as unknown as typeof fetch;
}

test("listIssueHeads sweeps with fields=id,updated_at only", async () => {
  const calls: string[] = [];
  const fetchImpl = dietFetch((u) => {
    if (u.includes("/issues/")) {
      return Response.json({ results: [{ id: "t1", updated_at: "2026-01-01T00:00:00Z" }] });
    }
    return null;
  }, calls);
  const client = new PlaneClient({ config, token: "tok", logger: quiet, fetch: fetchImpl });

  const heads = await client.listIssueHeads();
  expect(heads).toEqual([{ id: "t1", updatedAt: "2026-01-01T00:00:00Z" }]);
  const sweep = calls.find((u) => u.includes("/issues/?") || u.includes("fields="));
  expect(sweep).toContain("fields=id%2Cupdated_at");
});

test("VID client files into the VID project and maps video states back to canonical", async () => {
  const calls: string[] = [];
  let createPayload: any = null;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/projects/") && !u.includes("/issues/") && !u.includes("/states/")) {
      return Response.json({
        results: [
          { id: "pops", identifier: "OPS", name: "beckett" },
          { id: "pvid", identifier: "VID", name: "Video" },
          { id: "pvidpip", identifier: "VIDPIP", name: "Video Pipeline" },
        ],
      });
    }
    if (u.includes("/projects/pvid/states/")) {
      return Response.json({
        results: [
          { id: "sv-ideas", name: "Ideas", group: "backlog" },
          { id: "sv-script", name: "Scripting", group: "unstarted" },
          { id: "sv-prod", name: "Production", group: "started" },
          { id: "sv-voice", name: "Voiceover", group: "started" },
          { id: "sv-render", name: "Render", group: "started" },
          { id: "sv-review", name: "Review", group: "started" },
          { id: "sv-pub", name: "Published", group: "completed" },
          { id: "sv-shelf", name: "Shelved", group: "cancelled" },
        ],
      });
    }
    if (u.endsWith("/projects/pvid/issues/") && init?.method === "POST") {
      createPayload = JSON.parse(String(init.body));
      return Response.json({
        id: "vid-issue-1",
        name: "Video task",
        state: createPayload.state,
        sequence_id: 7,
        project: "pvid",
        description_html: createPayload.description_html,
        updated_at: "2026-01-01T00:00:00Z",
      });
    }
    if (u.endsWith("/projects/pvid/issues/vid-issue-voice/")) {
      return Response.json({
        id: "vid-issue-voice",
        name: "Voiceover task",
        state: "sv-voice",
        sequence_id: 8,
        project: "pvid",
        updated_at: "2026-01-01T00:00:00Z",
      });
    }
    return Response.json({ results: [] });
  }) as unknown as typeof fetch;

  const client = new PlaneClient({ config: configWithBoards(), board: "vid", token: "tok", logger: quiet, fetch: fetchImpl });
  const created = await client.createIssue({ title: "Video task", state: "in_progress" });
  expect(createPayload.state).toBe("sv-prod");
  expect(created.identifier).toBe("VID-7");
  expect(created.state).toBe("in_progress");

  const voice = await client.getIssue("vid-issue-voice");
  expect(voice?.identifier).toBe("VID-8");
  expect(voice?.state).toBe("in_progress");
});

test("VIDPIP client files with the VIDPIP identifier", async () => {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/projects/") && !u.includes("/issues/") && !u.includes("/states/")) {
      return Response.json({ results: [{ id: "pvidpip", identifier: "VIDPIP", name: "Video Pipeline" }] });
    }
    if (u.includes("/projects/pvidpip/states/")) {
      return Response.json({
        results: ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"].map((name, i) => ({ id: `sp-${i}`, name })),
      });
    }
    if (u.endsWith("/projects/pvidpip/issues/") && init?.method === "POST") {
      const payload = JSON.parse(String(init.body));
      return Response.json({ id: "pip-1", name: "Pipeline task", state: payload.state, sequence_id: 3, project: "pvidpip", updated_at: "now" });
    }
    return Response.json({ results: [] });
  }) as unknown as typeof fetch;

  const client = new PlaneClient({ config: configWithBoards(), board: "vidpip", token: "tok", logger: quiet, fetch: fetchImpl });
  const created = await client.createIssue({ title: "Pipeline task", state: "todo" });
  expect(created.identifier).toBe("VIDPIP-3");
  expect(created.state).toBe("todo");
});

test("listComments stops paginating once a newest-first page reaches past `since`", async () => {
  const calls: string[] = [];
  let commentPage = 0;
  const fetchImpl = dietFetch((u) => {
    if (u.includes("/comments/")) {
      commentPage++;
      // Page 1 (newest-first) already reaches behind the cursor — page 2 must never be fetched.
      return Response.json({
        results: [
          { id: "new", created_at: "2026-01-01T00:00:20Z", comment_html: "<p>new</p>" },
          { id: "old", created_at: "2026-01-01T00:00:01Z", comment_html: "<p>old</p>" },
        ],
        next_page_results: true,
        next_cursor: "cursor-2",
      });
    }
    return null;
  }, calls);
  const client = new PlaneClient({ config, token: "tok", logger: quiet, fetch: fetchImpl });

  const comments = await client.listComments("t1", "2026-01-01T00:00:10Z");
  expect(commentPage).toBe(1); // early stop — the 200-comment history is never re-walked
  expect(comments.map((c) => c.id)).toEqual(["new"]); // filtered to strictly-after `since`, ascending
  expect(calls.find((u) => u.includes("/comments/"))).toContain("order_by=-created_at");
});
