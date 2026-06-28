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

## Still TODO (needs Jason / not yet done)

- **🔑 Identity provisioning** (Spec 12 §1.6, interactive): Beckett's own **Discord bot** (token +
  enable **Message Content** intent), **GitHub** account + fine-grained PAT + collaborator add, **Gmail**
  account + OAuth. Then populate `~/.beckett/.env` and fix git email.
- **⚠️ Risk-A NOT yet verified** (the big v0 gate): does `claude -p --input-format stream-json` actually
  deliver a mid-task nudge at the next turn boundary on 2.1.195? This is the load-bearing steering
  assumption — smoke-test before building the ClaudeDriver.
- `config.toml` seed, systemd user service — defer until the daemon code exists.
- Decide whether to keep codex's bwrap sandbox (userns flipped) or bypass it (correction #3 alt).
