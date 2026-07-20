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
  parseSecretFieldSpecs,
  redeemSecretRequest,
  secretRequestStatus,
  serveSecretIntake,
  upsertEnvKey,
  validateSecretEnvName,
} from "./intake.ts";
import type { KeychainStore } from "./keychain.ts";

const temps: string[] = [];
function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-secret-"));
  temps.push(dir);
  return { beckettDir: dir, envFile: join(dir, ".env") };
}

function urlencode(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("secret-link intake", () => {
  test("mints a high-entropy URL token without storing the raw token", () => {
    const paths = tempPaths();
    const token = generateSecretToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const minted = mintSecretRequest({ paths, name: "OPENROUTER_API_KEY", baseUrl: "https://secret.0xbeckett.me" });
    expect(minted.url).toStartWith("https://secret.0xbeckett.me/s/");
    expect(minted.token.length).toBeGreaterThanOrEqual(32);
    expect(minted.destination.kind).toBe("env");
    expect(readFileSync(defaultSecretStorePath(paths.beckettDir), "utf8")).not.toContain(minted.token);
  });

  test("legacy single env field: request -> redeem -> env upsert, marker, and link dead", async () => {
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
      body: urlencode({ OPENROUTER_API_KEY: "dummy-secret", EVIL_KEY: "x" }),
    }));
    expect(post.status).toBe(200);
    expect(await post.text()).not.toContain("dummy-secret");
    expect(readFileSync(paths.envFile, "utf8")).toBe("OTHER=keep\nOPENROUTER_API_KEY=dummy-secret\nTAIL=still\n");
    const marker = readFileSync(defaultSecretMarkerPath(paths.beckettDir), "utf8");
    expect(marker).toContain("OPENROUTER_API_KEY");
    expect(marker).not.toContain("dummy-secret");
    expect(readFileSync(paths.envFile, "utf8")).not.toContain("EVIL_KEY");

    const secondOpen = await handler(new Request(minted.url));
    expect(secondOpen.status).toBe(410);
    const secondPost = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlencode({ OPENROUTER_API_KEY: "second" }),
    }));
    expect(secondPost.status).toBe(410);
  });

  test("batch env request collects multiple fields in one submit", async () => {
    const paths = tempPaths();
    const minted = mintSecretRequest({
      paths,
      fields: [{ name: "SITE_USER", secret: false }, { name: "SITE_PASS" }],
      destination: { kind: "env" },
      baseUrl: "https://secret.0xbeckett.me",
      token: "g".repeat(43),
    });
    const handler = createSecretHandler({ paths });

    const form = await (await handler(new Request(minted.url))).text();
    expect(form).toContain("SITE_USER");
    expect(form).toContain("SITE_PASS");
    // The non-secret field renders as text, the secret one as password.
    expect(form).toContain('name="SITE_USER" type="text"');
    expect(form).toContain('name="SITE_PASS" type="password"');

    const post = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlencode({ SITE_USER: "bot@example.com", SITE_PASS: "pw-123" }),
    }));
    expect(post.status).toBe(200);
    expect(readFileSync(paths.envFile, "utf8")).toBe("SITE_USER=bot@example.com\nSITE_PASS=pw-123\n");
  });

  test("a missing field in the batch is rejected and burns nothing", async () => {
    const paths = tempPaths();
    const minted = mintSecretRequest({
      paths,
      fields: [{ name: "A_KEY" }, { name: "B_KEY" }],
      destination: { kind: "env" },
      baseUrl: "https://secret.0xbeckett.me",
      token: "h".repeat(43),
    });
    const handler = createSecretHandler({ paths });
    const post = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlencode({ A_KEY: "only-one" }),
    }));
    expect(post.status).toBe(400);
    // Link still live because nothing was written.
    expect(secretRequestStatus(paths, minted.token).ok).toBe(true);
  });

  test("keychain destination routes the batch to the injected sink, not env", async () => {
    const paths = tempPaths();
    const calls: unknown[] = [];
    const sink: KeychainStore = async (p) => {
      calls.push(p);
    };
    const minted = mintSecretRequest({
      paths,
      fields: [{ name: "username", secret: false }, { name: "password" }],
      destination: { kind: "keychain", entry: "acme", service: "acme.example" },
      baseUrl: "https://secret.0xbeckett.me",
      token: "k".repeat(43),
    });
    const handler = createSecretHandler({ paths, storeInKeychain: sink });

    const form = await (await handler(new Request(minted.url))).text();
    expect(form).toContain("jingle keychain entry");
    expect(form).toContain("acme");

    const post = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlencode({ username: "ro@acme", password: "s3cret" }),
    }));
    expect(post.status).toBe(200);
    expect(calls).toEqual([
      {
        entry: "acme",
        service: "acme.example",
        fields: [
          { field: "username", value: "ro@acme" },
          { field: "password", value: "s3cret" },
        ],
      },
    ]);
    // Nothing hits .env for a keychain request.
    expect(() => readFileSync(paths.envFile, "utf8")).toThrow();
    // Marker records the entry + field names but never the values.
    const marker = readFileSync(defaultSecretMarkerPath(paths.beckettDir), "utf8");
    expect(marker).toContain("keychain");
    expect(marker).toContain("acme");
    expect(marker).not.toContain("s3cret");
    expect(marker).not.toContain("ro@acme");
  });

  test("a failing keychain sink leaves the link live and returns a generic error", async () => {
    const paths = tempPaths();
    const sink: KeychainStore = async () => {
      throw new Error("jingle exploded with s3cret in the message");
    };
    const minted = mintSecretRequest({
      paths,
      fields: [{ name: "password" }],
      destination: { kind: "keychain", entry: "acme" },
      baseUrl: "https://secret.0xbeckett.me",
      token: "m".repeat(43),
    });
    const handler = createSecretHandler({ paths, storeInKeychain: sink });
    const post = await handler(new Request(minted.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlencode({ password: "s3cret" }),
    }));
    expect(post.status).toBe(503);
    expect(await post.text()).not.toContain("s3cret");
    expect(secretRequestStatus(paths, minted.token).ok).toBe(true);
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
      body: "SAFE=ok%0aEVIL%3D1",
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
        controller.enqueue(new TextEncoder().encode(`SAFE=${"x".repeat(32 * 1024)}`));
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

  test("v1 on-disk records still redeem after the schema bump", async () => {
    const paths = tempPaths();
    const token = "v".repeat(43);
    const hash = (await import("node:crypto")).createHash("sha256").update(token).digest("hex");
    const legacy = {
      version: 1,
      requests: {
        [hash]: {
          name: "LEGACY_KEY",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      },
    };
    writeFileSync(defaultSecretStorePath(paths.beckettDir), JSON.stringify(legacy));
    const status = secretRequestStatus(paths, token);
    expect(status.ok).toBe(true);
    const redeemed = await redeemSecretRequest(paths, token, { LEGACY_KEY: "val" });
    expect(redeemed.ok).toBe(true);
    expect(readFileSync(paths.envFile, "utf8")).toBe("LEGACY_KEY=val\n");
  });
});

describe("parseSecretFieldSpecs", () => {
  test("defaults identifiers to visible and others to masked", () => {
    expect(parseSecretFieldSpecs("username,password")).toEqual([
      { name: "username", secret: false },
      { name: "password", secret: true },
    ]);
  });

  test("honors explicit text/secret modifiers", () => {
    expect(parseSecretFieldSpecs("token:secret,handle:text")).toEqual([
      { name: "token", secret: true },
      { name: "handle", secret: false },
    ]);
  });

  test("rejects an unknown modifier and an empty list", () => {
    expect(() => parseSecretFieldSpecs("a:bogus")).toThrow();
    expect(() => parseSecretFieldSpecs("  ")).toThrow();
  });
});
