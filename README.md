# Beckett

**A Discord-native AI engineer that lives in your server, talks like a person, and ships real code.**

You @mention Beckett in Discord. It chats back in its own voice, decides how much effort your
request actually deserves, and when there's real work to do it files a ticket and a fleet of
coding agents builds it — opening PRs, deploying sites, generating images — while it keeps you
posted in the channel. One long-lived agent is the face; a queue and a pool of workers are the
hands.

This repo is the whole thing: the Discord front-of-house, the ticket queue, the worker
dispatcher, and the ops to run it. It's built to be **forked** — rename it, give it a new
personality, point it at your own Discord, and you have your own Beckett.

---

## Table of contents

- [What Beckett is](#what-beckett-is)
- [Fork it and make it yours](#fork-it-and-make-it-yours)
- [Architecture in one paragraph](#architecture-in-one-paragraph)
- [Run your own Beckett](#run-your-own-beckett)
- [Configuration & secrets](#configuration--secrets)
- [Federation — many Becketts talking to each other](#federation--many-becketts-talking-to-each-other)
- [Everyday commands](#everyday-commands)
- [Deploying changes](#deploying-changes)
- [Repo layout](#repo-layout)
- [Contributing / working in the code](#contributing--working-in-the-code)

---

## What Beckett is

Beckett has two seats:

- **The Concierge** — a long-lived `claude -p` (Opus) agent that owns Discord. It's the only
  thing that talks to people. It chats, sizes effort, and for real work **files a ticket** into
  [Plane](https://plane.so) (self-hosted). It never writes the code itself.
- **The fleet** — a poller watches the Plane queue; a **dispatcher** turns ticket state changes
  into work. A ticket moving to *In Progress* spawns a coding agent in an isolated git worktree;
  *In Review* spawns a reviewer; a new comment steers the live worker; done advances the ticket
  and posts a summary back to the channel.

The workers aren't all the same model. Each ticket is **cast** per stage — implement with one
model/effort, review with another — so cheap work stays cheap and hard work gets the firepower.
Claude is the backbone; codex and pi can be enabled as alternates.

### INT intensive tickets

Normal **OPS** tickets keep the short implementation flow. **INT** is a separate Plane board for
multi-stage work: **Backlog → Design → Review (Design) → In Progress → Review → Done**. `Design`,
`In Progress`, and `Review` are live worker states. **Review (Design) is parked**: the design worker
commits `docs/design/int-N.md`, an independent lightweight model checks it against the ticket, and
Beckett sends an automated update to the filing channel asking the owner to greenlight it. Approval
is just `beckett ticket state INT-N in_progress --board int`; implementation and review resume on
the same ticket with its `design` / `implement` / `review` casts intact — no re-filing.

File one with `beckett ticket create --intensive --channel <discord-channel-id> --title "…"` (or
`--board int`); INT defaults to the live `Design` state. Use the seeded `--preset intensive` to
select the default three-stage cast.

Beckett also has hands beyond code: it can generate images, deploy throwaway mockups to
`<name>.your-domain`, manage its own public site, remember people and projects across
conversations, and self-provision tools it doesn't have yet.

## Fork it and make it yours

Beckett's **personality is a single editable file**, separate from how it works:

- **`persona.md`** (`~/.beckett/persona.md` on the box) is the voice — tone, slang, attitude.
  It's Beckett's to rewrite: ask it to "change your vibe" in Discord and it edits this file and
  reloads itself live, no redeploy. On a fresh install it's seeded from `DEFAULT_PERSONA` in
  [`src/concierge/index.ts`](src/concierge/index.ts) (the stock Beckett is a cocky 19-year-old
  dev who texts in lowercase).
- **`src/concierge/concierge.md`** is the *doctrine* — how it works (sizing effort, filing
  tickets, surfacing progress). This is fixed; don't put personality here.

So "a bunch of Becketts, each with their own flair" is exactly the intended shape: fork the repo,
rewrite the persona, register a new Discord bot, and run it. The engineering brain is shared; the
character is yours.

## Architecture in one paragraph

> A **Concierge** (a long-lived `claude -p` Opus agent) owns Discord. It chats in Beckett's
> voice, decides effort, and for real work FILES A TICKET into Plane with per-stage **casting**.
> It never does the work itself. The **shell** polls the Plane REST API every `poll_secs` and
> emits events. A **Dispatcher** consumes them: a ticket entering *in_progress* spawns the
> implement harness as a worker (git worktree, under a scope-guard); *in_review* spawns the
> review harness; a new comment on an in-flight ticket is injected as a steering nudge to the
> live worker; *cancelled* aborts it; when a worker finishes, the dispatcher advances the ticket
> and posts a summary comment.

The authoritative build contract is [`docs/V3.md`](docs/V3.md). Specs live in
[`specs/`](specs/) (older v2 design is archived under `specs/_legacy-v2/` — historical only).

## Run your own Beckett

Beckett runs as a set of **systemd user services** on a Linux box (the reference host is a
machine named `loom-desk`). The full, runnable host setup is [`deploy/host-setup.md`](deploy/host-setup.md);
the short version:

1. **A Linux user with lingering enabled** (so user units run without a login session) and
   passwordless sudo (Beckett self-provisions tools):
   ```bash
   sudo useradd -m -s /bin/bash beckett
   sudo loginctl enable-linger beckett
   ```
2. **Toolchain** (as that user): [`bun`](https://bun.sh), node ≥ 20, the `claude` CLI, optionally
   `codex` / `pi`, plus `gh`, `rg`/`fd`/`jq`/`yq`, and `cloudflared`.
3. **A self-hosted Plane** for the ticket queue, and a **Discord bot** (with the Message Content
   privileged intent enabled).
4. **Clone + install:**
   ```bash
   git clone https://github.com/<you>/beckett.git ~/beckett
   cd ~/beckett && bun install --frozen-lockfile
   ./deploy/install.sh    # links deploy/systemd/* and enables beckett-v4 + heartbeat
   ```

`deploy/install.sh` is idempotent — it symlinks every unit in `deploy/systemd/`, retires stale
units, and does `systemctl --user enable --now beckett-v4.service`. Re-run it any time the unit
files change.

**Auth is subscription-only by design.** Beckett drives `claude` / `codex` / `pi` through their
own `~/.claude` / `~/.codex` / `~/.pi` logins — it deliberately refuses `ANTHROPIC_*` / `OPENAI_*`
API keys from `.env` (see [`src/env.ts`](src/env.ts)). Log those CLIs in as their user once.

## Configuration & secrets

Two files, both under `~/.beckett/` on the box (never in git):

- **`.env`** — secrets: `DISCORD_TOKEN`, `PLANE_API_TOKEN`, `GITHUB_PAT`,
  `DISCORD_ALERT_WEBHOOK_URL`, … The committed `.env.example` is the full inventory with per-key
  mint/scope notes.
- **`config.toml`** — runtime overrides. Validation is **strict**: every key is defaulted, so a
  near-empty file boots, but an unknown or out-of-range value is a loud refuse-to-start.
  [`deploy/config.toml.example`](deploy/config.toml.example) is every key at its default (it's
  generated from the live schema by `beckett config print-default`, so it can't drift).

Secrets are backed up **age-encrypted to a separate machine** — see `deploy/host-setup.md`. This
repo is public; nothing sensitive belongs in it.

## Federation — many Becketts talking to each other

Discord bots ignore each other by default, and Beckett drops *every* bot message so it never
reacts to its own posts and loops. A sibling Beckett becomes a trusted **peer** only when the
**owner** adds it — and then its messages reach the Concierge like anyone else's.

**Add a peer live, from Discord (no restart):**

```
you (owner):  @beckett add @ABot to my peers
beckett:      done — ABot's on the list. their side has to add me back for a two-way though.
```

Beckett resolves the @mention to a bot id and appends it to `~/.beckett/peers.txt` — a living
file exactly like the `access.txt` whitelist. `remove @ABot` and `who are my peers?` work too.
Each owner governs only their *own* Beckett's list, so a real conversation only happens once
**both** owners have added the other — mutual consent is structural, not a handshake.

Guardrails:

- **Owner-only.** A non-owner asking to add a peer is declined (`concierge.md` → *Talking to
  another Beckett*).
- **Your own id is always ignored** even if listed (self-loop guard); unlisted bots stay dropped.
- **Talk ≠ authority.** Being a peer lets a bot *message* you; it does **not** let it put work on
  your fleet — that stays owner-gated.
- A per-channel burst cap (`federation.peer_burst_per_min`, default 5) is a hard runaway backstop
  on top of the Concierge's own "don't start a loop" judgment.

`config.toml` can also seed a permanent baseline for whoever provisions the box:

```toml
[federation]
peers = ["123456789012345678"]   # baseline trusted peer ids (unioned with the live peers.txt)
peer_burst_per_min = 5
```

Ships **inert** — no peers configured means byte-for-byte today's "ignore all bots" behavior.
This is the trust primitive; the richer protocol on top (discovery, delegation, real loop
semantics) is an open design question left for a follow-up.

## Everyday commands

Run on the box as the beckett user (`bun src/cli/beckett.ts <...>`, usually aliased to `beckett`):

| Command | What it does |
|---|---|
| `beckett status --pretty` | What the live daemon is doing right now (workers, poller, Discord, concierge). |
| `beckett doctor` | Would Beckett work right now? Binaries, live token probes, env drift, leaked workers. Non-zero exit on any failure. |
| `beckett discord reply --channel <id> "…"` | Post a message as Beckett into a channel. A reply-ack timeout reports `mayHaveSent`, not a retryable failure; do not resend it automatically. Set `BECKETT_DISCORD_REPLY_ACK_TIMEOUT_MS` to tune the 75s acknowledgement budget. |
| `beckett reload` | Re-read `persona.md` and re-ground on a fresh session (live voice retune). |
| `beckett ticket …` / `beckett plan …` | File a ticket / a multi-ticket plan into Plane. |
| `beckett eval "author/model" [--short|--full]` | Run the curated coding prompt suite against any OpenRouter model and save a readable report. |
| `beckett memory recall "…"` / `remember …` | Query / write Beckett's cross-conversation knowledge. |
| `beckett identity set --user <id> …` | Teach Beckett who someone is and how to address them. |

(Beckett itself uses these via skills; you rarely need them by hand.)

## Deploying changes

Prod (`~/beckett` on the box) only ever runs `origin/main` and is **never edited by hand**. From
your dev machine, after a PR merges to main:

```bash
./deploy/deploy-prod.sh
```

It fetches, fast-forward-pulls, `bun install`, typechecks (never restarts onto broken code),
restarts `beckett-v4.service`, reads back health, and tags the deployed version. Crash alerts and
a weekly heartbeat post to the Discord alert channel.

## Repo layout

```
src/
  concierge/    the Discord-facing Opus agent — concierge.md (doctrine) + persona seed
  discord/      gateway, message chunking, access control, federation (peer bots)
  dispatch/     turns ticket-state changes into worker/reviewer spawns
  plane/        Plane REST client + poller
  worker/       the coding-agent harness (worktree, scope-guard, casting)
  drivers/      claude / codex / pi process drivers
  memory/       cross-conversation knowledge graph
  rpc/          Discord Rich Presence daemon (separate service)
  cli/          the `beckett` CLI (one entrypoint, beckett.ts)
  config.ts     strict, fully-defaulted config schema
deploy/         systemd units, install.sh, deploy-prod.sh, host-setup.md
docs/           V3.md (the build contract) + audits
specs/          design specs (v2 archived under _legacy-v2/)
```

## Contributing / working in the code

- **Runtime:** [Bun](https://bun.sh) + TypeScript. No build step for dev.
- **Before you commit:**
  ```bash
  bun x tsc --noEmit    # typecheck — must be clean
  bun test              # the suite
  ```
- **Classifier prompt changes:** run `bun run eval:triage --provider=claude --runs=3` or use
  `--provider=cerebras --model=gemma-4-31b` with `CEREBRAS_API_KEY` set. The labeled contrast suite
  reports repeated-run exact accuracy, respond precision/recall, addressee and kind accuracy,
  classifier failures, p50/p95 latency, and a quality gate rather than requiring a stochastic model
  to reproduce every label in every run.
- **Style:** match the neighbors. This codebase leans on dense, explanatory comments that say
  *why*, strict config validation, and pure/testable helpers split out from I/O. Read
  [`docs/V3.md`](docs/V3.md) §1 for the non-negotiable conventions.
- **New to the repo?** There's a paste-into-your-AI-agent onboarding prompt at
  [`docs/onboarding-prompt.md`](docs/onboarding-prompt.md) that gets a coding agent up to speed
  fast.

---

No license is declared yet — if you want to fork and redistribute, ask first. And give yours a name.
