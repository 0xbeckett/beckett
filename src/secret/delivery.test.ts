import { describe, expect, test } from "bun:test";
import {
  deliverSecretLink,
  discordDmSender,
  DmUndeliverableError,
  isDiscordUserId,
} from "./delivery.ts";

const URL = "https://secret.0xbeckett.me/s/" + "a".repeat(43);

describe("deliverSecretLink", () => {
  test("DMs the requester and reports the dm channel", async () => {
    const sent: { id: string; content: string }[] = [];
    const result = await deliverSecretLink({
      requesterId: "1151230208783945818",
      url: URL,
      message: "hey",
      sendDm: async (id, content) => {
        sent.push({ id, content });
      },
    });
    expect(result).toEqual({ via: "dm" });
    expect(sent).toEqual([{ id: "1151230208783945818", content: `hey\n${URL}` }]);
  });

  test("falls back to ephemeral when the DM is undeliverable", async () => {
    const result = await deliverSecretLink({
      requesterId: "1151230208783945818",
      url: URL,
      sendDm: async () => {
        throw new DmUndeliverableError("closed");
      },
    });
    expect(result).toEqual({ via: "ephemeral-fallback", url: URL });
  });

  test("rejects a non-snowflake requester id", async () => {
    await expect(
      deliverSecretLink({ requesterId: "not-an-id", url: URL, sendDm: async () => {} }),
    ).rejects.toThrow();
  });
});

describe("isDiscordUserId", () => {
  test("accepts snowflakes, rejects junk", () => {
    expect(isDiscordUserId("1151230208783945818")).toBe(true);
    expect(isDiscordUserId("abc")).toBe(false);
    expect(isDiscordUserId("")).toBe(false);
  });
});

describe("discordDmSender", () => {
  function fakeFetch(handlers: Record<string, () => Response>): typeof fetch {
    return (async (input: unknown) => {
      const url = String(typeof input === "object" && input !== null && "url" in input ? (input as { url: string }).url : input);
      const key = url.includes("/users/@me/channels") ? "open" : "send";
      return handlers[key]!();
    }) as unknown as typeof fetch;
  }

  test("opens a DM channel then posts the message", async () => {
    const send = discordDmSender({
      token: "tok",
      fetchImpl: fakeFetch({
        open: () => new Response(JSON.stringify({ id: "dm123" }), { status: 200 }),
        send: () => new Response("{}", { status: 200 }),
      }),
    });
    await expect(send("1151230208783945818", "hello")).resolves.toBeUndefined();
  });

  test("maps a 403 on send to DmUndeliverableError", async () => {
    const send = discordDmSender({
      token: "tok",
      fetchImpl: fakeFetch({
        open: () => new Response(JSON.stringify({ id: "dm123" }), { status: 200 }),
        send: () => new Response("forbidden", { status: 403 }),
      }),
    });
    await expect(send("1151230208783945818", "hello")).rejects.toBeInstanceOf(DmUndeliverableError);
  });

  test("maps a 403 on open to DmUndeliverableError", async () => {
    const send = discordDmSender({
      token: "tok",
      fetchImpl: fakeFetch({
        open: () => new Response("forbidden", { status: 403 }),
        send: () => new Response("{}", { status: 200 }),
      }),
    });
    await expect(send("1151230208783945818", "hello")).rejects.toBeInstanceOf(DmUndeliverableError);
  });
});
