# Claude Code Headless / SDK Mode — Wire-Format Reference

Implementation-grade reference for driving `claude -p` (and the Agent SDK) as a worker
harness. Focus is on **wire formats and semantics** not visible in `--help`. Synthesized
from the official Anthropic docs (June 2026):

- `https://code.claude.com/docs/en/headless` (formerly `docs.claude.com/.../claude-code/sdk`, `/headless`)
- `https://code.claude.com/docs/en/agent-sdk/*` — `streaming-vs-single-mode`, `streaming-output`, `sessions`, `session-storage`, `permissions`, `user-input`, `hooks`, `cost-tracking`, `structured-outputs`, `agent-loop`, `overview`
- `https://code.claude.com/docs/en/cli-reference`

> Doc-host note: `docs.claude.com/en/docs/claude-code/sdk` now 301-redirects to `code.claude.com/docs/en/headless`, and the "SDK" concept has been renamed the **Agent SDK** (`@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk` PyPI). The CLI `claude -p` is documented as "the Agent SDK via the CLI."

⚠️ markers flag things the docs do not state explicitly (inferred or unverified).

---

## 0. TL;DR mental model

- `claude -p "<prompt>"` runs one non-interactive agent loop and exits.
- `--output-format stream-json` emits **newline-delimited JSON (NDJSON)**, one message object per line, on stdout. Requires `--verbose` for `-p`.
- `--input-format stream-json` makes stdin an NDJSON channel of **user messages you can write over time** — this is the steering/nudge mechanism.
- The loop runs *turns* autonomously (Claude → tools → results → repeat) and ends with exactly one `result` message (plus possibly a few trailing system events).
- The final `result` carries `total_cost_usd`, `usage`, `duration_ms`, `num_turns`, `session_id`, `is_error`, `subtype`.
- `--bare` is the recommended mode for scripted/SDK calls (skips auto-discovery of hooks/skills/plugins/MCP/CLAUDE.md). Will become the `-p` default in a future release. With `--bare`, auth must come from `ANTHROPIC_API_KEY` or an `apiKeyHelper` in `--settings`.

---

## 1. stream-json OUTPUT schema (stdout)

Enable with:

```bash
claude -p "Explain recursion" --output-format stream-json --verbose
# add --include-partial-messages for token-level deltas
# add --include-hook-events for hook lifecycle events
```

Each stdout line is one JSON object with a `type` field. The five **core** message types
(mirroring the SDK message classes) are:

| `type`              | When emitted                                              | Key payload |
| ------------------- | -------------------------------------------------------- | ----------- |
| `system` (`init`)   | First line of the stream; session metadata               | model, tools, mcp servers, plugins, `session_id` |
| `assistant`         | After each Claude response (incl. final text-only one)   | wraps a raw Anthropic API `message` (text + tool_use blocks) |
| `user`              | After each tool execution (tool_result) **and** echoed user inputs you stream | wraps a raw API `message` with tool_result content |
| `stream_event`      | Only with `--include-partial-messages`                   | raw API streaming delta event |
| `result`            | Exactly once, marks end of the loop                      | final text, cost, usage, timings, session_id |

Additional `system` subtypes / observability events you may see: `compact_boundary`,
`informational`, `worker_shutting_down`, `api_retry`, `plugin_install`, plus (TS SDK and
CLI) hook events, tool-progress, rate-limit, and `prompt_suggestion`.

> Important: a few trailing events (e.g. `prompt_suggestion`) can arrive **after** the
> `result` line. Iterate the stream to EOF; do **not** break on `result`.

### 1.1 `system` / `init`

First line. Reports session metadata: model, available tools, MCP servers, loaded plugins,
and the `session_id`. (`CLAUDE_CODE_SYNC_PLUGIN_INSTALL` can cause `plugin_install` events
to precede it.) Use `plugin_errors` to fail CI when a plugin didn't load.

