# Design doc: targeted ambient interjection — addressee gate + hold-and-cancel

**Ticket:** OPS-99 · **Status:** design only (no hot-path changes here) · **Requested by:** ro

> ro's framing (paraphrased): interjections sometimes fire when they shouldn't — either the
> message was clearly aimed at another person (SSH talking to ro, and I chime in anyway), or a
> human already answered by the time my reply posts, so it lands stale. Make the classifier
> answer *"does this actually need Beckett / need immediate attention,"* try to parse **who** is
> being addressed before I generate, and if a human responds first, **cancel** the pending
> request. Net: interjections that are targeted and effective, not reflexive.

This doc grounds that ask in how the ambient subsystem works **today** (v4.1.2), then proposes
three additive deltas — an **addressee / attention gate**, a **hold-and-cancel window**, and the
**cancellation mechanism** that backs it — plus edge cases and a phased build. The proposals
*extend* the existing debounce / engaged-lane / offer machinery; they do not replace it.

The build is a set of **separate tickets** (§7). This one produces the doc only. No file under
`src/concierge/` is edited here.

---

## 1. The problem, precisely

Two distinct false-positive modes, both currently unhandled:

1. **Wrong addressee.** The triage classifier scores *"is there a beat worth landing?"* — it does
   **not** ask *"was this aimed at Beckett or at another human?"* A directed message between two
   people ("ro, can you look at the deploy?") can still produce a high-confidence beat, and Beckett
   answers a question that wasn't its to answer. Fun sometimes, but it's "talking to talk."

2. **Already answered.** From classifier-fire to post there is real latency: the burst debounce
   (§2.3), the session **queue wait** behind any running turn, then the Opus generation itself
   (seconds). A human can answer inside that window. Beckett's reply then posts into a resolved
   thread — redundant at best, tone-deaf at worst.

Both are *ambient-only* failures. A **direct @mention or DM never enters this path at all** (§2.1),
which is the load-bearing fact for every failsafe in §6.

---

## 2. How ambient works today (end to end)

Files: `src/concierge/index.ts` (routing + the `engage` callback + the turn queue),
`src/concierge/ambient.ts` (the `AmbientCoordinator`), `src/concierge/triage.ts` +
`src/concierge/triage.md` (the classifier), `src/config.ts` (the `[proactivity]` schema).

### 2.1 Routing — mention vs ambient (`index.ts` `onMessage`, ~1799)

```ts
async onMessage(m: IncomingMessage): Promise<void> {
  if (!m.mentionsBot) {                    // ← DM or @mention folds into mentionsBot upstream
    const level = this.accessLevelFor(m.userId);
    this.captureInbound(m, level);
    this.ambient?.observe(m, level);       // ← AMBIENT path (eavesdrop)
    return;
  }
  this.ambient?.noteMention(m.channelId);  // ← a mention CANCELS any pending ambient burst here
  // … mention path: priority turn, typing indicator, fast-ack …
}
```

Consequences that the whole design leans on:

- **The two paths are disjoint.** Anything addressed to Beckett (`mentionsBot`) runs the priority
  mention turn with typing + fast-ack; it is *never* triaged, debounced, held, or cancelled.
- **A mention already pre-empts ambient.** `noteMention(channelId)` (`ambient.ts:191`) clears the
  channel's debounce timer and drops its pending burst — so if someone @mentions Beckett while an
  ambient burst is still assembling, the ambient reply is abandoned and the mention turn owns the
  transcript. The hold-and-cancel window (§4) generalises this to *plain* human replies.

### 2.2 The coordinator: `observe` → burst → debounce (`ambient.ts`)

Every non-mention message from a member/owner reaches `observe` (`ambient.ts:166`):

```ts
observe(message, accessLevel) {
  if (accessLevel === "outsider") return;
  // … transcript capture (or shared store, OPS-80) …
  if (!this.config.enabled) return;
  const liveOffer = this.offers.get(message.channelId);
  if (liveOffer) { void this.runConsentTurn(channelId, liveOffer, message); return; }  // consent lane
  const mode = this.effectiveMode(channelId);
  if (mode === "off") return;
  this.appendBurst(channelId, tm);   // accumulate the burst
  this.armDebounce(channelId);       // (re)start the quiet timer
}
```

