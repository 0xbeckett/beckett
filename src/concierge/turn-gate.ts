/**
 * TurnGate — a counting semaphore bounding how many concierge turns EXECUTE at once across the
 * whole session pool (OPS-80 §9.3). Sessions stay independently queued (per-channel FIFO with
 * priority jumps); the gate only meters the expensive part — a live `claude` turn — so N channels
 * can converse concurrently without unbounded parallel model calls.
 *
 * Fairness is FIFO across sessions: a released slot is handed DIRECTLY to the oldest waiter
 * (active never decrements on a handoff), so a burst of new acquires can neither overshoot the
 * limit nor starve a waiter. A slot is held for a session's full between-turns unit (the turn plus
 * its boundary rotation check) — rotation runs model turns of its own and must not exceed the cap.
 */
export class TurnGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`TurnGate limit must be a positive integer (got ${limit})`);
    }
  }

  /** Resolve with a release fn once a slot frees. Release is idempotent — a double call is a no-op. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      // The releasing turn hands its slot straight to us — `active` already counts it.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // direct handoff: the slot stays occupied, no decrement/increment gap
      else this.active -= 1;
    };
  }

  /** True when every slot is taken — the Concierge's "this turn will wait" fast-ack signal. */
  saturated(): boolean {
    return this.active >= this.limit;
  }

  stats(): { limit: number; active: number; waiting: number } {
    return { limit: this.limit, active: this.active, waiting: this.waiters.length };
  }
}

export function createTurnGate(limit: number): TurnGate {
  return new TurnGate(limit);
}
