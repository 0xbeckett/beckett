# pi ⇄ anthropic: routing + image-forwarding probe (#121)

The evidence behind making `pi` the default harness and reaching the Claude models through pi's
`anthropic` provider. Re-run it any time pi or the provider catalog moves:

```sh
bun scripts/ops/pi-anthropic-probe.ts            # both probes, claude-opus-5
bun scripts/ops/pi-anthropic-probe.ts --json     # machine-readable report
bun scripts/ops/pi-anthropic-probe.ts --model claude-fable-5 --only images
```

It needs `pi` on PATH, ImageMagick's `convert`, and a live Claude login (`ANTHROPIC_API_KEY`, else
the Claude Code login at `~/.claude/.credentials.json`). Exit 0 ⇒ everything passed.

## What it checks, and why each one is a real question

1. **Routing.** A cast of `{"harness":"pi","provider":"anthropic","model":"claude-opus-5"}` spawned
   through the REAL `PiDriver` — production argv, `--mode json` parsing, session handshake,
   done-signal — must come back with a real completion. The probe subclasses the driver for exactly
   one reason: the child env (see the auth gap below).
2. **Eyes.** pi only keeps Opus's vision if it forwards IMAGE content to the model. Two distinct
   code paths are probed: an `@file.png` attachment, and the agent's own `read` tool on a PNG (the
   path a worker actually takes after a screenshot). The image is rendered at run time with a
   phrase that exists ONLY as pixels — never in the filename, metadata, or bytes — so a correct
   answer cannot be scraped.

## Findings (2026-07-29, pi 0.82.1)

**pi forwards image content to Opus. Both paths. No carve-out is needed.**

| Probe | Result | Evidence |
| --- | --- | --- |
| Routing (real `PiDriver`) | PASS | `finish=success`, echoed the run's random marker; every assistant frame carries `"model":"claude-opus-5"` |
| Image via `@file.png` (`--no-tools`) | PASS | ground truth `MULBERRY 6646` / circle / blue+orange → answer `MULBERRY 6646`, `Circle`, `Blue and orange` |
| Image via the agent's `read` tool | PASS | ground truth `HALCYON 5928` / square → answer `HALCYON 5928`, `Square`, `Blue and orange` |

The concrete shape of the read-tool result (this is where an image would be dropped if pi stubbed
it out as text) — pi returns a real image content block, base64 PNG payload intact:

```json
[{"type": "text", "text": "Read image file [image/png]"},
 {"type": "image", "data": "<base64 25000 chars>"}]
```

Corroborating, pi's own provider catalog declares the modality per model
(`@earendil-works/pi-ai/dist/providers/data/anthropic.json`):

```json
{"id": "claude-opus-5", "api": "anthropic-messages", "provider": "anthropic",
 "input": ["text", "image"], "contextWindow": 1000000}
```

The `openai-codex` catalog says the same for `gpt-5.6-terra` / `gpt-5.6-luna`, so vision is not
what distinguishes the two backends.

Caveat worth knowing: the model's SELF-report is unreliable — asked what it was, the Opus 5 run
answered "Claude Sonnet 4.5". The authoritative signal is pi's own frames (`message_end.message.model`)
and the `--model` argv, both `claude-opus-5`. Don't grade routing on a model's self-description.

## The gap this probe exposes: the worker child has no anthropic credential

pi's `anthropic` provider authenticates from `~/.pi/agent/auth.json` or `ANTHROPIC_API_KEY`. The
box currently has neither for that provider:

- `~/.pi/agent/auth.json` holds `openai-codex` only;
- `src/env.ts#childEnv` strips every `ANTHROPIC_*` var from every harness child (subscription-auth-only
  rule), so a dispatched pi worker cannot inherit one either;
- the `anthropic` entry in the jingle vault is a Claude Code OAuth token that is now **revoked**
  (`401 … "OAuth access token has been revoked"`), despite #121 describing it as verified.

Effect today: an un-cast ticket spawns `pi --provider anthropic`; pi emits its `session` frame,
prints `No API key found for anthropic.` on **stderr** and exits. The driver's stderr tail feeds
`classifyHarnessFailure` (`/no api key/` ⇒ `auth`), so the dispatcher substitutes a healthy harness
and comments on the ticket rather than wedging it. Loud and self-healing — but the flip stays inert
until auth is wired.

The durable fix is a one-time login, not an env-var hole — pi's docs (`docs/providers.md` in the pi
package) cover both:

- `pi` → `/login` → Anthropic → Claude Pro/Max subscription auth, stored in `~/.pi/agent/auth.json`
  and auto-refreshed; or
- an `auth.json` entry whose key is a command, which can pull straight from the vault without ever
  printing the secret: `{"anthropic": {"type": "api_key", "key": "!jingle …"}}`.

**Cost note for whoever pulls the switch:** pi's provider docs state that third-party harness usage
on a Claude Pro/Max account draws from *extra usage* — billed per token — rather than against the
plan's limits. Routing every default stage through pi + `anthropic` therefore changes the billing
shape, not just the process tree.
