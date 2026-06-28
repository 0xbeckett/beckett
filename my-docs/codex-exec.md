# OpenAI Codex CLI — `codex exec` Worker-Harness Reference

Implementation-grade reference for programmatically driving the OpenAI Codex CLI in non-interactive
mode. Focused on **wire formats and semantics**, not flag lists. Verified against
developers.openai.com/codex docs and the openai/codex repo (≈ mid-2026, Codex CLI ~v0.13x).

> Convention: ⚠️ marks claims that are uncertain, version-sensitive, or have known bugs. Verify
> against your installed binary (`codex --version`) before relying on them.

Primary sources:
- https://developers.openai.com/codex/noninteractive (non-interactive mode + JSONL)
- https://developers.openai.com/codex/config-advanced (config.toml)
- https://developers.openai.com/codex/sandbox (sandbox + approvals)
- https://developers.openai.com/codex/app-server (app-server JSON-RPC protocol)
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/ (JSONL event cheatsheet)

---

## 0. TL;DR for a worker harness

- `codex exec` is **strictly one-shot**: prompt in → run to completion → process exits. There is
  **no supported way to inject a mid-task message into a running `exec` process** (no stdin
  steering). See §2.
- For **mid-turn steering** you must use the **`codex app-server`** (JSON-RPC over stdio), which
  exposes `turn/steer` to append input to an in-flight turn. This is the "controllable long-lived
  session" surface. See §7.
- For fully autonomous runs with **no approval hangs**, use
  `--sandbox workspace-write --ask-for-approval never` (or `codex exec --full-auto`, ⚠️ now a
  deprecated alias). `workspace-write` = writes inside cwd only, **network OFF by default**. See §5.
- The JSONL stream (`--json`) ends each turn with a `turn.completed` event carrying **token usage
  only — no dollar cost**. See §1.
- Resume preserves full context (transcript + plan + approvals): `codex exec resume <SESSION_ID>` or
  `--last`. Sessions are rollout JSONL files under `~/.codex/sessions/YYYY/MM/DD/`. See §2.

---

## 1. `codex exec --json` — JSONL event schema

With `--json`, **stdout becomes a JSON Lines stream**: one JSON object per line, each a top-level
*thread event* with a `type` field. (Human-formatted text goes to stdout when `--json` is absent;
logs/diagnostics go to stderr.)

### 1.1 Event taxonomy

Two layers:

**Thread/turn lifecycle events** (top-level `type`):
- `thread.started` — a thread (session/conversation) began; carries `thread_id`.
- `turn.started` — the agent began working on the current user request.
- `turn.completed` — the turn finished successfully; carries `usage` (token counts).
- `turn.failed` — the turn errored; carries `error.message`.
- `error` — a stream/transport-level error.

**Item events** — wrap a discrete unit of work in an `item` object with its own `id`, `type`,
`status`:
- `item.started` — item began (e.g. a command starts running).
- `item.updated` — item changed (e.g. todo list progress).
- `item.completed` — item finished (success or failure encoded in `status`/`exit_code`).

Item `type` values: `agent_message`, `reasoning`, `command_execution`, `file_change`,
`mcp_tool_call`, `web_search`, `todo_list`, and an item-level `error`.

### 1.2 Canonical full-run example

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Scanning docs for exec JSON schema**"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsrc\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs and src."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

### 1.3 Per-item schemas (verbatim examples)

**agent_message** — the assistant's user-facing text (the "final message" is the last one):
```json
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done. I updated the docs and added examples."}}
```

**reasoning** — summarized chain-of-thought (only when reasoning summaries are on):
```json
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Scanning docs for exec JSON schema**"}}
```

**command_execution** — shell commands. `exit_code` is `null` while `in_progress`; `status` is one
of `in_progress` / `completed` / `failed`; `aggregated_output` accumulates stdout+stderr:
```json
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsrc\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"bash -lc false","aggregated_output":"","exit_code":1,"status":"failed"}}
```

