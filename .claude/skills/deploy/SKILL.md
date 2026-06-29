---
name: deploy
description: Use to throw a locally-running app/mockup up at <name>.0xbeckett.me via Beckett's Cloudflare tunnel, or to manage DNS on the 0xbeckett.me zone. Always go through `beckett dns` / `beckett deploy`; the token is injected for you.
---

# deploy

Beckett owns the `0xbeckett.me` zone and runs a Cloudflare **named tunnel** on the host. That
means you can take something running locally — a mockup, a prototype, a one-off page — and give
it a real URL at `<name>.0xbeckett.me` in one command. This is the muscle behind the proactive
"saw yall yapping, threw it up here" move (see [[proactive]]) and the artifact you hand over at
the end (see [[deliver]]).

## The one rule

**Never call raw `cloudflared` or the Cloudflare API directly.** The zone-scoped token is in
`~/.beckett/.env` and the `beckett dns` / `beckett deploy` CLIs inject it per-invocation. All
output is JSON on stdout.

## DNS — `beckett dns`

The zone token can only edit DNS on `0xbeckett.me`, so DNS is **FREE**: a record is a reversible
proposal you can delete. Short names expand to the apex (`x-tool` → `x-tool.0xbeckett.me`).

| Want to… | Run |
|---|---|
| List records | `beckett dns ls [--name <n>] [--type <T>]` |
| Add / update (idempotent) | `beckett dns add <name> --content <c> [--type CNAME] [--proxied\|--no-proxied] [--ttl N]` |
| Remove | `beckett dns rm <name> [--type <T>]` |

`add` is an upsert (re-running never errors). `proxied` defaults to true; pass `--no-proxied` for
a grey-cloud record (e.g. a TXT or a raw A record you don't want proxied).

## Deploy — `beckett deploy`

Maps `<name>.0xbeckett.me` → a local port through the tunnel, and adds the CNAME for you.

| Want to… | Run |
|---|---|
| Publish a local app | `beckett deploy <name> --port <p>` (or `--service http://localhost:<p>`) |
| List what's published | `beckett deploy ls` |
| Take it down | `beckett deploy rm <name>` |

`deploy` returns `{ url, hostname, service, tunnelId, reload }`. It's idempotent — re-running with
a new port just updates the rule. It edits the cloudflared ingress file and reloads the tunnel; if
auto-reload isn't wired (`reload.reloaded: false`), the JSON carries a `hint` with the manual
command — surface that, don't pretend it's live.

## The flow (mockup → URL → announce)

1. Get the thing running locally on a port (a worker builds it, or you do inline). Confirm it
   actually serves on `http://localhost:<p>`.
2. `beckett deploy <name> --port <p>` → grab the `url`.
3. **Announce the URL in voice.** Deploy is reversible and FREE (it's a proposal/mockup, not a
   production release) — but it IS an outward action, so say what you put up and where:
   *"saw yall going back and forth on the pricing page — threw a mockup up: https://pricing.0xbeckett.me. lmk if it's the wrong direction, easy to pull."*
4. Tearing down later is `beckett deploy rm <name>` (drops the ingress rule + the CNAME).

## Free vs. handshake

- **Free** (just do it, then say you did): everything here — `dns add/rm`, `deploy`, `deploy rm`.
  It's all reversible and within remit (a mockup at a subdomain, deletable in one command).
- Overhearing never lowers the gate: deploying a mockup off `[ambient …]` chatter is fine, but
  anything genuinely irreversible/outward (a real production cutover, money, account admin) still
  needs a direct go. A `.0xbeckett.me` mockup is not that.

## Notes & the one-time prereq

- If `beckett deploy` errors with **"CLOUDFLARE_TUNNEL_ID is not set"**, the named tunnel hasn't
  been created yet — that's a **one-time human setup**, not something you can self-serve. Say so
  plainly: the human runs `cloudflared tunnel login && cloudflared tunnel create beckett` on the
  host and adds `CLOUDFLARE_TUNNEL_ID=<id>` to `~/.beckett/.env`. Until then, `beckett dns` still
  works (DNS isn't blocked on the tunnel).
- If `beckett dns`/`deploy` errors with **"no CLOUDFLARE_API_TOKEN"** the credential just isn't in
  `~/.beckett/.env` — say so plainly; don't try to re-auth.
