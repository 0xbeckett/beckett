/**
 * Durable GitHub publish outbox.
 *
 * A finished checkout is valuable: a GitHub hiccup must not turn it back into work or lose the
 * only worktree containing it.  Like AdvanceOutbox this is deliberately boring JSONL, but each
 * ticket has exactly one row (the row owns its worktree until it is removed).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ticket } from "../plane/types.ts";
import type { Logger } from "../types.ts";

export const PUBLISH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export type PublishPurpose = "done" | "wip";

export interface PublishOperation {
  id: string;
  ticket: Ticket;
  slug: string;
  repoRoot: string;
  messagePrefix: string;
  summary: string;
  purpose: PublishPurpose;
  /** Number of failed attempts already made (the initial synchronous attempt is 1). */
  attempt: number;
  nextAttemptAt: number;
  createdAt: string;
}

export type PublishFailureKind = "transient" | "permanent";

/** Conservative classifier: only known transport/service failures are retried unattended. */
export function classifyPublishError(error: unknown): PublishFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|cross[- ]fork|fork.{0,80}(?:pat|token|pull request)|resource not accessible by integration/i.test(message)
  ) return "permanent";
  if (
    /\b5\d\d\b|\b(?:econnreset|econnrefused|etimedout|enotfound|eai_again)\b|network(?: error| failed)?|fetch failed|timeout|timed out/i.test(message)
  ) return "transient";
  return "permanent";
}

export type PublishDrainResult =
  | { action: "remove" }
  | { action: "keep"; operation: PublishOperation };

export class PublishOutbox {
  constructor(private readonly path: string, private readonly logger: Logger) {}

  /** Replaces an existing row for the ticket: an outbox row has exclusive publish ownership. */
  append(op: PublishOperation): void {
    const ops = this.read().filter((existing) => existing.ticket.id !== op.ticket.id);
    ops.push(op);
    this.writeAll(ops);
    this.logger.warn("queued GitHub publish for retry", {
      id: op.id, ticket: op.ticket.identifier, attempt: op.attempt, nextAttemptAt: op.nextAttemptAt,
    });
  }

  has(ticketId: string): boolean {
    return this.read().some((op) => op.ticket.id === ticketId);
  }

  /** A human courier owns publishing from this point; never race them with a stale retry. */
  cancel(ticketId: string): boolean {
    const ops = this.read();
    const kept = ops.filter((op) => op.ticket.id !== ticketId);
    if (kept.length === ops.length) return false;
    this.writeAll(kept);
    this.logger.info("cancelled queued GitHub publish for human courier", { ticketId });
    return true;
  }

  async drain(
    apply: (op: PublishOperation) => Promise<PublishDrainResult>,
    now = Date.now(),
  ): Promise<number> {
    const ops = this.read();
    if (!ops.length) return 0;
    const kept: PublishOperation[] = [];
    let applied = 0;
    for (const op of ops) {
      if (op.nextAttemptAt > now) {
        kept.push(op);
        continue;
      }
      try {
        const result = await apply(op);
        if (result.action === "keep") kept.push(result.operation);
        else applied++;
      } catch (err) {
        // A dispatcher crash/Plane-comment failure must not erase the ownership row.
        kept.push(op);
        this.logger.warn("queued GitHub publish still failing", {
          id: op.id, ticket: op.ticket.identifier, error: (err as Error).message,
        });
      }
    }
    this.writeAll(kept);
    return applied;
  }

  private read(): PublishOperation[] {
    if (!existsSync(this.path)) return [];
    const out: PublishOperation[] = [];
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Partial<PublishOperation>;
        if (
          typeof raw.id === "string" && raw.ticket && typeof raw.ticket.id === "string" &&
          typeof raw.ticket.identifier === "string" && typeof raw.slug === "string" &&
          typeof raw.repoRoot === "string" && typeof raw.messagePrefix === "string" &&
          typeof raw.summary === "string" && (raw.purpose === "done" || raw.purpose === "wip") &&
          Number.isInteger(raw.attempt) && typeof raw.nextAttemptAt === "number" && typeof raw.createdAt === "string"
        ) out.push(raw as PublishOperation);
      } catch (err) {
        this.logger.warn("discarding malformed GitHub publish outbox line", { error: (err as Error).message });
      }
    }
    return out;
  }

  private writeAll(ops: PublishOperation[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!ops.length) {
      writeFileSync(this.path, "", "utf8");
      return;
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, ops.map((op) => JSON.stringify(op)).join("\n") + "\n", "utf8");
    renameSync(tmp, this.path);
  }
}
