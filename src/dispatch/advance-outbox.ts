/**
 * Durable dispatcher advance outbox.
 * =======================================================================================
 * When a worker has finished but Plane is temporarily unavailable, losing the final
 * `setState + comment` write wedges the ticket forever. This tiny JSONL file records the intended
 * advance so the poll loop can replay it on the next tick or after a daemon restart.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../types.ts";

export interface AdvanceOperation {
  id: string;
  ticketId: string;
  /** Plane project id for board-scoped replay/routing. Missing on pre-OPS-97 outbox rows. */
  projectId?: string;
  state: string;
  comment: string;
  promoteDependents?: boolean;
  createdAt: string;
}

export class AdvanceOutbox {
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {}

  append(op: AdvanceOperation): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(op) + "\n", { flag: "a", encoding: "utf8" });
    this.logger.warn("queued Plane advance for retry", {
      id: op.id,
      ticketId: op.ticketId,
      state: op.state,
    });
  }

  async drain(apply: (op: AdvanceOperation) => Promise<void>): Promise<number> {
    const ops = this.read();
    if (ops.length === 0) return 0;
    const kept: AdvanceOperation[] = [];
    let applied = 0;
    for (const op of ops) {
      try {
        await apply(op);
        applied += 1;
      } catch (err) {
        kept.push(op);
        this.logger.warn("queued Plane advance still failing", {
          id: op.id,
          ticketId: op.ticketId,
          state: op.state,
          error: (err as Error).message,
        });
      }
    }
    this.writeAll(kept);
    return applied;
  }

  private read(): AdvanceOperation[] {
    if (!existsSync(this.path)) return [];
    const ops: AdvanceOperation[] = [];
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
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
        this.logger.warn("discarding malformed Plane advance outbox line", {
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
