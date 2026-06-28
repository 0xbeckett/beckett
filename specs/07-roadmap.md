# Beckett — Spec 07: Roadmap & Setup

> Status: **draft v2.0** · 2026-06-28 · Owner: Jason
> The v2 build order, the loom-desk setup checklist, and the verify-first risks. Honors
> [Spec 00](./00-overview.md). The build order maps to the approved re-architecture plan.

---

## 1. Build order (v2)

The leaf libraries already exist and are salvaged; the work is deleting the control core and
standing up the agent. Phases gate on each other.

### Phase 1 — Specs (this set)
Reframe the spec set to the agent architecture (done). Sign-off gate before deleting code.

### Phase 2 — Scaffold the agent project
1. **`.claude/` for the parent:** `CLAUDE.md` (doctrine from [Spec 02](./02-doctrine.md) +
   persona from `~/.beckett/persona.md`); `skills/` (one folder per [Spec 03](./03-skills.md)
   skill); parent-side hooks.
2. **`beckett-control` MCP server** (`src/mcp/`): the tool contract ([Spec 05](./05-tools-mcp.md))
   wrapping the salvaged claude driver, sandcastle (codex/pi + sandbox + branch-merge), the
   watcher, and the Discord gateway.
3. **Worker hooks** (`.claude/worker-hooks/`, templated per worktree): salvaged scope-guard
   (PreToolUse) + a PostToolUse/Stop telemetry emitter → `~/.beckett/workers/<id>/`.
4. **The bun shell** (`src/shell/`): Discord pump, parent-session supervisor (spawn + resume),
   log watcher (digest → smoke-alarm → inject signal).
5. **Delete the control core:** `src/state/`, `src/brain/*`, `src/supervise/*`,
   `src/worker/manager.ts`, the controller half of `src/cli/index.ts`, the state-machine half of
   `src/types.ts`; slim `src/persistence/*` to outcomes + pending-actions + users.

### Phase 3 — Vertical slice (prove dynamic effort)
End-to-end on the **trivial** and **one-worker** paths: `@beckett <task>` → parent triages →
either an inline answer (no worker) or one Claude worker in a worktree with scope-guard → light
review → deliver. Prove a real mid-task nudge lands and a smoke-alarm surfaces (no auto-kill).

**Phase 3 acceptance:**
- A medium task ("add input validation to src/foo.ts + a test") runs end-to-end; the worktree has
  a real branch + diff; executable checks exit 0 before the gate passes.
- A trivial mention is answered inline with **no** worker spawned (effort-judgment works).
- ≥1 mid-task nudge visibly changes worker behavior (diff/logs).
- ≥1 smoke-alarm fires and is surfaced as a signal, not an auto-kill.
- Shell/parent restart mid-task resumes both via `--resume`, finishing with ≤1 turn lost.
- A gate-outcome row is logged to SQLite.

### Phase 4 — Fill out to v1
Heavy path (multi-node DAG fan-out + `integrate`), sandcastle codex/pi harnesses + rate-limit
failover, fresh adversarial review (+ cross-provider/panel behind flags), identity handshakes
(gh/gmail), memory recall/remember woven into skills, learned-outcome accumulation.

### Later (feature-flagged)
Learned staffing on; multiplayer; cross-provider review default; Codex app-server mid-turn
steering; containers (sandcastle Docker) for untrusted blast-radius; web dashboard.

---

## 2. loom-desk setup checklist

