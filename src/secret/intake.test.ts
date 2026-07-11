import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSecretHandler,
  defaultSecretMarkerPath,
  defaultSecretStorePath,
  generateSecretToken,
  mintSecretRequest,
  secretRequestStatus,
  serveSecretIntake,
  upsertEnvKey,
  validateSecretEnvName,
} from "./intake.ts";

const temps: string[] = [];
function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-secret-"));
  temps.push(dir);
  return { beckettDir: dir, envFile: join(dir, ".env") };
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("one-time secret intake", () => {
  test("mints a high-entropy URL token without storing the raw token", () => {
    const paths = tempPaths();
    const token = generateSecretToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const minted = mintSecretRequest({ paths, name: "OPENROUTER_API_KEY", baseUrl: "https://secret.0xbeckett.me" });
    expect(minted.url).toStartWith("https://secret.0xbeckett.me/s/");
    expect(minted.token.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(defaultSecretStorePath(paths.beckettDir), "utf8")).not.toContain(minted.token);
  });

  test("request -> redeem dummy -> env upsert, marker, and link dead", async () => {
    const paths = tempPaths();
    writeFileSync(paths.envFile, "OTHER=keep\nOPENROUTER_API_KEY=old\nTAIL=still\n");
    const minted = mintSecretRequest({
      paths,
      name: "OPENROUTER_API_KEY",
      baseUrl: "https://secret.0xbeckett.me",
      token: "a".repeat(43),
    });
    const handler = createSecretHandler({ paths });

    const get = await handler(new Request(minted.url));
    expect(get.status).toBe(200);
    const form = await get.text();
    expect(form).toContain("OPENROUTER_API_KEY");
    expect(form).toContain('type="password"');
    expect(form).not.toContain("dummy-secret");

    const post = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=EVIL_KEY&value=dummy-secret",
    }));
    expect(post.status).toBe(200);
    expect(await post.text()).not.toContain("dummy-secret");
    expect(readFileSync(paths.envFile, "utf8")).toBe("OTHER=keep\nOPENROUTER_API_KEY=dummy-secret\nTAIL=still\n");
    expect(readFileSync(defaultSecretMarkerPath(paths.beckettDir), "utf8")).toContain("OPENROUTER_API_KEY");
    expect(readFileSync(paths.envFile, "utf8")).not.toContain("EVIL_KEY");

    const secondOpen = await handler(new Request(minted.url));
    expect(secondOpen.status).toBe(410);
    const secondPost = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "value=second",
    }));
    expect(secondPost.status).toBe(410);
  });

  test("expired, used, and unknown tokens get the same generic response", async () => {
    const paths = tempPaths();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const minted = mintSecretRequest({
      paths,
      name: "OPENROUTER_API_KEY",
      ttlMinutes: 1,
      baseUrl: "https://secret.0xbeckett.me",
      token: "b".repeat(43),
      now,
    });
    now = new Date("2026-01-01T00:01:01.000Z");
    expect(secretRequestStatus(paths, minted.token, now).ok).toBe(false);

    const handler = createSecretHandler({ paths, now: () => now });
    const expired = await handler(new Request(minted.url));
    const unknown = await handler(new Request("https://secret.0xbeckett.me/s/" + "c".repeat(43)));
    expect(expired.status).toBe(410);
    expect(unknown.status).toBe(410);
    expect(await expired.text()).toBe(await unknown.text());
  });

  test("rejects env-name and value injection", async () => {
    expect(() => validateSecretEnvName("OPENROUTER_API_KEY\nEVIL=1")).toThrow();
    expect(() => validateSecretEnvName("1BAD")).toThrow();

    const paths = tempPaths();
    writeFileSync(paths.envFile, "SAFE=old\nOTHER=keep\n");
    const minted = mintSecretRequest({ paths, name: "SAFE", baseUrl: "https://secret.0xbeckett.me", token: "d".repeat(43) });
    const handler = createSecretHandler({ paths });
    const res = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "value=ok%0aEVIL%3D1",
    }));
    expect(res.status).toBe(400);
    expect(readFileSync(paths.envFile, "utf8")).toBe("SAFE=old\nOTHER=keep\n");
  });

  test("rejects a headerless form body that exceeds the streaming cap", async () => {
    const paths = tempPaths();
    const minted = mintSecretRequest({
      paths,
      name: "SAFE",
      baseUrl: "https://secret.0xbeckett.me",
      token: "e".repeat(43),
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`value=${"x".repeat(32 * 1024)}`));
        controller.close();
      },
    });
    const request = new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await createSecretHandler({ paths })(request);

    expect(response.status).toBe(413);
    expect(secretRequestStatus(paths, minted.token).ok).toBe(true);
  });

  test("the HTTP server rejects an oversized chunked body at the transport boundary", async () => {
    const paths = tempPaths();
    const minted = mintSecretRequest({
      paths,
      name: "SAFE",
      baseUrl: "https://secret.0xbeckett.me",
      token: "f".repeat(43),
    });
    const server = serveSecretIntake({ paths, port: 0 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
        controller.close();
      },
    });

    try {
      const response = await fetch(`${server.url}/s/${minted.token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(response.status).toBe(413);
      expect(secretRequestStatus(paths, minted.token).ok).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("upsert replaces only the target line or appends when absent", () => {
    const paths = tempPaths();
    writeFileSync(paths.envFile, "A=1\nB=2\n");
    upsertEnvKey(paths.envFile, "C", "three");
    expect(readFileSync(paths.envFile, "utf8")).toBe("A=1\nB=2\nC=three\n");
    upsertEnvKey(paths.envFile, "B", "two");
    expect(readFileSync(paths.envFile, "utf8")).toBe("A=1\nB=two\nC=three\n");
  });
});
