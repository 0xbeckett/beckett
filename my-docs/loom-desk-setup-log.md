# loom-desk — Setup Log & Reality Corrections

> What actually happened standing Beckett up on `loom-desk`, and the places where reality diverged
> from the specs. Done 2026-06-27 by Claude over `ssh loom-desk` (landing as user `claude`, which has
> passwordless sudo). **These corrections must be folded back into Spec 02 (CodexDriver) and Spec 12.**

## What got done (verified)

| Step | Result |
|---|---|
| OS user `beckett` (uid 1001, non-root) | ✅ created; `loginctl enable-linger beckett` on |
| `/home/beckett/projects` (0750) | ✅ |
| `~/.beckett/{memory,events,logs}` (0700) + `.env` (0600) | ✅ |
| `~/.claude` + `~/.codex` (0700) | ✅ |
| git identity | ✅ `Beckett <beckett@placeholder.local>` ⚠️ **update email to Beckett's gmail later** |
| bun | ✅ system-wide `/usr/local/bin/bun` 1.3.13 (beckett sees it) |
| `claude` CLI | ✅ `~/.local/bin/claude` 2.1.195 (native installer) |
| `codex` CLI | ✅ `~/.bun/bin/codex` 0.142.3 via `bun install -g @openai/codex`, symlinked into `~/.local/bin` |
| claude auth | ✅ **copied** `/home/claude/.claude/.credentials.json` → beckett; `claude -p` returns without prompt |
| codex auth | ✅ **copied** `/home/claude/.codex/auth.json` → beckett; `codex login status` → "Logged in using ChatGPT" |
| codex autonomous sandbox run | ✅ after the userns sysctl fix (below) |

