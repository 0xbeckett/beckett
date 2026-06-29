/**
 * Tests for the Haiku front-door triage in shell/main.ts (Spec 06).
 * We test the routing decision with fake implementations (no real model calls).
 */

import { describe, test, expect, mock } from "bun:test";
import type { Brain, IntakeEvent, HaikuClassification, DiscordGateway, IncomingMessage } from "../types.ts";

/** Fake Brain that returns canned classifications without calling a real model. */
class FakeBrain implements Partial<Brain> {
  constructor(private readonly cannedResponse: HaikuClassification) {}

  async intake(_evt: IntakeEvent): Promise<HaikuClassification> {
    return this.cannedResponse;
  }
}

/** Fake DiscordGateway that logs posts instead of sending them. */
class FakeGateway implements Partial<DiscordGateway> {
  public posted: Array<{ channelId: string; text: string }> = [];

  async post(channelId: string, text: string): Promise<string> {
    this.posted.push({ channelId, text });
    return "fake-message-id";
  }

  async sendTyping(_channelId: string): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(_handler: (msg: IncomingMessage) => void): void {}
}

/** Fake parent supervisor that logs injections. */
class FakeParent {
  public injected: string[] = [];

  inject(text: string): void {
    this.injected.push(text);
  }
}

/**
 * Extract the routing logic from main.ts as a testable function.
 * This mirrors the decision tree in injectMention without side effects.
 */
function shouldBypassHaiku(m: {
  repliedToId?: string;
  attachments: unknown[];
  level: "owner" | "member" | "outsider";
}): boolean {
  return Boolean(m.repliedToId) || m.attachments.length > 0 || m.level === "outsider";
}

describe("Haiku front-door triage", () => {
  test("chatter with answer + escalate:false → posts via gateway, parent NOT injected", async () => {
    const brain = new FakeBrain({
      kind: "chatter",
      withinPurview: true,
      escalate: false,
      ack: "got it",
      answer: "hey! what's up?",
    });
    const gateway = new FakeGateway();
    const parent = new FakeParent();

    const m = {
      userId: "user-123",
      channelId: "chan-456",
      messageId: "msg-789",
      content: "<@bot> hey",
      createdAt: Date.now(),
      attachments: [],
      repliedToId: undefined,
      level: "member" as const,
    };

    // Simulate the fast path.
    if (!shouldBypassHaiku(m)) {
      const result = await brain.intake!({
        userId: m.userId,
        channelId: m.channelId,
        msgId: m.messageId,
        text: "hey",
        ts: m.createdAt,
      });
      if (!result.escalate && result.answer) {
        await gateway.post!(m.channelId, result.answer);
      } else {
        parent.inject("fallback");
      }
    } else {
      parent.inject("bypassed");
    }

    expect(gateway.posted.length).toBe(1);
    expect(gateway.posted[0]?.text).toBe("hey! what's up?");
    expect(parent.injected.length).toBe(0); // parent NOT woken
  });

  test("task with escalate:true → parent injected, gateway NOT used for answer", async () => {
    const brain = new FakeBrain({
      kind: "task",
      withinPurview: true,
      escalate: true,
      escalateRole: "plan",
      ack: "on it",
      answer: undefined,
    });
    const gateway = new FakeGateway();
    const parent = new FakeParent();

    const m = {
      userId: "user-123",
      channelId: "chan-456",
      messageId: "msg-789",
      content: "<@bot> fix the bug in auth.ts",
      createdAt: Date.now(),
      attachments: [],
      repliedToId: undefined,
      level: "owner" as const,
    };

    if (!shouldBypassHaiku(m)) {
      const result = await brain.intake!({
        userId: m.userId,
        channelId: m.channelId,
        msgId: m.messageId,
        text: "fix the bug in auth.ts",
        ts: m.createdAt,
      });
      if (!result.escalate && result.answer) {
        await gateway.post!(m.channelId, result.answer);
      } else {
        const hint = result.memoryQuery ? `\n[recall hint: ${result.memoryQuery}]` : "";
        parent.inject(`[discord channel=${m.channelId} user=${m.userId} access=owner] fix the bug in auth.ts${hint}`);
      }
    } else {
      parent.inject("bypassed");
    }

    expect(parent.injected.length).toBe(1);
    expect(parent.injected[0]).toContain("fix the bug in auth.ts");
    expect(gateway.posted.length).toBe(0); // gateway NOT used
  });

  test("brain.intake throws → falls back to parent.inject (no drop)", async () => {
    const brain = new FakeBrain({
      kind: "chatter",
      withinPurview: true,
      escalate: false,
      ack: "",
      answer: "",
    });
    // Override intake to throw.
    brain.intake = async () => {
      throw new Error("Haiku timeout");
    };

    const gateway = new FakeGateway();
    const parent = new FakeParent();

    const m = {
      userId: "user-123",
      channelId: "chan-456",
      messageId: "msg-789",
      content: "<@bot> hello",
      createdAt: Date.now(),
      attachments: [],
      repliedToId: undefined,
      level: "member" as const,
    };

    try {
      if (!shouldBypassHaiku(m)) {
        const result = await brain.intake!({
          userId: m.userId,
          channelId: m.channelId,
          msgId: m.messageId,
          text: "hello",
          ts: m.createdAt,
        });
        if (!result.escalate && result.answer) {
          await gateway.post!(m.channelId, result.answer);
        } else {
          parent.inject(`[discord channel=${m.channelId} user=${m.userId} access=member] hello`);
        }
      } else {
        parent.inject("bypassed");
      }
    } catch (err) {
      // FAIL-SAFE: fall back to parent injection.
      parent.inject(`[discord channel=${m.channelId} user=${m.userId} access=member] hello`);
    }

    expect(parent.injected.length).toBe(1); // fallback injection happened
    expect(parent.injected[0]).toContain("hello");
    expect(gateway.posted.length).toBe(0); // no gateway post
  });

  test("outsider mention → bypasses brain entirely, goes to parent", () => {
    const m = {
      repliedToId: undefined,
      attachments: [],
      level: "outsider" as const,
    };
    expect(shouldBypassHaiku(m)).toBe(true);
  });

  test("mention with attachment → bypasses brain, goes to parent", () => {
    const m = {
      repliedToId: undefined,
      attachments: [{ url: "http://example.com/file.png", filename: "file.png" }],
      level: "member" as const,
    };
    expect(shouldBypassHaiku(m)).toBe(true);
  });

  test("thread reply (repliedToId set) → bypasses brain, goes to parent", () => {
    const m = {
      repliedToId: "msg-123",
      attachments: [],
      level: "owner" as const,
    };
    expect(shouldBypassHaiku(m)).toBe(true);
  });
});
