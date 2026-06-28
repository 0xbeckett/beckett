# Beckett — Spec 12: Roadmap & Setup

> **The "stand it up and ship it in order" doc.** Everything you need to take a bare `loom-desk`
> to a running Beckett, the systemd service that keeps it alive, the phased build order (v0 → v1 →
> later) with concrete acceptance criteria per milestone, the verify-first risks to smoke-test
> *before* building on them, the testing strategy, and a rolled-up list of every open ⚠️ that needs
> a decision around build time.
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Anchor: [Spec 00 — Overview & Canon](./00-overview.md) (phasing §8, filesystem §5, decisions §4).
> Research: [`../my-docs/`](../my-docs/) — [00-synthesis.md](../my-docs/00-synthesis.md) (loom-desk
> facts), [claude-code-headless.md](../my-docs/claude-code-headless.md),
> [codex-exec.md](../my-docs/codex-exec.md), [open-questions.md](../my-docs/open-questions.md).

---

## 0. Scope & cross-links

This doc owns: **host setup, identity provisioning, the service unit, the phased roadmap, the
verify-first smoke tests, and the testing strategy.** It defers component internals to their specs.

| Concern | Owner |
|---|---|
| `config.toml` schema, systemd unit rationale, startup/recovery | [Spec 01 — Architecture](./01-architecture.md) |
| Driver invocations (the exact `claude -p` / `codex exec` flags) | [Spec 02 — Worker Abstraction](./02-worker-abstraction.md) |
| Smoke-alarms, rate-limit *policy*, nudge/pause/abort mechanics | [Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md) |
| State machine, DAG executor, INTEGRATE, recovery semantics | [Spec 04 — State Machine](./04-state-machine.md) |
| Discord bot behavior, intents, ambient model | [Spec 05 — Discord Interface](./05-discord-interface.md) ⚠️ not yet written |
| Brain routing, model ids, persona application | [Spec 06 — Brain & Models](./06-brain-models.md) ⚠️ not yet written |
| `.env` key semantics, GitHub/Gmail agency, handshakes | [Spec 07 — Identity & Agency](./07-identity-agency.md) ⚠️ not yet written |
| Memory file format, seeding the knowledge graph | [Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md) ⚠️ not yet written |
| SQLite schema, migrations, outcome logging | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) ⚠️ not yet written |
| `beckett` CLI surface (`ps`/`tail`/`nudge`/…) | [Spec 10 — CLI](./10-cli.md) ⚠️ not yet written |
| Criteria format, tiered review, retry/escalate | [Spec 11 — Review, Gate & Quality](./11-review-gate-quality.md) ⚠️ not yet written |

> ⚠️ Specs 05–11 are forward references at time of writing. Where this doc needs a fact they own
> (e.g. the exact `.env` key list for Gmail), it states the **build-time best guess** and marks it ⚠️
> for that spec to ratify.

---

## 1. loom-desk setup checklist

**Target host** ([00-synthesis.md](../my-docs/00-synthesis.md)): Ubuntu 24.04, x86_64, 8c/31GB,
reachable via `ssh loom-desk` (Tailscale). **Already present:** bun 1.3.13, Docker 29, git 2.43,
node v18.19, npm 9. **Missing v0 prereqs:** `claude` CLI, `codex` CLI (must install + authenticate),
plus pnpm/tmux/sqlite3-cli (we don't need them — see §1.3).

Run §1.1–§1.8 in order. Steps that need an interactive browser/OAuth are flagged 🔑; do those from a
machine where you can open a browser and paste a code back (loom-desk is headless → device-flow).

### 1.1 Create the dedicated OS user `beckett`

Beckett runs as its **own non-root Unix user** — canon (Spec 00 §4 Identity) *and* a hard
requirement: Claude's `--permission-mode bypassPermissions` **refuses to run as root on Unix**
([claude-code-headless.md](../my-docs/claude-code-headless.md) §4.2). The whole worker model depends
on `bypassPermissions`, so root is a non-starter.

```bash
# as a sudoer on loom-desk
sudo adduser --disabled-password --gecos "Beckett coworker" beckett
sudo loginctl enable-linger beckett        # user services run without an active login / across reboots
sudo install -d -o beckett -g beckett -m 0750 /home/beckett/projects
# from here on, operate AS beckett:
sudo -iu beckett
```

> `enable-linger` is what lets the systemd **user** service (§2) survive logout and start on boot.

### 1.2 Install the runtime — bun (decision: bun, not node)

Canon (Spec 00 §4 Runtime; open-questions A1): the daemon runs on **bun** — it's modern, already
installed (1.3.13), and sidesteps the stale **node v18.19** on the box. We do **not** upgrade node
for the daemon. (node-18 only matters if a *worker's* npm-based tooling needs newer node; that's the
worker's concern inside its worktree, not the daemon's.)

```bash
# bun is already installed system-wide; confirm it's on beckett's PATH
bun --version            # expect 1.3.13+
# if missing for this user:  curl -fsSL https://bun.sh/install | bash  (then re-source ~/.bashrc)
```

### 1.3 Install missing tools (and what we deliberately skip)

```bash
# nothing extra is strictly required for v0. Explicitly:
#  - sqlite3 CLI  → NOT needed: persistence uses bun's built-in `bun:sqlite` (Spec 09).
#  - pnpm/tmux    → NOT needed: bun is the package manager + runtime; systemd is the supervisor.
#  - git          → present (2.43); confirm worktree support (any 2.x):  git worktree -h
git config --global user.name  "Beckett"
git config --global user.email "<beckett gmail from §1.6>"   # commits authored as Beckett
```

### 1.4 Install + AUTHENTICATE the `claude` CLI 🔑 (the key prereq)

This is *the* gating step — the harnesses are missing on loom-desk and Beckett is nothing without
them. Goal (Spec 00 §4 Secrets): **one-time login that persists in `~/.claude` → zero re-auth** for
the life of the daemon.

```bash
# install the native binary (no node dependency, avoids the node-18 problem)
curl -fsSL https://claude.ai/install.sh | bash       # installs `claude` to ~/.local/bin
claude --version                                      # expect 2.1.195 (the verified version) or newer
```

Authenticate against **Jason's Claude subscription** (not an API key — Beckett runs on the
subscription, Spec 00 §4 Economics). loom-desk is headless, so use the device/paste flow:

