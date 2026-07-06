/**
 * Unit coverage for the chilltext collector wrapper (OPS-73): the success path (messages[]
 * returned, single:true requested), and every fallback branch — non-2xx, network error,
 * timeout/abort, malformed response, empty messages, empty/overlong input. All mocked —
 * no live network. The invariant under test: `chillReply` returns `null` (⇒ the caller
 * sends the ORIGINAL text unchanged) on ANY failure, and never throws.
 */

import { expect, test, describe } from "bun:test";
import { chillReply } from "./chill.ts";

/** A fetch stub returning a canned JSON body with the given status. */
function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("chillReply — success path", () => {
  test("returns the collector's messages[]", async () => {
    const out = await chillReply(
      "A long formal multi-sentence reply that should be compressed.",
      fetchReturning({ messages: ["short casual version"], n_bubbles: 1, ms: 500 }),
    );
    expect(out).toEqual(["short casual version"]);
  });

  test("POSTs {text, single:true} to /chill with a JSON content type", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;

    await chillReply("hello there", spy);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://chilltext.ssh.codes/chill");
    expect(captured!.init.method).toBe("POST");
    expect((captured!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      text: "hello there",
      single: true,
    });
    // A timeout signal must be attached so an unreachable host can't hang the send path.
    expect(captured!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("drops non-string / blank entries but keeps real bubbles", async () => {
    const out = await chillReply(
      "some text",
      fetchReturning({ messages: ["first", "", 42, "  ", "second"] }),
    );
    expect(out).toEqual(["first", "second"]);
  });
});

describe("chillReply — hard passthrough (returns null, never throws)", () => {
  test("non-2xx response → null", async () => {
    expect(await chillReply("some text", fetchReturning({ error: "boom" }, 500))).toBeNull();
  });

  test("network error (unreachable) → null", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await chillReply("some text", down)).toBeNull();
  });

  test("timeout/abort → null", async () => {
    const hung = (async (_url: unknown, init?: RequestInit) => {
      // Simulate the runtime's abort-on-timeout without waiting the real 35s.
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await chillReply("some text", hung)).toBeNull();
  });

  test("malformed JSON body → null", async () => {
    const bad = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await chillReply("some text", bad)).toBeNull();
  });

  test("response without a messages array → null", async () => {
    expect(await chillReply("some text", fetchReturning({ ok: true }))).toBeNull();
  });

  test("empty messages array → null (never send nothing)", async () => {
    expect(await chillReply("some text", fetchReturning({ messages: [] }))).toBeNull();
  });

  test("all-blank messages → null (never send nothing)", async () => {
    expect(await chillReply("some text", fetchReturning({ messages: ["", "  "] }))).toBeNull();
  });

  test("empty/whitespace input skips the API entirely", async () => {
    const mustNotCall = (async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    expect(await chillReply("", mustNotCall)).toBeNull();
    expect(await chillReply("   \n", mustNotCall)).toBeNull();
  });

  test("text over the 6000-char API limit skips the API entirely", async () => {
    const mustNotCall = (async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    expect(await chillReply("x".repeat(6001), mustNotCall)).toBeNull();
  });
});