`armDebounce` (`ambient.ts:266`) starts a per-channel timer; **each new message resets it**, so the
burst flushes only after a lull:

```ts
const quietSecs = this.isEngaged(channelId)
  ? (this.config.engaged_quiet_secs ?? 4)     // v4.1.2: mid-conversation, 4s IS a turn boundary
  : this.config.burst_quiet_secs;             // cold default 20s
const timer = this.clock.setTimeout(() => { …; void this.flushBurst(channelId); }, quietSecs*1000);
```

### 2.3 The triage classifier (`triage.ts` / `triage.md`)

On flush (cold path only — see §2.4), the coordinator calls the classifier:

```ts
verdict = await this.triage(burst, transcript, { channelId });
if (!verdict.interject || verdict.confidence < this.config.triage_threshold) return;  // gate
```

- **Verdict schema** (`triage.ts:6`): `{ interject: boolean, kind: "feature-wish"|"bug-report"|
  "question"|"task-request"|"social"|"none", confidence: 0..1, reason: string }`.
- **Providers** (`triage.ts`): `claude` spawns the subscription CLI (`claude -p … --model
  claude-haiku-4-5`); `cerebras` POSTs the OpenAI-compatible API at wire speed. Selected by
  `proactivity.triage_provider`.
- **Fails closed**: any error returns `CLOSED = { interject:false, … }` (`triage.ts:48`) — the
  classifier being down means *silence*, never a blind post.
- **The prompt** (`triage.md`) is a *"should I speak?"* scorer: *"Nobody addressed Beckett — it is
  overhearing a channel and deciding whether jumping in would ADD something."* It is deliberately
  **lean-toward-speaking** ("when it's a coin-flip, lean interject=true"). Crucially, **it never
  asks who the message was directed at** — that is exactly the gap §3 fills.

### 2.4 The engaged lane (v4.1.1)

After Beckett posts anywhere in a channel, `noteBeckettPost` (`ambient.ts:198`) stamps
`lastBeckettPostAt`. For the next `engaged_window_secs` (default **180**), `isEngaged` is true and
`flushBurst` **bypasses the classifier and the caps entirely** (`ambient.ts:293`):

```ts
if (engaged) {
  verdict = { interject: true, kind: "none", confidence: 1,
              reason: "engaged conversation — the burst responds to something Beckett just said" };
} else {
  if (this.isCapped(channelId)) return;
  verdict = await this.triage(burst, transcript, { channelId });
  if (!verdict.interject || verdict.confidence < this.config.triage_threshold) return;
  if (this.isCapped(channelId)) return;
}
```

Rationale (from the changelog): Haiku was scoring replies-*to*-Beckett as "piling on"/"crowding the
room" and refusing them, so Beckett went silent the moment people engaged with it. In the engaged
lane the *session turn itself* decides (it can still return `PASS` on a conversation-ender).

### 2.5 Conversational cadence (v4.1.2)

Three cadence changes, all reused by this design:

- **Engaged lull `engaged_quiet_secs` (default 4)** — the 4s debounce in §2.2. Mid-conversation,
  waiting out the cold 20s read as "wandered off."
- **Typing indicator** — `runAmbientTurn` fires `gateway.sendTyping` **only** for `consent` turns
  and **engaged** candidates (`index.ts:1966`). Cold candidates stay untelegraphed: no "beckett is
  typing…" over a conversation it may still `PASS` on from eavesdrop distance.
- **Caps are backstops, not rations** — `channel_cooldown_secs` 60, `max_interjections_per_hour` 0
  (disabled). The *classifier* is the gate; caps only break pathological loops (`config.ts:372`).

### 2.6 The concierge turn — `engage` → post (`index.ts` `runAmbientTurn`, ~1958)

The coordinator's `engage` callback is `runAmbientTurn`. It:

1. Frames the turn (`frameAmbientTurn`) as `candidate` / `consent` / `timeout`.
2. Fires typing for engaged/consent only (§2.5).
3. Runs a **non-priority** session turn: `await this.session.ask(framed, claim, { priority: false })`
   — so real mentions and ticket updates jump ahead in the queue.
