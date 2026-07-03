# Proposal: Ambient Interjection — Beckett joins the conversation without being pinged

**Status:** proposal (not yet ticketed)
**Author:** drafted with Claude Code, grounded in the current `main` (v3.6.x, post-#90 worktrees)
**Goal:** Beckett hears un-mentioned channel chatter, and when someone says something like
*"man, I wish this thing had CSV export"*, Beckett offers — *"I can kick that off for you if
you want"* — then proceeds on a "sure" (or, where explicitly enabled, on silence). This turns
Beckett from a summonable tool into a coworker who's present in the room.

---

## 1. Where we are today (the good news)

The plumbing is ~90% built. Specifically:

- **The gateway already receives every non-bot message.** `DiscordJsGateway.wireListeners`
  (`src/discord/gateway.ts:265-292`) normalizes ALL guild messages into `IncomingMessage`
  (with `mentionsBot`, `repliedToId`, attachments, display names) and forwards them to the
  Concierge. Nothing new is needed at the Discord layer.
- **The entire mention gate is one line:** `if (!m.mentionsBot) return;` at
  `src/concierge/index.ts:1392`. Ambient chatter is dropped there, on purpose, today.
- **The session model already fits.** `ConciergeSession` is a persistent single-flight Opus
  session with a real priority queue (`src/concierge/index.ts:179-380`) — person mentions jump
  the queue, updates wait. Ambient turns slot in as a third, lowest-priority class.
- **Replies, chunking, human cadence** (OPS-62, `src/discord/chunk.ts`), the reply-claim
  system (`repliedViaCli` suppressing double-posts), progress threads, and the ticket filing
  path (`beckett ticket create --channel …`) all work unchanged for ambient-initiated work.
- **Access control still gates everything.** `accessLevelFor` (`src/concierge/index.ts:1537`)
  runs before the model ever sees a message. Ambient listening does not widen who Beckett
  listens to — outsiders stay invisible.

So the feature is NOT "make Beckett hear messages" — it already does. The feature is the
**judgment layer**: deciding *when* an un-addressed message deserves a voice, doing that
cheaply, and managing the offer → consent → work lifecycle without being a nuisance.

## 2. Design principles (what keeps this from being annoying)

1. **Silence is the default.** An interjection is rare and earns its place. The bar:
   Beckett only speaks when it can *offer concrete work or a concrete answer*, not to chat.
2. **Cheap triage before expensive judgment.** Every ambient message must NOT cost an Opus
   turn. A Haiku one-shot classifier (~$0.0002/message) decides whether the main session even
   sees it. The Opus session only wakes for genuine candidates, and can still decline.
3. **Never preempt a human.** Ambient turns are lowest priority in the queue; a real @mention
   always jumps ahead. No typing indicator, no fast-ack for ambient turns — Beckett doesn't
   telegraph that it's "considering" speaking.
4. **Consent is a conversation, not a regex.** We don't code-match "sure/yes/ok". A pending
   offer makes the next messages in that channel flow to the model with the offer as context;
   the model judges whether "sure" was aimed at it.
5. **Proceed-on-silence is opt-in, per channel, owner-gated.** Powerful and creepy if
   defaulted on. Ships off.
6. **Hard rate limits in code, not vibes.** Cooldowns and hourly caps are enforced before the
   model runs, so a bad doctrine day can't flood a channel.
7. **Killable in one command.** `beckett proactivity off` silences everything instantly.

## 3. Architecture

```
Discord msg (no @mention, allowed user)
  │
  ▼
[A] Code gate ──────── channel mode=off? cooldown live? hourly cap hit? → drop (log only)
  │
  ▼
[B] Burst buffer ───── per-channel ring buffer (last ~15 msgs) + debounce:
  │                    wait for ~20s of channel quiet so we react to the
  │                    thought, not the first half of a sentence
  ▼
[C] Haiku triage ───── one-shot classifier over the burst + recent transcript:
  │                    {interject: bool, kind: wish|bug|question|none, confidence}
  │                    → below threshold: drop, remember nothing, cost ≈ nothing
  ▼
[D] Opus ambient turn ─ framed transcript excerpt + AMBIENT doctrine; model either
  │                    replies with a one-line offer, answers directly, or outputs
  │                    PASS (posted nothing)
  ▼
[E] Offer ledger ───── pending offer {channel, offerMsgId, summary, expiresAt, mode}
  │                    • next msgs in channel skip triage → routed as consent turns
  │                    • "sure" → model files ticket via existing path (ack, thread, PR)
  │                    • "no/ignore" → clear + remember the decline (don't re-offer)
  │                    • timeout, mode=suggest → offer expires silently
  │                    • timeout, mode=auto    → synthetic SYSTEM turn: proceed
```

Stages A, B, E are pure code. C is a cheap model. D is the existing session. Only D can post.

## 4. Concrete changes, file by file

### 4.1 Config — `src/config.ts` + `src/types.ts`

New `[proactivity]` block (zod, strict, fully defaulted — matches the existing style):

```toml
[proactivity]
enabled = false                    # master switch; ships OFF
default_mode = "off"               # off | suggest | auto  (auto = proceed-on-silence)
triage_model = "claude-haiku-4-5"  # the cheap gate
triage_threshold = 0.7             # min confidence to wake the Opus session
burst_quiet_secs = 20              # channel-quiet window before triage fires
channel_cooldown_secs = 900        # min gap between interjections in one channel
max_interjections_per_hour = 4     # global cap, enforced in code
offer_ttl_secs = 600               # how long an offer waits for consent
transcript_window = 15             # ring-buffer size per channel

[proactivity.channels]             # per-channel mode overrides
"1520658476974735490" = "suggest"  # e.g. the ops channel
```

`Config.proactivity` gets added to the frozen-ish `Config` interface in `src/types.ts`
(the V3 freeze was for the parallel-build phase; config has been extended since — e.g.
`concierge.effort`). Keep the compile-time `_assertAssignable` guarantee intact.

Runtime overrides (so Beckett can obey "chill out in here" without a config edit + restart)
live in `~/.beckett/proactivity.json` — same pattern as `access.txt`/`progress-threads.json` —
merged over the TOML at read time and mutated via the CLI (§4.6).

### 4.2 New module — `src/concierge/ambient.ts` (`AmbientCoordinator`)

The heart of the feature; everything testable without Discord or a live model. Factory-style
(`createAmbientCoordinator(deps)`) per house convention, deps injected: config, logger, clock,
a `triage(burst, transcript) => Promise<TriageVerdict>` function, and an
`engage(turn) => Promise<string>` callback that runs a session turn.

Owns:
- **Per-channel ring buffers** (`transcript_window` messages: author display name, content,
  ts). These also solve a real context problem: the session never saw un-mentioned chatter,
  so the ambient turn must carry its own excerpt.
- **Debounce timers** per channel (`burst_quiet_secs`): a burst flushes to triage only after
  the channel goes quiet. A new message resets the timer. An @mention arriving mid-burst
  cancels the pending flush for that channel (the mention turn will see the transcript anyway
  — see §4.4 — and we must never double-respond).
- **Cooldown + rate-cap state**: last-interjection ts per channel, sliding-window global
  counter. Checked BEFORE triage (stage A) so capped channels cost zero model calls.
- **The offer ledger**: `Map<channelId, PendingOffer>` where
  `PendingOffer = { offerMessageId, offerText, sourceUserId, summary, mode, expiresAt, timer }`.
  One live offer per channel, newest wins. Persisted to `~/.beckett/pending-offers.json` so a
  daemon restart doesn't orphan a consent window (same durability pattern as progress
  threads).
