/**
 * The one-shot agent-lane seam (#125): seat resolution, per-harness argv, the capability gaps it
 * refuses to swallow, and reading both harnesses' output formats.
 */

import { expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import type { Config, LaneName } from "../types.ts";
import {
  LANE_DEFAULT_HARNESS,
  LANE_GAPS,
  LANE_NAMES,
  buildLaneCommand,
  isLaneHarness,
  parseLaneOutput,
  piToolNames,
  resolveLaneSeat,
  warnLaneGaps,
} from "./lane.ts";

function configWith(lanes: Partial<Record<LaneName, { harness?: "claude" | "pi"; provider?: string; model?: string }>> = {}): Config {
  const config = defaultConfig();
  for (const [lane, over] of Object.entries(lanes)) {
    Object.assign(config.harness.lanes[lane as LaneName], over);
  }
  return config;
}

// ── seats ────────────────────────────────────────────────────────────────────────────────

test("every lane has a config block, and the schema default matches the resolver's", () => {
  const config = defaultConfig();
  for (const lane of LANE_NAMES) {
    expect(config.harness.lanes[lane]).toBeTruthy();
    expect(resolveLaneSeat(config, lane).harness).toBe(LANE_DEFAULT_HARNESS[lane]);
  }
});

test("the fleet runs pi; only the browser lane is pinned to claude", () => {
  expect(LANE_DEFAULT_HARNESS).toEqual({
    quick: "pi",
    agent: "pi",
    browser: "claude",
    dream: "pi",
    dream_spike: "pi",
  });
});

test("config pins a single lane without touching any other", () => {
  const config = configWith({ quick: { harness: "claude" } });
  expect(resolveLaneSeat(config, "quick").harness).toBe("claude");
  expect(resolveLaneSeat(config, "dream").harness).toBe("pi");
  expect(resolveLaneSeat(config, "agent").harness).toBe("pi");
});

test("seat precedence: per-run > lane config > harness default", () => {
  const config = configWith({ dream: { model: "lane-model", provider: "anthropic" } });
  // lane config beats the harness default…
  expect(resolveLaneSeat(config, "dream").model).toBe("lane-model");
  expect(resolveLaneSeat(config, "dream").provider).toBe("anthropic");
  // …and a per-run seat beats the lane config.
  expect(resolveLaneSeat(config, "dream", { model: "run-model" }).model).toBe("run-model");
  expect(resolveLaneSeat(config, "dream", { harness: "claude" }).harness).toBe("claude");
});

test("an unset model falls back per harness: pi's default, or the lane's own historical key on claude", () => {
  const config = defaultConfig();
  expect(resolveLaneSeat(config, "quick").model).toBe(config.harness.pi.default_model);
  // Pinning back to claude must restore the lane's PREVIOUS seat, not invent a new default.
  const pinned = configWith({ quick: { harness: "claude" } });
  expect(resolveLaneSeat(pinned, "quick", { claudeModel: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
  // …and with nothing to restore, the claude harness default.
  expect(resolveLaneSeat(pinned, "quick").model).toBe(config.harness.claude.default_model);
});

test("provider is a pi concept: claude seats never carry one", () => {
  const config = configWith({ dream: { provider: "anthropic" } });
  expect(resolveLaneSeat(config, "dream").provider).toBe("anthropic");
  expect(resolveLaneSeat(config, "dream", { harness: "claude" }).provider).toBe("");
});

test("a whitespace-only provider is not a routing decision — it falls back to the configured default", () => {
  const config = configWith({ dream: { provider: "   " } });
  expect(resolveLaneSeat(config, "dream").provider).toBe(defaultConfig().harness.pi.default_provider);
});

test("a hand-built Config with no lanes table still resolves to the documented default", () => {
  const bare = { harness: { claude: { bin: "claude", default_model: "m" }, pi: { bin: "pi", default_model: "pm" } } } as unknown as Config;
  expect(resolveLaneSeat(bare, "quick").harness).toBe("pi");
  expect(resolveLaneSeat(bare, "browser").harness).toBe("claude");
});

test("isLaneHarness admits exactly the two harnesses a lane can spawn", () => {
  expect(isLaneHarness("pi")).toBe(true);
  expect(isLaneHarness("claude")).toBe(true);
  // codex exec has no --append-system-prompt and no tool allowlist, so it cannot honor a seat.
  expect(isLaneHarness("codex")).toBe(false);
});

// ── argv ─────────────────────────────────────────────────────────────────────────────────

test("a pi command is a valid `pi -p --mode json` invocation with the prompt LAST", () => {
  const config = defaultConfig();
  const seat = resolveLaneSeat(config, "quick", { effort: "low" });
  const { bin, args } = buildLaneCommand(config, seat, {
    prompt: "do the thing",
    appendSystemPrompt: "SYSTEM",
    output: "text",
    allowedTools: ["Read", "Bash"],
  });
  expect(bin).toBe(config.harness.pi.bin);
  expect(args.slice(0, 2)).toEqual(["-p", "--mode"]);
  // The worker environment is pinned exactly as PiDriver pins it: a stray extension/skill/theme
  // install on the box must not silently change how a lane behaves.
  expect(args).toContain("--no-extensions");
  expect(args).toContain("--no-skills");
  expect(args).toContain("--no-themes");
  expect(args).toContain("--thinking");
  expect(args).toContain("low");
  expect(args).toContain("--append-system-prompt");
  // pi parses flags first and takes the prompt positionally.
  expect(args.at(-1)).toBe("do the thing");
  // No claude spellings leak through.
  expect(args).not.toContain("--output-format");
  expect(args).not.toContain("--permission-mode");
  expect(args).not.toContain("--allowedTools");
});

test("a claude command keeps the flags claude actually has", () => {
  const config = configWith({ quick: { harness: "claude" } });
  const seat = resolveLaneSeat(config, "quick", { claudeModel: "claude-sonnet-5", effort: "medium" });
  const { bin, args } = buildLaneCommand(config, seat, {
    prompt: "do the thing",
    appendSystemPrompt: "SYSTEM",
    output: "json",
    unattended: true,
    disallowedTools: ["Bash", "WebFetch"],
    maxTurns: 40,
    settingsPath: "/tmp/settings.json",
  });
  expect(bin).toBe(config.harness.claude.bin);
  expect(args.slice(0, 4)).toEqual(["-p", "do the thing", "--output-format", "json"]);
  expect(args).toContain("--permission-mode");
  expect(args).toContain("--disallowedTools");
  expect(args).toContain("Bash,WebFetch");
  expect(args).toContain("--max-turns");
  expect(args).toContain("--settings");
});

test("unattended is opt-in — a lane that never asked for it does not silently acquire it", () => {
  const config = configWith({ dream: { harness: "claude" } });
  const seat = resolveLaneSeat(config, "dream");
  expect(buildLaneCommand(config, seat, { prompt: "p", output: "json" }).args).not.toContain("--permission-mode");
  expect(buildLaneCommand(config, seat, { prompt: "p", output: "json", unattended: true }).args).toContain(
    "--permission-mode",
  );
});

test("session ids and resumes use each harness's own selector", () => {
  const config = defaultConfig();
  const pi = resolveLaneSeat(config, "quick");
  const claude = resolveLaneSeat(config, "browser");
  expect(buildLaneCommand(config, pi, { prompt: "p", output: "text", sessionId: "S" }).args).toContain("--session-id");
  expect(buildLaneCommand(config, pi, { prompt: "p", output: "text", resumeSessionId: "S" }).args).toContain("--session");
  expect(buildLaneCommand(config, claude, { prompt: "p", output: "text", resumeSessionId: "S" }).args).toContain("--resume");
});

test("noTools is one flag under pi and the caller's denylist under claude", () => {
  const config = defaultConfig();
  const denied = ["Bash", "Read", "WebFetch"];
  const pi = buildLaneCommand(config, resolveLaneSeat(config, "dream"), {
    prompt: "p",
    output: "json",
    noTools: true,
    disallowedTools: denied,
  });
  expect(pi.args).toContain("--no-tools");
  expect(pi.args).not.toContain("--exclude-tools");

  const claude = buildLaneCommand(config, resolveLaneSeat(config, "dream", { harness: "claude" }), {
    prompt: "p",
    output: "json",
    noTools: true,
    disallowedTools: denied,
  });
  expect(claude.args).toContain("--disallowedTools");
  expect(claude.args).toContain("Bash,Read,WebFetch");
});

test("toolSet REPLACES the built-in tools; allowedTools only widens permission", () => {
  const config = defaultConfig();
  // claude draws the distinction: `--tools` is the built-in set, `--allowedTools` is a permission
  // allowlist that leaves every other tool in the agent's hands. The browser lane's containment
  // depends on getting the first one.
  const claude = buildLaneCommand(config, resolveLaneSeat(config, "browser"), {
    prompt: "p",
    output: "json",
    toolSet: ["mcp__browser__betterwright_browser"],
  });
  expect(claude.args).toContain("--tools");
  expect(claude.args).not.toContain("--allowedTools");

  const permitted = buildLaneCommand(config, resolveLaneSeat(config, "browser"), {
    prompt: "p",
    output: "text",
    allowedTools: ["Read"],
  });
  expect(permitted.args).toContain("--allowedTools");
  expect(permitted.args).not.toContain("--tools");

  // pi has one enable-allowlist, so both land on `--tools` there.
  const pi = buildLaneCommand(config, resolveLaneSeat(config, "quick"), {
    prompt: "p",
    output: "text",
    toolSet: ["mcp__browser__betterwright_browser"],
  });
  expect(pi.args).toContain("--tools");
});

test("claude tool names are translated to pi's, and the ones pi has no analogue for are dropped", () => {
  expect(piToolNames(["Read", "Bash", "Glob", "Grep"])).toEqual(["read", "bash", "find", "grep"]);
  // Sub-agents and web tools have no pi built-in; keeping them in an ALLOWLIST would be worse than
  // dropping them, since an allowlist that matches nothing starves the run of every tool.
  expect(piToolNames(["Task", "WebSearch", "Read"])).toEqual(["read"]);
  // Edit and MultiEdit both map to pi's `edit`; the result is deduped.
  expect(piToolNames(["Edit", "MultiEdit"])).toEqual(["edit"]);
  // A name that is already pi-shaped passes through.
  expect(piToolNames(["bash", "mcp__browser__betterwright_browser"])).toEqual([
    "bash",
    "mcp__browser__betterwright_browser",
  ]);
});

// ── capability gaps ──────────────────────────────────────────────────────────────────────

test("pi reports every affordance it cannot honor, by name, instead of silently dropping it", () => {
  const config = defaultConfig();
  const { unsupported, args } = buildLaneCommand(config, resolveLaneSeat(config, "quick"), {
    prompt: "p",
    output: "json",
    mcpConfigPath: "/tmp/mcp.json",
    strictMcp: true,
    jsonSchema: { type: "object" },
    settingsPath: "/tmp/settings.json",
    maxTurns: 40,
  });
  expect(unsupported).toHaveLength(4);
  expect(unsupported.join("\n")).toContain("pi has no MCP client");
  expect(unsupported.join("\n")).toContain("pi.registerTool()");
  expect(unsupported.join("\n")).toContain("tool_call");
  // Crucially, none of them are emitted as flags pi would reject.
  for (const flag of ["--mcp-config", "--strict-mcp-config", "--json-schema", "--settings", "--max-turns"]) {
    expect(args).not.toContain(flag);
  }
});

test("claude honors all four, so it reports no gap", () => {
  const config = configWith({ browser: { harness: "claude" } });
  const { unsupported } = buildLaneCommand(config, resolveLaneSeat(config, "browser"), {
    prompt: "p",
    output: "json",
    mcpConfigPath: "/tmp/mcp.json",
    jsonSchema: { type: "object" },
    settingsPath: "/tmp/settings.json",
    maxTurns: 40,
  });
  expect(unsupported).toEqual([]);
});

test("every gap names an in-pi fix, so a gap reads as a TODO rather than a verdict on pi", () => {
  for (const description of Object.values(LANE_GAPS)) expect(description).toContain("Fix:");
});

test("warnLaneGaps logs the gaps once, and stays silent when there are none", () => {
  const warnings: Record<string, unknown>[] = [];
  const logger = {
    info() {},
    debug() {},
    error() {},
    warn(_msg: string, fields: Record<string, unknown>) {
      warnings.push(fields);
    },
    child() {
      return logger;
    },
  } as never;
  const config = defaultConfig();
  warnLaneGaps(logger, buildLaneCommand(config, resolveLaneSeat(config, "quick"), { prompt: "p", output: "text" }));
  expect(warnings).toHaveLength(0);

  warnLaneGaps(
    logger,
    buildLaneCommand(config, resolveLaneSeat(config, "quick"), { prompt: "p", output: "text", mcpConfigPath: "/x" }),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({ lane: "quick", harness: "pi" });
});

// ── output ───────────────────────────────────────────────────────────────────────────────

test("claude output: text mode is the raw answer, json mode carries usage", () => {
  expect(parseLaneOutput("claude", "text", "  hello  ")).toEqual({ text: "hello", outputTokens: null, error: null });
  expect(parseLaneOutput("claude", "json", JSON.stringify({ result: "hi", usage: { output_tokens: 12 } }))).toEqual({
    text: "hi",
    outputTokens: 12,
    error: null,
  });
  // Unparseable stdout degrades to the raw text rather than throwing away the run.
  expect(parseLaneOutput("claude", "json", "not json").text).toBe("not json");
});

test("pi output: the last assistant message is the answer, turn_end frames sum the tokens", () => {
  const stream = [
    '{"type":"session","id":"s"}',
    '{"type":"turn_start"}',
    '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"ignored"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
    '{"type":"turn_end","message":{"usage":{"input":5,"output":20}}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}',
    '{"type":"turn_end","message":{"usage":{"input":5,"output":22}}}',
    '{"type":"agent_end"}',
  ].join("\n");
  expect(parseLaneOutput("pi", "text", stream)).toEqual({ text: "final", outputTokens: 42, error: null });
});

test("pi output: a final turn that died on a provider error is an error, not an empty success", () => {
  const stream = [
    '{"type":"session","id":"s"}',
    '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"No API key found for anthropic.","content":[]}}',
    '{"type":"agent_end"}',
  ].join("\n");
  expect(parseLaneOutput("pi", "text", stream).error).toContain("No API key");
});

test("pi output: an error a later turn recovered from does not fail the run", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"transient","content":[]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}]}}',
    '{"type":"agent_end"}',
  ].join("\n");
  expect(parseLaneOutput("pi", "text", stream)).toEqual({ text: "recovered", outputTokens: null, error: null });
});

test("pi output: garbage lines are skipped, never thrown on", () => {
  const stream = [
    "some pi banner text",
    "{not json at all",
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
  ].join("\n");
  expect(parseLaneOutput("pi", "text", stream).text).toBe("ok");
  // A stream with no recognizable frame at all degrades to raw stdout rather than reporting an
  // empty success (a pi that died before its first line, or a stubbed binary).
  expect(parseLaneOutput("pi", "text", "pi: command failed").text).toBe("pi: command failed");
});