4. If the reply is the **`PASS` sentinel** (`isAmbientPass`, `ambient.ts:97` — `PASS` alone on the
   first line), it **posts nothing and consumes no cooldown**, returning the sentinel verbatim so
   the coordinator skips its cooldown stamp.
5. Otherwise it posts (`gateway.post(channelId, reply, { chill: true })`), calls
   `recordBeckettPost` (which re-opens the engaged window), and for a **cold** candidate arms the
   offer ledger (`armAmbientOffer` → `recordOffer`, TTL + cooldown).

The **session queue** (`index.ts` `ask`/`pump`, ~295) is single-flight: turns run one at a time; a
`priority` turn splices ahead of queued non-priority turns but **never pre-empts the running one**.
`stop()` (~351) rejects every queued/in-flight turn — the only existing "abort" primitive, and it's
all-or-nothing. There is **no per-turn mid-flight abort today**; §5 addresses this directly.

### 2.7 Config surface + control bus

`[proactivity]` (`config.ts:357`), the levers that matter here:

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch |
| `default_mode` / `channels` | `off` | per-channel `off`/`suggest`/`auto` |
| `triage_provider` / `triage_model` | `claude` / `claude-haiku-4-5` | classifier backend |
| `triage_threshold` | `0.55` | min confidence to interject (cold); conservative so a cold coin-flip stays silent |
| `burst_quiet_secs` | `20` | cold debounce |
| `engaged_quiet_secs` | `4` | engaged debounce (v4.1.2) |
| `engaged_window_secs` | `180` | how long after a Beckett post counts as "engaged" |
| `channel_cooldown_secs` | `60` | cold backstop |
| `max_interjections_per_hour` | `0` | cold backstop (disabled) |
| `offer_ttl_secs` | `600` | consent-offer lifetime |
| `transcript_window` | `15` | burst-assembly context window |

Runtime overrides ride `proactivity.json` merged over TOML (`config.ts:487`), driven by the
`beckett proactivity` CLI / control bus — so new numeric knobs added below are hot-tunable without a
redeploy, same as the existing ones.

### 2.8 Reuse inventory — what today already gives us for free

The new features are mostly *wiring on existing seams*, not new machinery:

- **A per-channel debounce timer** (`debounceTimers`) that any message already resets — the natural
  home for the hold window (§4).
- **A `PASS` sentinel** that means "post nothing, consume nothing" — the clean shape for a
  *cancelled* turn to take (§5): cancellation degrades to a synthetic `PASS`.
- **`noteMention` already cancels a pending burst on @mention** — we generalise it to plain replies.
- **The injected `AmbientClock`** (`now`/`setTimeout`/`clearTimeout`) — every timer in the design
  goes through it, so tests drive hold-and-cancel on a fake clock exactly like the existing debounce.
- **`isEngaged` / `lastBeckettPostAt`** — the timing context the hold window composes with.
- **The classifier prompt + verdict schema** — extended, not rebuilt, for the addressee gate (§3).

---

## 3. Proposal A — the addressee / attention gate

**Goal:** before generating, infer whether the burst is *directed at Beckett* vs *at another
participant*, and how *urgently* it wants a response. Skip or downrank non-directed chatter.

### 3.1 Where it sits — augment the classifier, don't add a pass

A separate model call would double the latency on the hot path and add a second thing to fail. The
burst classifier already reads the burst + transcript and returns structured JSON; **extend that
same call**. Widen `TriageVerdictSchema` (`triage.ts:6`) with two fields:

```ts
addressee: z.enum(["beckett", "other", "group", "unclear"]),
attention: z.number().min(0).max(1),   // 0 = idle chatter, 1 = someone is actively waiting on an answer
```

