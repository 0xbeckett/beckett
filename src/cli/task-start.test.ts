import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateTicketInput } from "../tracker/types.ts";
import type { Ticket } from "../tracker/types.ts";
import { TaskStore } from "../task/store.ts";
import { startTaskBranch, type TaskTrackerClient } from "./task-start.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { store: TaskStore; inputs: CreateTicketInput[]; tickets: Ticket[]; client: TaskTrackerClient } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-start-"));
  dirs.push(dir);
  const store = new TaskStore(join(dir, "tasks.json"));
  const inputs: CreateTicketInput[] = [];
  const tickets: Ticket[] = [];
  const client: TaskTrackerClient = {
    async listIssues() {
      return tickets.map((ticket) => ({ ...ticket }));
    },
    async createIssue(input) {
      inputs.push(input);
      const n = inputs.length;
      const ticket = {
        id: `ticket-${n}`,
        identifier: `OPS-${n}`,
        title: input.title,
        description: "",
        body: input.body ?? "",
        state: input.state ?? "backlog",
        assignees: [],
        casting: input.casting ?? {},
        criteria: input.criteria ?? [],
        blockedBy: input.blockedBy ?? [],
        branchRef: input.branchRef,
        project: input.project,
        projectId: "bored:ops",
        url: `https://tracker.test/OPS-${n}`,
        updatedAt: "2026-07-12T00:00:00.000Z",
        originChannel: input.originChannel,
      } as Ticket;
      tickets.push(ticket);
      return ticket;
    },
  };
  return { store, inputs, tickets, client };
}

test("starts the main branch as a linked tracker ticket", async () => {
  const { store, inputs, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });

  const started = await startTaskBranch(store, client, {
    branchRef: "#1.1",
    board: "ops",
    create: { body: "Build voting", originChannel: "thread-1" },
  });

  expect(inputs[0]).toMatchObject({
    title: "Voting",
    project: "polls",
    branchRef: "1.1",
    blockedBy: [],
    state: "in_progress",
    startState: "in_progress",
    originChannel: "thread-1",
  });
  expect(started.branch).toMatchObject({ ref: "1.1", status: "running", ticket: { identifier: "OPS-1" } });
  expect(store.findByTicket("OPS-1")?.task.number).toBe(1);
});

test("translates branch dependencies and native parentage into tracker ids", async () => {
  const { store, inputs, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });
  const api = await store.createBranch({ task: 1, title: "API", needs: ["1.1"] });
  const route = await store.createBranch({ task: 1, title: "Route", parentRef: api.ref, needs: [api.ref] });

  await startTaskBranch(store, client, { branchRef: "1.1", board: "ops", create: {} });
  await startTaskBranch(store, client, { branchRef: api.ref, board: "ops", create: {} });
  await startTaskBranch(store, client, { branchRef: route.ref, board: "ops", create: {} });

  expect(inputs[1]).toMatchObject({ branchRef: "1.2", blockedBy: ["OPS-1"], state: "backlog" });
  expect(inputs[2]).toMatchObject({
    branchRef: "1.2.1",
    blockedBy: ["OPS-2"],
    parentId: "ticket-2",
    state: "backlog",
  });
});

test("refuses an unstarted dependency or duplicate start before writing the tracker", async () => {
  const { store, inputs, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });
  const api = await store.createBranch({ task: 1, title: "API", needs: ["1.1"] });

  await expect(startTaskBranch(store, client, { branchRef: api.ref, board: "ops", create: {} }))
    .rejects.toThrow("dependency branch #1.1 must be started");
  expect(inputs).toHaveLength(0);

  await startTaskBranch(store, client, { branchRef: "1.1", board: "ops", create: {} });
  await expect(startTaskBranch(store, client, { branchRef: "1.1", board: "ops", create: {} }))
    .rejects.toThrow("already started as OPS-1");
  expect(inputs).toHaveLength(1);
});

test("starts immediately when every authoritative tracker dependency is already done", async () => {
  const { store, inputs, tickets, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });
  const api = await store.createBranch({ task: 1, title: "API", needs: ["1.1"] });
  const main = await startTaskBranch(store, client, { branchRef: "1.1", board: "ops", create: {} });
  await store.linkTicket("1.1", main.branch.ticket!, "done");
  tickets[0]!.state = "done";

  await startTaskBranch(store, client, { branchRef: api.ref, board: "ops", create: {} });

  expect(inputs[1]).toMatchObject({ blockedBy: ["OPS-1"], state: "in_progress" });
});

test("recovers a remotely-created branch instead of filing a duplicate", async () => {
  const { store, inputs, tickets, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });
  tickets.push({
    id: "remote-1",
    identifier: "OPS-99",
    title: "Voting",
    description: "",
    body: "",
    state: "in_progress",
    assignees: [],
    casting: {},
    criteria: [],
    blockedBy: [],
    branchRef: "1.1",
    project: "polls",
    projectId: "bored:ops",
    url: "https://tracker.test/OPS-99",
    updatedAt: "2026-07-12T00:00:00.000Z",
  });

  const recovered = await startTaskBranch(store, client, { branchRef: "1.1", board: "ops", create: {} });
  expect(recovered.ticket.identifier).toBe("OPS-99");
  expect(inputs).toHaveLength(0);
  expect(store.getBranch("1.1")?.branch.ticket?.id).toBe("remote-1");
});

test("concurrent starts reserve the branch before the tracker network gap", async () => {
  const { store, inputs, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const create = client.createIssue.bind(client);
  client.createIssue = async (input) => {
    await gate;
    return create(input);
  };

  const first = startTaskBranch(store, client, { branchRef: "1.1", board: "ops", create: {} });
  await Bun.sleep(10);
  await expect(startTaskBranch(new TaskStore(store.path), client, {
    branchRef: "1.1",
    board: "ops",
    create: {},
  })).rejects.toThrow("already being started");
  release();
  await first;
  expect(inputs).toHaveLength(1);
});

test("held intensive branches remember that dependency promotion must enter design", async () => {
  const { store, inputs, client } = setup();
  await store.createTask({ title: "Voting", project: "polls" });
  const next = await store.createBranch({ task: 1, title: "Implementation", needs: ["1.1"] });
  await startTaskBranch(store, client, { branchRef: "1.1", board: "int", state: "design", create: {} });
  await startTaskBranch(store, client, { branchRef: next.ref, board: "int", state: "design", create: {} });
  expect(inputs[1]).toMatchObject({ state: "backlog", startState: "design" });
});