Representative shape (⚠️ reconstructed from documented fields — docs describe the fields but
don't print a full verbatim init line):

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "cwd": "/Users/jason/Code/beckett",
  "model": "claude-opus-4-9",
  "permissionMode": "default",
  "tools": ["Read", "Edit", "Bash", "Glob", "Grep", "..."],
  "mcp_servers": [{ "name": "playwright", "status": "connected" }],
  "plugins": [{ "name": "gstack", "path": "/Users/jason/.claude/plugins/gstack" }],
  "plugin_errors": [],
  "uuid": "..."
}
```

In the Python SDK this is `SystemMessage(subtype="init", data={...})` — `session_id` is
nested in `.data["session_id"]`. In TS it's a direct field `message.session_id`.

### 1.2 `assistant`

Wraps the raw Anthropic API message. Content blocks live at `message.message.content` (TS)
/ `message.message` (Py `AssistantMessage` exposes `.content`, `.usage`, `.message_id`).
Per-step token usage is on `message.message.usage`. Messages from a subagent carry
`parent_tool_use_id`.

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_01ABC",
    "role": "assistant",
    "model": "claude-opus-4-9",
    "content": [
      { "type": "text", "text": "I'll read the file first." },
      { "type": "tool_use", "id": "toolu_01XYZ", "name": "Read",
        "input": { "file_path": "/Users/jason/Code/beckett/auth.py" } }
    ],
    "stop_reason": "tool_use",
    "usage": { "input_tokens": 1234, "output_tokens": 56,
               "cache_creation_input_tokens": 0, "cache_read_input_tokens": 900 }
  },
  "parent_tool_use_id": null,
  "session_id": "550e8400-...",
  "uuid": "..."
}
```

> Dedup caution: parallel tool calls in one turn produce **multiple** `assistant` lines that
> share the same `message.id` and identical `usage`. Dedup by `message.id` when summing
> tokens yourself.

### 1.3 `user`

Emitted after each tool runs (the tool_result fed back to Claude) and also re-emits any user
inputs you streamed (when `--replay-user-messages` is set).

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_01XYZ",
        "content": "def login(): ...", "is_error": false }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "550e8400-...",
  "uuid": "..."
}
```

### 1.4 `stream_event` (partial messages)

Only with `--include-partial-messages`. Wraps a raw Claude API streaming event. Sequence per
assistant message:

```
message_start → content_block_start → content_block_delta (text_delta | input_json_delta)…
→ content_block_stop → message_delta → message_stop
```

```json
{
  "type": "stream_event",
  "event": { "type": "content_block_delta", "index": 0,
             "delta": { "type": "text_delta", "text": "Recursion is " } },
  "parent_tool_use_id": null,
  "session_id": "550e8400-...",
  "uuid": "...",
  "ttft_ms": 412
}
```

`ttft_ms` (time-to-first-token) is present only on `message_start` events. Text streams from
`delta.type == "text_delta"` (`.text`); tool-call args stream from `input_json_delta`
(`.partial_json`). Extract live text with:

```bash
claude -p "Write a poem" --output-format stream-json --verbose --include-partial-messages \
  | jq -rj 'select(.type=="stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

### 1.5 `result` (the important one)

Emitted once at loop end. **Yes — it carries `total_cost_usd`, `usage`, `duration_ms`,
`num_turns`, `session_id`, `is_error`, and `subtype`.** Cost/usage are present on *both*
success and error results, so you can always track spend and resume after a failure.

Python `ResultMessage` dataclass (authoritative field list):

```python
@dataclass
class ResultMessage:
    subtype: str                      # see table below
    duration_ms: int                  # wall-clock for the whole query
    duration_api_ms: int              # time spent in API calls
    is_error: bool
    num_turns: int
    session_id: str
    stop_reason: str | None = None    # end_turn | max_tokens | refusal | ...
    total_cost_usd: float | None = None
    usage: dict | None = None         # input/output/cache token counts
    result: str | None = None         # final text — ONLY on subtype="success"
    structured_output: Any = None     # validated JSON when --json-schema used
    model_usage: dict | None = None   # per-model cost/token breakdown
    permission_denials: list | None = None
    deferred_tool_use: DeferredToolUse | None = None
    errors: list[str] | None = None
    api_error_status: int | None = None
    uuid: str | None = None
```

