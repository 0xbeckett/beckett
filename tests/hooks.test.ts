/**
 * Beckett — hook registry / settings rendering tests (`tests/hooks.test.ts`)
 * =======================================================================================
 * Guards the Phase-B consolidation: scope-guard settings now flow through the registry's
 * renderClaudeSettings instead of a separate hardcoded path. The cardinal check is
 * BYTE-IDENTICAL output to the historical scope-guard-only JSON when no extra hooks are
 * registered (the default), so wiring the registry changed no observable behavior.
 */

import { test, expect, afterEach } from "bun:test";
import {
  renderClaudeSettings,
  registerHook,
  _resetForTests,
} from "../src/hooks/registry.ts";
import { scopeGuardSettings, scopeGuardCommand, GLOB_SEP } from "../src/hooks/scope-guard.ts";

afterEach(() => _resetForTests());

const PATH = "/abs/path/to/scope-guard.ts";
const WS = "/tmp/wt/wk_abc";
const OWNED = ["src/auth/**", "src/types.ts"];

/** The exact object the pre-consolidation scopeGuardSettings produced. */
function historicalSettings() {
  const command =
    `bun ${JSON.stringify(PATH)} ` +
    `--root ${JSON.stringify(WS)} ` +
    `--owned ${JSON.stringify(OWNED.join(GLOB_SEP))}`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  };
}

test("scopeGuardSettings is byte-identical to the historical JSON (no extras)", () => {
  const got = scopeGuardSettings(PATH, WS, OWNED);
  const want = historicalSettings();
  expect(got).toEqual(want);
  // The manager serializes with (null, 2) — assert the literal bytes match too.
  expect(JSON.stringify(got, null, 2)).toBe(JSON.stringify(want, null, 2));
});

test("scopeGuardCommand bakes root + owned into the args", () => {
  expect(scopeGuardCommand(PATH, WS, OWNED)).toBe(
    `bun ${JSON.stringify(PATH)} --root ${JSON.stringify(WS)} --owned ${JSON.stringify(OWNED.join(GLOB_SEP))}`,
  );
});

test("renderClaudeSettings groups specs by event in order", () => {
  const got = renderClaudeSettings([
    { event: "PreToolUse", matcher: "A", command: "c1" },
    { event: "PostToolUse", command: "c2" }, // no matcher → omitted
    { event: "PreToolUse", matcher: "B", command: "c3" },
  ]);
  expect(got).toEqual({
    hooks: {
      PreToolUse: [
        { matcher: "A", hooks: [{ type: "command", command: "c1" }] },
        { matcher: "B", hooks: [{ type: "command", command: "c3" }] },
      ],
      PostToolUse: [{ hooks: [{ type: "command", command: "c2" }] }],
    },
  });
});

test("registered extra hooks are appended after the scope-guard baseline", () => {
  registerHook({ event: "PostToolUse", handlers: [{ type: "command", command: "audit.sh" }] });
  const got = scopeGuardSettings(PATH, WS, OWNED);
  // Baseline scope guard still present + unchanged...
  expect(got.hooks.PreToolUse).toEqual(historicalSettings().hooks.PreToolUse);
  // ...plus the extra.
  expect(got.hooks.PostToolUse).toEqual([{ hooks: [{ type: "command", command: "audit.sh" }] }]);
});

test("after reset, output returns to the byte-identical baseline", () => {
  registerHook({ event: "PostToolUse", handlers: [{ type: "command", command: "audit.sh" }] });
  _resetForTests();
  expect(JSON.stringify(scopeGuardSettings(PATH, WS, OWNED), null, 2)).toBe(
    JSON.stringify(historicalSettings(), null, 2),
  );
});