```bash
claude            # launches; choose "Log in with your Anthropic account"
                  # it prints a URL + code → open on your laptop, approve, paste the token back.
# verify it stuck (this should run WITHOUT prompting for auth):
claude -p "say 'auth ok' and nothing else" --output-format json | jq -r '.result'
```

> Credentials land in `~/.claude` (login token + config). **Back this directory up** after first
> login — restoring it onto a rebuilt box restores zero-re-auth. Do **not** set
> `ANTHROPIC_API_KEY` and do **not** use `--bare` (it forces API-key auth and bypasses the
> subscription login — [Spec 02 §4.1](./02-worker-abstraction.md)).

### 1.5 Install + AUTHENTICATE the `codex` CLI 🔑 (needed for v1, install now)

v0 is Claude-only, but install+auth Codex during setup so failover (Spec 00 §4 Rate limits) is a
config flip later, not a new provisioning round-trip.

```bash
# native install preferred; npm fallback works but pulls node (18 is fine for the codex JS shim)
curl -fsSL https://codex.openai.com/install.sh | bash     # or: npm i -g @openai/codex
codex --version                                           # expect codex-cli 0.142.3 or newer
codex login            # OAuth against Jason's ChatGPT/Codex subscription; device/paste flow as above
# verify (autonomous one-shot, no hang — also doubles as Risk-B smoke test, §4):
cd /tmp && codex exec --sandbox workspace-write --ask-for-approval never --json \
  "write hello to ./codex-auth-ok.txt then stop" && cat /tmp/codex-auth-ok.txt
```

> Credentials land in `~/.codex`. Back it up alongside `~/.claude`. Keep `harness.codex.enabled =
> false` in `config.toml` until the Codex driver lands (Spec 00 §8).

### 1.6 Provision Beckett's identities 🔑

These give Beckett its "self" (Spec 00 §4 Identity; open-questions F1). All secrets go in
`~/.beckett/.env` (§1.7).

**Discord bot** (interface; Spec 05):
1. https://discord.com/developers/applications → **New Application** ("Beckett").
2. **Bot** tab → **Reset Token** → copy → `DISCORD_TOKEN`. Note the **Application ID** → `DISCORD_APP_ID`.
3. **Bot** tab → **Privileged Gateway Intents** → enable **MESSAGE CONTENT INTENT** (required to read
   `@beckett …` text; this is privileged-gated — see Risk-E §4). Also enable **Server Members** only
   if attribution needs it later (multiplayer).
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions: *View
   Channels, Send Messages, Read Message History* (add *Create Public Threads* only if Spec 05 ever
   re-introduces threads — current canon is ambient/no-threads). Open the URL → invite to the server.

**GitHub** (agency; Spec 07):
1. Create Beckett's **own** GitHub account (e.g. `beckett-bot`) → `GITHUB_USER`.
2. Create a **fine-grained PAT**, least-privilege (open-questions F3 = branch/PR only, no force-push):
   - Repository access: only the repos Beckett works in.
   - Permissions: **Contents: Read/Write**, **Pull requests: Read/Write**, **Metadata: Read**
     (auto). *No* admin, *no* workflow, *no* org scopes.
   - → `GITHUB_PAT`.
3. Add `beckett-bot` as a **collaborator** (write) on each target repo.