**file_change** — edits applied to the workspace; `changes[].kind` ∈ `add` / `update` / `delete`:
```json
{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"docs/exec-json-cheatsheet.md","kind":"add"},{"path":"docs/exec.md","kind":"update"}],"status":"completed"}}
```

**mcp_tool_call** — calls to configured MCP servers. `result` follows the MCP content-block shape;
`error` is set on failure:
```json
{"type":"item.started","item":{"id":"item_5","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"exec --json"},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_5","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"exec --json"},"result":{"content":[{"type":"text","text":"Found 3 matches.","annotations":{"audience":["assistant"],"priority":0.5}}],"structured_content":{"matches":3}},"error":null,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_6","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"exec --json"},"result":null,"error":{"message":"tool timeout"},"status":"failed"}}
```

**web_search**:
```json
{"type":"item.completed","item":{"id":"item_7","type":"web_search","query":"codex exec --json schema"}}
```

**todo_list** — the agent's plan; emits `started` → `updated`* → `completed`:
```json
{"type":"item.started","item":{"id":"item_8","type":"todo_list","items":[{"text":"Scan docs","completed":false},{"text":"Write cheatsheet","completed":false}]}}
{"type":"item.updated","item":{"id":"item_8","type":"todo_list","items":[{"text":"Scan docs","completed":true},{"text":"Write cheatsheet","completed":false}]}}
{"type":"item.completed","item":{"id":"item_8","type":"todo_list","items":[{"text":"Scan docs","completed":true},{"text":"Write cheatsheet","completed":true}]}}
```

**item-level error** (e.g. truncated output):
```json
{"type":"item.completed","item":{"id":"item_9","type":"error","message":"command output truncated"}}
```

### 1.4 Turn failure / stream error

```json
{"type":"turn.failed","error":{"message":"model response stream ended unexpectedly"}}
{"type":"error","message":"stream error: broken pipe"}
```

### 1.5 Token usage & cost

`turn.completed.usage` fields:

| field | meaning |
|---|---|
| `input_tokens` | total prompt tokens for the turn |
| `cached_input_tokens` | portion served from prompt cache |
| `output_tokens` | completion tokens |
| `reasoning_output_tokens` | reasoning tokens (subset/adjacent to output) ⚠️ field presence is version-dependent |

