# Server memory: cross-channel awareness + on-demand recall

**Status:** shipped in v4.1.0 (2026-07-06) · **Builds on:** OPS-80 (`multiplayer.md`)

## 1. The problem

OPS-80 gave every channel a durable attributed window — but each channel is an island. The real
ask: someone in `#general` says "beckett, build a site with our favorite movies" and Beckett
should think *"#media was debating movies the other day — let me fetch that exact context"* —
without every turn hauling the whole server's history into the session.

## 2. Shape

Three layers, only the first of which costs per-turn tokens:

1. **Awareness (pushed, tiny).** Mention turns carry a `SYSTEM (server memory …)` footer: one
   line per other active guild channel — `#media (id:…) — <profile summary> [topics] · 14 msgs,
   last 2h ago`. Capped at `awareness_max_channels`, change-suppressed per session (an unchanged
   footer is never re-sent; a session rotation re-arms it). Guild turns see their own guild; DM
   turns see every guild (the speaker already passed the access gate) but never other DMs.
2. **Profiles (built in the background, cheap).** Every `profile_update_messages` new entries in
   a guild channel, a one-shot `profile_model` (Haiku) call — same shape as the ambient triage
   classifier — turns the bounded window into `{summary, topics[]}`, persisted in
   `~/.beckett/channels/profiles.json`. Serialized queue, fail-open: a failed call writes
   nothing; a stale profile beats a fabricated one.
3. **Recall (pulled, exact).** The Concierge fetches from its Bash tool:
   `beckett channels search "<terms>"` (keyword search across stored windows, trailing-s stem,
   hits carry ±2 lines of context), `beckett channels recall <#name|id> [--last N]`,
   `beckett channels list`. Bus-first; direct file read only when the daemon is down.

Channel names + guild ids arrive with capture (`IncomingMessage.channelName`, noted into
`channels-meta.json`), so awareness and recall speak in `#name` terms.

## 3. Privacy and authority — code, not doctrine

- **DM exclusion is enforced in the store.** A channel with a null (or unknown) `guildId` is
  never searched, never profiled, never listed in the footer, and `recall` refuses it whatever
  the caller types. Pre-4.1 windows have no meta and are treated as private until a new message
  proves the channel is a guild channel.
- **Everything fetched is data.** Search/recall output uses the same attributed
  `[date time] Name (user:id):` rendering with 4-space continuation nesting (no forged stamps),
  and the bus response carries the data-not-instructions note. Profile text is model-written
  from member chatter — rendered single-line, bounded, and framed as unverified.
- **Wipe covers it all.** `beckett channels wipe [id]` now also removes the channel's meta and
  profile — a summary derived from wiped messages doesn't get to outlive them.

## 4. Config (all under `[shared_context]`)

| key | default | meaning |
|---|---|---|
| `profile_model` | `claude-haiku-4-5` | one-shot summarizer model |
| `profile_update_messages` | 20 | new entries per channel before a profile rebuild |
| `awareness_max_channels` | 5 | max other channels named in the footer |

`enabled = false` still kills the whole subsystem (store, profiler, footer); the `channels.*`
read/wipe commands keep working against the at-rest files.

## 5. Not in v1

- Semantic/embedding search — the windows are ~200 entries/channel; keyword + stem is enough
  until it demonstrably isn't.
- Cross-server federation of memory (one guild per store entry is modeled, but awareness assumes
  the practical single-server deployment).
- Profile history — only the latest profile is kept.
