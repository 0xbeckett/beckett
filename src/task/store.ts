/** Durable user-facing task and branch registry. Tracker tickets remain an execution detail. */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { Ticket, TicketState } from "../tracker/types.ts";

export const TASK_TITLE_MAX = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;
const START_CLAIM_STALE_MS = 5 * 60_000;

export type TaskStatus = "active" | "paused" | "done" | "cancelled";
export type TaskBranchStatus =
  | "ready"
  | "waiting"
  | "designing"
  | "approval"
  | "running"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

const TicketLinkSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  board: z.string().min(1),
  projectId: z.string(),
  url: z.string(),
});

const GitLinkSchema = z.object({
  project: z.string().min(1),
  workspace: z.string().optional(),
  gitRef: z.string().optional(),
  baseSha: z.string().optional(),
});

const PullRequestLinkSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
});

const PublicationLinkSchema = z.object({
  repo: z.string().min(1),
  url: z.string().min(1),
  kind: z.enum(["pushed", "pr"]),
});

const DiffSummarySchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

const TaskBranchSchema = z.object({
  id: z.string().min(1),
  ref: z.string().regex(/^\d+(?:\.\d+)+$/),
  path: z.array(z.number().int().positive()).min(1),
  title: z.string().min(1),
  status: z.enum(["ready", "waiting", "designing", "approval", "running", "review", "blocked", "done", "cancelled"]),
  parentRef: z.string().optional(),
  needs: z.array(z.string()).default([]),
  ticket: TicketLinkSchema.optional(),
  git: GitLinkSchema.optional(),
  pullRequest: PullRequestLinkSchema.optional(),
  publication: PublicationLinkSchema.optional(),
  diff: DiffSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TaskSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  status: z.enum(["active", "paused", "done", "cancelled"]),
  originChannelId: z.string().optional(),
  threadId: z.string().optional(),
  project: z.string().optional(),
  branches: z.array(TaskBranchSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RegistrySchema = z.object({
  version: z.literal(1),
  nextTaskNumber: z.number().int().positive(),
  tasks: z.array(TaskSchema),
  startClaims: z.record(z.string(), z.object({ token: z.string().min(1), createdAt: z.string() })).default({}),
});

export type TaskTicketLink = z.infer<typeof TicketLinkSchema>;
export type TaskGitLink = z.infer<typeof GitLinkSchema>;
export type TaskPullRequestLink = z.infer<typeof PullRequestLinkSchema>;
export type TaskPublicationLink = z.infer<typeof PublicationLinkSchema>;
export type TaskDiffSummary = z.infer<typeof DiffSummarySchema>;
export type TaskBranch = z.infer<typeof TaskBranchSchema>;
export type WorkTask = z.infer<typeof TaskSchema>;
type TaskRegistry = z.infer<typeof RegistrySchema>;

export interface TaskStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export function normalizeTaskTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("task title cannot be empty");
  return title.slice(0, TASK_TITLE_MAX);
}

export function normalizeTaskNumber(raw: string | number): number {
  const text = String(raw).trim().replace(/^#/, "");
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new Error(`invalid task reference "${raw}"`);
  return Number(text);
}

export function normalizeBranchRef(raw: string): string {
  const ref = raw.trim().replace(/^#/, "");
  if (!/^\d+(?:\.\d+)+$/.test(ref)) throw new Error(`invalid branch reference "${raw}"`);
  return ref;
}

export function displayTaskName(task: Pick<WorkTask, "number" | "title">): string {
  return `#${task.number} - ${task.title}`;
}

export function branchStatusForTicket(state: TicketState): TaskBranchStatus {
  switch (state) {
    case "backlog": return "waiting";
    case "todo": return "ready";
    case "design": return "designing";
    case "design_review": return "approval";
    case "in_progress": return "running";
    case "in_review": return "review";
    case "done": return "done";
    case "cancelled": return "cancelled";
  }
}

export class TaskStore {
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly path: string, opts: TaskStoreOptions = {}) {
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? randomUUID;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  list(): WorkTask[] {
    return structuredClone(this.read().tasks).sort((a, b) => a.number - b.number);
  }

  getTask(ref: string | number): WorkTask | null {
    const number = normalizeTaskNumber(ref);
    return structuredClone(this.read().tasks.find((task) => task.number === number) ?? null);
  }

  getBranch(ref: string): { task: WorkTask; branch: TaskBranch } | null {
    const normalized = normalizeBranchRef(ref);
    const taskNumber = Number(normalized.split(".")[0]);
    const task = this.read().tasks.find((candidate) => candidate.number === taskNumber);
    const branch = task?.branches.find((candidate) => candidate.ref === normalized);
    return task && branch ? structuredClone({ task, branch }) : null;
  }

  findByTicket(ticketIdOrIdentifier: string): { task: WorkTask; branch: TaskBranch } | null {
    for (const task of this.read().tasks) {
      const branch = task.branches.find(
        (candidate) => candidate.ticket?.id === ticketIdOrIdentifier || candidate.ticket?.identifier === ticketIdOrIdentifier,
      );
      if (branch) return structuredClone({ task, branch });
    }
    return null;
  }

  async createTask(input: {
    title: string;
    originChannelId?: string;
    project?: string;
    initialBranchTitle?: string;
  }): Promise<{ task: WorkTask; branch: TaskBranch }> {
    return this.mutate((registry) => {
      const now = this.now().toISOString();
      const number = registry.nextTaskNumber++;
      const title = normalizeTaskTitle(input.title);
      const branch: TaskBranch = {
        id: this.id(),
        ref: `${number}.1`,
        path: [1],
        title: normalizeTaskTitle(input.initialBranchTitle ?? title),
        status: "ready",
        needs: [],
        createdAt: now,
        updatedAt: now,
      };
      const task: WorkTask = {
        id: this.id(),
        number,
        title,
        status: "active",
        ...(input.originChannelId ? { originChannelId: input.originChannelId } : {}),
        ...(input.project ? { project: input.project } : {}),
        branches: [branch],
        createdAt: now,
        updatedAt: now,
      };
      registry.tasks.push(task);
      return structuredClone({ task, branch });
    });
  }

  async createBranch(input: {
    task: string | number;
    title: string;
    parentRef?: string;
    needs?: string[];
    project?: string;
  }): Promise<TaskBranch> {
    return this.mutate((registry) => {
      const taskNumber = normalizeTaskNumber(input.task);
      const task = registry.tasks.find((candidate) => candidate.number === taskNumber);
      if (!task) throw new Error(`no such task: #${taskNumber}`);
      const parentRef = input.parentRef ? normalizeBranchRef(input.parentRef) : undefined;
      const parent = parentRef ? task.branches.find((candidate) => candidate.ref === parentRef) : undefined;
      if (parentRef && !parent) throw new Error(`no such parent branch: #${parentRef}`);
      const prefix = parent ? parent.path : [];
      const siblings = task.branches.filter((branch) =>
        branch.path.length === prefix.length + 1 && prefix.every((part, index) => branch.path[index] === part)
      );
      const next = Math.max(0, ...siblings.map((branch) => branch.path.at(-1) ?? 0)) + 1;
      const path = [...prefix, next];
      const ref = `${task.number}.${path.join(".")}`;
      const needs = [...new Set((input.needs ?? []).map(normalizeBranchRef))];
      for (const need of needs) {
        if (!task.branches.some((candidate) => candidate.ref === need)) throw new Error(`no such dependency branch: #${need}`);
        if (need === ref) throw new Error(`branch #${ref} cannot depend on itself`);
      }
      const now = this.now().toISOString();
      const branch: TaskBranch = {
        id: this.id(),
        ref,
        path,
        title: normalizeTaskTitle(input.title),
        status: needs.length ? "waiting" : "ready",
        ...(parent ? { parentRef: parent.ref } : {}),
        needs,
        ...(input.project ? { git: { project: input.project } } : {}),
        createdAt: now,
        updatedAt: now,
      };
      task.branches.push(branch);
      task.status = "active";
      task.updatedAt = now;
      return structuredClone(branch);
    });
  }

  async setThread(taskRef: string | number, threadId: string, parentChannelId?: string): Promise<WorkTask> {
    return this.updateTask(taskRef, (task) => {
      task.threadId = threadId;
      if (parentChannelId) task.originChannelId = parentChannelId;
    });
  }

  async linkTicket(
    branchRef: string,
    link: TaskTicketLink,
    state: TicketState,
    project?: string,
  ): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      if (branch.ticket && branch.ticket.id !== link.id) {
        throw new Error(`branch #${branch.ref} is already linked to ${branch.ticket.identifier}`);
      }
      branch.ticket = link;
      branch.status = branchStatusForTicket(state);
      // A durable diff is the prior publish attempt's final contribution. Once implementation is
      // deliberately resumed it becomes stale; clear it so live cards follow the active worktree
      // until the next pre-publication snapshot replaces it.
      if (state === "design" || state === "in_progress") delete branch.diff;
      if (project) branch.git = { ...(branch.git ?? { project }), project };
    });
  }

  async syncTicket(ticket: Ticket, board = "ops"): Promise<TaskBranch | null> {
    const branchRef = ticket.branchRef ?? this.findByTicket(ticket.id)?.branch.ref;
    if (!branchRef) return null;
    return this.linkTicket(
      branchRef,
      { id: ticket.id, identifier: ticket.identifier, board, projectId: ticket.projectId, url: ticket.url },
      ticket.state,
      ticket.project,
    );
  }

  async setGit(branchRef: string, git: TaskGitLink): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.git = { ...(branch.git ?? {}), ...git };
    });
  }

  async setPullRequest(branchRef: string, pullRequest: TaskPullRequestLink): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.pullRequest = pullRequest;
    });
  }

  async setPublication(branchRef: string, publication: TaskPublicationLink): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.publication = publication;
    });
  }

  /** Claim the remote-create gap so concurrent/retried `task start` calls cannot file duplicates. */
  async reserveStart(branchRef: string): Promise<string> {
    return this.mutate((registry) => {
      const ref = normalizeBranchRef(branchRef);
      const task = registry.tasks.find((candidate) => candidate.number === Number(ref.split(".")[0]));
      const branch = task?.branches.find((candidate) => candidate.ref === ref);
      if (!branch) throw new Error(`no such branch: #${ref}`);
      if (branch.ticket) throw new Error(`branch #${ref} is already started as ${branch.ticket.identifier}`);
      const existing = registry.startClaims[ref];
      const createdAt = existing ? Date.parse(existing.createdAt) : Number.NaN;
      if (existing && Number.isFinite(createdAt) && this.now().getTime() - createdAt < START_CLAIM_STALE_MS) {
        throw new Error(`branch #${ref} is already being started; wait for that request to finish`);
      }
      const token = this.id();
      registry.startClaims[ref] = { token, createdAt: this.now().toISOString() };
      return token;
    });
  }

  async releaseStart(branchRef: string, token: string): Promise<void> {
    await this.mutate((registry) => {
      const ref = normalizeBranchRef(branchRef);
      if (registry.startClaims[ref]?.token === token) delete registry.startClaims[ref];
    });
  }

  async clearStartClaim(branchRef: string): Promise<void> {
    await this.mutate((registry) => {
      delete registry.startClaims[normalizeBranchRef(branchRef)];
    });
  }

  async setDiff(branchRef: string, diff: Omit<TaskDiffSummary, "updatedAt">): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.diff = { ...diff, updatedAt: this.now().toISOString() };
    });
  }

  private async updateTask(ref: string | number, change: (task: WorkTask) => void): Promise<WorkTask> {
    return this.mutate((registry) => {
      const number = normalizeTaskNumber(ref);
      const task = registry.tasks.find((candidate) => candidate.number === number);
      if (!task) throw new Error(`no such task: #${number}`);
      change(task);
      task.updatedAt = this.now().toISOString();
      return structuredClone(task);
    });
  }

  private async updateBranch(ref: string, change: (branch: TaskBranch, task: WorkTask) => void): Promise<TaskBranch> {
    return this.mutate((registry) => {
      const normalized = normalizeBranchRef(ref);
      const task = registry.tasks.find((candidate) => candidate.number === Number(normalized.split(".")[0]));
      const branch = task?.branches.find((candidate) => candidate.ref === normalized);
      if (!task || !branch) throw new Error(`no such branch: #${normalized}`);
      change(branch, task);
      const now = this.now().toISOString();
      branch.updatedAt = now;
      task.updatedAt = now;
      task.status = aggregateTaskStatus(task.branches, task.status);
      return structuredClone(branch);
    });
  }

  private read(): TaskRegistry {
    try {
      const raw = readFileSync(this.path, "utf8");
      return RegistrySchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: 1, nextTaskNumber: 1, tasks: [], startClaims: {} };
      throw new Error(`task registry ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  private async mutate<T>(change: (registry: TaskRegistry) => T): Promise<T> {
    await this.acquireLock();
    try {
      const registry = this.read();
      const result = change(registry);
      this.write(registry);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private write(registry: TaskRegistry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.id()}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }

  private async acquireLock(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        mkdirSync(this.lockPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await this.sleep(10 + attempt);
      }
    }
    throw new Error(`timed out waiting for task registry lock ${this.lockPath}`);
  }
}

function aggregateTaskStatus(branches: TaskBranch[], current: TaskStatus): TaskStatus {
  if (current === "cancelled") return current;
  if (branches.length > 0 && branches.every((branch) => branch.status === "done" || branch.status === "cancelled")) {
    return branches.some((branch) => branch.status === "done") ? "done" : "cancelled";
  }
  if (current === "paused") return current;
  return "active";
}

export function createTaskStore(path: string, opts?: TaskStoreOptions): TaskStore {
  return new TaskStore(path, opts);
}
