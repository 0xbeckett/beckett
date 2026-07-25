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
  /** Failed replay attempts so far. Missing on pre-OPS-99 rows (treated as 0). */
  attempt?: number;
}

/**
 * Deterministic 4xx errors cannot become true by waiting, so a permanent advance is dropped after
 * this many failed attempts. Small on purpose: a wedged advance should never dominate the journal.
 */
export const MAX_PERMANENT_ADVANCE_ATTEMPTS = 3;

export type AdvanceFailureKind = "satisfied" | "permanent" | "transient";

/**
 * Classify a failed advance so the outbox knows whether to dequeue it, give up on it, or keep
 * retrying. Mirrors {@link classifyPublishError}'s conservative spirit: only known transport/service
 * failures earn unbounded retry.
 *
 * - `satisfied`: the tracker rejected the write because the run is ALREADY in the state we asked
 *   for (e.g. a 409 "run #80 is done, not parked" for a `state: done` advance). The advance has, in
 *   substance, already landed — re-POSTing the gate can never make it "more done". Dequeue it.
 * - `transient`: 5xx / connection refused / timeout / network error — can become true by waiting.
 * - `permanent`: any other deterministic 4xx — cannot become true by waiting; cap and drop.
 */
export function classifyAdvanceError(error: unknown, op: AdvanceOperation): AdvanceFailureKind {
  const rawStatus = (error as { status?: unknown } | null)?.status;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const message = error instanceof Error ? error.message : String(error);

  // "already in the target state" — the run reports it IS the state we requested. Anchor the state
  // right after "is"/"already" so "run #80 is done, not parked" is only satisfied for `done`, never
  // for the `parked` precondition it merely mentions.
  const escaped = op.state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alreadyThere = new RegExp(`\\b(?:is|already)\\s+${escaped}\\b`, "i").test(message);
  if (alreadyThere && (status === undefined || (status >= 400 && status < 500))) return "satisfied";

  // Genuinely transient: a network error (BoredApiError uses status 0), any 5xx, or the usual
  // transport failure signatures.
  if (
    status === 0 ||
    (status !== undefined && status >= 500) ||
    /\b5\d\d\b|\b(?:econnrefused|econnreset|etimedout|enotfound|eai_again)\b|network(?: error)?|fetch failed|timed? out/i.test(message)
  ) return "transient";

  // Any other deterministic 4xx is permanent.
  if (status !== undefined && status >= 400 && status < 500) return "permanent";

  // Unknown shape: retry rather than silently drop real work.
  return "transient";
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
    // Rows removed from the outbox this drain — whether they succeeded, were already satisfied, or
    // were permanently given up on. All three must NOT be re-kept from the appended snapshot below.
    const settledIds = new Set<string>();
    let applied = 0;
    for (const op of ops) {
      try {
        await apply(op);
        applied += 1;
        settledIds.add(op.id);
      } catch (err) {
        const kind = classifyAdvanceError(err, op);
        if (kind === "satisfied") {
          // The advance already landed (the run is in the requested state). Dequeue it quietly.
          applied += 1;
          settledIds.add(op.id);
          this.logger.info("queued tracker advance already satisfied; dequeuing", {
            id: op.id,
            ticketId: op.ticketId,
            state: op.state,
            error: (err as Error).message,
          });
          continue;
        }
        if (kind === "permanent") {
          const attempts = (op.attempt ?? 0) + 1;
          if (attempts >= MAX_PERMANENT_ADVANCE_ATTEMPTS) {
            // Deterministic failure that can never resolve. Give up ONCE, visibly, and drop it —
            // never re-log it per tick.
            settledIds.add(op.id);
            this.logger.warn("giving up on unresolvable tracker advance", {
              id: op.id,
              ticketId: op.ticketId,
              state: op.state,
              attempts,
              error: (err as Error).message,
            });
            continue;
          }
          // Not yet capped: keep with an incremented counter, but stay quiet (debug) until we act.
          kept.push({ ...op, attempt: attempts });
          this.logger.debug("tracker advance failing with a permanent error; will give up soon", {
            id: op.id,
            ticketId: op.ticketId,
            state: op.state,
            attempts,
            error: (err as Error).message,
          });
          continue;
        }
        // Transient: keep retrying with the existing per-tick cadence.
        kept.push({ ...op, attempt: (op.attempt ?? 0) + 1 });
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
    const appended = this.read(this.path).filter((op) => !settledIds.has(op.id));
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
            ...(typeof raw.attempt === "number" ? { attempt: raw.attempt } : {}),
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