**Gmail** (agency; Spec 07):
1. Create Beckett's own Google account → `GMAIL_ADDRESS`.
2. Auth: a Google Cloud OAuth client (Gmail API, scopes `gmail.readonly` + `gmail.send` +
   `gmail.modify` for labels) → store `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` /
   `GMAIL_REFRESH_TOKEN`. ⚠️ Whether email rides the **Gmail MCP** (available this session,
   [00-synthesis.md](../my-docs/00-synthesis.md)) vs. raw OAuth API is owned by **Spec 07** — provision
   the account now; the exact key shape is ratified there.

### 1.7 Populate `~/.beckett/` (config, secrets, persona, memory seed)

Lay out the home exactly as Spec 00 §5:

```bash
install -d -m 0700 ~/.beckett ~/.beckett/memory ~/.beckett/events ~/.beckett/logs
install -m 0600 /dev/null ~/.beckett/.env        # secrets — mode 0600, never world-readable
```

**`~/.beckett/.env`** — full key list (semantics ratified by [Spec 07](./07-identity-agency.md)).
Note: **no `ANTHROPIC_API_KEY` / no OpenAI key** — the harnesses use the subscription logins in
`~/.claude` / `~/.codex` (§1.4–1.5).

```bash
# ── Discord (interface, Spec 05) ──
DISCORD_TOKEN=...
DISCORD_APP_ID=...
# ── GitHub (agency, Spec 07) ──
GITHUB_USER=beckett-bot
GITHUB_PAT=github_pat_...
# ── Gmail (agency, Spec 07) — ⚠️ exact set depends on MCP-vs-API decision ──
GMAIL_ADDRESS=beckett@...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
# ── (intentionally NO ANTHROPIC_API_KEY / OPENAI_API_KEY — subscription auth lives in ~/.claude, ~/.codex) ──
```

**`~/.beckett/config.toml`** — full schema is [Spec 01 §4](./01-architecture.md#4-beckettconfigtoml-schema);
every key has a default, so a near-empty file boots. The v0 seed (Claude-only, conservative cap):

```toml
[concurrency]
max_workers = 2                     # v0: one worker really, headroom of 2 (Spec 01 §2.1)

[harness.claude]
enabled = true
bin = "claude"
default_model = "claude-sonnet-4-5"
permission_mode = "bypassPermissions"   # bounded by worktree + PreToolUse hook (Spec 02 §8)

[harness.codex]
enabled = false                     # flip true when the codex driver lands (v1)

[paths]
home        = "/home/beckett"
beckett_dir = "/home/beckett/.beckett"
projects    = "/home/beckett/projects"

[discord]
reply_channel_mode = "same"         # ambient: reply in the channel the mention came from

[features]
codex_failover = false              # v0 = Claude-only → rate-limit handling degenerates to queue+backoff
fresh_reviewer = false              # v0 = self-review only; turn on for v1 critical nodes
multiplayer    = false              # user_id tracked regardless
```

**`~/.beckett/persona.md`** — Beckett's user-facing voice (Spec 00 §4 Persona: chill, quippy, young,
energetic-but-relaxed, talks like Jason; lowercase-friendly, dry wit). Applies to the Haiku
front-door only; worker/reviewer prompts stay businesslike. Seed:

```markdown
# Beckett — persona (user-facing voice only)
chill, quippy, young, energetic-but-relaxed. talks like Jason: casual, lowercase-friendly, dry wit.
first person, owns its decisions ("I aborted worker 3 because…"). sparse — only says what you need.
pushes back when something's wrong; never performs progress.
```

**`~/.beckett/memory/MEMORY.md`** + seed files — the knowledge-graph index (Spec 00 §5,
[Spec 08](./08-memory-knowledge-graph.md)). Minimum viable seed so the brain has ground truth:

```markdown
# Memory index
- [[people/jason]] — primary user; voice reference for persona
- [[env/loom-desk]] — the host: Ubuntu 24.04, 8c/31GB, bun daemon, projects under ~/projects
- [[self/beckett]] — own GitHub (beckett-bot) + Gmail identity; agency boundaries
```

Create the linked stubs (`memory/people/jason.md`, `memory/env/loom-desk.md`,
`memory/self/beckett.md`) with frontmatter + `[[wikilinks]]` per Spec 08.

### 1.8 Deploy the daemon code & smoke-boot

```bash
git clone <beckett repo> /home/beckett/beckett        # the TS/bun daemon source
cd /home/beckett/beckett && bun install
bun run build                                          # → dist/daemon.js (path used by the unit, §2)
# dry boot in the foreground first (Ctrl-C to stop) — should reach `daemon.ready` (Spec 01 §5.1):
bun dist/daemon.js
```

---

## 2. Run as a service (systemd *user* service)

