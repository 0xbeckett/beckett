# `p-mcp-bridge` — an MCP client for pi

**Priority 1.** Unblocks the last lane pinned off pi.

## Problem

pi has no MCP client. Verified, not assumed: no `--mcp-config` flag, no `mcpServers` settings
key, and no `@modelcontextprotocol/sdk` anywhere in pi's dependency tree. Its own `docs/usage.md`
says built-in MCP is intentionally absent.

Beckett's browser lane reaches BetterWright as an MCP tool, so `LANE_DEFAULT_HARNESS.browser` is
pinned to `claude` (`src/drivers/lane.ts:98-104`) — the one lane that did not move to pi in #121.
That pin is labelled temporary with this extension as the named fix
(`src/drivers/lane.ts:122-126`).

Beyond the browser lane: Beckett has a live MCP client dependency already
(`@modelcontextprotocol/sdk` ^1.13.0 in `package.json`), so every MCP server the daemon can reach
becomes reachable from a pi worker once this exists. That is the difference between "pi is the
fleet harness except for one lane" and "pi is the fleet harness."

## Mechanism

An extension that speaks MCP on one side and `pi.registerTool()` on the other.

1. Read a server config — same shape as claude's `--mcp-config` JSON, so Beckett can pass the
   *identical* file it passes claude today and the two harnesses cannot drift. Path arrives via
   `pi.registerFlag("mcp-config", …)` or an env var; prefer the flag, it is self-documenting in
   `pi --help`.
2. In the **async extension factory** (pi awaits it before startup, per `docs/custom-provider.md`
   — the same guarantee applies to tool registration), connect to each server over stdio, run
   `tools/list`, and `pi.registerTool()` one pi tool per MCP tool.
3. Map the MCP JSON Schema to pi's `parameters` (TypeBox). MCP tool schemas are JSON Schema
   already; pi's TypeBox accepts a raw schema object, so this is mostly a pass-through with
   validation on the way in.
4. `execute()` forwards to `tools/call` and maps the MCP content blocks back to pi's
   `{content: [{type:"text", text}], details}`. Images matter here — the browser tool returns
   screenshots; map MCP `image` content to a pi image block, and if pi's tool-result surface
   can't carry it for the active model, say so in `details` rather than dropping it.
5. Wire `signal` through to the MCP call so `ctx.abort()` / a Beckett cancel actually cancels the
   in-flight tool, not just the turn. This is the part a naive implementation skips and it is why
   a cancelled browser run leaves a Chromium behind.
6. Dispose the MCP clients on `session_shutdown` (the extension's returned cleanup function, per
   `docs/extensions.md` "Long-lived resources and shutdown").

## Naming contract

Tool names must be **stable and predictable**, because Beckett's lane already builds allowlists
out of them: `src/drivers/lane.ts:212-264` `LaneRun.toolSet` carries
`["mcp__browser__betterwright_browser"]` and the browser lane's containment depends on that exact
string being the *only* tool available.

Use claude's scheme verbatim — `mcp__<server>__<tool>` — so the same `toolSet` array works under
both harnesses and `piToolNames()` (`src/drivers/lane.ts:346-349`) can stop dropping it. Today
that mapper drops any name that isn't `/^[a-z0-9_]+$/`, which silently discards
`mcp__browser__…`; with this extension the regex must be widened and a test added that the
browser lane's allowlist survives the mapping intact.

## Beckett-side changes this enables

- `LANE_DEFAULT_HARNESS.browser: "claude" → "pi"`, and `LANE_GAPS.mcpConfigPath` deleted.
- `buildPiLaneCommand` stops reporting `mcpConfigPath` as unsupported and starts emitting
  `-e <path-to-p-mcp-bridge> --mcp-config <path>`.
- `piToolNames` widened for the `mcp__` namespace, with the drop-on-no-match behaviour kept for
  everything else (an allowlist entry that silently vanishes starves the run).

## Verification

The bar is not "it loads." It is:

1. `pi -e ./pi-ext/mcp-bridge/index.ts --mcp-config <browser.json> --tools mcp__browser__betterwright_browser -p "<a real browser task>"` completes a live browser task end-to-end.
2. `npm run browser:smoke` (`scripts/ops/browser-smoke.ts`) passes with the browser lane pinned
   to pi. That smoke is already a hard deploy gate, so this is the honest test.
3. A cancel mid-tool leaves no orphan process — check with `pgrep` after
   `beckett browser stop`.
4. The tool-name round trip: a unit test asserting `piToolNames(["mcp__browser__betterwright_browser"])` returns it unchanged.

## Failure modes to handle explicitly

- **Server unreachable at startup.** Fail the extension factory loudly so pi exits before the
  agent starts. A worker that comes up without its only tool will burn a full turn budget
  discovering it can't work — this is exactly the class of silent degradation the preflight
  exists to prevent.
- **Server dies mid-run.** Surface it as a tool error (`isError: true`) with the reason, so the
  model can report rather than retry into the void. Do not auto-reconnect silently.
- **Schema the model can't satisfy.** Log the rejected arguments in `details`; a browser tool
  with a mis-mapped schema fails in ways that look like model incompetence.

## Size

**M.** The MCP protocol work is small (Beckett already depends on the SDK and the stdio
transport is the easy one). The real cost is the content-block mapping, cancellation
plumbing, and the browser-lane migration + smoke gate.

## Do not

- Do not reimplement MCP transports beyond stdio until something needs SSE/HTTP. The browser
  server is stdio.
- Do not make this discover servers from the filesystem. Explicit config path only — discovery
  is how a worker silently acquires a capability nobody granted it.
