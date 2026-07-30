/**
 * V6 Phase 2 — the extension catalog reaches the concierge's system prompt
 * (docs/v6-architecture.md §6). The composed prompt is deliberately UNPINNED by any
 * characterization snapshot, so this suite is the deliberate pin: with a wired registry the
 * catalog renders as one compact block between doctrine and persona; without one the prompt
 * is byte-identical to the pre-catalog shape. Skills and dispatch mechanics are unchanged
 * this phase — the block is the concierge SEEING the surface, not a routing rewrite.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, ConciergeSession } from "./index.ts";
import { validateConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { ExtensionRegistry, renderCatalogBlock, type ExtensionContext } from "../ext/index.ts";
import { createImageExtension } from "../capability/modules/index.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { Logger } from "../types.ts";

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-catalog-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  // Doctrine rendering resolves the GitHub identity; give it one so composition succeeds.
  return validateConfig({ identity: { github_user: "octocat" } });
}

function extCtx(config = validateConfig({})): ExtensionContext {
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

/** The composed prompt is private plumbing; reach it directly rather than spawning claude. */
function composedPrompt(session: ConciergeSession): string {
  return (session as unknown as { composeSystemPrompt(): string }).composeSystemPrompt();
}

// ── the renderer ─────────────────────────────────────────────────────────────────────────

test("renderCatalogBlock is one compact id+description line per capability, empty for none", () => {
  expect(renderCatalogBlock([])).toBe("");
  const registry = new ExtensionRegistry();
  registry.register(createImageExtension(extCtx()));
  const block = renderCatalogBlock(registry.catalog());
  expect(block.startsWith("<extension-catalog>")).toBeTrue();
  expect(block.endsWith("</extension-catalog>")).toBeTrue();
  expect(block).toContain("- image.generate — ");
});

// ── the composed prompt ──────────────────────────────────────────────────────────────────

test("with a catalog thunk the block composes AFTER doctrine and BEFORE persona", () => {
  const config = tempConfig();
  const registry = new ExtensionRegistry();
  registry.register(createImageExtension(extCtx(config)));
  const session = new ConciergeSession({
    config,
    catalogBlock: () => renderCatalogBlock(registry.catalog()),
  });
  const prompt = composedPrompt(session);
  const doctrineAt = prompt.indexOf("<doctrine>");
  const catalogAt = prompt.indexOf("<extension-catalog>");
  const personaAt = prompt.indexOf("<persona>");
  expect(doctrineAt).toBe(0);
  expect(catalogAt).toBeGreaterThan(doctrineAt);
  expect(personaAt).toBeGreaterThan(catalogAt);
  expect(prompt).toContain("image.generate");
});

test("empty catalog and loop stores leave the composed prompt byte-identical", () => {
  const config = tempConfig();
  const bare = composedPrompt(new ConciergeSession({ config }));
  const emptyCatalog = composedPrompt(new ConciergeSession({ config, catalogBlock: () => "" }));
  const emptyLoops = composedPrompt(new ConciergeSession({ config, openLoopsBlock: () => "" }));
  const emptyCalibration = composedPrompt(new ConciergeSession({ config, calibrationBlock: () => "" }));
  const emptyProposals = composedPrompt(new ConciergeSession({ config, proposalsBlock: () => "" }));
  expect(bare).not.toContain("<extension-catalog>");
  expect(bare).not.toContain("<open-loops>");
  expect(bare).not.toContain("<calibration>");
  expect(bare).not.toContain("<open-proposals>");
  expect(emptyCatalog).toBe(bare);
  expect(emptyLoops).toBe(bare);
  expect(emptyCalibration).toBe(bare);
  expect(emptyProposals).toBe(bare);
});

test("the open-proposals block composes after open-loops and before persona (issue #37)", () => {
  const config = tempConfig();
  const session = new ConciergeSession({
    config,
    openLoopsBlock: () => "<open-loops>\\n- OVERDUE 2026-07-01 [commitment] I owe this\\n</open-loops>",
    proposalsBlock: () =>
      "<open-proposals>\\n- prop-2026-07-26-x [doctrine-change] stop asking to confirm reads\\n</open-proposals>",
  });
  const prompt = composedPrompt(session);
  expect(prompt.indexOf("<open-loops>")).toBeLessThan(prompt.indexOf("<open-proposals>"));
  expect(prompt.indexOf("<open-proposals>")).toBeLessThan(prompt.indexOf("<persona>"));
  expect(prompt).toContain("prop-2026-07-26-x");
});

test("the fresh loop block composes after catalog and before persona", () => {
  const config = tempConfig();
  const session = new ConciergeSession({
    config,
    catalogBlock: () => "<extension-catalog>\\n- x\\n</extension-catalog>",
    openLoopsBlock: () => "<open-loops>\\n- OVERDUE 2026-07-01 [commitment] I owe this\\n</open-loops>",
  });
  const prompt = composedPrompt(session);
  expect(prompt.indexOf("<extension-catalog>")).toBeLessThan(prompt.indexOf("<open-loops>"));
  expect(prompt.indexOf("<open-loops>")).toBeLessThan(prompt.indexOf("<persona>"));
});

