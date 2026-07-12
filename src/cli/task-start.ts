/** Plane-facing half of `beckett task start`, kept injectable for focused tests. */
import type { CreateTicketInput } from "../plane/client.ts";
import type { Ticket, TicketState } from "../plane/types.ts";
import { projectSlug } from "../plane/cast.ts";
import type { TaskBranch, TaskStore, WorkTask } from "../task/store.ts";

export interface TaskPlaneClient {
  createIssue(input: CreateTicketInput): Promise<Ticket>;
  listIssues(): Promise<Ticket[]>;
}

export interface StartTaskBranchInput {
  branchRef: string;
  board: string;
  state?: TicketState;
  create: Omit<CreateTicketInput, "title" | "branchRef" | "blockedBy" | "parentId" | "state">;
}

export interface StartedTaskBranch {
  task: WorkTask;
  branch: TaskBranch;
  ticket: Ticket;
}

/**
 * File one registered branch as a normal Plane ticket, translating task-branch dependencies back
 * to the internal Plane identifiers the dispatcher already understands.
 */
export async function startTaskBranch(
  store: TaskStore,
  client: TaskPlaneClient,
  input: StartTaskBranchInput,
): Promise<StartedTaskBranch> {
  const found = store.getBranch(input.branchRef);
  if (!found) throw new Error(`no such branch: #${input.branchRef.replace(/^#/, "")}`);
  const planeTickets = await client.listIssues();
  const remoteMatches = planeTickets.filter((ticket) => ticket.branchRef === found.branch.ref);
  if (remoteMatches.length > 1) {
    throw new Error(`branch #${found.branch.ref} has multiple Plane records; refusing to create another`);
  }
  if (found.branch.ticket) {
    throw new Error(`branch #${found.branch.ref} is already started as ${found.branch.ticket.identifier}`);
  }
  const recovered = remoteMatches[0];
  if (recovered) {
    const branch = await store.linkTicket(
      found.branch.ref,
      {
        id: recovered.id,
        identifier: recovered.identifier,
        board: input.board,
        projectId: recovered.projectId,
        url: recovered.url,
      },
      recovered.state,
      recovered.project,
    );
    await store.clearStartClaim(found.branch.ref).catch(() => undefined);
    return { task: store.getTask(found.task.number)!, branch, ticket: recovered };
  }

  const dependencies = found.branch.needs.map((ref) => {
    const dependency = store.getBranch(ref)?.branch;
    if (!dependency?.ticket) {
      throw new Error(`dependency branch #${ref} must be started before #${found.branch.ref}`);
    }
    return dependency;
  });
  const currentById = new Map(planeTickets.map((ticket) => [ticket.id, ticket]));
  for (const dependency of dependencies) {
    if (dependency.ticket!.board !== input.board) {
      throw new Error(`dependency branch #${dependency.ref} must use the same Plane board as #${found.branch.ref}`);
    }
    if (!currentById.has(dependency.ticket!.id)) {
      throw new Error(`dependency branch #${dependency.ref} is missing from Plane; refusing to park forever`);
    }
  }
  const blockers = dependencies.map((dependency) => dependency.ticket!.identifier);

  let parentId: string | undefined;
  if (found.branch.parentRef) {
    const parent = store.getBranch(found.branch.parentRef)?.branch;
    if (!parent?.ticket) {
      throw new Error(`parent branch #${found.branch.parentRef} must be started before #${found.branch.ref}`);
    }
    if (parent.ticket.board !== input.board) {
      throw new Error(`parent branch #${found.branch.parentRef} must use the same Plane board as #${found.branch.ref}`);
    }
    if (!currentById.has(parent.ticket.id)) {
      throw new Error(`parent branch #${found.branch.parentRef} is missing from Plane`);
    }
    parentId = parent.ticket.id;
  }

  const project = input.create.project ?? found.branch.git?.project ?? found.task.project;
  for (const dependency of dependencies) {
    const dependencyProject = dependency.git?.project ?? found.task.project;
    if (projectSlug(dependencyProject ?? dependency.ticket!.identifier) !== projectSlug(project ?? found.branch.ref)) {
      throw new Error(`dependency branch #${dependency.ref} must build the same project as #${found.branch.ref}`);
    }
  }
  // A branch with prerequisites is filed into the dispatcher's existing held state. Explicit
  // `--state` still controls independent branches; dependencies always win over eager starts.
  const state: TicketState = dependencies.some((dependency) => currentById.get(dependency.ticket!.id)?.state !== "done")
    ? "backlog"
    : (input.state ?? "in_progress");
  const claim = await store.reserveStart(found.branch.ref);
  try {
    const ticket = await client.createIssue({
      ...input.create,
      title: found.branch.title,
      ...(project ? { project } : {}),
      branchRef: found.branch.ref,
      blockedBy: blockers,
      ...(parentId ? { parentId } : {}),
      state,
      startState: input.state ?? "in_progress",
    });
    const branch = await store.linkTicket(
      found.branch.ref,
      {
        id: ticket.id,
        identifier: ticket.identifier,
        board: input.board,
        projectId: ticket.projectId,
        url: ticket.url,
      },
      ticket.state,
      ticket.project ?? project,
    );
    await store.releaseStart(found.branch.ref, claim).catch(() => undefined);
    return { task: store.getTask(found.task.number)!, branch, ticket };
  } catch (err) {
    // Keep the claim: a timeout may have created Plane remotely. A retry first reconciles by the
    // branch marker; stale claims become reclaimable after the bounded recovery window.
    throw err;
  }
}