Target: Ubuntu 24.04, x86_64, 8c/31GB, headless (`ssh loom-desk` via Tailscale). 🔑 =
interactive/one-time. (Per memory, the `beckett` user + toolset + GitHub identity are largely
provisioned already — verify, don't redo.)

1. **OS user:** non-root `beckett`; `sudo loginctl enable-linger beckett` (user services persist
   across logout/reboot).
2. **Runtimes:** `bun` on PATH; `node` (v22/fnm per the installed toolset) for worker npm tooling.
3. **`claude` CLI** 🔑 — authenticate to Jason's Claude subscription (device-flow, not API key);
   `claude -p "hi"` smoke-test; back up `~/.claude` (zero-reauth depends on it).
4. **`codex` CLI** 🔑 — authenticate to Jason's Codex subscription; verify
   `codex exec --sandbox workspace-write --skip-git-repo-check </dev/null "…"` doesn't hang;
   back up `~/.codex`; keep `harness.codex.enabled = false` until the sandcastle path is wired.
5. **`@ai-hero/sandcastle`** — `bun add @ai-hero/sandcastle`; `npx @ai-hero/sandcastle init` if
   using its Docker scaffold; confirm a no-sandbox `run()` works locally.
6. **Discord bot** 🔑 — app → Bot → token (`DISCORD_TOKEN`, note `DISCORD_APP_ID`); enable
   **MESSAGE CONTENT INTENT** (required for @mention); OAuth2 `bot`+`applications.commands`,
   View/Send/Read; invite to server.
7. **GitHub** 🔑 — `beckett-bot` account + fine-grained PAT (target repos only; Contents/PRs/
   Issues RW, Metadata RO; no admin/workflow/org); add as collaborator to each target repo.
8. **Gmail** 🔑 — Beckett's own Google account + OAuth client (scopes readonly + send + modify);
   `GMAIL_OAUTH_*` in `.env`.
9. **`~/.beckett/`** — populate `.env` (mode 600), `config.toml`, `persona.md`, seed
   `memory/MEMORY.md` + a few env/people/project notes.
10. **Deploy:** clone → `bun install` → run the shell foreground once to confirm it spawns the
    parent and reaches ready → install the systemd user unit (§3).

**`~/.beckett/.env`:** `DISCORD_TOKEN, DISCORD_APP_ID, GITHUB_PAT, GITHUB_ACCOUNT, GMAIL_ACCOUNT,
GMAIL_OAUTH_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN}` (or `GMAIL_APP_PASSWORD`). **No** model API
keys.

---

## 3. systemd user service

```ini
# ~beckett/.config/systemd/user/beckett.service   (loginctl enable-linger beckett)
[Unit]
Description=Beckett agentic coworker (shell + parent agent)
After=network-online.target

[Service]
Type=simple
ExecStart=/home/beckett/.bun/bin/bun /home/beckett/beckett/dist/shell/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```
The shell owns spawning + resuming the parent agent; a crash self-heals via §recovery
([Spec 01 §5.3](./01-runtime.md)) with ≤1 turn lost. Logs → journald + `~/.beckett/logs/`.

---

## 4. Verify-first risks (smoke-test before building on them)

| Risk | Test | Fallback |
|---|---|---|
| **A — Claude stream-json nudge** lands at turn boundary + changes behavior | replay-echo + diff change on a live worker | kill + `--resume` with steer as first turn (coarser) |
| **B — Codex autonomous no-hang** via sandcastle | a sandcastle `codex()` run completes unattended | Docker sandbox + bypass-approvals inside the container |
| **C — Parent stays coherent long-lived** without context blowup | a multi-worker heavy task over many signals; verify digests + auto-compaction hold | tighter digest budgets; periodic explicit compaction; per-task parent fork |
| **D — Headless loads skills+hooks** (parent not `--bare`) | confirm `.claude/skills` + hooks fire in `claude -p` | embed instructions in `--append-system-prompt` |
| **E — Discord MESSAGE CONTENT intent** | bot receives non-empty `content` on @mention | slash-command intake (contradicts ambient canon) |
| **F — Rate-limit detection** for failover | capture real throttle frames (Claude `api_error_status` / Codex `turn.failed`) | v0 Claude-only → queue+backoff; failover gates on this at v1 |

---

## 5. Testing strategy
- **Unit:** salvaged libs stay green — memory recall/dedup, `agency.classifyAction`, scope-guard
  decisions, claude-driver command construction, config loader.
- **Integration:** fake-harness binary (scripted stream-json/JSONL, honors nudges) drives the
  watcher + MCP tools deterministically (happy path, drift, scope-violation, restart-mid-turn).
- **E2E (sparing):** one canned real task against `claude` (and `codex` at v1) asserting the
  Phase 3 / Phase 4 acceptance criteria.

## 6. Cross-references
- Runtime + recovery the unit relies on → [Spec 01](./01-runtime.md)
- What gets built in each phase → [Spec 02](./02-doctrine.md)–[06](./06-identity-memory.md)
- Harness wire-format research behind the risks → [`../my-docs/`](../my-docs/)