- **Timers** for offer expiry: `suggest` mode → expire silently; `auto` mode → emit a
  synthetic SYSTEM turn (see §4.5) telling the session to proceed.

### 4.3 New module — `src/concierge/triage.ts`

A one-shot classifier: spawn `claude -p --model <triage_model> --output-format json` with a
~40-line prompt (transcript excerpt + burst) and zod-validate:

```ts
const TriageVerdict = z.object({
  interject: z.boolean(),
  kind: z.enum(["feature-wish", "bug-report", "question", "task-request", "none"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),           // logged, never posted
});
```

The prompt is a static file (`src/concierge/triage.md`) next to `concierge.md`, and it's
strict: *"You are a gatekeeper. Interject=true ONLY when someone expresses a concrete wish,
bug, or task Beckett could start, or asks a question Beckett is uniquely positioned to answer.
Chatting, venting, banter, decided plans, and anything ambiguous → false."* Log every verdict
(channel, kind, confidence, reason) at info level — this is the tuning knob we'll actually
iterate on, and the log is how we tune it.

Implementation note: this reuses the `Bun.spawn` + JSON-parse pattern from
`ConciergeSession.launch` / the ClaudeDriver, but one-shot (no `--resume`, no stream) —
~30 lines. Timeout 30s; on any failure the verdict is `interject:false` (fail silent, never
fail loud into a channel).

### 4.4 Wire-up — `src/concierge/index.ts`

`onMessage` (line 1391) becomes a router instead of a gate:

```ts
async onMessage(m: IncomingMessage): Promise<void> {
  if (!m.mentionsBot) {
    this.ambient?.observe(m, this.accessLevelFor(m.userId));  // never throws, never awaited into the mention path
    return;
  }
  this.ambient?.noteMention(m.channelId);   // cancel pending burst flush for this channel
  // ...existing mention path unchanged...
}
```

