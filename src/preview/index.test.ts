import { expect, test } from "bun:test";
import {
  isFrontendChange,
  isFrontendPath,
  previewNameFor,
  PreviewManager,
  type PreviewStore,
} from "./index.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as import("../types.ts").Logger;

// ── frontend detection ────────────────────────────────────────────────────────────────────────

test("isFrontendPath recognizes browser-facing files by extension and config name", () => {
  expect(isFrontendPath("src/App.tsx")).toBe(true);
  expect(isFrontendPath("styles/main.css")).toBe(true);
  expect(isFrontendPath("index.html")).toBe(true);
  expect(isFrontendPath("web/vite.config.ts")).toBe(true);
  expect(isFrontendPath("tailwind.config.js")).toBe(true);
  expect(isFrontendPath("components/Button.vue")).toBe(true);
  expect(isFrontendPath("public/logo.svg")).toBe(true);
  expect(isFrontendPath("web/lib/helpers.ts")).toBe(true); // .ts under a frontend dir
});

test("isFrontendPath does NOT flag backend/config-only changes", () => {
  expect(isFrontendPath("src/dispatch/dispatcher.ts")).toBe(false);
  expect(isFrontendPath("package.json")).toBe(false); // lone manifest is not a frontend change
  expect(isFrontendPath("README.md")).toBe(false);
  expect(isFrontendPath("scripts/build.sh")).toBe(false);
  expect(isFrontendPath("src/server/api.ts")).toBe(false);
});

test("isFrontendChange is true if ANY file is frontend", () => {
  expect(isFrontendChange(["src/api.ts", "README.md"])).toBe(false);
  expect(isFrontendChange(["src/api.ts", "web/App.tsx"])).toBe(true);
  expect(isFrontendChange([])).toBe(false);
});

// ── deterministic host ─────────────────────────────────────────────────────────────────────────

test("previewNameFor is a deterministic, DNS-safe label", () => {
  expect(previewNameFor("my-app")).toBe("my-app-preview");
  expect(previewNameFor("OPS 42")).toBe("ops-42-preview");
  expect(previewNameFor("weird/slug!")).toBe("weird-slug-preview");
});

// ── PreviewManager.ensure ────────────────────────────────────────────────────────────────────

function managerWith(over: Partial<ConstructorParameters<typeof PreviewManager>[0]> = {}) {
  const removed: string[] = [];
  const recorded: Array<{ branchRef: string; url: string; host: string }> = [];
  const cleared: string[] = [];
  const store: PreviewStore = {
    async setPreview(branchRef, p) { recorded.push({ branchRef, ...p }); },
    async clearPreview(branchRef) { cleared.push(branchRef); },
  };
  const manager = new PreviewManager({
    deployer: { available: true, remove: async (name: string) => { removed.push(name); return {} as never; } },
    probe: async () => true,
    changedFiles: async () => ["web/App.tsx"],
    store,
    logger: quiet,
    apex: "0xbeckett.me",
    probeAttempts: 1,
    sleep: async () => {},
    ...over,
  });
  return { manager, removed, recorded, cleared };
}

test("ensure surfaces and records a reachable frontend preview", async () => {
  const { manager, recorded } = managerWith();
  const out = await manager.ensure({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(out.status).toBe("ready");
  if (out.status === "ready") {
    expect(out.url).toBe("https://my-app-preview.0xbeckett.me");
    expect(out.host).toBe("my-app-preview.0xbeckett.me");
  }
  expect(recorded).toEqual([{ branchRef: "42.1", url: "https://my-app-preview.0xbeckett.me", host: "my-app-preview.0xbeckett.me" }]);
});

test("ensure does NOT surface when the preview is unreachable (dead link never posted)", async () => {
  const { manager, recorded } = managerWith({ probe: async () => false, probeAttempts: 2 });
  const out = await manager.ensure({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(out.status).toBe("skipped");
  expect(recorded).toEqual([]);
});

test("ensure skips non-frontend branches", async () => {
  const { manager } = managerWith({ changedFiles: async () => ["src/server/api.ts", "README.md"] });
  const out = await manager.ensure({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(out).toEqual({ status: "skipped", reason: "no frontend changes" });
});

test("ensure surfaces nothing when the tunnel is not configured", async () => {
  const { manager } = managerWith({ deployer: { available: false, remove: async () => ({}) as never } });
  const out = await manager.ensure({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(out).toEqual({ status: "skipped", reason: "tunnel not configured" });
});

test("ensure retries the probe across propagation delay", async () => {
  let calls = 0;
  const { manager } = managerWith({
    probe: async () => { calls++; return calls >= 2; },
    probeAttempts: 3,
  });
  const out = await manager.ensure({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(out.status).toBe("ready");
  expect(calls).toBe(2);
});

// ── PreviewManager.teardown ──────────────────────────────────────────────────────────────────

test("teardown removes the tunnel deploy and clears the record", async () => {
  const { manager, removed, cleared } = managerWith();
  await manager.teardown({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(removed).toEqual(["my-app-preview"]);
  expect(cleared).toEqual(["42.1"]);
});

test("teardown is a clean no-op when the tunnel is not configured", async () => {
  const { manager, removed, cleared } = managerWith({ deployer: { available: false, remove: async () => ({}) as never } });
  await manager.teardown({ id: "t1", slug: "my-app", branchRef: "42.1" });
  expect(removed).toEqual([]);
  expect(cleared).toEqual(["42.1"]); // record still cleared
});

test("teardown never throws even if remove fails", async () => {
  const { manager } = managerWith({
    deployer: { available: true, remove: async () => { throw new Error("cloudflare down"); } },
  });
  await manager.teardown({ id: "t1", slug: "my-app", branchRef: "42.1" });
});