- `beckett` — the burst is aimed at Beckett (names it, asks it something answerable only by it,
  continues a thread it's in).
- `other` — clearly aimed at a *specific other human* ("ro, can you…", "@ssh what's the port").
- `group` — addressed to the room broadly (a question to everyone, thinking out loud).
- `unclear` — genuinely ambiguous.

`attention` is the "needs immediate attention" signal ro asked for: a direct question with a `?`
and no answer yet scores high; two people bantering scores low.

`triage.md` gains a short section instructing the scorer to fill these, with the anchor examples
ro gave (SSH talking to ro ⇒ `addressee:"other"`). The output contract line and the fenced example
in `triage.md:41` are updated to include both fields; `parseVerdict` / `TriageVerdictSchema.parse`
enforce them so a model that omits them **fails closed** (§2.3) exactly as today.

### 3.2 How the gate combines with the existing threshold

`flushBurst`'s cold gate (`ambient.ts:307`) currently is:

```ts
if (!verdict.interject || verdict.confidence < triage_threshold) return;
```

Replace the single threshold with an **addressee-weighted** effective score. Sketch:

```ts
const w = addressee_weight[verdict.addressee];        // beckett 1.0, group 0.7, unclear 0.5, other 0.15
const effective = verdict.confidence * w;
const bar = Math.max(triage_threshold, other_min_bar_if_addressee_other);
if (!verdict.interject || effective < bar) return;    // skip or downrank non-directed chatter
```

- **Skip, not answer** — `addressee:"other"` with a low weight drops nearly everything below the
  bar, so Beckett stays out of a two-person exchange *unless* it has a genuinely high-value beat
  (a real "i can build that", a factual correction) that survives even at weight 0.15. That
  preserves the "it can be fun" case ro noted without making it reflexive.
- **`attention` as a tiebreak / hold input** — high `attention` on `addressee:"beckett"` shortens
  the hold window (§4.2, someone is actively waiting); high `attention` on `addressee:"other"` is a
  *stronger* skip (someone else is being asked, and is expected to answer). It does **not** by
  itself force a post.
- **Engaged lane is exempt.** In the engaged lane there is no classifier call (§2.4), so the
  addressee gate does not run there — a burst inside `engaged_window_secs` is *by construction*
  people talking with Beckett. The session turn still decides via `PASS`. (One refinement in §6:
  if the engaged burst is clearly two other people talking to each other, the frame should let the
  session `PASS` — handled at the frame level, not by re-adding a classifier to the engaged lane.)

All weights/bars are new `[proactivity]` keys (defaults: `addressee_weight` map, `attention_*`),
hot-tunable via the control bus (§2.7). Defaults chosen to bias toward *silence for `other`*,
*unchanged behaviour for `beckett`/`group`*.

### 3.3 Why not gate purely on a regex for `@name` / directed cues

Discord `@mentions` of Beckett already route to the mention path (§2.1); the hard cases are
*implicit* addressee ("ro, …", replying to ssh's message, second-person "you" that means a
specific person). Those need the model's read of the transcript, not a regex. A cheap
pre-filter (does the burst literally name another roster member at the start?) can *short-circuit
to `other`* before the model call as an optimisation, but the model is the source of truth.

---

## 4. Proposal B — the hold-and-cancel window

**Goal:** a short debounce between "we've decided to interject" and "the message actually posts";
if a human answers (or the thread resolves) during it, cancel cleanly with **no stale post**.

### 4.1 Two hold points (the window is really two gates)

Latency lives in two places, so cancellation must too:

- **Gate 1 — pre-generation (dequeue guard).** Between the classifier verdict and calling
  `session.ask`. Cheapest possible cancel: nothing has been generated, so we just don't enqueue /
  we return `PASS`. Catches humans who answer during the debounce tail and the queue wait.
- **Gate 2 — pre-post (send guard).** Between `session.ask` resolving and `gateway.post`. Catches
  humans who answered *during* the multi-second Opus generation — the exact "already answered by
  the time my reply is generated" complaint. This is the important one and is what makes the
  feature feel targeted.

Gate 2 is where the "hold window" name lives: after generation, hold the finished reply for
`hold_window_secs` (proposed default **2–3s**, tunable) before posting, re-checking the cancel
token (§5) throughout. If nothing superseded it, post; else drop to `PASS`.

> Note we do **not** need a *large* post-hold if Gate 2 also re-checks a supersede flag that is set
> the instant a human posts (§5). The hold is a short grace so a human reply that lands within a
> beat or two of Beckett's still wins the race; it is not a fixed multi-second stall on every post.

### 4.2 The window, and how it composes with the 4s engaged lull

These are **different windows** and must not be conflated:

- `engaged_quiet_secs` (4s, §2.5) is *burst assembly* — "has the human finished their thought?" It
  sits **before** the decision to interject.
- `hold_window_secs` (new) is *post debounce* — "did the situation change after we decided?" It
  sits **after** generation, **before** the post.

Composition rule: the hold window runs on the **cold path and the engaged path alike**, but with
different durations. Cold candidates get the full `hold_window_secs`. Engaged continuations —
already telegraphed with a typing indicator, and by definition a live conversation — get a **shorter
or zero** hold (`engaged_hold_secs`, default ~1s or 0): once Beckett has visibly started typing,
yanking the message is *more* jarring than a slightly-late reply. High `attention` (§3.1) further
shortens the hold. So the window scales inversely with how committed/expected the reply already is.

### 4.3 What counts as "resolved" (a cancel trigger)

During either gate, the pending interjection is cancelled if, in the same channel:

1. **A human posts a relevant reply.** "Relevant" = a non-Beckett member/owner message that is
   *not* itself directed away from the burst. Cheap default: **any** new human message in the
   channel during the window cancels a *cold* candidate (a fresh human turn means the room moved on
   without Beckett). For an **engaged** continuation, only a message that reads as answering the
   same open thread cancels — bystander chatter shouldn't kill Beckett's live reply. A second
   (optional) classifier signal or a lightweight heuristic (does the new message address the same
   person the burst addressed?) refines this; v1 can use the coarse rule and tune.
2. **A human @mentions Beckett.** Already handled — `noteMention` cancels the burst pre-generation
   (§2.1). Post-generation, the mention path will run its own priority turn, so the pending ambient
   reply must also drop (Gate 2 cancel) to avoid double-posting. This is a new hook.
3. **The offer/consent path takes over.** If a live offer exists, `observe` routes to
   `runConsentTurn` (§2.2) — a pending cold candidate for the same channel is superseded.
4. **The exchange goes quiet and stale.** If the burst that triggered the interjection is now old
   (older than, say, `hold_window_secs` past the last relevant message *and* the value was
   time-sensitive), a `question`/`bug-report` beat can self-cancel. Low priority; a `social` beat
   doesn't stale this way. v1 can skip this and rely on triggers 1–3.

### 4.4 State machine delta

Today: `observe → appendBurst → armDebounce → flushBurst → engage → post|PASS`.

Proposed: `flushBurst`, after it decides to interject, transitions the channel into a
**`pending`** state carrying a monotonically-increasing **generation id** (§5). New `observe`s in
that channel during `pending` evaluate the §4.3 triggers and, if one fires, bump the generation id
(superseding the in-flight turn). The turn's own completion checks its generation id at Gate 2;
if it's stale, it returns `PASS`. No new long-lived state beyond one integer + one timestamp per
channel, both cleared when the turn resolves.

---

## 5. Proposal C — the cancellation mechanism

The hard constraint from §2.6: the concierge session is **one long-lived process** draining a
single-flight queue, and there is **no per-turn mid-flight abort** — only `stop()`, which kills
everything. So cancellation is designed in **three tiers**, cheapest first, none of which requires
tearing down the session.

### 5.1 The generation token (the primitive)

Add a per-channel **generation counter** to the coordinator: `pendingGen: Map<channelId, number>`.
When `flushBurst` commits to an interjection it captures `const gen = ++counter[channelId]`. Any
supersede trigger (§4.3) does `counter[channelId]++`, invalidating every token `< counter`. This is
the same idea as the offer ledger's `offerMessageId` freshness check
(`expireOffer`, `ambient.ts:357`, only acts if the live offer still matches the one it was armed
for) — reuse that pattern, don't invent a new one.

### 5.2 Tier 1 — pre-generation skip (Gate 1)

`flushBurst` already runs to the point of calling `engage`. Insert a token check immediately before
`await this.engage(...)`: if `gen` is stale, return without generating. Free — no Opus tokens spent.
This catches the common case (human answers during the debounce tail or queue wait).

### 5.3 Tier 2 — pre-post suppression (Gate 2, the workhorse)

`runAmbientTurn` (`index.ts:1958`) already has the exact hook: it returns a string, and returning
the `PASS` sentinel means **post nothing, consume no cooldown** (§2.6). So:

- Thread the `gen` into the `AmbientTurn` (add `gen: number` to the `candidate`/`consent` variants).
- In `runAmbientTurn`, after `session.ask` resolves and after the optional hold (§4.2), **re-check
  the token via a coordinator callback** (`ambient.isCurrent(channelId, gen)`). If stale, **discard
  the generated reply and return `PASS`.**

This is race-safe *by construction*: cancellation is just a synthetic `PASS`, which the coordinator
and post path already handle correctly (no cooldown consumed, engaged window not re-opened,
transcript already marked seen). No new "half-posted" state is possible — the reply either posts
whole or not at all, decided at one point right before `gateway.post`.

**The race that matters** is: human posts *at the same instant* Beckett is about to send. Ordering:
`gateway.post` is `await`ed, and the token re-check happens synchronously immediately before it.
The human's message runs through `onMessage → observe`, which bumps the token. As long as the token
bump is synchronous within `observe` (it is — no `await` before it) and the re-check is the last
thing before `post`, the last writer wins deterministically: if the human's `observe` ran first,
the token is stale and Beckett `PASS`es; if Beckett's `post` already fired, the human simply sees
Beckett's reply and their own — which is the correct, non-stale outcome (Beckett *did* answer
first). No double-post, no dropped-needed-reply.

