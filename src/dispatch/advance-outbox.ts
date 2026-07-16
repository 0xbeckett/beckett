/**
 * Durable dispatcher advance outbox.
 * =======================================================================================
 * When a worker has finished but the tracker is temporarily unavailable, losing the final
 * `setState + comment` write wedges the ticket forever. This tiny JSONL file records the intended
 * advance so the poll loop can replay it on the next tick or after a daemon restart.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../types.ts";

export interface AdvanceOperation {
  id: string;
  ticketId: string;
  /** tracker board id for board-scoped replay/routing. Missing on pre-OPS-97 outbox rows. */
  projectId?: string;
  state: string;
  comment: string;
  promoteDependents?: boolean;
  createdAt: string;
}

export class AdvanceOutbox {
  private drainInFlight: Promise<number> | null = null;

  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {}

  append(op: AdvanceOperation): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(op) + "\n", { flag: "a", encoding: "utf8" });
    this.logger.warn("queued tracker advance for retry", {
      id: op.id,
      ticketId: op.ticketId,
      state: op.state,
    });
  }

  drain(apply: (op: AdvanceOperation) => Promise<void>): Promise<number> {
    if (this.drainInFlight) return this.drainInFlight;
    const run = this.drainOnce(apply).finally(() => {
      if (this.drainInFlight === run) this.drainInFlight = null;
    });
    this.drainInFlight = run;
    return run;
  }

  private async drainOnce(apply: (op: AdvanceOperation) => Promise<void>): Promise<number> {
    const drainingPath = `${this.path}.draining`;
    mkdirSync(dirname(this.path), { recursive: true });

    // Atomically detach the rows being replayed. Appends during the awaited tracker calls now land
    // in a fresh active file instead of being overwritten by the drain's stale snapshot. A
    // leftover sidecar is an interrupted prior drain and takes precedence on the next boot.
    if (!existsSync(drainingPath)) {
      if (!existsSync(this.path)) return 0;
      renameSync(this.path, drainingPath);
    }

    const ops = this.read(drainingPath);
    if (ops.length === 0) {
      unlinkSync(drainingPath);
      return 0;
    }
    const kept: AdvanceOperation[] = [];
    const appliedIds = new Set<string>();
    let applied = 0;
    for (const op of ops) {
      try {
        await apply(op);
        applied += 1;
        appliedIds.add(op.id);
      } catch (err) {
        kept.push(op);
        this.logger.warn("queued tracker advance still failing", {
          id: op.id,
          ticketId: op.ticketId,
          state: op.state,
          error: (err as Error).message,
        });
      }
    }

    // This block is synchronous on purpose: no append can interleave between reading the active
    // rows and replacing them with retained failures + those new rows.
    const appended = this.read(this.path).filter((op) => !appliedIds.has(op.id));
    const merged = new Map<string, AdvanceOperation>();
    for (const op of [...kept, ...appended]) {
      if (!merged.has(op.id)) merged.set(op.id, op);
    }
    this.writeAll([...merged.values()]);
    unlinkSync(drainingPath);
    return applied;
  }

  private read(path = this.path): AdvanceOperation[] {
    if (!existsSync(path)) return [];
    const ops: AdvanceOperation[] = [];
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Partial<AdvanceOperation>;
        if (
          typeof raw.id === "string" &&
          typeof raw.ticketId === "string" &&
          typeof raw.state === "string" &&
          typeof raw.comment === "string" &&
          typeof raw.createdAt === "string"
        ) {
          ops.push({
            id: raw.id,
            ticketId: raw.ticketId,
            ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
            state: raw.state,
            comment: raw.comment,
            ...(raw.promoteDependents ? { promoteDependents: true } : {}),
            createdAt: raw.createdAt,
          });
        }
      } catch (err) {
        this.logger.warn("discarding malformed tracker advance outbox line", {
          error: (err as Error).message,
        });
      }
    }
    return ops;
  }

  private writeAll(ops: AdvanceOperation[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (ops.length === 0) {
      writeFileSync(this.path, "", "utf8");
      return;
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, ops.map((op) => JSON.stringify(op)).join("\n") + "\n", "utf8");
    renameSync(tmp, this.path);
  }
}