Beckett runs as a **systemd user service** under the `beckett` account — non-root (so
`bypassPermissions` is allowed) and owning `~/.beckett`, `~/.claude`, `~/.codex`. Rationale and the
startup/shutdown/recovery contract live in [Spec 01 §5.3](./01-architecture.md#53-supervision-on-loom-desk);
this is the install procedure.

```bash
# as beckett:
install -d ~/.config/systemd/user
cat > ~/.config/systemd/user/beckett.service <<'UNIT'
[Unit]
Description=Beckett agentic coworker daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/home/beckett/.bun/bin/bun /home/beckett/beckett/dist/daemon.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30            # give graceful shutdown (Spec 01 §5.2) room before SIGKILL
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now beckett.service
```

> `loginctl enable-linger beckett` (done in §1.1) is what makes a **user** service start at boot and
> survive logout — without it the service dies when your SSH session ends.

**Relationship to `beckett daemon` (Spec 10).** The unit's `ExecStart` runs the long-lived daemon
process directly. The `beckett` **CLI** (`ps`, `tail`, `nudge`, `abort`, `status`, `logs`) is a
*separate, transient* process that talks to the running daemon over the unix socket
`~/.beckett/beckett.sock` (writes) or reads SQLite/JSONL directly (queries) —
[Spec 01 §7](./01-architecture.md#7-ipc--how-beckett-talks-to-the-daemon). `beckett daemon`
(Spec 10) is the same entrypoint as `ExecStart`; in production systemd owns it, and you use
`beckett daemon` only for manual foreground runs during dev.

**Logs.** stdout/stderr → journald. Per-worker prettified logs → `~/.beckett/logs/` (Spec 00 §5).

```bash
journalctl --user -u beckett.service -f          # live daemon log
systemctl --user status beckett.service          # health / restart count
systemctl --user restart beckett.service         # apply config.toml changes (treat config as boot-time, Spec 01 §4)
```

**Restart policy.** `Restart=on-failure` + the recovery hook (Spec 01 §5.1 step 6) means a crash
self-heals: on restart Beckett re-attaches in-flight workers via `claude --resume` / `codex exec
resume` from their persisted `session_id`s and re-enters SUPERVISE, losing **≤ 1 turn** (Spec 00 §4
Persistence; [Spec 04](./04-state-machine.md) recovery).

---

## 3. The phased roadmap

Each milestone lists what ships, the **recommended build order** (which modules, which specs), and
**concrete acceptance criteria** — a real check someone can run, not a vibe.

### v0 — prove steering end-to-end (one harness, one worker, real soft-interrupt)

The thinnest thing that proves the thesis (Spec 00 §8; open-questions K1): a real `@beckett` task
goes all the way through with at least one mid-task nudge that *visibly changes worker behavior*.

```
Discord @mention → Haiku ack → Opus single-node plan + criteria → ONE claude worker in a worktree
→ SUPERVISE (smoke-alarm + manual nudge from CLI/Discord) → self-review vs criteria → DELIVER in-channel
```

**Build order (modules → specs):**
1. **Config + persistence skeleton** — load `.env`/`config.toml` ([Spec 01 §4](./01-architecture.md)),
   open `bun:sqlite`, JSONL event log, the startup sequence ([Spec 09](./09-persistence-data-model.md),
   [Spec 01 §5](./01-architecture.md)). *Everything writes a row + an event from day one.*
2. **ClaudeDriver** — `claude -p` stream-json spawn/onEvent/sendNudge/abort + WorkerEvent
   normalization ([Spec 02 §4, §7](./02-worker-abstraction.md)). **Gate this on Risk-A (§4).**
3. **Worktree + scope hook** — `git worktree add` per worker + the PreToolUse `scope-guard.ts`
   ([Spec 02 §8](./02-worker-abstraction.md)).
4. **Supervisor/Tailer** — read-only tail + the v0 smoke-alarms (no-progress over K, scope-violation)
   ([Spec 03](./03-control-plane-supervise.md)).
5. **Brain (minimal)** — Haiku intake/ack/deliver + Opus single-node plan-with-criteria
   ([Spec 06](./06-brain-models.md)); self-review at GATE ([Spec 11](./11-review-gate-quality.md)).
6. **Discord gateway** — mention in → ack/deliver out; a reply routed as a nudge
   ([Spec 05](./05-discord-interface.md)).
7. **CLI (write path)** — at minimum `beckett nudge` + `beckett tail`/`ps` over the socket
   ([Spec 10](./10-cli.md)) so steering is testable off-Discord.

**Acceptance criteria (v0 is "done" when ALL hold):**
- [ ] A real task (e.g. "add input validation to `src/foo.ts` and a test") posted as `@beckett` in a
      channel runs **end-to-end**: ack → plan → one Claude worker in its own worktree/branch →
      self-review against the written criteria → delivery message in the **same channel**.
- [ ] The worktree contains a real branch with a real diff; executable checks (the node's
      test/build command) **exit 0** before GATE passes (Spec 00 §4 Criteria).
- [ ] **≥1 successful mid-task nudge that changed behavior:** while the worker is mid-run, a
      `beckett nudge <worker> "<instruction>"` (or a Discord reply) is **delivered** (acked via
      `--replay-user-messages`, [Spec 02 §4.4](./02-worker-abstraction.md)) and the worker's
      subsequent turns demonstrably follow it (visible in `beckett tail` + the final diff).
- [ ] At least one smoke-alarm fires on a deliberately-stuck task and surfaces to the supervisor
      (no auto-kill — it's a signal, Spec 00 glossary).
- [ ] Kill the daemon mid-task (`systemctl --user restart beckett`); it **resumes** the worker via
      `--resume` and finishes, losing ≤ 1 turn.
- [ ] A gate-outcome row `(harness, model, task_type) → {passed, retries, drift_events, turns}` is
      logged to SQLite (Spec 00 §4 Learned model — log from day one even though staffing is static).

### v1 — the coworker (Codex, multi-node DAG, agency, memory, review)

Adds the pieces that make it a colleague rather than a single-shot steerer (Spec 00 §8).

**Build order (each item ~independent; rough dependency order):**
1. **CodexDriver** — `codex exec` one-shot + `exec resume`, deferred nudge, WorkerEvent
   normalization ([Spec 02 §5, §7](./02-worker-abstraction.md)). **Gate on Risk-B & Risk-C (§4).**
   → flip `harness.codex.enabled = true`.
2. **Rate-limit failover** — detect a throttled harness, route portable nodes to the other
   ([Spec 01 §2.2](./01-architecture.md), [Spec 03](./03-control-plane-supervise.md)). **Gate on
   Risk-D (§4).** → `features.codex_failover = true`.
3. **Multi-node DAG + INTEGRATE** — the DAG executor, parallel/sequenced nodes, non-overlapping
   scopes, `git merge` integrate + integration-worker on conflict ([Spec 04](./04-state-machine.md)).
4. **Delegated fresh reviewer** — spawn a fresh `claude -p` with criteria+diff only, no implementer
   context, for critical nodes ([Spec 11](./11-review-gate-quality.md)). → `features.fresh_reviewer = true`.
5. **Identity & agency** — GitHub branch/PR as `beckett-bot`; Gmail read/triage/draft; delivery
   handshakes ("PR's up — review or merge?"); inbox poller ([Spec 07](./07-identity-agency.md)).
6. **Knowledge-graph memory** — recall feeding brain + worker prompts; learned-worker narratives
   accrue ([Spec 08](./08-memory-knowledge-graph.md)).
7. **Outcome logging maturity** — the full `(harness, model, task_type)` stats table that the
   later learned model will read ([Spec 09](./09-persistence-data-model.md)).

**Acceptance criteria (per capability):**
- [ ] **Codex driver:** a node staffed to Codex completes autonomously via `codex exec
      --sandbox workspace-write --ask-for-approval never` with **no hang**, JSONL telemetry parsed
      into WorkerEvents, and `exec resume` continues it with a queued nudge applied.
- [ ] **Failover:** a (simulated) Claude rate-limit reroutes a portable pending node to Codex and it
      completes; the user is **not** notified unless blocked > `escalate_after_s` (Spec 01 §6).
- [ ] **Multi-node DAG + integrate:** a task that decomposes into ≥2 parallel nodes (non-overlapping
      worktrees) merges cleanly via `git merge`; an induced conflict spawns an integration worker
      that resolves it before escalating (Spec 04; open-questions C4).
- [ ] **Fresh reviewer:** a critical node is reviewed by a fresh worker with **only** criteria+diff
      (no implementer transcript); GATE = checks pass **AND** reviewer pass; a planted defect is caught.
- [ ] **GitHub identity:** Beckett pushes a `beckett/*` branch and opens a PR **as `beckett-bot`**
      (verify the PR author), then asks the merge handshake rather than auto-merging
      (`identity.auto_merge = false`).
- [ ] **Gmail identity:** Beckett reads/labels its own inbox and drafts a reply, but **send** is
      gated behind the handshake (open-questions F2).
- [ ] **Memory:** a non-code task ("email the marketing team we're a go for Project Anaconda")
      resolves *marketing team* + *Project Anaconda* from the knowledge graph (open-questions K).
- [ ] **Outcome logging:** stats accumulate per `(harness, model, task_type)` across ≥10 nodes.

### Later — capability model, multiplayer, cross-provider, app-server, containers, dashboard

Turn-on order (Spec 00 §8), all behind feature flags so each is a flip + a real-data threshold:
- **Learned capability model ON** — adaptive STAFF from logged outcomes + Opus narration ("Codex
  over-engineers data layers") (`features.learned_staffing = true`; open-questions G1).
- **Multiplayer unlock** — concurrent multi-user tasks, attribution, conflict surfacing
  (`features.multiplayer = true`; `user_id` already on every row from v0).
- **Cross-provider review** — Codex reviews Claude's work and vice-versa for critical nodes
  (open-questions H2).
- **Codex app-server steering** — `turn/steer` for true mid-turn Codex nudges, replacing
  deferred-via-resume (`features.app_server_codex = true`; [Spec 02 §5.2](./02-worker-abstraction.md)).
- **Containers** — per-worker Docker for untrusted/multi-tenant blast-radius (Docker 29 present;
  Spec 00 §4 Workspace; closes the Bash-write-leak in [Spec 02 §8.4](./02-worker-abstraction.md)).
- **Web dashboard** — beyond the CLI (Spec 00 §4 Mgmt surface).

---

## 4. Verify-first risks (⚠️ smoke-test BEFORE building on them)

Each is a load-bearing assumption baked into a sibling spec. Run the test on the **installed**
binaries (`claude 2.1.195`, `codex-cli 0.142.3`) before writing the module that depends on it. If it
fails, take the fallback.

### ⚠️ Risk-A — Claude stream-json nudge lands at the next turn boundary
**Why it matters:** the *entire* v0 thesis (steering) and [Spec 02 §4.4](./02-worker-abstraction.md)
assume a `user` line written to an open `--input-format stream-json` stdin is ingested mid-task and
acked via `--replay-user-messages`. The docs don't pin the exact read boundary
([claude-code-headless.md](../my-docs/claude-code-headless.md) §2.2).

**Test** (run in a throwaway git dir; gives the worker a multi-turn task, then nudges):
```bash
mkdir -p /tmp/risk-a && cd /tmp/risk-a && git init -q
mkfifo in
claude -p --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --include-hook-events --permission-mode bypassPermissions \
  --max-turns 12 < in \
  | jq -rc 'select(.type=="user" or .type=="result") | {type, subtype, text:(.message.content)}' &
# initial multi-step task
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Create files a.txt, b.txt, c.txt one at a time, pausing to think between each."}}' > in
sleep 8
# mid-task nudge — should appear as a replayed `user` line (ACK) and change behavior
printf '%s\n' '{"type":"user","message":{"role":"user","content":"STOP creating files. Instead write DONE into stop.txt and finish."}}' > in
# PASS if: (1) a replayed user line for the nudge appears on stdout (ack), and
#          (2) stop.txt exists and c.txt does NOT (behavior changed before completion).
```
**Fallback if it fails:** (a) accept nudge = **kill + `--resume`** with the steer text as the first
resumed turn (coarser, loses the in-flight turn — [Spec 02 §4.5](./02-worker-abstraction.md)); or
(b) escalate to embedding the **Claude Agent SDK** for `interrupt()` fidelity (open-questions B1 —
explicitly a deferred upgrade path, not v1).

### ⚠️ Risk-B — Codex runs fully autonomously without hanging
**Why it matters:** [Spec 02 §5.1](./02-worker-abstraction.md) drives Codex with
`--sandbox workspace-write --ask-for-approval never`; if it ever blocks on a prompt the worker hangs
forever and the supervisor's only recourse is a wall-clock kill.

**Test** (already run in §1.5 as the auth check — formalize it):
```bash
mkdir -p /tmp/risk-b && cd /tmp/risk-b && git init -q
timeout 120 codex exec --json -C /tmp/risk-b \
  --sandbox workspace-write --ask-for-approval never --skip-git-repo-check \
  "Create out.txt with the text 'ok', then try to write /etc/x (which you can't) and continue anyway." \
  | jq -rc 'select(.type=="turn.completed" or .type=="turn.failed" or (.item.type=="command_execution"))'
# PASS if: process exits before the 120s timeout, out.txt exists, and the forbidden /etc write
#          surfaces as a FAILED command_execution (not a prompt that blocks).
```
**Fallback if it fails:** if `never` still hangs on some op, run Codex under
`--dangerously-bypass-approvals-and-sandbox` **inside a container** (Docker 29 present) and treat the
container as the sandbox ([codex-exec.md](../my-docs/codex-exec.md) §5.4) — pulls "Later: containers"
forward for Codex only.

### ⚠️ Risk-C — Codex network-off breaks `npm install` / `git push`
**Why it matters:** `workspace-write` has **network OFF by default** ([codex-exec.md](../my-docs/codex-exec.md)
§5.1); nodes needing deps or a push must opt in per-node ([Spec 02 §6.3](./02-worker-abstraction.md)).
We need to confirm the failure mode (clean failed-command vs. silent partial) and that opt-in works.

**Test:**
```bash
cd /tmp/risk-b
# (1) default: network OFF → expect a FAILED command_execution, not a hang
codex exec --json -C /tmp/risk-b --sandbox workspace-write --ask-for-approval never \
  "run: npm ping" | jq -rc 'select(.item.type=="command_execution")'
# (2) opt-in: network ON → expect success
codex exec --json -C /tmp/risk-b --sandbox workspace-write --ask-for-approval never \
  -c sandbox_workspace_write.network_access=true "run: npm ping" \
  | jq -rc 'select(.item.type=="command_execution")'
# PASS if (1) fails cleanly (exit_code!=0, status=failed) and (2) succeeds.
```
**Fallback if it fails:** if per-node opt-in is unreliable, do **dependency-bearing steps on the
host before/after** the Codex run (Beckett pre-installs deps in the worktree; Codex works offline),
or route network-needing nodes to Claude (no fs/network jail) in v1.

### ⚠️ Risk-D — Rate-limit detection (what a subscription cap looks like in each stream)
**Why it matters:** failover (Spec 00 §4; [Spec 01 §2.2](./01-architecture.md)) needs the driver to
**recognize** a throttle. The exact signal per harness is an open gap ([Spec 01 §2.2 note](./01-architecture.md),
[Spec 02 §11](./02-worker-abstraction.md)).

**Test (observational — capture a real cap):** run a heavy loop until the subscription throttles and
record the terminal frames:
```bash
# Claude: watch for the result subtype / api_error_status on a throttle
claude -p "…long task…" --output-format stream-json --verbose \
  | jq -rc 'select(.type=="result" or .type=="system") | {type, subtype, api_error_status, is_error}'
# Codex: watch for turn.failed / top-level error messages
codex exec --json "…long task…" | jq -rc 'select(.type=="turn.failed" or .type=="error")'
# Capture the literal strings/subtypes a cap produces → that's the detection heuristic the drivers encode.
```
**Expected handles to map:** Claude → a `result` with `is_error:true` + an `api_error_status` (e.g.
429) or a rate-limit `subtype`; Codex → `turn.failed`/`error` with a rate-limit `message`. **Fallback
if undetectable from the stream:** treat repeated `error_during_execution`/`turn.failed` within a
cooldown window as a throttle proxy and back off (Spec 01 §6); **v0 needs none of this** (Claude-only
→ queue+backoff), so this only gates v1 failover.

### ⚠️ Risk-E — Discord MESSAGE CONTENT is a privileged intent
**Why it matters:** without the **MESSAGE CONTENT INTENT** enabled (§1.6) the bot receives empty
`content` for `@beckett …` messages and can't read the task at all — the whole interface is dead.
It's privileged-gated (and requires verification once a bot is in 100+ servers — not a concern for
one private server).

**Test:** with `DISCORD_TOKEN` set and the intent enabled, run a 20-line discord.js listener that
logs `message.content` on `messageCreate`; post `@beckett hello` in the server.
```
PASS if message.content === "@beckett hello" (non-empty). FAIL (empty string) ⇒ intent not enabled.
```
**Fallback if it fails / can't be enabled:** use **slash commands** (`/beckett <task>`) which deliver
their args without the privileged intent, or DM-based intake — but this contradicts the *ambient,
mention-in-any-channel* canon (Spec 00 §4 Discord), so prefer fixing the intent toggle.

---

## 5. Testing strategy

Three layers; the middle one is the one that lets us iterate the loop **without burning the
subscription**.

### 5.1 Unit — drivers, telemetry parsing, scope hook
- **Telemetry normalization:** feed recorded raw JSONL lines (Claude `system/assistant/user/result`;
  Codex `thread/turn/item.*`) through the parser, assert the resulting `WorkerEvent` union + derived
  `WorkerSpend` counters ([Spec 02 §7](./02-worker-abstraction.md)). Include the known-nasty cases:
  dedup `assistant` by `message.id`; trailing events after `result`; unknown `item.type` → skip;
  Codex `cacheCreate:0`.
- **Scope hook (`scope-guard.ts`):** unit-test the deny/allow decision over a matrix of tool inputs
  (in-scope Edit, out-of-scope Edit, abs-path escape, Bash redirection) — pure stdin→stdout, no
  subprocess ([Spec 02 §8.2](./02-worker-abstraction.md)).
- **Config/`.env` loader:** schema validation rejects bad types loudly (Spec 01 §4).
- **Nudge line construction + ack matching:** the NDJSON `user` line shape and the `user_echo` match
  ([Spec 02 §4.4](./02-worker-abstraction.md)).

### 5.2 Integration — a fake/echo harness (loop testing without spend)
Build a **`fake-harness`** binary that speaks the *exact* stream-json / JSONL wire formats but is
scripted, not a model. It reads a scenario file and emits canned `system→assistant→tool_use→
tool_result→result` (Claude) or `thread.started→turn.started→item.*→turn.completed` (Codex) frames,
honoring stdin nudges (echo them back when `--replay-user-messages`-equivalent). Point the drivers at
it via `harness.claude.bin` / `harness.codex.bin` in a test `config.toml`.

This exercises the **whole loop** — spawn → tail → smoke-alarm → nudge → review → gate → deliver,
plus DAG/integrate and crash-recovery (resume) — deterministically, fast, and **at zero
subscription cost**. Scenario fixtures: happy path, no-progress (drift alarm), scope-violation
(hook deny), max-turns failure, mid-task nudge changes the canned branch, daemon-restart-mid-turn.

### 5.3 End-to-end — a canned real task (smoke, run sparingly)
A single committed fixture task (e.g. "add a pure function + its passing test to a scratch repo")
run against the **real** `claude`/`codex` on loom-desk, asserting the §3 v0 acceptance criteria.
Kept to one cheap task so it can run on each release without meaningful rate-limit pressure. This is
the canary that the real binaries still behave like the recorded fixtures (re-run after any
`claude`/`codex` version bump — see Risk-A/B/C/D).

---

## 6. Open questions / deferred — the consolidated ⚠️ rollup

The "needs a decision before/around the relevant build" list, swept from siblings + this doc. ⚠️ This
is **not exhaustive** — re-sweep every spec for `⚠️` before each milestone (`grep -rn "⚠️" specs/`);
Specs 05–11 don't exist yet and will add their own.

**Harness wire-format (gate v0/v1 drivers — verify on loom-desk):**
- Claude stream-json nudge actually lands at turn boundary + acks (**Risk-A**, §4). *(blocks v0)*
- Claude `--effort` flag existence; effort via `--model` tier until verified ([Spec 02 §7.1, §9.1](./02-worker-abstraction.md)).
- Claude `--append-system-prompt` / `--add-dir` / `--settings` real on 2.1.195 (`claude --help`) ([Spec 02 §11](./02-worker-abstraction.md)).
- Codex autonomous-no-hang (**Risk-B**) + network opt-in (**Risk-C**) (§4). *(blocks v1 Codex)*
- Codex `resume` id format / archived-session visibility on 0.142.3 ([Spec 02 §5.4](./02-worker-abstraction.md)).
- Codex `--output-schema` corruption when MCP active → validate ourselves ([Spec 02 §5.1, §6](./02-worker-abstraction.md)).
- Rate-limit detection signal per harness (**Risk-D**) ([Spec 01 §2.2](./01-architecture.md)). *(blocks v1 failover)*

**Architecture / ops:**
- `config.toml` **hot-reload scope** — which keys `beckett reload` honors vs. need restart; until
  decided, treat all config as boot-time ([Spec 01 §4 note](./01-architecture.md)).
- Socket **auth** beyond unix file perms once multiplayer/remote CLI lands ([Spec 01 §7 note](./01-architecture.md)).
- Bash write-leak inside the worktree (Claude) — heuristic hook now; containers are the real fix
  ([Spec 02 §8.4](./02-worker-abstraction.md)).
- Back up `~/.claude` + `~/.codex` (and `~/.beckett/.env`) — the zero-re-auth guarantee depends on
  it; where/how is undecided (this doc §1.4).

**Identity / agency (Spec 07, not yet written):**
- Email via **Gmail MCP vs. raw OAuth API** → fixes the exact `.env` key set (§1.7; open-questions F2).
- Discord MESSAGE CONTENT privileged intent (**Risk-E**, §4) — and slash-vs-NL control surface
  (open-questions E3).
- Standing **auto-merge** grant policy (default off; when to grant) (open-questions F3).
- Hard "always ask first" action classes (open-questions F4).

**Phasing / scope:**
- Is multiplayer v0-critical given the collaboration wedge, or fast-follow? (Canon = fast-follow;
  memory flags collaboration as *the* wedge — revisit; open-questions E4, K1.)
- Concurrency cap real ceiling on 8c/31GB (start 2 in v0, default 4 — Spec 01 §2.1; open-questions J2).
- Cross-provider review as default for critical nodes — later (open-questions H2/B4).

---

## 7. Summary

1. **Setup** = create non-root `beckett` user (root can't run `bypassPermissions`) → confirm bun →
   install + **authenticate `claude` and `codex` against Jason's subscriptions** (the key missing
   prereq; one-time device-flow login persists in `~/.claude`/`~/.codex` → back them up) → provision
   Discord bot / GitHub `beckett-bot` PAT / Gmail → populate `~/.beckett/{.env,config.toml,persona.md,memory/}`.
2. **Service** = a systemd **user** unit under `beckett` with `enable-linger`, `Restart=on-failure`,
   30s stop grace; recovery hook resumes workers (≤1 turn lost); the `beckett` CLI is a separate
   socket client (Spec 01 §5.3, §7).
3. **v0** proves steering: Discord → Opus 1-node plan → one Claude worker in a worktree → supervise +
   **a real mid-task nudge that changes behavior** → self-review → deliver. Build order: persistence
   → ClaudeDriver → worktree+hook → supervisor → minimal brain → Discord → CLI.
4. **v1** = Codex driver (failover) → multi-node DAG + integrate → fresh reviewer → GitHub/Gmail
   identity + handshakes → knowledge-graph memory → outcome logging, each with its own acceptance bar.
5. **Verify-first**, before building on them: (A) Claude turn-boundary nudge, (B) Codex
   autonomous-no-hang, (C) Codex network-off opt-in, (D) rate-limit detection, (E) Discord
   MessageContent intent — each with a copy-paste smoke test + a named fallback.
6. **Testing** = unit (telemetry/scope/config) + a **fake-harness** integration layer that runs the
   whole loop at zero subscription cost + one canned real e2e task as the post-version-bump canary.
</content>
</invoke>