### 5.4 Tier 3 — true mid-flight abort (future, optional)

To also save the *generation tokens* when a human answers mid-Opus-turn, the session needs a
per-turn abort primitive: an `AbortSignal` threaded into `ask`/`runTurn` that, when fired, sends the
child an interrupt and rejects that one turn (leaving the session alive for the next). This is a
larger change to the session core (`index.ts` `pump`/`runTurn`) and is **explicitly deferred** —
Tiers 1+2 deliver the *behaviour* (no stale post) without it; Tier 3 is a pure cost optimisation.
Flagged as its own ticket so it can be scoped/benchmarked on its own.

### 5.5 Why not just rely on the queue

One might hope a fresh human message could "jump ahead" and moot the ambient turn via priority.
It can't: a human *reply* is a non-mention, so it's ambient (`priority: false`) and an @mention runs
a *new* turn rather than cancelling the queued one. Priority ordering (§2.6) changes *what runs
next*, never *what a completed turn does with its output*. The token gate is the right layer.

---

## 6. Edge cases & failsafe defaults

- **Owner direct @mention is NEVER cancelled or held.** Architecturally guaranteed: a `mentionsBot`
  message never enters the ambient coordinator (§2.1), so no addressee gate, hold window, or token
  ever touches it. The mention path keeps its priority turn, typing, and fast-ack. This invariant
  is a *test*, not a hope (§7, ticket 5). If a future refactor ever routes mentions through shared
  code, the gate must hard-exempt `isOwner`/`mentionsBot`.