Representative `result` JSON line (⚠️ reconstructed from the field list — docs don't print a
full verbatim line, but every field below is documented):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 18342,
  "duration_api_ms": 15012,
  "num_turns": 4,
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "stop_reason": "end_turn",
  "result": "Fixed the auth bug, all three tests pass now.",
  "total_cost_usd": 0.0421,
  "usage": {
    "input_tokens": 12000,
    "output_tokens": 850,
    "cache_creation_input_tokens": 3000,
    "cache_read_input_tokens": 48000
  },
  "modelUsage": {
    "claude-opus-4-9": {
      "inputTokens": 12000, "outputTokens": 850,
      "cacheReadInputTokens": 48000, "cacheCreationInputTokens": 3000,
      "costUSD": 0.0421
    }
  },
  "structured_output": null,
  "uuid": "..."
}
```

**`subtype` values** (the primary termination check):

| subtype                                | meaning                                     | `result` text present? |
| -------------------------------------- | ------------------------------------------- | :--------------------: |
| `success`                              | finished normally                           | Yes |
| `error_max_turns`                      | hit `--max-turns`                           | No |
| `error_max_budget_usd`                 | hit `--max-budget-usd`                      | No |
| `error_during_execution`              | API failure / cancelled request             | No |
| `error_max_structured_output_retries`  | `--json-schema` validation never satisfied  | No |

`total_cost_usd`/`costUSD` are **client-side estimates** from a bundled price table, not
authoritative billing. (`field naming differs by SDK: TS uses camelCase modelUsage/costUSD; Py uses model_usage and the usage dict keys.`)

`--output-format json` (non-streaming) returns one object with the same metadata plus
`result` (and `structured_output` when `--json-schema` is used).

---

## 2. stream-json INPUT schema (stdin) — steering / nudging

This is the heart of the worker-harness use case.

```bash
claude -p --input-format stream-json --output-format stream-json --verbose
```

stdin becomes an **NDJSON channel of user messages**. Each line is a user message object:

```json
{"type":"user","message":{"role":"user","content":"Analyze this codebase for security issues"},"parent_tool_use_id":null}
```

Content can be a string or an array of content blocks (text + images):

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"Review this architecture diagram"},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<...>"}}
]},"parent_tool_use_id":null}
```

(`parent_tool_use_id` is optional/`null` for top-level user input. Image attachments require
streaming input mode — single-message mode does not support them.)

### 2.1 Can you send MULTIPLE messages over time? — YES

This is the **streaming input mode** and it is the documented, recommended way to use the
agent. The docs state it explicitly: the agent "operates as a long-lived process that takes
in user input, handles interruptions, surfaces permission requests, and handles session
management." Benefits listed include **"Queued Messages — Send multiple messages that
process sequentially, with ability to interrupt."**

So yes: you keep the stdin pipe open and write additional user-message lines while the agent
is mid-task. They are **queued** and processed.

In the SDKs this is done by passing an **async generator** as the prompt (TS `query({prompt:
asyncGen})`, Py `ClaudeSDKClient.query(async_gen)` / `client.query(...)`). At the CLI layer
the same behavior is exposed by keeping `--input-format stream-json` stdin open and writing
NDJSON lines.

### 2.2 When are queued messages read? ⚠️

The docs describe the high-level behavior (messages "process sequentially") and show the
flow diagram (Message 1 → tools run → response → Message 2 → … → "Queue Message 3" →
"Interrupt/Cancel"), but they **do not pin down the exact read boundary** (between turns vs.
between individual tool calls).

Best supported reading:
- A queued user message is consumed at a **turn boundary** — i.e. it becomes the next user
  turn once the current turn's tool batch resolves and control returns to the model. It does
  **not** splice into the middle of an in-flight model generation or a running tool.
- To force an immediate stop and redirect, use the **interrupt** mechanism (below), then
  send the new instruction.

⚠️ Treat the precise timing as implementation-defined; for Beckett, design for "nudge lands
at the next turn boundary, interrupt for immediate."

### 2.3 Interrupt / cancel control

- **SDK:** `ClaudeSDKClient.interrupt()` (Python, async; "only works in streaming mode") and
  the TS equivalent send an interrupt that stops the current work so you can redirect. The
  flow diagram explicitly shows "Interrupt/Cancel → Handle interruption" while the session
  stays alive.
- **CLI control message over stdin:** ⚠️ The public docs do **not** document a JSON
  "control_request"/interrupt envelope for the raw `--input-format stream-json` stdin
  channel. The interrupt is documented only as an SDK method. The underlying CLI↔SDK
  protocol does use control messages, but the wire shape is **not officially specified**;
  do not depend on it. For a CLI-only harness, the robust interrupt is to **kill/restart the
  process and `--resume`** the session, or use the SDK rather than hand-rolling stdin.
