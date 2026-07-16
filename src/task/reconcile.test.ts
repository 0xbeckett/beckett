import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "../tracker/types.ts";
import { reconcileTaskTickets } from "./reconcile.ts";
import { TaskStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("full-board reconciliation catches terminal changes made while Beckett was offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-reconcile-"));
  dirs.push(dir);
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Voting" });
  await store.linkTicket(
    "1.1",
    { id: "ticket-1", identifier: "OPS-1", board: "ops", projectId: "p1", url: "https://plane/OPS-1" },
    "in_progress",
  );
  const terminal = {
    id: "ticket-1",
    identifier: "OPS-1",
    title: "Voting",
    description: "",
    body: "",
    state: "done",
    assignees: [],
    casting: {},
    criteria: [],
    blockedBy: [],
    branchRef: "1.1",
    projectId: "p1",
    url: "https://plane/OPS-1",
    updatedAt: "2026-07-12T00:00:00.000Z",
  } satisfies Ticket;

  expect(await reconcileTaskTickets(store, [terminal], "ops")).toBe(1);
  expect(store.getBranch("1.1")?.branch.status).toBe("done");
  expect(store.getTask(1)?.status).toBe("done");
});