- **Direct mention from a non-owner member** — same: mention path, never gated. The addressee gate
  and hold apply **only** to un-addressed ambient bursts.
- **Multi-party threads.** With 3+ people, `addressee:"group"` keeps Beckett able to chime into a
  genuine open-to-the-room question, while `addressee:"other"` (A asking B specifically) keeps it
  out. The §4.3 cancel triggers are per-channel, so in a busy channel Beckett's cold candidate is
  readily superseded by the humans continuing — which is the desired "let the humans talk" bias.
- **Addressee ambiguity (`unclear`).** Treated as a *downrank*, not a block: weight 0.5 (§3.2), so
  only a strong beat survives. Bias-to-silence, but not silence-always.
- **Bias to silence for ambient, never for a mention.** The default posture everywhere unsure is
  *don't post* (the classifier already fails closed; the gate lowers effective score; the hold
  cancels on doubt). The **only** place this bias is inverted is the mention/DM path, which is out
  of scope for all of the above.
- **Engaged lane + two bystanders.** Inside `engaged_window_secs`, if the new burst is clearly two
  *other* people talking to each other (not to Beckett), the ambient frame should present that so
  the session can `PASS` — rather than re-introducing a classifier into the engaged lane. Handled
  in `frameAmbientCandidate`, low priority.