- **`canUseTool` redirect:** within a permission callback you can `deny` with a guidance
  message (Claude adjusts) or, for a full change of direction, stream a brand-new user
  instruction (see §4).

### 2.4 `--replay-user-messages`

> "Re-emit user messages from stdin back on stdout for acknowledgment. Requires
> `--input-format stream-json` and `--output-format stream-json`."

Use this so your reader gets a positive **ack** (echoed as a `user` line on stdout) that an
injected steering message was actually ingested — important for a harness that needs to know
its nudge was received vs. still buffered.

### 2.5 `--include-partial-messages`

> "Include partial streaming events in output. Requires `--print` and `--output-format
> stream-json`." (CLI examples also pass `--verbose`.) Surfaces `stream_event` lines (§1.4)
> for token-level progress.

---

## 3. Session resume

### 3.1 Flags / options

| CLI flag                              | SDK option (Py / TS)               | Behavior |
| ------------------------------------- | ---------------------------------- | -------- |
| `--resume <session_id>`               | `resume=` / `resume:`              | Resume a specific session by id; full prior context restored. |
| `--continue`                          | `continue_conversation=` / `continue:` | Resume the **most recent** session in the current dir — no id tracking. |
| `--session-id <uuid>`                 | (set explicitly)                   | Use a caller-chosen session id (must be a valid UUID). |
| `--fork-session`                      | `fork_session=` / `forkSession:`   | On resume, create a **new** session id seeded with a copy of the original history; original untouched. Use with `--resume`/`--continue`. |

Capture the id from `result.session_id` (always present, success or error) or from the
`system/init` line.

```bash
# capture then resume a specific session
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

Resume/continue lookup is **scoped to the current working directory** (and its git
worktrees). Run resume from the **same `cwd`**, or it silently starts fresh.

### 3.2 On-disk transcript location & format

