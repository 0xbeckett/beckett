# OPS-56 — Fixing the pi harness (`PiDriver: process exited (code 1) before session line`)

## Symptom

Every ticket cast to the `pi` harness died at dispatch with:

```
Could not start the implement worker: PiDriver: process exited (code 1) before session line. Leaving for a human.
```

The child `pi` process exited before it printed its `session` handshake line, so `spawn()` —
which blocks waiting for that line — only ever saw the process die. No work happened; the ticket
went silent and fell back to `claude`.

## Root cause

Two distinct failure modes, both now fixed in `src/drivers/pi.ts`.

### 1. Version/protocol drift on the session flag → "exited before session line"

The driver minted a session id and passed **`--session-id <uuid>`** on the first launch. pi's
session CLI has drifted repeatedly:

- The driver was first written against a pi build with `--session-id` (create-if-missing).
- pi was then rolled back to a `0.72.x` build that has **no `--session-id` flag** — it resumes
  only an *existing* session via `--session <id|path>`.
- So every fresh dispatch ran `pi … --session-id <uuid> …`, pi rejected it with
  `Error: Unknown option: --session-id`, and the child exited **code 1 before the `session`
  line**. That is exactly the reported outage.

`pi 0.80.3` (currently installed) restored `--session-id`, but depending on it is a landmine: the
next rollback re-breaks every dispatch.

**Fix — version-agnostic sessions.** The driver **never** passes `--session-id`. On the first
launch it passes no session flag at all → pi mints and persists its **own** id, which we capture
from the `session` line as the source of truth. On resume we replay it via **`--session <id>`**.
`--session` exists in every pi build; `--session-id` does not — so a version rollback can never
again crash the child before its handshake. `src/worker/manager.ts` was updated so a pi **resume**
passes the captured id back through `spec.sessionId`.

### 2. Silent provider death → a masked, empty "success"

When the provider is dead (quota exhausted / auth expired / provider down), pi still emits a clean
`session` line, then an assistant turn that ends with `stopReason:"error"` + an `errorMessage`
(e.g. `Codex error: The usage limit has been reached`), then a normal `agent_end`, and exits `0`.
Treating `agent_end` as unconditional success **masks a dead provider as a successful empty
worker** — the ticket "completes" with zero output.

**Fix — loud provider errors.** The driver tracks the last assistant turn's provider error
(`providerErrorOf`) and, on `agent_end`, emits `finished status:"error"` (subtype
`error_provider`) with the cause surfaced, instead of a masked success.

## Hardening: a fast preflight + a clear startup failure message

- **`piPreflight(config)`** (`src/drivers/pi.ts`) runs at **every dispatch** before launching the
  worker. Offline, no network: (1) a modern node (≥20) resolves on the child PATH; (2) `pi
  --version` runs; (3) `pi --help` still advertises **every flag the driver emits** — this catches
  the exact CLI/protocol drift above **without** depending on `--session-id`; (4) a pi login
  exists at `~/.pi/agent/auth.json`. A failing preflight throws a clear, itemized error so a
  broken pi surfaces **loudly and immediately** instead of silently killing a ticket.
- **Optional live probe** (`harness.pi.preflight_live_probe`, or `beckett doctor pi`): runs one
  cheap real turn and fails if pi never emits its session line, or if the provider turn errors —
  catching a *started-but-dead* harness the offline checks can't see.
- **Startup failure message.** If the child still dies before the session line, the rejection folds
  in the captured **stderr tail** (e.g. `Error: Unknown option: --session-id`) plus the likely
  causes, instead of the opaque bare "exited before session line".
- **`beckett doctor`** shows a `pi harness` line (offline). **`beckett doctor pi`** adds the live
  provider probe.

## Current environmental state (credential, not code)

As of this fix, the `openai-codex` subscription login (`~/.pi/agent/auth.json`) is **quota
exhausted** — every `gpt-5.5` turn returns `Codex error: The usage limit has been reached`, and it
is the only provider with a pi login. The code fix is complete and proven end-to-end against the
real `pi 0.80.3` binary (see below): dispatch clears the session handshake and runs to a terminal
state. A **green model answer is blocked only by the exhausted quota** — refill/rotate the pi
login to restore successful turns. The preflight + loud-failure changes mean this now surfaces
immediately (`beckett doctor pi`, or a loud `error_provider` finish) instead of silently killing
tickets.

## Verification

- Unit tests: `bun test src/drivers/pi.test.ts` — 13 tests covering the version-agnostic argv
  invariant (never `--session-id`), the loud-provider-error path, NDJSON normalization, tolerant
  parsing, and the pure probe/version helpers.
- Live end-to-end: `bun test/pi-e2e-verify.ts` — drives the **real** `PiDriver` against the
  **real** `pi` binary. Proves: offline preflight PASS; the live probe catches the dead provider
  and would refuse dispatch loudly; and a real spawn **gets past the session line** (captured
  `sessionId`) and runs to a terminal `finished` event — i.e. the original "exited before session
  line" symptom is gone. With the quota exhausted, the terminal state is a loud `error_provider`
  (not a masked success, not the opaque original error).
