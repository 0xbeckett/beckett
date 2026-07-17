import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmbientCoordinator, type AmbientClock, type AmbientTurn } from "./ambient.ts";
import { validateConfig } from "../config.ts";
import type { IncomingMessage, Logger } from "../types.ts";
import type { TriageFn, TriageVerdict } from "./triage.ts";

const quietLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quietLogger;
  },
};

class FakeClock implements AmbientClock {
  t = 0;
  next = 1;
  timers = new Map<number, { at: number; cb: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.t + ms;
    while (true) {
      const due = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      this.t = due[1].at;
      this.timers.delete(due[0]);
      due[1].cb();
    }
    this.t = target;
  }
}

function msg(
  id: string,
  channelId: string,
  content: string,
  createdAt: number,
  over: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    messageId: id,
    userId: "user-1",
    authorDisplayName: "Jason",
    channelId,
    guildId: "guild-1",
    content,
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt,
    attachments: [],
    ...over,
  };
}

const yes: TriageVerdict = {
  interject: true,
  kind: "feature-wish",
  confidence: 0.91,
  reason: "concrete wish",
  addressee: "group",
};

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AmbientCoordinator", () => {
  test("enabled=false records allowed-user transcript but never triages", async () => {
    const clock = new FakeClock();
    let triageCalls = 0;
    const coordinator = createAmbientCoordinator({
      config: validateConfig({ proactivity: { enabled: false, default_mode: "suggest" } }),
      logger: quietLogger,
      clock,
      triage: (async () => {
        triageCalls++;
        return yes;
      }) as TriageFn,
      engage: async () => ({ decision: "send", message: "should not run" }),
    });

    coordinator.observe(msg("m1", "c1", "wish this had csv", 0), "member");
    clock.advance(60_000);
    await tick();

    expect(coordinator.getTranscript("c1").map((m) => m.content)).toEqual(["wish this had csv"]);
    expect(triageCalls).toBe(0);
  });

  test("outsiders update nothing, not even ring buffers", () => {
    const coordinator = createAmbientCoordinator({
      config: validateConfig({ proactivity: { enabled: true, default_mode: "suggest" } }),
      logger: quietLogger,
      clock: new FakeClock(),
      triage: async () => yes,
      engage: async () => ({ decision: "send", message: "ok" }),
    });

    coordinator.observe(msg("m1", "c1", "secret outsider text", 0), "outsider");
    expect(coordinator.getTranscript("c1")).toEqual([]);
  });

  test("debounces bursts, triages once after quiet, and engages candidate", async () => {
    const clock = new FakeClock();
    const bursts: string[][] = [];
    const turns: AmbientTurn[] = [];
    const coordinator = createAmbientCoordinator({
      config: validateConfig({
        proactivity: { enabled: true, default_mode: "suggest", burst_quiet_secs: 2 },
      }),
      logger: quietLogger,
      clock,
      triage: async (burst) => {
        bursts.push(burst.map((m) => m.content));
        return yes;
      },
      engage: async (turn) => {
        turns.push(turn);
        return { decision: "send", message: "want me to kick that off?" };
      },
    });

    coordinator.observe(msg("m1", "c1", "export flow hurts", 0), "member");
    clock.advance(1_000);
    coordinator.observe(msg("m2", "c1", "wish it gave me csv", 1_000), "member");
    clock.advance(1_999);
    await tick();
    expect(bursts).toEqual([]);

    clock.advance(1);
    await tick();
    expect(bursts).toEqual([["export flow hurts", "wish it gave me csv"]]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "candidate", channelId: "c1" });
  });

  test("preserves Discord's native reply edge for classifier addressee reads", async () => {
    const clock = new FakeClock();
    let replyTarget: string | null | undefined;
    const coordinator = createAmbientCoordinator({
      config: validateConfig({
        proactivity: { enabled: true, default_mode: "suggest", burst_quiet_secs: 1, engaged_window_secs: 0 },
      }),
      logger: quietLogger,
      clock,
      triage: async (burst) => {
        replyTarget = burst[0]?.repliedToId;
        return { ...yes, interject: false, kind: "none" };
      },
      engage: async () => ({ decision: "send", message: "must not run" }),
    });

    coordinator.observe(msg("m2", "c1", "can you paste that?", 0, { repliedToId: "m1" }), "member");
    clock.advance(1_000);
    await tick();
    expect(replyTarget).toBe("m1");
  });

  test("hard-stops an internally inconsistent high-score verdict aimed at another person", async () => {
    const clock = new FakeClock();
    let engageCalls = 0;
    const coordinator = createAmbientCoordinator({
      config: validateConfig({
        proactivity: { enabled: true, default_mode: "suggest", burst_quiet_secs: 1, engaged_window_secs: 0 },
      }),
      logger: quietLogger,
      clock,
      triage: async () => ({ ...yes, confidence: 1, addressee: "other" }),
      engage: async () => {
        engageCalls++;
        return { decision: "send", message: "I should not interrupt" };
      },
    });

    coordinator.observe(msg("m1", "c1", "ssh, can you check the deploy?", 0), "member");
    clock.advance(1_000);
    await tick();
    expect(engageCalls).toBe(0);
  });

  test("mention mid-burst cancels pending flush", async () => {
    const clock = new FakeClock();
    let triageCalls = 0;
    const coordinator = createAmbientCoordinator({
      config: validateConfig({ proactivity: { enabled: true, default_mode: "suggest", burst_quiet_secs: 2 } }),
      logger: quietLogger,
      clock,
      triage: async () => {
        triageCalls++;
        return yes;
      },
      engage: async () => ({ decision: "send", message: "ok" }),
    });

    coordinator.observe(msg("m1", "c1", "maybe csv would help", 0), "member");
    coordinator.noteMention("c1");
    clock.advance(2_000);
    await tick();
    expect(triageCalls).toBe(0);
  });

  test("cooldown and hourly cap are enforced before triage (cold path — engaged lane disabled)", async () => {
    const clock = new FakeClock();
    let triageCalls = 0;
    const coordinator = createAmbientCoordinator({
      config: validateConfig({
        proactivity: {
          enabled: true,
          default_mode: "suggest",
          burst_quiet_secs: 1,
          channel_cooldown_secs: 10,
          max_interjections_per_hour: 1,
          engaged_window_secs: 0,
        },
      }),
      logger: quietLogger,
      clock,
      triage: async () => {
        triageCalls++;
        return yes;
      },
      engage: async () => ({ decision: "send", message: "I can do that" }),
    });

    coordinator.observe(msg("m1", "c1", "wish csv existed", 0), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(1);

    coordinator.observe(msg("m2", "c1", "and pdf too", 2_000), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(1);

    clock.advance(11_000);
    coordinator.observe(msg("m3", "c2", "need import too", 14_000), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(1);
  });

  test("engaged continuation: after Beckett speaks, the next burst bypasses triage AND caps, spends no budget, and window expiry restores the cold path", async () => {
    const clock = new FakeClock();
    let triageCalls = 0;
    const turns: AmbientTurn[] = [];
    const coordinator = createAmbientCoordinator({
      config: validateConfig({
        proactivity: {
          enabled: true,
          default_mode: "suggest",
          burst_quiet_secs: 1,
          engaged_quiet_secs: 1,
          channel_cooldown_secs: 10,
          max_interjections_per_hour: 1,
          engaged_window_secs: 60,
        },
      }),
      logger: quietLogger,
      clock,
      triage: async () => {
        triageCalls++;
        return yes;
      },
      engage: async (turn) => {
        turns.push(turn);
        return { decision: "send", message: "riffing back" };
      },
    });

    // Beckett just replied to a mention in c1 (the Concierge stamps this on every post).
    coordinator.noteBeckettPost("c1");

    // Someone responds without @mentioning — mid-cooldown-from-nothing, this must engage anyway:
    // no triage call, engaged flag on the turn.
    coordinator.observe(msg("m1", "c1", "haha nice, what changed?", 1_000), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(0);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "candidate", channelId: "c1", engaged: true });

    // The continuation reply refreshed the window and spent NO interjection budget: a back-and-forth
    // keeps flowing (hourly cap is 1 here and would have starved this immediately).
    coordinator.observe(msg("m2", "c1", "ok but does it survive restarts?", 3_000), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(0);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ engaged: true });

    // Past the window with no Beckett post in between, the channel is cold again: triage gates.
    clock.advance(61_000);
    coordinator.observe(msg("m3", "c1", "anyway, unrelated chatter", 66_000), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(1);
    expect(turns).toHaveLength(3);
    expect(turns[2]).toMatchObject({ engaged: false });
  });

  test("a structured pass on an engaged turn does not refresh the window — a dead conversation goes cold", async () => {
    const clock = new FakeClock();
    let triageCalls = 0;
    let engageCalls = 0;
    const coordinator = createAmbientCoordinator({
      config: validateConfig({
        proactivity: {
          enabled: true,
          default_mode: "suggest",
          burst_quiet_secs: 1,
          engaged_quiet_secs: 1,
          engaged_window_secs: 10,
        },
      }),
      logger: quietLogger,
      clock,
      triage: async () => {
        triageCalls++;
        return { ...yes, interject: false };
      },
      engage: async () => {
        engageCalls++;
        return { decision: "pass", message: null } as const;
      },
    });

    coordinator.noteBeckettPost("c1");
    coordinator.observe(msg("m1", "c1", "k", 1_000), "member");
    clock.advance(1_000);
    await tick();
    expect(engageCalls).toBe(1); // engaged: the session got to decide...
    expect(triageCalls).toBe(0);

    // ...and chose pass, so the window was NOT refreshed: 10s later the channel is cold and the
    // (declining) triage gate is back in charge.
    clock.advance(10_000);
    coordinator.observe(msg("m2", "c1", "random chatter", 12_000), "member");
    clock.advance(1_000);
    await tick();
    expect(triageCalls).toBe(1);
    expect(engageCalls).toBe(1);
  });

  test("offer ledger persists and auto expiry emits timeout turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ambient-test-"));
    try {
      const clock = new FakeClock();
      const storageFile = join(dir, "pending-offers.json");
      const turns: AmbientTurn[] = [];
      const coordinator = createAmbientCoordinator({
        config: validateConfig({ proactivity: { enabled: true, offer_ttl_secs: 5 } }),
        logger: quietLogger,
        clock,
        triage: async () => yes,
        engage: async (turn) => {
          turns.push(turn);
          return { decision: "send", message: "running with it" };
        },
        storageFile,
      });

      coordinator.recordOffer("c1", {
        offerMessageId: "offer-1",
        offerText: "want me to do csv?",
        sourceUserId: "user-1",
        summary: "csv export",
        mode: "auto",
      });
      expect(JSON.parse(readFileSync(storageFile, "utf8")).offers).toHaveLength(1);

      const reloaded = createAmbientCoordinator({
        config: validateConfig({ proactivity: { enabled: true, offer_ttl_secs: 5 } }),
        logger: quietLogger,
        clock,
        triage: async () => yes,
        engage: async (turn) => {
          turns.push(turn);
          return { decision: "send", message: "running with it" };
        },
        storageFile,
      });
      expect(reloaded.getPendingOffer("c1")?.summary).toBe("csv export");

      coordinator.stop();
      clock.advance(5_000);
      await tick();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ kind: "timeout", channelId: "c1" });
      expect(reloaded.getPendingOffer("c1")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
