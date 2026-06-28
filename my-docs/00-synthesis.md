# Beckett — Harness Synthesis & Architectural Implications

> Living doc. My (Claude's) interpretation of what `claude -p` and `codex exec` can actually
> do, and what that *forces* in Beckett's design. Edit as facts change.
> Sources: [claude-code-headless.md](./claude-code-headless.md), [codex-exec.md](./codex-exec.md).
> Verified against local binaries: `claude 2.1.195`, `codex-cli 0.142.3` (2026-06-27).

## The one fact that shapes everything: the harnesses are asymmetric

Beckett is "a harness over harnesses." But the two harnesses it drives have **different control
surfaces**, and the whole supervise/control-plane design has to absorb that asymmetry instead of
pretending it away.

| Capability | Claude Code (`claude -p`) | Codex (`codex exec`) |
|---|---|---|
| **Invocation** | Long-lived; bidirectional stream | One-shot: prompt in → run → exit |
| **Mid-run steering (nudge)** | ✅ stream-json input — inject `user` msgs that land at next **turn boundary** | ❌ exec can't. Only `codex app-server` (`turn/steer`, JSON-RPC) can |
| **Hard interrupt** | SDK `interrupt()` only; CLI = kill + `--resume` | kill process; or app-server `turn/interrupt` |
| **Resume w/ full context** | `--resume <id>` / `--session-id` / `--fork-session` | `codex exec resume <id> "<prompt>"` |
| **Cost visibility** | ✅ `result.total_cost_usd` + token `usage` | ⚠️ **tokens only, no USD**; model name not even in stream |
| **Structured output** | `--json-schema` → `result.structured_output` | `--output-schema FILE` (⚠️ leaks into intermediates; ignored when MCP active) |
| **Live telemetry** | stream-json: system/assistant/user/result msgs | `--json` JSONL: thread/turn/item events |
| **Permission control** | `--permission-mode`, `--allowedTools`, hooks, `--permission-prompt-tool` (MCP) | sandbox modes + approval policy |
| **Autonomous no-hang** | `--permission-mode bypassPermissions` (or acceptEdits + allowlist) | `--sandbox workspace-write --ask-for-approval never` |
| **Sandbox / network** | tool allowlist + hooks; no built-in fs sandbox | OS sandbox; **network OFF by default** in workspace-write |
| **Sessions on disk** | `~/.claude/projects/<enc-cwd>/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl` |
| **Hooks/observability** | PreToolUse/PostToolUse etc.; can block+modify; `--include-hook-events` | execpolicy `.rules`; lighter |

### What the asymmetry forces

1. **The "nudge" primitive is not uniform.** Beckett's control plane must define `nudge(worker, msg)`
   as an interface with **two implementations**:
   - Claude worker → write a `user` NDJSON line to its open stdin (lands next turn).
   - Codex worker → **can't** mid-run. Either (a) drive codex via `app-server` `turn/steer` instead of
     `exec`, or (b) accept that codex nudges = checkpoint-at-turn-end then `exec resume` with the
     steer text. **This is the single biggest build-time fork in the spec.** (See Q: harness depth.)

2. **Pause/checkpoint is cheap for both** (read the on-disk JSONL transcript), but **only Claude gives
   true soft-interrupt without losing the turn.** Codex's "pause" is really "wait for turn end."

3. **Budget math is split.** Claude reports USD directly; Codex reports tokens only and *doesn't even
   emit the model name*. Beckett needs a `tokens × model → USD` pricing table to normalize Codex spend
   into the same budget ledger. The budget pillar of "agency" depends on this normalization existing.

4. **Autonomy flags differ.** A fully-unattended worker is `bypassPermissions` (Claude) vs
   `workspace-write + approval never` (Codex). Codex's network-off-by-default is a *feature* for blast
   radius but a *footgun* for tasks needing `npm install`/`git push` — must opt in per-worker.

5. **Embedding the SDK beats shelling out — for Claude.** The TS/Python Agent SDK exposes
   `interrupt()`, `canUseTool` callbacks, and programmatic streaming input that the bare CLI doesn't.
   If steering fidelity matters (it's the thesis of the whole pitch), Beckett's Claude driver should
   probably be the **SDK**, not `child_process('claude -p')`. Codex has no equivalent embeddable SDK —
   its programmatic surface *is* `app-server`/`exec-server` (JSON-RPC over stdio/ws).

## The worker abstraction (concrete struct, first draft)

```
Worker {
  id:            string
  harness:       'claude' | 'codex'
  driver:        'sdk' | 'cli-stream' | 'app-server' | 'exec-oneshot'   // see harness-depth Q
  session_id:    string            // for resume
  scope:         FileScope         // owned paths/modules — enforced how? (worktree? hook deny?)
  workspace:     path              // isolated dir / git worktree
  budget:        { usd?: number, tokens?: number, wall_clock_s?: number }
  criteria:      AcceptanceCriteria // written at PLAN time; what REVIEW checks against
  telemetry:     stream handle      // parsed JSONL → counters
  state:         spawning|running|nudging|paused|review|done|failed|aborted
  spend:         { usd, tokens }    // live, normalized
  control:       { nudge(msg), pause(), abort(), ask_plan() }  // the 3+1 primitives
}
```

Everything else (parallel/sequence) is a DAG of these. Open questions below pin down each field.

## Assets we already have available (MCP)

This session exposes **Gmail, Google Calendar, Google Drive, Notion, Figma** MCP tools — directly
relevant to Beckett's "own inbox / own agency" pillar. Beckett-as-coworker email/calendar could ride
these MCP servers rather than raw IMAP/SMTP. (Auth-as-Beckett vs auth-as-Jason is an open question.)

## Standing assumptions (from memory + pitch) — confirm before building

- **Wedge = multiplayer collaboration in Discord**, not per-tenant isolation. v1 = **shared project VM**.
- **Opus is judgment, not the clock.** Cheap models for intake/format/classify; Opus only on signal.
- Beckett reports in **first person**, owns decisions, can push back / refuse / self-halt.
