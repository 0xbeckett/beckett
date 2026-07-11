import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexImageGen, FalMediaGen } from "./imagegen.ts";
import type { Logger } from "../types.ts";

const quiet = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as unknown as Logger;
})();

const savedFalKey = process.env.FAL_KEY;
const savedFalApiKey = process.env.FAL_API_KEY;
const savedBeckettDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];

afterEach(() => {
  if (savedFalKey === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = savedFalKey;
  if (savedFalApiKey === undefined) delete process.env.FAL_API_KEY;
  else process.env.FAL_API_KEY = savedFalApiKey;
  if (savedBeckettDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedBeckettDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-imagegen-"));
  tmpDirs.push(d);
  return d;
}

test("default image generation remains the Codex path and does not need a FAL key", async () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  const dir = tmp();
  const fakeCodex = join(dir, "fake-codex");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'last="${!#}"',
      'out="$(printf \'%s\' "$last" | awk \'/Save the final image to EXACTLY this absolute path/{getline; print; exit}\')"',
      'if [[ -z "$out" ]]; then echo "missing out path" >&2; exit 2; fi',
      'mkdir -p "$(dirname "$out")"',
      "printf 'PNG!' > \"$out\"",
      "printf '%s\\n' \"$out\"",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);

  const out = join(dir, "default.png");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });
  const res = await gen.generate({ prompt: "default robot", out });

  expect(res.provider).toBeUndefined();
  expect(res.path).toBe(out);
  expect(res.relocated).toBe(false);
  expect(statSync(out).size).toBe(4);
});

test("Codex image generation rejects a nonzero exit instead of returning an old output", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "failing-codex");
  const out = join(dir, "existing.png");
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\necho failed >&2\nexit 7\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /failed \(exit 7\)/,
  );
  expect(Bun.file(out).size).toBe(3);
});

test("Codex image generation rejects an unchanged pre-existing output", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "noop-codex");
  const out = join(dir, "existing.png");
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /no fresh image/,
  );
});

test("Codex image generation does not relocate a recent pre-existing sibling", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "noop-codex");
  const out = join(dir, "existing.png");
  writeFileSync(fakeCodex, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  writeFileSync(join(dir, "recent-sibling.png"), "UNRELATED");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /no fresh image/,
  );
  expect(await Bun.file(out).text()).toBe("OLD");
});

test("Codex image generation does not treat touching old bytes as a new image", async () => {
  const dir = tmp();
  const fakeCodex = join(dir, "touch-codex");
  const out = join(dir, "existing.png");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      'last="${!#}"',
      'out="$(printf \'%s\' "$last" | awk \'/Save the final image to EXACTLY this absolute path/{getline; print; exit}\')"',
      'touch "$out"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);
  writeFileSync(out, "OLD");
  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
    codexBin: fakeCodex,
    codexHome: join(dir, "codex-home"),
  });

  await expect(gen.generate({ prompt: "replace this", out })).rejects.toThrow(
    /no fresh image/,
  );
  expect(await Bun.file(out).text()).toBe("OLD");
});

test("fal missing key fails cleanly before any network call", () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir;
  expect(
    () => new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, fetchImpl: (() => { throw new Error("network"); }) as unknown as typeof fetch }),
  ).toThrow(/FAL key not on box: no FAL_KEY or FAL_API_KEY/);
});

test("fal reads FAL_API_KEY from the Beckett .env file", () => {
  delete process.env.FAL_KEY;
  delete process.env.FAL_API_KEY;
  const dir = tmp();
  process.env.BECKETT_DIR = dir;
  writeFileSync(join(dir, ".env"), "FAL_API_KEY=from-file\n");
  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet });
  expect(gen).toBeDefined();
  expect(String(process.env.FAL_API_KEY)).toBe("from-file");
});

test("CodexImageGen routes fal-ai model slugs through the fal async queue and downloads images", async () => {
  const dir = tmp();
  const calls: Array<{ url: string; method: string; auth?: string; body?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      auth: init?.headers instanceof Headers ? init.headers.get("Authorization") ?? undefined : (init?.headers as any)?.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (u === "https://queue.fal.run/fal-ai/flux/dev") {
      return Response.json({ request_id: "req-1", status_url: "https://queue.test/status/req-1", response_url: "https://queue.test/result/req-1" });
    }
    if (u === "https://queue.test/status/req-1?logs=1") return Response.json({ status: "COMPLETED" });
    if (u === "https://queue.test/result/req-1") return Response.json({ images: [{ url: "https://cdn.test/out.png" }] });
    if (u === "https://cdn.test/out.png") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const gen = new CodexImageGen({
    imagesDir: join(dir, "images"),
    logger: quiet,
  });
  // Inject fal settings by constructing the routed provider's env knobs, but keep the public entrypoint
  // as CodexImageGen.generate: this pins the no-regression behavior that only fal-ai/... changes route.
  process.env.FAL_KEY = "fal-test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const out = join(dir, "flux.png");
    const res = await gen.generate({ prompt: "a small robot", model: "fal-ai/flux/dev", out, size: "1024x1024" });
    expect(res.provider).toBe("fal");
    expect(res.media).toBe("image");
    expect(res.path).toBe(out);
    expect(statSync(out).size).toBe(3);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://queue.fal.run/fal-ai/flux/dev", auth: "Key fal-test" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ prompt: "a small robot", image_size: { width: 1024, height: 1024 } });
  } finally {
    globalThis.fetch = originalFetch;
  }
}, { timeout: 10_000 });

test("fal video models write video output and failed queue statuses expose fal's error", async () => {
  const dir = tmp();
  const videoFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://queue.test/fal-ai/bytedance/seedance/text-to-video") {
      return Response.json({ request_id: "vid-1", status_url: "https://queue.test/status/vid-1", response_url: "https://queue.test/result/vid-1" });
    }
    if (u === "https://queue.test/status/vid-1?logs=1") return Response.json({ status: "COMPLETED" });
    if (u === "https://queue.test/result/vid-1") return Response.json({ video: { url: "https://cdn.test/out.mp4" } });
    if (u === "https://cdn.test/out.mp4") return new Response(new Uint8Array([9, 8, 7, 6]), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const out = join(dir, "clip.mp4");
  const gen = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", baseUrl: "https://queue.test", fetchImpl: videoFetch, pollIntervalMs: 1 });
  const res = await gen.generate({ prompt: "camera pushes in", model: "fal-ai/bytedance/seedance/text-to-video", media: "video", out });
  expect(res.media).toBe("video");
  expect(res.path).toBe(out);
  expect(statSync(out).size).toBe(4);

  const failFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://queue.test/fal-ai/bytedance/seedance/text-to-video") {
      return Response.json({ request_id: "bad-1", status_url: "https://queue.test/status/bad-1", response_url: "https://queue.test/result/bad-1" });
    }
    if (u === "https://queue.test/status/bad-1?logs=1") return Response.json({ status: "FAILED", error: "seedance quota exceeded" });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const bad = new FalMediaGen({ imagesDir: join(dir, "images"), logger: quiet, apiKey: "fal-test", baseUrl: "https://queue.test", fetchImpl: failFetch, pollIntervalMs: 1 });
  await expect(bad.generate({ prompt: "x", model: "fal-ai/bytedance/seedance/text-to-video", media: "video" })).rejects.toThrow(
    /fal fal-ai\/bytedance\/seedance\/text-to-video failed: seedance quota exceeded/,
  );
});