**Decision realized:** "fresh `beckett` user + copy creds" (Jason's call). The clawdbot stack under
`/home/claude` is untouched and still running. `/home/claude` is mode `750` so beckett cannot read it —
that's why beckett got its **own** binaries; only the cred files were copied (root read them).

### Passwordless sudo + docker (2026-06-27, Jason's call)

beckett gets **passwordless sudo** so it can manage its own tooling (install/update, manage its service)
— the agency goal, and parity with how `claude`/clawdbot already runs. Mirrors `claude` exactly:
`/etc/sudoers.d/beckett-nopasswd` → `beckett ALL=(ALL:ALL) NOPASSWD: ALL` (mode 0440); added to
`sudo` + `docker` groups. Verified `sudo -n whoami → root`, `docker ps → ok`.

- ✋ **Note (not a blocker):** the original premise was that bwrap needed sudo — it didn't. bubblewrap is
  unprivileged by design; the codex sandbox already worked as beckett with no sudo (the real fix was the
  userns sysctl). So sudo is granted for **tooling/agency**, not for the sandbox.
- ⚠️ **Accepted blast-radius tradeoff:** workers (`claude -p`/`codex exec`) run **as `beckett`**, so they
  inherit passwordless root. Untrusted input (email, external repos) flowing into a worker now has a path
  to root. This is consistent with clawdbot's existing model on a trusted personal box, and Jason owns
  the box. *Future mitigation if isolation tightens:* run untrusted workers under a separate
  no-sudo user, or scrub sudo from the worker process env. Tracked for the multiplayer/untrusted era.
- beckett remains a **non-root account** (uid 1001) — it just *can* escalate. So Claude's
  `bypassPermissions`-can't-run-as-root requirement still holds (workers run as beckett, not root).

## ✅ Confirmed: subscription creds are portable across OS users (same host)

Copying `~/.claude/.credentials.json` (471 B) and `~/.codex/auth.json` (4.4 KB) from `claude` → `beckett`
gives beckett **zero-re-auth** access to Jason's Claude + Codex subscriptions. No `ANTHROPIC_API_KEY` /
no OpenAI key needed. This validates the Spec 00 "zero re-auth" economics goal via copy, not device-flow.
→ **Back up these two files**; restoring them onto a rebuilt box restores auth.

## ⚠️ Spec corrections discovered (codex 0.142.3 on Ubuntu 24.04)

These invalidate parts of Spec 02 §CodexDriver and Spec 12 §1.5 as written:

1. **`codex exec` blocks on stdin even when the prompt is an argument.** Symptom over a non-TTY:
   `Reading additional input from stdin...` → hangs forever (we saw exit 124 timeout). **Fix: the
   CodexDriver MUST redirect stdin from `/dev/null`** (or spawn with stdin = ignore). Every codex
   invocation: `codex exec ... </dev/null`.

2. **`--ask-for-approval` is NOT a `codex exec` flag in 0.142.3** — it's a *top-level* `codex` flag.
   `codex exec` only takes `--sandbox`. So the spec's
   `codex exec --sandbox workspace-write --ask-for-approval never` **errors** (`unexpected argument`).
   - Autonomous + sandboxed (the canon choice): `codex exec --sandbox workspace-write --skip-git-repo-check </dev/null`
     — exec is inherently non-interactive; it does not prompt.
   - Full bypass (no sandbox, rely on OS user + worktree): `codex exec --dangerously-bypass-approvals-and-sandbox`.

3. **Ubuntu 24.04 blocks codex's bubblewrap sandbox by default.** Symptom:
   `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Cause: `kernel.apparmor_restrict_
   unprivileged_userns=1` (24.04 default). **Fix applied + persisted:**
   `/etc/sysctl.d/99-beckett-userns.conf` → `kernel.apparmor_restrict_unprivileged_userns=0`. After
   this, `--sandbox workspace-write` works. (Alternative if you don't want to relax userns:
   run codex with `--dangerously-bypass-approvals-and-sandbox` and lean on the `beckett` user + worktree
   for isolation — consistent with how we run claude under `bypassPermissions`.)

4. **PATH:** Ubuntu's default `~/.profile` adds `~/.local/bin` but not `~/.bun/bin`. claude resolved on
   login shells, codex didn't until symlinked into `~/.local/bin`. The daemon should not rely on login
   PATH — prefer absolute paths or an explicit PATH in the systemd unit (Spec 01/12).

## 🟢 Risk-A VERIFIED — mid-task nudge works (2026-06-27)

The load-bearing steering assumption is **confirmed** on `claude 2.1.195` via a real bun harness
(streaming input). Test: slow count 1→12 (one `bash -c 'echo N; sleep 4'` per turn), nudge injected at
t=12s telling it to stop + write a sentinel.

**Result:** `log.txt = [1, 2, NUDGE-RECEIVED]` — counted only to 2/12, then steered. Timeline: nudge sent
12.0s → echoed back (replay) 15.0s → claude finished its in-flight tool (wrote `2`), then "Stopping the
count now as instructed" → wrote sentinel 21.7s → `result/success turns=4 cost=$0.09`.

Confirmed facts for the ClaudeDriver (Spec 02/03):
- `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
  --permission-mode bypassPermissions --model sonnet` works headless as beckett.
- Injected `{"type":"user","message":{"role":"user","content":"..."}}` NDJSON lines are accepted mid-run.
- **Nudges land at the next TURN boundary, not mid-tool** — the in-flight `sleep 4` completed (wrote `2`)
  before the nudge applied. Exactly the context-preserving behavior the spec wants. ✅
- `--replay-user-messages` echoes the nudge back on stdout (`type:"user"`) → clean ack/ingestion signal.
- `result` carries `total_cost_usd`, `num_turns`, `is_error`, `session_id` (cost is informational only).
- ⚠️ The stream has **more `system` subtypes than init/result**: saw `system/thinking_tokens`,
  `system/task_started`, `system/task_notification`. The telemetry parser must tolerate unknown system
  subtypes (don't assume the schema; switch on what you know, ignore the rest).
- ⚠️ `--model sonnet` resolved to **`claude-sonnet-4-6`** on this box (not 4.5) — update the model id in
  the Spec 06 routing table to match what the alias actually resolves to, or pin full ids.

## Done since: Discord creds

- `~/.beckett/.env` populated (0600) with `DISCORD_TOKEN`, `DISCORD_HOME_SERVER_ID`
  (`1446046120433418302` — telemetry/home server), `DISCORD_OWNER_ID` (`1151230208783945818`). GitHub +
  Gmail keys still blank. ⚠️ The bot token was shared in plaintext chat — rotate it if that transcript
  is ever exposed.

## Still TODO (needs Jason / not yet done)

- **🔑 Identity provisioning** (Spec 12 §1.6, interactive): **Discord** — enable **Message Content**
  intent in the dev portal + invite the bot to the home server (token already stored). **GitHub** account
  + PAT (or App — see decision pending) + collaborator add. **Gmail** account + OAuth. Then fill `.env`
  and set git email.
- `config.toml` seed, systemd user service — defer until the daemon code exists.
- Decide whether to keep codex's bwrap sandbox (userns flipped) or bypass it (correction #3 alt).
