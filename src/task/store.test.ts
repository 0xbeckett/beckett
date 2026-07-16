import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, displayTaskName } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { path: string; store: TaskStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-tasks-"));
  dirs.push(dir);
  const path = join(dir, "tasks.json");
  return { path, store: new TaskStore(path) };
}

test("creates durable sequential tasks with a numbered initial branch", async () => {
  const { path, store: first } = makeStore();
  const one = await first.createTask({ title: "  Voting   launch ", originChannelId: "c1" });
  const two = await first.createTask({ title: "Uploads" });

  expect(displayTaskName(one.task)).toBe("#1 - Voting launch");
  expect(one.branch.ref).toBe("1.1");
  expect(two.task.number).toBe(2);
  expect(new TaskStore(path).getTask("#1")?.originChannelId).toBe("c1");
  expect(JSON.parse(readFileSync(path, "utf8")).nextTaskNumber).toBe(3);
});

test("creates sibling and nested branches with validated dependencies", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });
  const api = await store.createBranch({ task: 1, title: "API", needs: ["1.1"] });
  const route = await store.createBranch({ task: 1, parentRef: api.ref, title: "Route" });

  expect(api).toMatchObject({ ref: "1.2", status: "waiting", needs: ["1.1"] });
  expect(route).toMatchObject({ ref: "1.2.1", parentRef: "1.2" });
  await expect(store.createBranch({ task: 1, title: "Bad", needs: ["9.1"] })).rejects.toThrow("no such dependency");
});

test("concurrent creators receive unique task numbers", async () => {
  const { path } = makeStore();
  const stores = Array.from({ length: 8 }, () => new TaskStore(path));
  const created = await Promise.all(stores.map((taskStore, index) => taskStore.createTask({ title: `Task ${index}` })));
  expect(created.map((row) => row.task.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("links internal tickets while keeping the public branch reference stable", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting", project: "polls" });
  const linked = await store.linkTicket(
    "#1.1",
    { id: "uuid", identifier: "OPS-143", board: "ops", projectId: "p1", url: "https://tracker.test/OPS-143" },
    "in_progress",
    "polls",
  );
  expect(linked).toMatchObject({ ref: "1.1", status: "running", ticket: { identifier: "OPS-143" } });
  expect(store.findByTicket("OPS-143")?.branch.ref).toBe("1.1");
});

test("a corrupt registry fails loudly instead of resetting task numbers", () => {
  const { path, store } = makeStore();
  writeFileSync(path, "{not-json", "utf8");
  expect(() => store.list()).toThrow("task registry");
});

test("start claims serialize the tracker create gap and clear after linking", async () => {
  const { path, store } = makeStore();
  await store.createTask({ title: "Voting" });
  const token = await store.reserveStart("1.1");
  await expect(new TaskStore(path).reserveStart("1.1")).rejects.toThrow("already being started");
  await store.releaseStart("1.1", "wrong-token");
  await expect(new TaskStore(path).reserveStart("1.1")).rejects.toThrow("already being started");
  await store.releaseStart("1.1", token);
  expect(typeof await store.reserveStart("1.1")).toBe("string");
});

test("records direct publication independently from pull-request metadata", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });
  await store.setPublication("1.1", {
    repo: "0xbeckett/voting",
    url: "https://github.com/0xbeckett/voting",
    kind: "pushed",
  });
  expect(store.getBranch("1.1")?.branch.publication).toEqual({
    repo: "0xbeckett/voting",
    url: "https://github.com/0xbeckett/voting",
    kind: "pushed",
  });
});

test("resuming implementation clears the previous final diff snapshot", async () => {
  const { store } = makeStore();
  const ticket = {
    id: "uuid",
    identifier: "OPS-143",
    board: "ops",
    projectId: "p1",
    url: "https://tracker.test/OPS-143",
  };
  await store.createTask({ title: "Voting" });
  await store.linkTicket("1.1", ticket, "in_review");
  await store.setDiff("1.1", { additions: 4, deletions: 1, files: 2, commits: 1 });

  await store.linkTicket("1.1", ticket, "in_progress");

  expect(store.getBranch("1.1")?.branch.diff).toBeUndefined();
});