- **Cancel-storm / thrash.** A channel where every candidate is cancelled by the next human message
  is *correct* (the humans don't need Beckett), but it wastes generation. Tier-1 skip (§5.2) caps
  the waste to at most one in-flight generation per channel; Tier-3 abort (§5.4) removes it.
- **Classifier down.** Fails closed to silence (unchanged). The addressee fields simply don't gate
  anything because no verdict is produced — the burst is dropped, which is the safe direction.
- **Hold window vs. offer/consent.** A `pending` cold candidate that is superseded by a live offer
  arriving must not *also* try to post; token bump on offer-record covers it (§4.3 trigger 3).

---

## 7. Phased implementation plan (ticket-sized)

Each ticket is independently shippable and testable. Ordered so behaviour lands before optimisation.

1. **Addressee + attention fields in triage** *(schema + prompt)* — widen `TriageVerdictSchema`
   with `addressee` + `attention`; update `triage.md` (instructions, output contract, examples);
   keep fail-closed parsing. Add `[proactivity]` weight/bar keys with silence-biased defaults. No
   behaviour change yet beyond logging the new fields. *Tests: verdict parses/rejects; prompt
   golden.*
2. **Wire the addressee gate into `flushBurst`** *(cold-path gating)* — replace the single-threshold
   check with the addressee-weighted effective score (§3.2); skip/downrank `other`; leave the
   engaged lane untouched. *Tests: `other` burst is skipped; `beckett`/`group` unchanged; a
   high-value `other` beat still survives.*
3. **The generation token + Tier-1 pre-generation skip** *(the primitive + Gate 1)* — add
   `pendingGen` per channel, bump on supersede triggers, check before `engage`. Generalise
   `noteMention` and offer-arm to bump the token. *Tests: a human message during the debounce tail
   cancels before generation; fake-clock driven.*
4. **Tier-2 pre-post suppression + the hold window** *(Gate 2, the workhorse)* — thread `gen` into
   `AmbientTurn`; add `ambient.isCurrent(channelId, gen)`; in `runAmbientTurn` add the hold
   (`hold_window_secs` / `engaged_hold_secs`, attention-scaled) and the token re-check → synthetic
   `PASS`. *Tests: reply generated then a human answers → no post, no cooldown consumed; the
   at-the-instant race resolves last-writer-wins with no double-post.*
5. **Failsafe hardening** *(invariants as tests)* — owner @mention never gated/held/cancelled;
   `unclear` downranks not blocks; multi-party skip-bias; classifier-down → silence. Mostly tests
   over tickets 1–4, plus any guard rails they surface.
6. **(Deferred) Tier-3 true mid-flight abort** *(session core)* — an `AbortSignal` per turn in
   `ask`/`pump`/`runTurn` that interrupts the child and rejects only that turn. Pure token-cost
   optimisation; scope + benchmark separately. Ship only if Tier-1's one-generation-per-channel
   waste proves material.

### Files the build will touch (none in this ticket)

- `src/concierge/triage.ts` — verdict schema (`addressee`, `attention`)
- `src/concierge/triage.md` — scorer instructions + output contract + examples
- `src/concierge/ambient.ts` — addressee-weighted gate, `pendingGen` token, supersede triggers,
  hold window, `isCurrent`
- `src/concierge/index.ts` — `runAmbientTurn` hold + pre-post token re-check → `PASS`; `AmbientTurn`
  gains `gen`; (Tier 3) session `ask`/`pump`/`runTurn` abort primitive
- `src/config.ts` — new `[proactivity]` keys (`addressee_weight`, `attention_*`, `hold_window_secs`,
  `engaged_hold_secs`); regenerate `deploy/config.toml.example`
- tests alongside each; a `CHANGELOG.md` entry per shipped ticket

Nothing in **this** ticket edits any of them — this is the design only.

---

## 8. Design principles this doc commits to

- **Extend the seams, don't rebuild.** Every mechanism above reuses something that already exists:
  the classifier call, the `PASS` sentinel, the debounce timer, the offer-freshness pattern, the
  injected clock. New surface = two verdict fields, one integer token, one hold timer, a handful of
  tunable config keys.
- **Cancellation degrades to a `PASS`.** There is exactly one decision point where a message posts
  or doesn't; cancellation drives it to "doesn't." No partial/half-posted state can exist.
- **Bias to silence for ambient; never for a mention.** Every unsure branch resolves toward not
  speaking — *except* the direct-mention path, which this design never touches.