Rules inside `observe`:
- `outsider` messages update NOTHING — not even the ring buffer. The model must never see
  text from someone outside `access.txt`, same guarantee as today.
- Allowed users' messages always feed the ring buffer (context), but only trigger the
  debounce→triage pipeline when the channel's effective mode ≠ `off`.
- If the channel has a **pending offer**, skip triage entirely: frame the new message as a
  consent turn (§4.5) and send it to the session at normal (non-priority) queue position.

**Ambient turn execution** differs from the mention path deliberately:
- **No typing indicator, no fast-ack** (those are for people waiting on an answer they asked
  for).
- Queued with `{ priority: false }` — mentions and even ticket updates go first.
- The reply is auto-posted (plain post, no `replyToMessageId` — replying-to an un-addressed
  message reads as surveillance; a plain message reads as joining in) **unless** the model
  returned the sentinel `PASS` (alone, first line) — then nothing is posted and the cooldown
  is NOT consumed. The existing `repliedViaCli` claim mechanism works unchanged if the model
  chooses the CLI path.
- When a post happens, `AmbientCoordinator.recordOffer(...)` stores the ledger entry with the
  posted message id, arms the TTL timer, and starts the channel cooldown.

**Mention-path addition (small but important):** `buildTurn` should prepend the channel's
ring-buffer excerpt when the transcript has entries the session hasn't seen. Today a mention
like "@beckett do that" after five un-mentioned messages is a riddle; with ambient buffers we
can finally answer it. This is a free, immediate UX win even in `off`-mode channels.

### 4.5 Turn framing — new frames alongside `frameUserTurn` (`src/concierge/index.ts:1698`)

Three new frames, same terse machine-stamp style:

**Ambient candidate:**
```
SYSTEM (ambient — nobody addressed you; you are choosing whether to speak):
[channel:<id>] recent conversation:
  [10:41] Jason: honestly the export flow is painful
  [10:41] Jason: wish it just gave me a CSV
Triage says: feature-wish (confidence 0.86).
If you have a CONCRETE offer or answer, reply with ONE short message in your voice.
If not — and when in doubt — reply with exactly: PASS
Do not file a ticket yet. An offer is a question, not a commitment.
```

**Consent follow-up** (pending offer exists, new message arrives):
```
SYSTEM (ambient follow-up): you offered in this channel 40s ago:
  "want me to kick off CSV export? say the word."
[channel:<id>] [user:… address:Jason msg:…]
sure go for it
If this accepts your offer: ack via `beckett discord reply`, then file the ticket exactly as
you would for a direct request (--channel stamped). If it declines or is unrelated to your
offer: reply PASS. If it's unrelated but ambient-worthy on its own, treat it as a fresh
candidate.
```

**Silence-consent (auto mode only):**
```
SYSTEM (ambient timeout): your offer "<text>" in [channel:<id>] got no reply in 10 minutes.
This channel is set to proceed-on-silence. If the work is still sensible, post a one-line
heads-up ("no objection, so I'm running with the CSV export thing") and file the ticket.
If the moment has passed, PASS.
```

From the ticket onward, everything is the existing machinery: ack, `beckett ticket create
--channel`, progress thread, worker in its own worktree, PR, done ping. Zero dispatcher
changes.

### 4.6 CLI + control bus — `src/cli/beckett.ts`, `src/shell/control-bus.ts`

New command group, routed over the control bus like `beckett discord reply`:

```
beckett proactivity status                       # effective mode per channel, caps, live offers
beckett proactivity set <channel-id> off|suggest|auto
beckett proactivity off                          # global kill switch (flips runtime enabled=false)
```

Because the Concierge's Bash tool can run these, "beckett, stop butting in here" becomes
self-service — add one line to the doctrine telling it so. `auto` mode additionally requires
the requesting turn's speaker to be `role:owner` (checked in code at the bus handler, not by
the model).

### 4.7 Doctrine — `src/concierge/concierge.md`

New section **"Ambient turns — when you speak without being asked"**, placed right after the
existing message-classification block (lines 28-40). Core content:

- You'll receive `SYSTEM (ambient …)` turns. These are OVERHEARD, not addressed to you.
  Interjecting is a privilege: **PASS is the correct answer most of the time.**
- Speak only when you can offer something concrete: "I can build that", "that's already
  ticketed as OPS-12", "that bug is the thing I fixed yesterday — pull latest". One line.
  Never two interjections about the same topic; never pile onto a decided plan; never
  correct people or join banter.
- Before offering work, `recall` the topic — if you offered before and they declined, or a
  ticket already exists, PASS (or point at the ticket, once).
- An offer is a question. Don't file the ticket until they accept (or a timeout turn tells
  you the channel policy is proceed-on-silence).
- After a decline, `remember` it (`type: feedback`, "declined ambient offer: <topic>") so you
  don't re-offer.