> Sessions are stored at:
> `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
> (or `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/*.jsonl` if `CLAUDE_CONFIG_DIR` is set).

`<encoded-cwd>` = the absolute working dir with **every non-alphanumeric char replaced by
`-`**. e.g. `/Users/jason/Code/beckett` → `-Users-jason-Code-beckett`.

- Format: **JSONL**, one transcript entry per line (prompt, every tool call, every tool
  result, every response, plus metadata entries).
- **Yes, you can read them.** Both SDKs expose readers: Py `list_sessions()` /
  `get_session_messages()` / `get_session_info()`; TS `listSessions()` /
  `getSessionMessages()` / `getSessionInfo()` (plus rename/tag). `getSessionMessages` returns
  the **post-compaction** linked chain (may be far fewer than raw lines); read the file (or
  `store.load`) directly for the full raw history.
- Subagent transcripts live under `subagents/agent-<id>` subpaths.

### 3.3 Cross-host resume

Session files are **local to the machine**. To resume elsewhere: copy the
`<encoded-cwd>/<session-id>.jsonl` to the same path on the new host (cwd must match), or use
a `SessionStore` adapter (TS/Py: `append`/`load` required; S3/Redis/Postgres reference
adapters exist) to mirror transcripts. The store is a **mirror** (dual-write): the
subprocess always writes local disk first, then forwards to `append()` (best-effort; failures
emit a `system/mirror_error` and continue). For Beckett's "shared project VM" model, local
disk on the VM is sufficient; a SessionStore is only needed if workers move across hosts.

---

## 4. Permissions in headless mode

### 4.1 Evaluation order (every tool request)

1. **Hooks** — can `deny` outright or pass through (an `allow` here does NOT skip deny/ask).
2. **Deny rules** (`--disallowedTools` / settings) — block even in `bypassPermissions`.
3. **Ask rules** (settings) — fall through to `canUseTool`; in `dontAsk` mode they become deny.
4. **Permission mode** (below).
5. **Allow rules** (`--allowedTools` / settings) — approve.
6. **`canUseTool` callback** — final decision; skipped (= deny) in `dontAsk`.

### 4.2 Permission modes (`--permission-mode`)

| Mode                | Behavior |
| ------------------- | -------- |
| `default`           | No auto-approvals; unmatched tools hit `canUseTool` (no callback ⇒ deny). |
| `acceptEdits`       | Auto-approve file edits (Edit/Write) + fs commands (`mkdir touch rm rmdir mv cp sed`) inside cwd/`additionalDirectories`; other Bash still gated. |
| `plan`              | Read-only exploration; file edits never auto-approved (route to `canUseTool`); may use `AskUserQuestion`. |
| `dontAsk`           | Never prompts. Only pre-approved tools/rules run; everything else **denied**. Best for locked-down CI. |
| `bypassPermissions` | Approves everything reaching the mode step. Deny rules, explicit ask rules, and hooks still apply. Cannot run as root on Unix. |
| `auto` (TS only)    | Model classifier approves/denies each call. |

Gotchas:
- `--allowedTools` does **not** constrain `bypassPermissions` (every tool approved). To block
  specific tools there, use `--disallowedTools`.
- Bare-name deny like `Bash` *removes the tool from context*; scoped deny like `Bash(rm *)`
  keeps it but blocks matches.
- Allow-rule globs only work after a literal `mcp__<server>__` prefix; `allowedTools=["*"]`
  / `["mcp__*"]` is **ignored** with a startup warning.
- Subagents **inherit** `bypassPermissions`/`acceptEdits`/`auto` and can't override per-subagent.

Locked-down pattern: `--allowedTools "Read,Glob,Grep" --permission-mode dontAsk`.

### 4.3 `canUseTool` (SDK) vs `--permission-prompt-tool` (CLI/MCP)

**SDK `canUseTool` callback** fires for any tool not auto-approved (and for `AskUserQuestion`).
Returns:

- Allow: TS `{ behavior: "allow", updatedInput }` / Py `PermissionResultAllow(updated_input=...)`
  — may **modify** the input (sanitize paths, scope to sandbox), Claude isn't told it changed.
- Deny: TS `{ behavior: "deny", message }` / Py `PermissionResultDeny(message=...)` — Claude
  sees the message and may adjust (use it to *suggest an alternative*).
- "Remember": echo back `updatedPermissions` from `context.suggestions` (e.g. `localSettings`
  destination writes a rule to `.claude/settings.local.json`).

⚠️ Python `can_use_tool` requires streaming mode **and** a dummy `PreToolUse` hook returning
`{"continue_": True}` to keep the stream open, else the stream closes before the callback fires.
The callback may stay pending indefinitely (execution pauses); for long human waits return the
`defer` hook decision so the process can exit and resume later.

**MCP-based `--permission-prompt-tool` (non-interactive CLI):**

> `--permission-prompt-tool` "Specify an MCP tool to handle permission prompts in
> non-interactive mode." e.g. `claude -p --permission-prompt-tool mcp__auth__approve "query"`.

This routes each permission decision to a tool you expose from an MCP server (configured via
`--mcp-config`). Claude Code calls that MCP tool with the pending tool name+input; your tool
returns an allow/deny decision (allow may include modified input). This lets a **headless**
run make approval decisions programmatically without a `canUseTool` callback in-process —
ideal when the harness drives the CLI rather than embedding the SDK. ⚠️ The exact
request/response JSON contract the permission-prompt MCP tool must implement is not fully
specified in these docs; mirror the `canUseTool` allow/deny shape (`behavior`/`message`/
`updatedInput`).

MCP config: `--mcp-config <file-or-json>` (stdio/SSE/HTTP servers). Under `--bare`, project
`.mcp.json` is NOT auto-loaded — pass servers explicitly.

---

## 5. Hooks (observability + control)

Hooks fire at lifecycle points and can **block or modify** tool calls — making them the main
observability and guardrail surface.

### 5.1 Events

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Notification` (both
SDKs). TS-only adds: `PostToolBatch`, `MessageDisplay`, `SessionStart`, `SessionEnd`,
`Setup`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`.

### 5.2 Can hooks block/modify? — YES

`PreToolUse` callbacks return `hookSpecificOutput.permissionDecision` ∈
`allow | deny | ask | defer`:

- `deny` (+ `permissionDecisionReason`) blocks the tool; Claude sees the reason.
- `allow` + `updatedInput` modifies the tool input before execution (must set `allow`).
- `defer` ends the query for later resume.
- Top-level `systemMessage` shows a user-facing note; `continue`/`continue_` controls whether
  the loop keeps running.
- `PostToolUse` can set `additionalContext` (appended to tool result) or `updatedToolOutput`
  (replace output before Claude sees it).

Precedence across multiple hooks: `deny > defer > ask > allow`. Hooks run in parallel; one
`deny` wins. Async side-effect hooks return `{async: true, asyncTimeout}` (Py `async_`) to
not block the loop.

```json
// PreToolUse deny example (hook return value)
{
  "systemMessage": "system dirs are protected",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Writing to /etc is not allowed"
  }
}
```

### 5.3 Surfacing hooks in the stream: `--include-hook-events`

> "Include all hook lifecycle events in the output stream. Requires `--output-format
> stream-json`." (CLI example also passes `--verbose`.)

Without this, hook output (incl. `systemMessage`) is **not** surfaced in the message stream.
For a harness that wants to observe/audit every tool gate decision, set
`--include-hook-events` (CLI) or `includeHookEvents`/`include_hook_events` (SDK). Note hooks
may **not fire** if the run hits `max_turns` (session ends first).

---

## 6. Cost / budget

### 6.1 `--max-budget-usd`

> "Maximum dollar amount to spend on API calls before stopping (print mode only)."
> SDK: `max_budget_usd` / `maxBudgetUsd` — "Stop the query when the **client-side cost
> estimate** reaches this USD value." Compared against the same estimate as `total_cost_usd`.

When hit: the loop stops and emits a `result` with `subtype: "error_max_budget_usd"`,
`is_error: true`, and **no** `result` text — but `total_cost_usd`, `usage`, `num_turns`, and
`session_id` are still populated. You can `--resume` the session with a higher budget to
continue.

```bash
claude -p --max-budget-usd 5.00 "Refactor the module"
```

### 6.2 Tracking spend live from the stream

- **Final total:** read `result.total_cost_usd` (cumulative for that `query()`/invocation;
  per-invocation only — accumulate yourself across resumes).
- **Per-step live:** sum `assistant` line `message.usage.{input,output}_tokens`, **dedup by
  `message.id`** (parallel tool calls repeat the id).
- **Per-model:** `result.modelUsage` / `model_usage` → `{costUSD, inputTokens, outputTokens,
  cacheReadInputTokens, cacheCreationInputTokens}`.
- Cache fields: `cache_creation_input_tokens` (higher rate) and `cache_read_input_tokens`
  (reduced rate). `ENABLE_PROMPT_CACHING_1H=1` extends cache TTL to 1h for many-short-session
  workloads.
- ⚠️ All cost numbers are **estimates**; use the Usage/Cost API for billing.

---

## 7. Structured output (`--json-schema`)

```bash
claude -p "Extract the main function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}'
```

- The validated object appears in the result's **`structured_output`** field (NOT in
  `result`, which holds free text). Extract with `jq '.structured_output'`.
- SDK equivalent: `output_format={"type":"json_schema","schema":{...}}` (Py) /
  `outputFormat:{type:"json_schema",schema}` (TS); generate schema from Pydantic
  `.model_json_schema()` or Zod `z.toJSONSchema()`.
- The SDK validates and **re-prompts on mismatch**. If it can't satisfy the schema within the
  retry limit → `result.subtype = "error_max_structured_output_retries"` and
  `structured_output` is absent. (Also triggered by a model-fallback retraction; check
  `result.errors` to disambiguate.)
- ⚠️ With partial-message streaming, structured output appears **only** in the final result —
  it does not stream as deltas.
- Schema support: object/array/string/number/boolean/null, `enum`, `const`, `required`,
  nested objects, `$ref`. Keep schemas focused; make uncertain fields optional.

---

## 8. Spawning + steering — copy-paste recipes

### 8.1 CLI: long-lived steerable worker (the Beckett pattern)

```bash
# Open a persistent NDJSON session; feed steering messages on stdin over time.
# Reader gets acks (--replay-user-messages) and hook-gate visibility (--include-hook-events).
mkfifo /tmp/claude_in
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --replay-user-messages \
  --include-hook-events \
  --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Bash,Glob,Grep" \
  --max-budget-usd 5.00 \
  < /tmp/claude_in \
  | while IFS= read -r line; do
      echo "$line" | jq -c '{type, subtype, session_id, cost: .total_cost_usd}'
    done &

# initial task
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Refactor auth.py to use JWT"}}' > /tmp/claude_in
# ... later, mid-task nudge (lands at next turn boundary) ...
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Also keep backward-compat with the old session cookie"}}' > /tmp/claude_in
```

### 8.2 Python SDK: stream input + interrupt

```python
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, AssistantMessage, ResultMessage, TextBlock

async def worker():
    async def messages():
        yield {"type":"user","message":{"role":"user","content":"Analyze the codebase for security issues"}}
        # generator can yield more over time (await events, queue pulls, etc.)

    opts = ClaudeAgentOptions(allowed_tools=["Read","Grep","Edit"], max_budget_usd=2.0)
    async with ClaudeSDKClient(options=opts) as client:
        await client.query(messages())

        # mid-task steering: just send another query (queued)
        await client.query("Prioritize the auth module first")

        # hard interrupt + redirect
        # await client.interrupt()
        # await client.query("Stop — instead just produce a written risk report")

        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                for b in msg.content:
                    if isinstance(b, TextBlock): print(b.text, end="")
            elif isinstance(msg, ResultMessage):
                print(f"\n[{msg.subtype}] ${msg.total_cost_usd} turns={msg.num_turns} sid={msg.session_id}")

asyncio.run(worker())
```

---

## 9. Implications for Beckett

**What this enables**
- **True mid-session steering / nudge is a first-class, supported feature.** Streaming input
  mode is the *recommended* default: keep stdin (or an async generator) open and inject extra
  user messages while the agent works. They queue and get picked up at turn boundaries. This
  is exactly the "drop a nudge into a running worker" primitive Beckett wants — and it maps
  cleanly onto the multiplayer-Discord collaboration wedge (any participant can append a
  steering message to the live worker without restarting it).
- **`--replay-user-messages` gives an ack channel** so the collaboration layer can confirm a
  nudge was ingested vs. still buffered — important for multi-user UX (show "delivered").
- **Full observability from the stream alone:** `system/init` (capabilities), per-turn
  `assistant`/`user` lines, `--include-partial-messages` for live tokens,
  `--include-hook-events` for every tool-gate decision, and a rich `result` with cost/usage/
  timings/`session_id`. A harness can render a live activity feed + spend meter directly.
- **Session model fits the shared-VM v1.** Transcripts are plain JSONL at
  `~/.claude/projects/<encoded-cwd>/<id>.jsonl` on the project VM — readable for replay,
  audit, and "join an in-progress session" views. `--session-id` lets Beckett assign its own
  UUIDs; `--resume`/`--fork-session` support branch/continue and "try another approach."
- **Budget + structured output for safe automation:** `--max-budget-usd` hard-caps spend
  (clean `error_max_budget_usd` result, resumable), and `--json-schema` yields validated
  `structured_output` for machine-readable worker results.

**Gotchas**
- ⚠️ **No officially documented CLI interrupt wire format.** Immediate interruption is only a
  documented SDK method (`interrupt()`). For a CLI-driven harness, "immediate stop" means
  kill+`--resume`, or embed the SDK. Plain stdin nudges only land at the **next turn
  boundary**, not mid-tool. Design the UX around that latency.
- ⚠️ **Exact queue read-boundary is unspecified** (turn vs. tool granularity). Don't assume
  sub-turn injection.
- **Python `can_use_tool` footgun:** requires streaming mode + a dummy `PreToolUse` hook
  returning `{"continue_": True}` or the stream closes early.
- **cwd-scoped sessions:** resume from a different directory silently starts fresh; encode the
  exact `cwd` mapping. Session files are host-local — multi-host needs a `SessionStore`.
- **Permission-mode traps:** `bypassPermissions` ignores `--allowedTools` (use
  `--disallowedTools`); subagents inherit it and can't be down-scoped; `dontAsk` silently
  denies anything unlisted (good for CI, surprising in dev). `allowedTools=["*"]` is ignored.
- **Cost numbers are estimates**, not billing — fine for live meters/budgets, not invoicing.
- **`--bare`** skips MCP/hooks/CLAUDE.md/plugins auto-discovery and keychain/OAuth — great
  for reproducible workers but you must pass everything explicitly and auth via
  `ANTHROPIC_API_KEY`. (Will become the `-p` default later.)
- **Iterate the stream to EOF** — trailing events (`prompt_suggestion`, etc.) can follow the
  `result` line; don't break early. And **dedup `assistant` lines by `message.id`** when
  summing tokens.
- Branding: products built on this must not present as "Claude Code"; "Powered by Claude" is
  the allowed framing.