test("the per-channel calibration block composes after open-loops and before persona", () => {
  const config = tempConfig();
  const session = new ConciergeSession({
    config,
    openLoopsBlock: () => "<open-loops>\\n- OVERDUE 2026-07-01 [commitment] I owe this\\n</open-loops>",
    calibrationBlock: () => '<calibration>\\n- [veto] 2026-07-27 replay-missed — "nah its fine"\\n</calibration>',
  });
  const prompt = composedPrompt(session);
  expect(prompt.indexOf("<open-loops>")).toBeLessThan(prompt.indexOf("<calibration>"));
  expect(prompt.indexOf("<calibration>")).toBeLessThan(prompt.indexOf("<persona>"));
  expect(prompt).toContain("replay-missed");
});

// ── the concierge wiring ─────────────────────────────────────────────────────────────────

test("Concierge.extensionCatalogBlock is empty until the registry is wired, then renders it", () => {
  const config = tempConfig();
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 1,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({}),
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, gateway, session });
  expect(concierge.extensionCatalogBlock()).toBe("");

  const ctx = extCtx(config);
  const registry = new ExtensionRegistry();
  registry.register(createImageExtension(ctx));
  concierge.setExtensionRegistry(registry, ctx);
  const block = concierge.extensionCatalogBlock();
  expect(block).toContain("<extension-catalog>");
  expect(block).toContain("image.generate");
});

// ── the GENERATED verb inventory ──────────────────────────────────────────────────────────
// The failure this closes: confidently denying a capability the build HAS ("I can't react to
// Discord messages", while `discord.react` has been a registered bus command since #103). The
// denial came from prose and from a memory entry, neither of which is regenerated when code lands.
// So the block is DERIVED from the registry that dispatches — a hand-written list would rot the
// same way, which is the whole point.

/** A Concierge is heavy to construct; give it the same inert stand-ins the bus suite uses. */
function conciergeForInventory() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-verbs-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const config = validateConfig({ identity: { github_user: "octocat" } });
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() { return "mid-1"; },
    isConnected: () => true,
    lastEventAgeMs: () => 1,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({}),
  } as unknown as ConciergeSession;
  return new Concierge({ config, session, gateway } as never);
}

test("the verb inventory is generated from the bus registry and names discord.react", () => {
  const block = conciergeForInventory().verbInventoryBlock();
  expect(block.startsWith("<capabilities>")).toBeTrue();
  expect(block.endsWith("</capabilities>")).toBeTrue();
  // The canonical regression: the capability that got denied.
  expect(block).toContain("- discord.react — ");
  // A spread of other registered commands, so this fails if the block stops being registry-derived.
  for (const cmd of ["discord.delete", "memory.recall", "quick.run", "browser.run", "ticket.restaff"]) {
    expect(block).toContain(`- ${cmd} — `);
  }
  // And the instruction that makes the list act on behaviour rather than just sit there.
  expect(block).toContain("Never tell anyone you cannot do something that appears above");
});

test("the inventory composes FIRST after doctrine, ahead of the extension catalog", () => {
  const config = tempConfig();
  const registry = new ExtensionRegistry();
  registry.register(createImageExtension(extCtx(config)));
  const session = new ConciergeSession({
    config,
    // A unique marker, not "<capabilities>": the doctrine mentions that tag in prose, so indexOf
    // on the tag would find the doctrine's copy and make the ordering assertions vacuous.
    verbInventoryBlock: () => "<capabilities>\nINVENTORY-MARKER\n- discord.react — react\n</capabilities>",
    catalogBlock: () => renderCatalogBlock(registry.catalog()),
  });
  const prompt = composedPrompt(session);
  const doctrineAt = prompt.indexOf("<doctrine>");
  const doctrineEndAt = prompt.indexOf("</doctrine>");
  const verbsAt = prompt.indexOf("INVENTORY-MARKER");
  const catalogAt = prompt.indexOf("<extension-catalog>");
  const personaAt = prompt.indexOf("<persona>");
  expect(doctrineAt).toBe(0);
  expect(verbsAt).toBeGreaterThan(doctrineEndAt);
  expect(catalogAt).toBeGreaterThan(verbsAt);
  expect(personaAt).toBeGreaterThan(catalogAt);
});

test("no inventory thunk composes no inventory block", () => {
  const config = tempConfig();
  const bare = composedPrompt(new ConciergeSession({ config }));
  // NOT `not.toContain("<capabilities>")`: the doctrine itself now discusses the block by name
  // (concierge.md, "Saying you can't"), so the tag legitimately appears in prose. Assert on the
  // generated block's own first line instead — the thing only the renderer emits.
  expect(bare).not.toContain("GENERATED from this running build's command registry");
});
