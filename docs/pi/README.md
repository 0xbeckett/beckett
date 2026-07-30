# The pi extension backlog

Specs for extensions to build inside the pi ecosystem, one file per extension
(`p-<name>.md`). Written to be handed to pi itself as the brief — each one names the exact pi
API it rides, the contract Beckett consumes, and how to verify it. Written against pi
**0.82.1**; API references are to the installed package's own `docs/`.

Companion review: [`../pi-harness-review.md`](../pi-harness-review.md).

## Why extensions at all

pi's own `docs/usage.md` is explicit: it "intentionally does not include built-in MCP,
sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install
those workflows as extensions or packages." That is not a shortfall to work around — it is the
seam Beckett should be building on. Every capability below that `claude` has and pi lacks is a
capability Beckett can own the implementation of, rather than waiting for a vendor.

The strategic reading: the harness gaps in `LANE_GAPS` (`src/drivers/lane.ts:121-138`) are all
*one* kind of thing — Beckett's orchestration policy, currently expressed as CLI flags to
somebody else's binary. Moved into pi extensions, that policy becomes code Beckett owns, tests,
and can make smarter than a flag ever could.

## Priority

| # | Extension | Unblocks | Size |
|---|---|---|---|
| 1 | [`p-mcp-bridge`](p-mcp-bridge.md) | the browser lane's claude pin — the last lane off pi | M |
| 2 | [`p-scope-guard`](p-scope-guard.md) | real file-scope containment for pi workers (today: cwd only) | M |
| 3 | [`p-done-signal`](p-done-signal.md) | enforced structured output; kills the lenient-parse fallback | S |
| 4 | [`p-turn-budget`](p-turn-budget.md) | in-run turn + dollar ceiling; `budget.per_task_usd_cap` actually enforced | S |
| 5 | [`p-beckett-bus`](p-beckett-bus.md) | workers that report progress and recall memory mid-run | M |
| 6 | [`p-semantic-index`](p-semantic-index.md) | retrieval instead of grep — the biggest token/latency win | M |
| 7 | [`p-subagent`](p-subagent.md) | fan-out: one worker orchestrating cheap parallel sub-runs | L |

1–4 close known gaps. 5–7 are the ones that make Beckett an orchestrator rather than a
dispatcher.

## Not an extension: OpenRouter endpoint pinning

Worth stating up front so nobody builds it twice. Pinning an OpenRouter **endpoint** or
**quantization** (`modal/mxfp4`, `moonshotai/mxfp4`, `baseten/fp8`, …) needs **no extension**.
pi supports it natively through `compat.openRouterRouting` in `~/.pi/agent/models.json`,
emitted into the request body at `pi-ai/dist/api/openai-completions.js:642-644`, schema at
`pi-coding-agent/dist/core/model-config.js:13-30`.

Two live-verified cautions:

- **Slug-suffix pinning does not work.** `moonshotai/kimi-k3:modal/mxfp4` silently routes
  somewhere else (verified: three different suffixes all landed on Moonshot AI, no error). Do
  not build on the suffix form.
- **Two pins of one model need two provider ids** (`openrouter-modal`, `openrouter-moonshot`),
  because the pin lives on the provider entry while `id` must remain the real OpenRouter slug.

The Beckett-side work is making `models.json` a **generated artifact** from config rather than
untracked box state — see `../pi-harness-review.md` §3.2. That is a Beckett ticket, not a pi
extension.

## Shared conventions for all of these

**Location.** Beckett-owned extensions live in the repo and are loaded explicitly, never
discovered. `PiDriver` already passes `--no-extensions --no-skills --no-themes`
(`src/drivers/pi.ts:498-506`) precisely so a stray install on the box can't change worker
behavior invisibly; explicit `-e <path>` still loads under `--no-extensions`, which is the
intended attach point. Proposed home: `pi-ext/<name>/index.ts` in the beckett repo, with the
driver appending `-e` per enabled extension from a `[harness.pi.extensions]` config list.

**Keep them stateless where possible.** A worker's extension should read config and Beckett's
IPC socket, not hold its own durable state. The daemon is the source of truth; an extension that
caches policy will drift from it.

**They must fail loudly.** An extension that silently no-ops when its backing service is down
recreates the exact failure class the pi preflight was written to kill. Every one of these
specs has a "when the backend is unreachable" section, and the answer is never "carry on
quietly."

**Testing.** pi loads a single file with `pi -e ./ext.ts`, so each extension gets a fixture
harness that runs a real pi against a throwaway cwd and asserts on the `--mode json` frame
stream — the same stream `PiDriver` parses. Beckett-side assertions belong in
`src/drivers/pi.*.test.ts` next to the existing frame tests.

## API surface these specs draw on

From the installed `docs/extensions.md` — all verified present in 0.82.1:

| Need | API |
|---|---|
| register a tool the model can call | `pi.registerTool({name, label, description, parameters, execute})` |
| block a tool call | `pi.on("tool_call")` → `{ block: true, reason }` |
| inspect/rewrite a finished assistant message | `pi.on("message_end")` → `{ message }` |
| count turns | `pi.on("turn_start" \| "turn_end")` |
| mutate the outbound provider request | `pi.on("before_provider_request")` |
| inspect the provider response | `pi.on("after_provider_response")` |
| add a CLI flag | `pi.registerFlag(name, options)` |
| run a subprocess | `pi.exec(command, args, options?)` |
| spawn a nested session | `ctx.newSession(options?)` + `pi.sendMessage(...)` |
| context pressure / compaction | `ctx.getContextUsage()`, `ctx.compact()` |
| narrow the live toolset | `pi.getActiveTools()` / `pi.setActiveTools(names)` |
| register a provider | `pi.registerProvider(name, config)` |
| stop the run | `ctx.abort()`, `ctx.shutdown()` |