- If told to knock it off — in any phrasing — run `beckett proactivity set <channel> off`
  yourself and confirm in one line.

### 4.8 Memory — no code changes

`recall`/`remember` (`src/memory/index.ts`) already do everything needed; the dedup behavior
(§4.7) is doctrine-driven. Optionally seed one memory at rollout: "ambient interjection
exists; here's how to tune yourself."

## 5. Cost & load

Assume a fairly active channel: 300 allowed-user messages/day.
- Stage A/B are free. Debounce collapses those into perhaps 60-80 bursts/day.
- Stage C: ~80 Haiku one-shots/day at ~1k tokens in / 50 out ≈ **pennies per day**.
- Stage D: with `triage_threshold 0.7` + hard caps, worst case `max_interjections_per_hour`
  Opus turns/hour; realistically 2-5 ambient Opus turns/day at a few k tokens each — noise
  next to the existing update-turn traffic. Ring-buffer excerpts (~15 short messages) add
  little to session context; the 190k rotation ceiling
  (`config.concierge.rotate_at_tokens`) is unaffected in any meaningful way.

## 6. Failure modes and their mitigations

| Risk | Mitigation |
|---|---|
| Beckett becomes That Guy who replies to everything | code-level cooldown + hourly cap; strict triage prompt; PASS-by-default doctrine; per-channel `off`; memory of declines |
| "sure" was aimed at another human | consent is judged by the model WITH the transcript, not regex; doctrine says PASS when ambiguous; offer TTL keeps the window short |
| Double-response when someone @mentions mid-burst | `noteMention()` cancels the pending flush for that channel |
| Interjecting on its own or other bots' messages | existing `msg.author.bot` guard at the gateway (`gateway.ts:270`) — ambient path never sees bot traffic |
| Outsider text reaching the model via ambient | outsiders excluded before the ring buffer, not just before the reply |
| Auto mode fires on stale context | timeout turn explicitly offers PASS ("if the moment has passed"); `auto` is opt-in per channel and owner-gated |
| Triage flake (bad JSON, timeout) | fail-closed to `interject:false`; logged |
| Daemon restart orphans a consent window | offer ledger persisted to `~/.beckett/pending-offers.json`, reloaded on boot, expired entries dropped |
| Ambient turn delays a real person | ambient turns are non-priority; mentions jump the queue (existing issue-#25 machinery) |

## 7. Ticket plan (suggested `beckett plan` DAG)

Sized for the existing worker pipeline; T1 has no dependencies, T2-T3 depend on T1, T4 last.

1. **T1 — Ambient plumbing (config + coordinator + triage).** `[proactivity]` schema,
   `AmbientCoordinator` (buffers, debounce, cooldowns, caps, ledger + persistence),
   `triage.ts` + `triage.md`, unit tests with injected clock/triage fakes. No behavior change
   while `enabled=false`.
2. **T2 — Concierge wire-up + frames.** `onMessage` router, ambient/consent/timeout frames,
   PASS suppression, no-typing/no-ack ambient execution, mention-path transcript prepend,
   `noteMention` cancellation. Tests: PASS posts nothing; mention mid-burst never
   double-fires; consent turn bypasses triage.
3. **T3 — CLI + control bus + doctrine.** `beckett proactivity …` group, owner gate on
   `auto`, `concierge.md` ambient section, kill switch.
4. **T4 — E2E + rollout.** Script under `scripts/e2e/` driving fake gateway messages through
   the full pipeline with a stubbed triage; deploy with `enabled=false`; flip one channel to
   `suggest`; watch triage logs for a few days; tune threshold/prompt; only then consider
   `auto` anywhere.

## 8. Explicitly out of scope (v1)

- Interjecting in DMs (a DM already IS an address — nothing ambient about it).
- Reading channels Beckett wasn't already in / widening access beyond `access.txt`.
- Cross-channel awareness ("they discussed this in #general yesterday") — the ring buffer is
  per-channel and short. Memory handles durable facts.
- Emoji-reaction consent (👍 on the offer). Nice v2; the gateway doesn't listen to reaction
  events today.
- Proactive conversation-STARTING (Beckett bringing up its own topics unprompted). This
  proposal is reactive-ambient: it joins conversations that exist. Initiating from ticket
  events already exists via update turns; initiating from nothing is a different feature
  with a different risk profile.

---

## Appendix: kick-off prompt for Beckett

> Read `proposal.md` at the repo root — it's a fully-specified design for ambient
> interjection (replying without being @mentioned). File it as a plan with the four tickets
> from §7, dependencies as stated (T2 and T3 after T1, T4 last), `--project beckett`. The
> proposal has exact file paths, config schema, frame texts, and test requirements — workers
> should treat it as the spec and read it before writing code. Ship with
> `proactivity.enabled=false`; do not enable any channel until I say so.
