import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeFilename,
  downloadAttachments,
  formatAttachmentManifest,
  type DownloadedAttachment,
} from "./attachments.ts";
import type { IncomingAttachment } from "../types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function att(over: Partial<IncomingAttachment> = {}): IncomingAttachment {
  return { id: "1", name: "notes.md", url: "https://cdn.test/notes.md", contentType: "text/markdown", size: 12, ...over };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "beckett-att-"));
}

// ── safeFilename ──────────────────────────────────────────────────────────────

test("safeFilename strips path traversal down to a basename", () => {
  expect(safeFilename("../../etc/passwd")).toBe("passwd");
  expect(safeFilename("/abs/path/x.png")).toBe("x.png");
});

test("safeFilename sanitizes junk but keeps the extension", () => {
  expect(safeFilename("my file!@#.pdf")).toContain(".pdf");
  expect(safeFilename("weird/../name.txt")).toBe("name.txt");
});

test("safeFilename falls back when there's no usable name", () => {
  expect(safeFilename("///")).toBe("file");
  expect(safeFilename("")).toBe("file");
});

// ── downloadAttachments ───────────────────────────────────────────────────────

test("empty list returns empty", async () => {
  const out = await downloadAttachments([], { attachmentsDir: tmp(), messageId: "m1" });
  expect(out).toEqual([]);
});

test("downloads bytes to a per-message dir and reports a local path", async () => {
  const dir = tmp();
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att({ name: "pic.png", contentType: "image/png", size: 4 })], {
    attachmentsDir: dir,
    messageId: "msg42",
  });
  const r = out0[0]!;
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.localPath).toBe(join(dir, "msg42", "pic.png"));
    expect(existsSync(r.localPath)).toBe(true);
    expect(readFileSync(r.localPath).length).toBe(4);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("rejects an oversized attachment by declared size without fetching", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("x");
  }) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att({ size: 999 })], {
    attachmentsDir: tmp(),
    messageId: "m",
    maxBytes: 100,
  });
  const r = out0[0]!;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("too large");
  expect(fetched).toBe(false); // pre-flight reject — never spent a fetch
});

test("rejects by Content-Length before buffering an oversized body", async () => {
  let buffered = false;
  globalThis.fetch = (async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-length": "9999" },
    });
    const orig = res.arrayBuffer.bind(res);
    Object.defineProperty(res, "arrayBuffer", {
      value: async () => {
        buffered = true;
        return orig();
      },
    });
    return res;
  }) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att({ size: 1 })], {
    attachmentsDir: tmp(),
    messageId: "m",
    maxBytes: 100,
  });
  const r = out0[0]!;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("too large");
  expect(buffered).toBe(false); // bailed on the header, never read the body
});

test("a fetch error degrades to ok:false, never throws", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  const out0 = await downloadAttachments([att()], { attachmentsDir: tmp(), messageId: "m" });
  const r = out0[0]!;
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("404");
});

test("one bad download doesn't sink the others", async () => {
  const dir = tmp();
  globalThis.fetch = (async (url: string) =>
    url.includes("bad")
      ? new Response("", { status: 500 })
      : new Response(new Uint8Array([9]), { status: 200 })) as unknown as typeof fetch;
  const out = await downloadAttachments(
    [att({ id: "a", name: "good.txt", url: "https://cdn.test/good.txt", size: 1 }),
     att({ id: "b", name: "bad.txt", url: "https://cdn.test/bad.txt", size: 1 })],
    { attachmentsDir: dir, messageId: "m" },
  );
  expect(out[0]!.ok).toBe(true);
  expect(out[1]!.ok).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// ── formatAttachmentManifest ──────────────────────────────────────────────────

test("manifest is empty for no attachments", () => {
  expect(formatAttachmentManifest([])).toBe("");
});

test("manifest lists local paths for hits and reasons for misses", () => {
  const results: DownloadedAttachment[] = [
    { ok: true, name: "a.png", localPath: "/tmp/x/a.png", contentType: "image/png", size: 2048 },
    { ok: false, name: "b.pdf", url: "https://cdn.test/b.pdf", reason: "timeout" },
  ];
  const out = formatAttachmentManifest(results);
  expect(out).toContain("2 attachments, 1 saved locally");
  expect(out).toContain("/tmp/x/a.png");
  expect(out).toContain("Read:");
  expect(out).toContain("b.pdf");
  expect(out).toContain("timeout");
});