**There is NO dollar cost field — token counts only.** A harness must apply its own price table per
model to estimate cost. ⚠️ The model name is **not** included in the JSONL stream as of this writing
(open issue openai/codex#14736), so you must track which model you launched with out-of-band.

### 1.6 Parsing notes / gotchas for a harness

- Treat unknown `type` and unknown `item.type` values as forward-compatible (skip, don't crash). The
  set has grown over releases.
- Match the **final** `agent_message` `item.completed` as the answer; intermediate `agent_message`s
  can occur before tool calls.
- A turn is "done" at `turn.completed` / `turn.failed`; the **process exits** after that in `exec`
  (single turn) — see §2.
- ⚠️ Known bug: when MCP servers/tools are active, `--json` + `--output-schema` can be silently
  ignored / produce malformed output (openai/codex#15451). Validate JSON before trusting it.

---

## 2. Steering & resume — is `exec` one-shot?

**Yes, `codex exec` is one-shot.** It reads the prompt (arg or stdin), runs a single turn to
completion, streams events, writes outputs, and exits. There is **no supported mechanism to push a
new message into a still-running `exec` process** — no "nudge"/"steer" on the exec surface. The only
in-band influence is the initial prompt and the AGENTS.md / config it picks up. If you need to
interrupt, you kill the process.

> If you need true mid-task steering, use `codex app-server` and `turn/steer` (see §7). That is the
> only documented way to inject input into a running turn.

### 2.1 Resume — the "next best" to steering

Resume continues a prior session in a **new** `exec` invocation, preserving context:

```bash
# Resume the most recent session
codex exec resume --last "Now add tests for the function you just wrote"

# Resume a specific session by id
codex exec resume 7f9f9a2e-1b3c-4c7a-9b0e-... "Address the review comments"
```

Per docs: *"Each resumed run keeps the original transcript, plan history, and approvals, so Codex
can use prior context while you supply new instructions."* So resume = full context carryover, but
it is still a fresh one-shot turn each time — not live steering of an in-flight turn.

### 2.2 Where sessions live on disk

- Root: `$CODEX_HOME/sessions/` (defaults to `~/.codex/sessions/`).
- Layout: date-partitioned `~/.codex/sessions/YYYY/MM/DD/`.
- File: `rollout-<session-id>.jsonl` — the full rollout (conversation history, tool calls, token
  usage). This is the same record `resume` replays to restore state.
- ⚠️ v0.136 (June 2026) added **session archiving**: archived sessions move to
  `$CODEX_HOME/archived_sessions/`. Archived sessions may not appear in `resume` pickers.
- The `thread_id` in the JSONL `thread.started` event corresponds to the session id used by
  `resume`. ⚠️ Confirm the id format matches what `resume` expects in your version (UUID vs `thr_`
  prefixed in app-server v2).

---

## 3. `--output-schema <FILE>` — constrained structured final output

- Takes a path to a **JSON Schema** file:
  `codex exec --output-schema schema.json "Produce a risk report"`.
- Constrains the model's **final response** to conform to that schema (structured outputs). Intended
  for downstream automation needing stable machine-readable fields (job summaries, risk reports,
  release notes, etc.).
- The conforming JSON is emitted as the final `agent_message` (and to `--output-last-message` if
  set; see §4). With `--json`, it appears as the text of the last `agent_message` item.
- ⚠️ Known limitations:
  - Only effective on certain model families historically (gpt-5 guard; openai/codex#4181).
  - Does **not** apply *only* to the final message — intermediate `agent_message`s emitted before
    tool calls are also forced into the schema (openai/codex#19816), which can corrupt progress
    messages.
  - Silently ignored when MCP/tools are active in some versions (openai/codex#15451).
  - Recommendation: combine with `--output-last-message` and validate output against the schema
    yourself; do not assume conformance.

---

## 4. `-o` / `--output-last-message <FILE>`

- Writes the **final assistant message** (the last `agent_message`) to `<FILE>`.
- Still prints it to stdout as well (file is in addition to, not instead of, stdout).
- With `--output-schema`, the file contains the schema-conforming JSON.
- This is the simplest robust way for a harness to grab the answer without parsing JSONL: write to a
  temp file, read it after the process exits.

---

## 5. Sandbox + approvals (the autonomy question)

Two orthogonal axes: **sandbox mode** (what the agent *can* do) and **approval policy** (when it
*pauses to ask*). For autonomous workers you must set BOTH so nothing blocks on a prompt.

### 5.1 Sandbox modes (`--sandbox` / `sandbox_mode`)

| mode | filesystem | network | notes |
|---|---|---|---|
| `read-only` | read anywhere; **no writes/edits/commands** without approval | none | safe default for analysis |
| `workspace-write` | read anywhere; **write only within the workspace (cwd)** + configured `writable_roots` (+ `$TMPDIR`/`/tmp` unless excluded) | **OFF by default** | the standard "do work" mode; out-of-workspace writes & network require approval/escalation |
| `danger-full-access` | unrestricted r/w | on | "No sandbox; no approvals" — full host access |

`workspace-write` specifics: writes are *"limited to the active workspace"*; **network access is
turned off by default**. To allow network you must opt in via config
`[sandbox_workspace_write] network_access = true` (or `-c sandbox_workspace_write.network_access=true`).
Extra writable paths via `writable_roots`. `exclude_tmpdir_env_var` / `exclude_slash_tmp` control
temp dir access.

### 5.2 Approval policies (`--ask-for-approval` / `approval_policy`)

| policy | behavior |
|---|---|
| `untrusted` | auto-runs only known-safe read ops; prompts for anything state-mutating |
| `on-failure` | runs in sandbox; only prompts to escalate if a sandboxed command **fails** |
| `on-request` | model decides when to ask (e.g. to escalate sandbox or use network) |
| `never` | **never prompts**; commands that would need escalation just fail instead of asking |

### 5.3 Running fully autonomously (no hangs)

For a non-interactive worker the safe combo is:

```bash
codex exec --sandbox workspace-write --ask-for-approval never "…task…"
```

- `--ask-for-approval never` guarantees no interactive prompt will ever block the process; anything
  the sandbox forbids simply **fails** (surfaced as a failed `command_execution`) rather than
  hanging.
- `codex exec` already defaults toward non-interactive behavior, but **set `never` explicitly** to
  be safe across versions.
- ⚠️ `codex exec --full-auto` is the old "workspace-write + low-friction approvals" shortcut; it is
  now a **deprecated compatibility path** that prints a warning. Prefer the explicit
  `--sandbox/--ask-for-approval` pair.

### 5.4 `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`)

- Disables **both** the sandbox and all approvals: *"No sandbox; no approvals."*
- Equivalent in effect to `danger-full-access` + `never`, but explicit and unmistakable.
- Use only inside an already-isolated environment (container/VM/microVM). For Beckett's shared
  project VM model this is the likely real-world setting — the OS/container is the sandbox, and you
  let Codex run freely inside it. See §8.

---

## 6. `config.toml` keys for automation

Location: `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). All keys overridable per-invocation with `-c key=value` (TOML-valued).

### 6.1 Key reference

```toml
# --- model ---
model = "gpt-5.1-codex"            # model id
model_provider = "openai"          # "openai" | "ollama" | "lmstudio" | "amazon-bedrock" | custom
model_reasoning_effort = "high"    # e.g. "minimal" | "low" | "medium" | "high" | "xhigh" (model-dependent)

# --- sandbox / approvals ---
sandbox_mode = "workspace-write"   # "read-only" | "workspace-write" | "danger-full-access"
approval_policy = "never"          # "untrusted" | "on-failure" | "on-request" | "never"

[sandbox_workspace_write]
network_access = false             # opt-in outbound network for workspace-write
writable_roots = ["/Users/you/.cache"]   # extra writable paths beyond cwd
exclude_tmpdir_env_var = false     # if true, $TMPDIR not auto-writable
exclude_slash_tmp = false          # if true, /tmp not auto-writable

# --- MCP servers (launched automatically each session) ---
[mcp_servers.my_tools]
command = "npx"
args = ["-y", "@me/mcp-server"]
# env = { API_KEY = "..." }
# enabled = true

# --- subprocess environment hygiene ---
[shell_environment_policy]
inherit = "core"                   # "all" | "core" | "none"
set = { CI = "1" }                 # force-set vars
exclude = ["AWS_*", "AZURE_*"]     # glob-remove (e.g. strip secrets)
include_only = ["PATH", "HOME"]    # whitelist

# --- profiles: named bundles of the above, selected via --profile NAME ---
[profiles.ci]
model = "gpt-5.1-codex"
approval_policy = "never"
sandbox_mode = "workspace-write"

# --- notify: external hook on lifecycle events ---
notify = ["python3", "/path/to/notify.py"]   # receives JSON arg, e.g. agent-turn-complete
```

### 6.2 `-c` / `--config` overrides

- Value is parsed as TOML, so **strings need embedded quotes**:
  ```bash
  codex exec -c model='"gpt-5.1-codex"' -c sandbox_workspace_write.network_access=true "…"
  ```
- Dotted keys address nested tables: `-c sandbox_workspace_write.network_access=true`.
- Bare booleans/numbers don't need quotes; strings do (`model='"gpt-5.1"'`).
- Profiles: `--profile ci` loads a `[profiles.ci]` block; individual `-c` overrides still win on top.
- Precedence (low→high): config.toml defaults → `[profiles.NAME]` → explicit CLI flags / `-c`.

---

## 7. app-server / mcp-server / exec-server (the steerable surface)

These are the long-lived server modes. The **app-server** is the one that gives real steering.

### 7.1 `codex app-server` — JSON-RPC 2.0 over stdio (the harness API)

- *"Like MCP, `codex app-server` supports bidirectional communication using JSON-RPC 2.0 messages."*
  Transport: **newline-delimited JSON-RPC over stdio** (default). ⚠️ Experimental WebSocket
  (`ws://IP:PORT`) and Unix-socket transports also exist.
- It is the **same harness that powers every Codex surface** (web, macOS app, VS Code, the CLI
  itself): a long-lived process hosting Codex core "threads".
- Protocol primitives: **Thread** (conversation) → **Turn** (one request+agent work) → **Item**
  (messages, commands, file changes, …).

**Core methods** (v2 protocol; method names ⚠️ version-sensitive — older builds used
`newConversation`/`sendUserTurn`/`interruptConversation`/`addConversationListener`):

| method | purpose |
|---|---|
| `thread/start` | create a new thread |
| `thread/resume` | reopen an existing thread (replays rollout to restore state) |
| `thread/fork` | branch conversation history |
| `thread/list` | paginate stored threads |
| `thread/archive` / `thread/unarchive` | manage thread state |
| `turn/start` | begin a request; responds with initial `turn` and streams events |
| **`turn/steer`** | **append user input to the active in-flight turn** (no new turn) — i.e. live steering |
| `turn/interrupt` | cancel the in-flight turn |
| `mcpServer/tool/call`, `mcpServer/resource/read` | MCP integration |
| `command/exec` | run a command under sandbox without a thread |
| `process/spawn`, `process/outputDelta` | ⚠️ experimental explicit process control |

**Streamed notifications** (server → client, while a turn runs):
`turn/started`, `turn/completed`, `item/started`, `item/completed`,
`item/agentMessage/delta` (streamed text append), `turn/diff/updated` (aggregated file changes), plus
**approval requests** that the server initiates and that **pause the turn until the client responds**.

Example steerable exchange:
```json
{"method":"turn/start","id":30,"params":{"threadId":"thr_123","input":[{"type":"text","text":"Run the tests"}]}}
{"id":30,"result":{"turn":{"id":"turn_456","status":"inProgress"}}}
// ... server streams item/started, item/agentMessage/delta, ...
{"method":"turn/steer","id":31,"params":{"threadId":"thr_123","input":[{"type":"text","text":"Also fix any lint errors you hit"}]}}
```

- ⚠️ `capabilities.experimentalApi: true` must be negotiated to access gated methods (dynamic tools,
  extended filesystem RPCs). Method names/shapes are the least stable part of this doc — confirm
  against `codex-rs/app-server/README.md` and `app-server-protocol/src/protocol/v2/` for your build.

### 7.2 `codex mcp-server` (a.k.a. `codex mcp`)

- Runs **Codex itself as an MCP server** so another agent (Claude, another Codex, an IDE) can call
  Codex as a tool. JSON-RPC/MCP over stdio. This is "Codex-as-a-tool", not a steering API for your
  own runs.

### 7.3 `codex exec-server`

- ⚠️ Experimental/internal server variant around the exec path. Not well-documented publicly; the
  app-server is the supported programmatic surface. Treat exec-server as unstable and prefer
  app-server for anything long-lived.

---

## 8. Implications for Beckett (worker harness)

Context: Beckett's wedge is **multiplayer/Discord collaboration on a shared project VM**, not
per-tenant isolation; v1 = shared project VM (per MEMORY).

### What Codex enables
- **Clean machine-readable telemetry.** `--json` gives a stable, typed event stream (commands,
  file changes, tool calls, plan, final message) — easy to fan out to a Discord channel as live
  progress. Per-turn `turn.completed.usage` gives token accounting for free.
- **Structured results** via `--output-schema` + `--output-last-message` — good for posting a
  tidy "result card" back to the channel / DB.
- **Resume = durable sessions on disk** (`~/.codex/sessions/.../rollout-*.jsonl`). A worker can
  persist `thread_id`, then `codex exec resume <id> "<follow-up>"` to continue with full context —
  maps naturally to a Discord thread = a Codex session.
- **Real steering exists, but only via app-server.** If Beckett wants "type into the running agent
  mid-task" (the multiplayer collaboration feel), build on `codex app-server` + `turn/steer` /
  `turn/interrupt`, not on `codex exec`. That's a JSON-RPC-over-stdio integration, more work than
  spawning `exec`, but it's the only path to live multi-user nudging of an in-flight turn.

### Constraints / gotchas
- **`codex exec` cannot be steered.** Each Discord "nudge" to an `exec` worker = kill + `resume`
  with the new instruction (loses the in-flight turn's partial work), OR queue it for the next turn.
  Acceptable for v1, but it's coarse-grained vs. true steering.
- **No cost field** — only tokens. Beckett must maintain its own per-model price table to show $.
  Model id isn't even in the stream (#14736), so record the launch model yourself.
- **Sandbox vs. shared VM.** Codex's `workspace-write` sandbox restricts writes to cwd and disables
  network — useful, but on a *shared* VM the OS-level isolation is your real boundary. Practical
  pattern: run `codex exec --sandbox workspace-write --ask-for-approval never` (network on only if
  needed via `-c sandbox_workspace_write.network_access=true`), OR
  `--dangerously-bypass-approvals-and-sandbox` and rely on the VM/container as the sandbox. Always
  set approvals to `never` so nothing blocks waiting for a human.
- **Schema/JSON reliability bugs** when MCP tools are active (#15451, #19816) — validate output;
  don't assume `--output-schema` conformance.

### How it differs from Claude Code (as a harness)
| dimension | Codex `exec` | Claude Code (`claude -p` / SDK) |
|---|---|---|
| steering a running turn | ❌ not on exec; ✅ only via `app-server` `turn/steer` | partial — SDK streaming-input mode can feed messages between turns; no true mid-turn inject either |
| event stream | JSONL: `thread/turn/item.*` + `usage` | `stream-json` with `system/assistant/result` events |
| cost visibility | tokens only, **no $**, no model in stream | `result` event includes `total_cost_usd` + per-model usage |
| sessions/resume | rollout JSONL on disk; `exec resume <id>`/`--last` | `--resume <session_id>` / `--continue`; sessions in `~/.claude` |
| sandbox model | first-class `read-only`/`workspace-write`/`danger-full-access` + approval policy axis | permission modes / allow-deny tool rules; no built-in fs/network jail of comparable granularity |
| long-lived controllable server | `app-server` (JSON-RPC/stdio, multi-surface) | Agent SDK (in-process), MCP |

**Net:** for a *one-shot batch worker* Codex `exec` is excellent (clean JSONL, schema output,
resume). For Beckett's *collaborative, steerable* vision, the differentiator lives in
`codex app-server` (`turn/steer`) — but that's a heavier JSON-RPC integration. Codex's biggest
relative weakness vs. Claude Code is **cost visibility** (tokens only); its biggest relative
strength is the **explicit sandbox/approval matrix** and a documented multi-surface harness server.

---

## 9. Quick recipes

```bash
# Autonomous one-shot, JSON telemetry, capture final answer to a file
codex exec \
  --sandbox workspace-write \
  --ask-for-approval never \
  --json \
  -o /tmp/answer.txt \
  "Refactor utils.py and run the tests"

# Structured result conforming to a schema
codex exec --output-schema ./schema.json -o /tmp/result.json "Produce a risk report for this PR"

# Continue the same logical task later (full context preserved)
codex exec resume --last "Now add unit tests for the new code"
codex exec resume 7f9f9a2e-1b3c-4c7a-9b0e-... "Address review comments"

# Override config inline (note TOML quoting on strings)
codex exec -c model='"gpt-5.1-codex"' -c sandbox_workspace_write.network_access=true "…"

# Fully unsandboxed inside an already-isolated VM/container
codex exec --dangerously-bypass-approvals-and-sandbox --json "…"
```
