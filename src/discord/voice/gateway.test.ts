import { expect, test } from "bun:test";
import { VoiceGateway, VoiceAuthorizationError, canControlVoice } from "./gateway.ts";
import { FakeVoiceBackend } from "./fake-backend.ts";
import type { AccessLevel } from "./types.ts";

function mkGateway(levels: Record<string, AccessLevel>) {
  const backends: FakeVoiceBackend[] = [];
  const gateway = new VoiceGateway({
    backendFactory: async () => {
      const b = new FakeVoiceBackend();
      backends.push(b);
      return b;
    },
    authorize: (userId) => levels[userId] ?? "outsider",
  });
  return { gateway, backends };
}

test("canControlVoice is owner/maintainer only — the four-elevated-verbs set", () => {
  expect(canControlVoice("owner")).toBe(true);
  expect(canControlVoice("maintainer")).toBe(true);
  expect(canControlVoice("member")).toBe(false);
  expect(canControlVoice("outsider")).toBe(false);
});

test("the owner can join and leave", async () => {
  const { gateway } = mkGateway({ boss: "owner" });
  const session = await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "boss" });
  expect(session.channelId).toBe("c1");
  expect(await gateway.leave("g1", "boss")).toBe(true);
});

test("a maintainer can join (same authority as push/merge/deploy/restart)", async () => {
  const { gateway } = mkGateway({ mnt: "maintainer" });
  const session = await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "mnt" });
  expect(session.guildId).toBe("g1");
});

test("a member is refused", async () => {
  const { gateway, backends } = mkGateway({ mem: "member" });
  await expect(
    gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "mem" }),
  ).rejects.toBeInstanceOf(VoiceAuthorizationError);
  expect(backends).toHaveLength(0); // never even opened a backend
});

test("an outsider is refused", async () => {
  const { gateway } = mkGateway({});
  await expect(
    gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "nobody" }),
  ).rejects.toBeInstanceOf(VoiceAuthorizationError);
});

test("leave is gated too — a member cannot make Beckett leave", async () => {
  const { gateway } = mkGateway({ boss: "owner", mem: "member" });
  await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "boss" });
  await expect(gateway.leave("g1", "mem")).rejects.toBeInstanceOf(VoiceAuthorizationError);
  // still connected — the refused leave did nothing
  expect(gateway.session("g1")).toBeDefined();
});

test("joining a different channel in the same guild moves (leaves the old session)", async () => {
  const { gateway, backends } = mkGateway({ boss: "owner" });
  await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "boss" });
  await gateway.join({ guildId: "g1", channelId: "c2", requestedByUserId: "boss" });
  expect(backends[0]!.closed).toBe(true); // old channel torn down
  expect(gateway.session("g1")!.channelId).toBe("c2");
});

test("re-joining the same channel returns the existing session", async () => {
  const { gateway, backends } = mkGateway({ boss: "owner" });
  const a = await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "boss" });
  const b = await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "boss" });
  expect(a).toBe(b);
  expect(backends).toHaveLength(1);
});

test("leaveAll tears down every session (shutdown path)", async () => {
  const { gateway, backends } = mkGateway({ boss: "owner" });
  await gateway.join({ guildId: "g1", channelId: "c1", requestedByUserId: "boss" });
  await gateway.join({ guildId: "g2", channelId: "c2", requestedByUserId: "boss" });
  await gateway.leaveAll();
  expect(backends.every((b) => b.closed)).toBe(true);
  expect(gateway.session("g1")).toBeUndefined();
});
