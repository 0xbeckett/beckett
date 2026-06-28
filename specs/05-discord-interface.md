# Beckett — Spec 05: Discord Interface

> **The front porch.** This spec defines the *only* surface a human talks to Beckett through: an
> **ambient** Discord bot that listens for `@beckett` mentions in any channel it's in and replies **in
> that same channel** — no threads, no dashboards, no progress spam. It owns the gateway connection,
> the intake → Brain handoff, clarify/steer/escalation correlation, the delivery + handshake message,
> and the **sparseness policy** that decides what is even worth saying. The governing rule, from
> [Spec 00 §4 — "Discord"](./00-overview.md#4-canonical-decisions-the-ledger): **ambient, no threads;
> management lives off Discord (the CLI); sparseness is law.** If this spec contradicts
> [Spec 00](./00-overview.md), Spec 00 wins (or we fix 00 first).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Canon: [Spec 00](./00-overview.md). Research & rationale: [`../my-docs/open-questions.md`](../my-docs/open-questions.md)
> (esp. §E1 ambient/no-threads, §E2 sparseness, §E3 steering-maps-to-nudge, §E4 multiplayer attribution).

---

## 0. Scope & cross-links

This document **owns**: the discord.js bot setup (intents, gateway lifecycle, reconnect/resume), the
**ambient interaction model** (mention-in → reply-in-same-channel, no threads), the `IncomingMessage`
capture shape, the intake → Brain handoff wiring, the **awaiting-reply correlation** machinery (clarify
Q&A, steering, handshake answers) keyed by `channel_id`+`user_id`/reply-to, the **sparseness policy
table** + chattiness knob, the optional `/beckett` slash commands, and message-formatting / rate-limit /
error-UX conventions.

It **defers**:

| Concern | Owner |
|---|---|
| Which model classifies a mention; the ack/persona/delivery *voice* (text content) | [Spec 06 — Brain & Models](./06-brain-models.md) |
| The state machine that emits acks/clarify/escalation/delivery (when, not how) | [Spec 04 — State Machine](./04-state-machine.md) |
| Nudge / pause / abort primitives a steering message maps to | [Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md) |
| The `PendingAction` a handshake gates; the `AnswerGrammar` (go/decline/variant parser) | [Spec 07 — Identity & Agency](./07-identity-agency.md) |
| DAG/worker management surface (`ps`, `tail`, `nudge`, `abort`, `logs`) | [Spec 10 — CLI](./10-cli.md) |
| How `tasks`/`messages`/`pending_actions` rows persist + survive restart | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) |
| `user_id` → person resolution (who is this, what do they prefer) | [Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md) |
| One-time bot provisioning, token minting, gateway perms in the dev portal | [Spec 12 — Roadmap & Setup](./12-roadmap-setup.md) |

⚠️ All sibling specs are written; correlation/voice contracts below are the **consumer** side of
[Spec 06](./06-brain-models.md) / [Spec 07](./07-identity-agency.md) — they must stay consistent with
those owners.

---

## 1. Bot setup (discord.js)

### 1.1 Library + client

Beckett's interface is a single long-lived **discord.js v14** `Client` inside the bun daemon
([Spec 00 runtime](./00-overview.md#4-canonical-decisions-the-ledger)). It is **not** a separate
process — it shares the orchestrator's event loop so an intake event can hand straight to the Brain
([Spec 06](./06-brain-models.md)) and a `SuperviseDecision.escalate` ([Spec 03 §4.3](./03-control-plane-supervise.md))
can post without IPC.

```ts
// discord/client.ts
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";

export function makeDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,          // channels/roles cache; required for everything
      GatewayIntentBits.GuildMessages,   // receive messageCreate in guild channels
      GatewayIntentBits.MessageContent,  // ⚠️ PRIVILEGED — without it, message.content is empty
      GatewayIntentBits.DirectMessages,  // 1:1 DMs to the bot (still ambient — the "channel" is the DM)
    ],
    // DM channels + messages arrive uncached → enable partials so we still get the event:
    partials: [Partials.Channel, Partials.Message],
  });
}
```

> **MessageContent is a privileged intent.** Beckett's *entire* model is reading free-text mentions, so
> it cannot function without it. It must be toggled on in the Discord Developer Portal **and** declared
> here; the two must match or the gateway rejects the connection. Under 100 guilds this needs no
> verification; at scale it requires Discord approval. Provisioning the toggle is a
> [Spec 12](./12-roadmap-setup.md) item. **We deliberately avoid the alternative** (slash-command-only,
> which dodges the privileged intent) because the ambient `@beckett` conversation *is* the product
> ([open-questions §E1](../my-docs/open-questions.md)). Slash commands (§8) are a thin mirror, not the
> interface.

The bot user is **Beckett's own Discord identity** (`Identity.discord.botUser`,
[Spec 07 §2.1](./07-identity-agency.md)) — the `@beckett` people mention. The token lives in
`~/.beckett/.env` as `DISCORD_TOKEN` ([Spec 07 §7.1](./07-identity-agency.md)); provisioning the app +
bot user + invite (scopes `bot` + `applications.commands`) is deferred to
[Spec 12](./12-roadmap-setup.md).

### 1.2 Gateway connection + reconnection/resume

discord.js manages the WebSocket gateway, heartbeats, and **session RESUME vs re-IDENTIFY** internally —
Beckett does **not** hand-roll this. Our job is to (a) `login()` once, (b) treat `ClientReady` as the
"go live" signal, (c) survive transient drops without losing state, and (d) reconcile anything that
happened while disconnected (see §6.4 — durability).

```ts
// discord/lifecycle.ts
const client = makeDiscordClient();

client.once(Events.ClientReady, (c) => {
  log.info(`discord up as ${c.user.tag} (${c.user.id})`);
  identity.discord.botUser = c.user.id;            // the @mention id (Spec 07)
  reconcileAfterDowntime();                         // §6.4 — re-bind awaiting-replies, scan missed mentions
});

// discord.js auto-reconnects + RESUMEs; we just observe for diagnostics:
client.on(Events.ShardDisconnect, (e, id) => log.warn(`shard ${id} down code=${e.code}`));
client.on(Events.ShardReconnecting, (id) => log.warn(`shard ${id} reconnecting`));
client.on(Events.ShardResume, (id, n) => log.info(`shard ${id} RESUMEd, replayed ${n} events`));
client.on(Events.Error, (e) => log.error("discord client error", e));

await client.login(process.env.DISCORD_TOKEN);     // single login; ws layer owns retry/backoff
```

- **RESUME** (gateway replays missed events from the last sequence number) is the happy path on a brief
  blip — Beckett loses nothing.
- **Re-IDENTIFY** (full reconnect, session invalidated) means the gateway will **not** replay the gap.
  This is the case §6.4 must cover: on `ClientReady` after a non-resumed reconnect, Beckett scans for
  mentions that arrived during downtime (using `messages.fetch` after the last-seen message id per
  active channel, persisted in SQLite — [Spec 09](./09-persistence-data-model.md)).
- The gateway connection is **process-lifetime**; there is no per-task connection. One daemon = one
  gateway session.

---

## 2. The ambient model (CRITICAL — no threads)

### 2.1 The one rule

> **`@beckett` in any channel → Beckett replies in THAT SAME channel. It never creates a thread, never
> opens a DM unsolicited, never spawns a "task channel."** ([Spec 00](./00-overview.md#4-canonical-decisions-the-ledger),
> [open-questions §E1](../my-docs/open-questions.md).)

Beckett "works where you work." A mention in `#general` is answered in `#general`. A mention in a DM is
answered in that DM (the DM *is* the channel). There is no topology to manage — the channel the human
chose is the channel Beckett uses. All DAG/worker/telemetry inspection lives **off Discord** on the
`beckett` CLI ([Spec 10](./10-cli.md)); Discord carries only the coworker-visible moments (§7).

**Why no threads** ([open-questions §E1](../my-docs/open-questions.md), which *replaced* an earlier
thread-per-task proposal): threads fragment the conversation, demand topology management, and push
Beckett toward chatty per-task status posts — the opposite of sparseness. Ambient + sparse means
Beckett reads like a colleague typing in the channel, not a CI bot spamming a thread.

### 2.2 The mention listener + capture shape

Every inbound message runs through one handler. It captures the full multiplayer-ready context for
**every** message (not just mentions) so correlation (§4/§5) and `user_id` attribution
([Spec 00 multiplayer](./00-overview.md#4-canonical-decisions-the-ledger)) work uniformly.

```ts
// discord/intake.ts
export interface IncomingMessage {
  messageId:    string;            // discord message snowflake (correlation anchor)
  userId:       string;            // author id — on EVERYTHING (multiplayer-ready, Spec 00/09)
  channelId:    string;            // ambient: where we reply
  guildId:      string | null;     // null for DMs
  content:      string;            // requires MessageContent intent (§1.1)
  repliedToId:  string | null;     // message.reference?.messageId — the strong correlation key (§4.2)
  mentionsBot:  boolean;           // did this @beckett?
  authorIsBot:  boolean;           // ignore our own + other bots (loop guard)
  createdAt:    number;            // epoch ms
}

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;                         // never react to bots (incl. self) — loop guard
  const m: IncomingMessage = {
    messageId:   msg.id,
    userId:      msg.author.id,
    channelId:   msg.channelId,
    guildId:     msg.guildId,
    content:     msg.content,
    repliedToId: msg.reference?.messageId ?? null,
    mentionsBot: msg.mentions.has(client.user!.id),
    authorIsBot: msg.author.bot,
    createdAt:   msg.createdTimestamp,
  };
  await persistMessage(m);                             // Spec 09 — audit + downtime reconciliation cursor

  // Routing precedence: an in-flight conversation beats a fresh mention (§4/§5).
  if (await tryResolveAwaitingReply(m)) return;        // clarify answer / handshake answer / steer (§4,§5)
  if (m.mentionsBot) return void onMention(m);         // fresh intake (§3)
  // else: ambient chatter Beckett isn't part of → ignore (sparseness; don't barge in)
});
```

Two precedence rules baked in above:
1. **Reply-correlation wins over fresh-mention.** If a message answers an outstanding clarify/handshake
   or steers a running task (§4/§5), it's handled there even if it *also* `@beckett`s.
2. **No mention + not a reply to us = silence.** Beckett does not insert itself into conversations it
   wasn't addressed in. (It *may* still read them into Memory passively — [Spec 08](./08-memory-knowledge-graph.md) —
   but it does not post.)

### 2.3 Multiplayer-ready by construction

`user_id` rides every `IncomingMessage`, every persisted `messages` row ([Spec 09](./09-persistence-data-model.md)),
every `TaskRecord.userId` ([Spec 04 §2](./04-state-machine.md)), every `QueuedNudge.userId`
([Spec 03 §6](./03-control-plane-supervise.md)), and every `PendingAction.userId`
([Spec 07 §5.1](./07-identity-agency.md)). v1 is single-user, but **nothing in this interface assumes
one human** — attribution is "who mentioned," concurrency is per-task, and the correlation logic (§4.3)
explicitly handles two people with outstanding questions in the same channel. This is the
design-for-build-later posture from [Spec 00](./00-overview.md#4-canonical-decisions-the-ledger).

---

## 3. Intake → Brain handoff

A fresh mention becomes an **intake event** handed to the Brain ([Spec 06 §1](./06-brain-models.md)).
Beckett does not classify in the Discord layer — the Haiku front door owns that. This layer's job is:
build the intake payload, call the Brain, **post the `ack` instantly**, and (if escalated) let the rest
of the loop run in the background.

```ts
// discord/intake.ts (cont.)
async function onMention(m: IncomingMessage) {
  const ch = await client.channels.fetch(m.channelId);
  await (ch as TextBasedChannel).sendTyping();        // "Beckett is typing…" — cheap presence cue

  // Haiku front door: classify + produce the instant ack (Spec 06 §1.3 HaikuClassification).
  const cls = await brain.intake({
    userId: m.userId, channelId: m.channelId, guildId: m.guildId,
    content: stripMention(m.content), quoted: await fetchQuoted(m),  // §4 quoted/replied context
    messageId: m.messageId,
  });

  // The ack is ALWAYS posted first — a receipt, not a promise (Spec 00 INTAKE, Spec 06 §5.3).
  const ackMsg = await reply(m, cls.ack);

  switch (cls.kind) {
    case "chatter":
    case "fyi":
      // Haiku already fully handled it (Spec 04 T4); `answer` may be the ack itself or a follow-up.
      if (cls.answer && cls.answer !== cls.ack) await reply(m, cls.answer);
      return;                                          // no task, no DAG — done
    case "question":
      if (cls.withinPurview && cls.answer) { await reply(m, cls.answer); return; }
      // falls through to task if it needs judgment (escalate=true)
    case "task": {
      const task = await createTask({ ...m, prompt: stripMention(m.content), ackMessageId: ackMsg.id });
      orchestrator.beginTask(task, cls);               // Spec 04 T1 → CLARIFY?/PLAN runs in background
      return;                                          // Discord layer returns; loop owns the task now
    }
  }
}
```

- **The ack** is the one-line honest read (Spec 06 §5.3): *"on it — gonna branch off main and wire JWT
  into the auth layer, keeping the old cookie path working. back in a bit."* It is posted **before**
  Opus is even woken — the human gets a receipt in ~1s while planning happens in the background
  ([Spec 06 §1.2](./06-brain-models.md), silent escalation).
- **No plan-approval gate.** Per [Spec 00 plan-gate](./00-overview.md#4-canonical-decisions-the-ledger),
  Beckett acks and *starts*; it returns to Discord only at the clarify bar (§4), an escalation (§7), or
  delivery (§6). After the ack, the channel goes quiet — that silence is the sparseness contract, not a
  bug.
- The `ackMessageId` is stored on the `TaskRecord` so later messages (delivery, escalation) can
  optionally `reply()` to the original ask, threading the conversation visually *without* Discord
  threads.

---

## 4. Clarify Q&A correlation

When the loop enters `CLARIFY` ([Spec 04 T3](./04-state-machine.md)), Beckett posts ONE crisp question
(content from [Spec 06 §4.2 `ClarifyOutput`](./06-brain-models.md)) and **arms an awaiting-reply
binding** so the human's next message routes back to the waiting task — not treated as a fresh mention.

### 4.1 The awaiting-reply registry

Every place Beckett asks a human something (clarify, escalation, handshake) registers an
`AwaitingReply`. This is the single correlation table the intake handler consults first (§2.2).

```ts
// discord/awaiting.ts
export type AwaitKind = "clarify" | "handshake" | "self_halt" | "escalation_choice";

export interface AwaitingReply {
  id:            string;          // ULID
  kind:          AwaitKind;
  taskId:        string;          // the parked task (Spec 04)
  pendingActionId?: string;       // for kind==="handshake"|"self_halt" → Spec 07 PendingAction.id
  channelId:     string;          // where the question was posted (ambient)
  userId:        string;          // WHO we asked (the expected answerer) — multiplayer disambiguation
  promptMessageId: string;        // the bot message id carrying the question (reply-to correlation key)
  buttonsCustomIdPrefix?: string; // if we attached buttons/reactions (§5/§6.3)
  createdAt:     number;
  expiresAt:     number;          // clarify/escalation timeout (Spec 04 T7/T8); handshake → Spec 07 §5.4
}
```

Persisted in SQLite ([Spec 09](./09-persistence-data-model.md)) so a restart re-binds it (§6.4). The
in-memory index is keyed three ways for the resolution heuristic below:
`byPromptMessageId`, `byChannelUser` (`channelId+userId`), and `byChannelId` (all outstanding in a
channel).

### 4.2 Correlating a reply back to the waiting task

`tryResolveAwaitingReply(m)` (called first in §2.2) resolves an incoming message to an `AwaitingReply`
using a **precedence ladder**, strongest signal first:

```ts
async function tryResolveAwaitingReply(m: IncomingMessage): Promise<boolean> {
  // (1) STRONGEST: Discord native reply-to one of our question messages.
  if (m.repliedToId) {
    const aw = awaiting.byPromptMessageId.get(m.repliedToId);
    if (aw) return resolve(aw, m);
  }
  // (2) Button/reaction interaction is handled in a separate gateway event (§5/§6.3), not here.

  // (3) Channel+user: exactly ONE outstanding question for this user in this channel → bind it.
  const mine = awaiting.byChannelUser.get(`${m.channelId}:${m.userId}`) ?? [];
  if (mine.length === 1) return resolve(mine[0], m);

  // (4) AMBIGUOUS: this user has >1 outstanding, OR no native reply to disambiguate.
  if (mine.length > 1) { await askWhichOne(m, mine); return true; }

  // (5) Not an answer to anything → fall through to fresh-mention/ignore (§2.2).
  return false;
}
```

- **Native reply-to is the gold standard.** Beckett's clarify/handshake messages are posted; when a
  human hits "Reply" on Discord, `repliedToId` points straight at `promptMessageId` — unambiguous even
  in a busy multiplayer channel. Beckett **encourages** this implicitly by always posting questions as
  distinct, replyable messages.
- **Channel+user single-outstanding** is the common no-reply-button fallback: if Jason has exactly one
  open question in `#general`, his next message there answers it. Robust for the single-user v1.

### 4.3 Concurrency & multiplayer ambiguity

Two hard cases this layer must handle (not punt):

1. **Multiple concurrent awaiting tasks in one channel, same user.** If Jason has two tasks both in
   `CLARIFY` in `#general`, a bare reply is ambiguous (ladder step 4). Beckett asks which one, *cheaply
   and specifically*, rather than guessing:
   > "two things open — the auth refactor (which token expiry?) or the dashboard (dark mode default?)?"
   The disambiguation reply itself becomes an `AwaitingReply` of kind `escalation_choice` so the next
   message resolves it. (Native reply-to sidesteps this entirely — preferred.)
2. **Multiplayer: Sam answers Jason's question.** Each `AwaitingReply` records `userId` = *who we
   asked*. A message from a different user does **not** auto-resolve another person's clarify (step 3
   keys on `channelId+userId`). If Sam *replies-to* (step 1) Jason's question, Beckett accepts it but
   notes the attribution shift in the loop (the answer's `userId` is recorded — the task may care who
   actually decided). ⚠️ Whether a non-owner may answer another's clarify is a **policy** question that
   belongs to [Spec 07](./07-identity-agency.md)/multiplayer; v1 (single-user) treats reply-to as
   authoritative and records the answerer.

On resolve, Beckett folds the answer into the task and the loop advances (`CLARIFY → PLAN`,
[Spec 04 T5](./04-state-machine.md)); a contradictory answer can trigger pushback/escalation
([Spec 04 T6](./04-state-machine.md), [Spec 06 §4.2 `pushback`](./06-brain-models.md)). **Timeout**
(no answer by `expiresAt`) follows [Spec 04 T7/T8](./04-state-machine.md): proceed on a reversible
fallback (and note the assumption at delivery) or park in `ESCALATED`.

---

## 5. Steering via Discord

A message **in a channel where a task of that user is running** is a potential **NUDGE** routed to that
task's worker(s) — the [open-questions §E3](../my-docs/open-questions.md) decision: *"a reply in the
channel = a nudge routed to the relevant worker(s); Beckett decides which, or asks. stop/pause →
abort/pause."* The Discord layer does **not** implement nudge/pause/abort — it maps a message to a
control primitive and calls the control plane ([Spec 03 §5](./03-control-plane-supervise.md)).

### 5.1 Deciding what a steering message targets

```ts
// discord/steer.ts
async function maybeSteer(m: IncomingMessage): Promise<boolean> {
  // Candidate tasks: this user's non-terminal tasks in this channel that have live workers.
  const live = tasks.activeFor(m.userId, m.channelId);     // Spec 04 EXECUTING tasks
  if (live.length === 0) return false;                     // nothing to steer → fresh mention/ignore

  const intent = classifySteerIntent(m.content);           // §5.2 — "stop"/"pause"/nudge
  let target: TaskRecord | undefined;

  if (m.repliedToId) target = tasks.byAnyMessageId(m.repliedToId); // replied to an ack/update → that task
  else if (live.length === 1) target = live[0];                    // only one running → it's that one
  else { await askWhichTask(m, live); return true; }               // ambiguous → ASK (don't guess)

  if (!target) return false;
  switch (intent.kind) {
    case "abort": await control.abortTask(target, m); break;       // Spec 03 §5.3 / Spec 04 T14
    case "pause": await control.pauseTask(target, m); break;       // Spec 03 §5.2
    case "nudge": await control.nudgeTask(target, m); break;       // Spec 03 §5.1 / §6 nudge queue
  }
  return true;
}
```

- **Target resolution mirrors §4.2:** reply-to is strongest, single-live-task is the easy case,
  multiple live tasks → **ask, never guess** ("which one — the auth refactor or the dashboard?").
- A nudge is enqueued on the target task's worker(s) via the **nudge queue**
  ([Spec 03 §6](./03-control-plane-supervise.md)) with `source: "discord"` and the steerer's `userId`
  for attribution. Which *worker* inside a multi-node DAG receives it is the control plane's call
  ([Spec 03 §6.2](./03-control-plane-supervise.md)); if genuinely ambiguous, Beckett asks.

### 5.2 Intent classification (stop/pause vs nudge)

Cheap and Haiku-fronted (a steering message is just another mention-class input;
[Spec 06](./06-brain-models.md) owns the model). The Discord layer carries only the mapping table:

| Human says | Intent | Maps to |
|---|---|---|
| "stop" / "abort" / "kill it" / "cancel that" | `abort` | `control.abortTask` ([Spec 03 §5.3](./03-control-plane-supervise.md), [Spec 04 T14](./04-state-machine.md)) |
| "pause" / "hold on" / "wait" | `pause` | `control.pauseTask` ([Spec 03 §5.2](./03-control-plane-supervise.md)) |
| anything else (a correction, a hint, "also handle X") | `nudge` | enqueue on worker(s) ([Spec 03 §6](./03-control-plane-supervise.md)) |

> ⚠️ "stop"/"pause" as bare keywords are a heuristic; a message like "don't stop on the first error" is
> a *nudge*, not an abort. The Haiku intent classifier (not keyword matching) makes the call, with the
> table as its prior. When confidence is low, Beckett confirms before a destructive `abort`
> ("kill the auth task? it's ~70% through" — itself an `AwaitingReply`).

### 5.3 Surfacing the claude-instant vs codex-deferred asymmetry

The control plane's nudge is **honestly asymmetric** ([Spec 03 §5.1](./03-control-plane-supervise.md),
[open-questions §B3](../my-docs/open-questions.md)): a Claude worker consumes a nudge at the next turn
boundary (~seconds); a Codex `exec` worker only at its next resume (coarser). Discord **surfaces this,
never fakes parity**. Beckett's acknowledgement of a steering message reflects the `NudgeReceipt.status`
([Spec 03 §5.1](./03-control-plane-supervise.md)):

| Worker | Beckett's reply to a nudge |
|---|---|
| Claude (status `queued`→`delivered` fast) | "got it — passing that along now." (a single 👍 reaction is enough; see §7) |
| Codex (`exec`, status `queued` until resume) | "noted — it'll pick that up at the next checkpoint (it's mid-run, can't interrupt cleanly)." |

We do **not** post a second message when a queued Codex nudge later flips to `delivered` — that would be
progress spam (§7). The honest one-time "it'll land at the next checkpoint" is the whole disclosure.
Live status is on the CLI (`beckett tail`/`ps`, [Spec 10](./10-cli.md)).

---

## 6. Delivery + handshake

At `DELIVERING` ([Spec 04 T12/T18](./04-state-machine.md)), Beckett posts the final message **in the
origin channel**, replying to the original ask (visual threading without threads). The *text* is Haiku
in Beckett's voice ([Spec 06 §8.1 delivery](./06-brain-models.md)); this layer owns the **shape** and
the **handshake correlation**.

### 6.1 Delivery message shape

Three parts, always, in Beckett's voice ([Spec 06 §8.1](./06-brain-models.md)):

1. **What was done** — first person, concrete. ("JWT auth's wired in, old session-cookie path still
   works so nothing breaks on rollout.")
2. **Known limits + assumptions** — the reversible-clarify assumptions surfaced now
   ([Spec 04 §7](./04-state-machine.md), `TaskRecord.assumptions`). ("one assumption: kept the 24h
   token expiry — lmk if you want it shorter. tests green.")
3. **The artifact** — a link (PR url, draft, file path). Rendered as a plain link or a slim embed (§9).
4. **The handshake question** — the one crisp gate for the irreversible step ([Spec 00 DELIVER](./00-overview.md#3-the-loop-canonical-state-machine),
   [Spec 07 §5](./07-identity-agency.md)): *"want to eyeball it yourself or should I merge to main?"* /
   *"drafted it — send as me, or you handle it?"*

```
[reply to original ask]
PR's up — JWT auth's wired in, old session-cookie path still works so nothing breaks on rollout.
one assumption: kept the 24h token expiry from the old config — lmk if you want it shorter. tests green.
→ https://github.com/acme/app/pull/412
want to eyeball it yourself, or should I merge to main?            [ Merge ]  [ I'll review ]
```

### 6.2 The handshake gates a `PendingAction`

The handshake question corresponds to a `PendingAction` created by `Gate.perform`
([Spec 07 §2.4, §5](./07-identity-agency.md)) for the HANDSHAKE-GATED step (merge / send). This layer:

1. Posts `handshake.prompt` ([Spec 07 §5.1 `HandshakeSpec`](./07-identity-agency.md)) to the channel.
2. Registers an `AwaitingReply{ kind:"handshake", pendingActionId, promptMessageId, userId }` (§4.1).
3. On the human's answer, parses it to a `HandshakeAnswer` and calls
   `pending.resolve(pendingActionId, answer)` ([Spec 07 §5.2](./07-identity-agency.md)).

> **Split of responsibility (the contract from [Spec 07 §5.3](./07-identity-agency.md)):** the
> `AnswerGrammar` (free-text → `go | decline | variant`) is **policy and lives in Spec 07**; Spec 05
> owns only **transport + which-message-is-this correlation**. The Discord layer hands the raw reply
> text (and any button custom-id) to the grammar and relays the parsed `HandshakeAnswer` back through
> `resolve()`.

### 6.3 NL replies primary, buttons/reactions optional

**Recommendation: natural-language replies are the primary path; Discord buttons/reactions are an
optional convenience for the binary handshake.** Rationale: the whole product is conversational ambient
chat — forcing a button-click breaks the "talking to a coworker" feel, and NL already carries the
*variant* case ("merge but to develop") that a binary button can't. But a one-tap **Merge / I'll
review** pair is genuinely nice for the common yes/no, so we offer both:

```ts
// discord/handshake.ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } from "discord.js";

function handshakeButtons(paId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`hs:${paId}:go`).setLabel("Merge").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hs:${paId}:decline`).setLabel("I'll review").setStyle(ButtonStyle.Secondary),
  );
}

// A button click is a separate gateway event — correlation is EXACT via the custom-id.
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || !i.customId.startsWith("hs:")) return;
  const [, paId, verb] = i.customId.split(":");
  const answer = verb === "go" ? { kind: "go" } : { kind: "decline" } as const;  // Spec 07 §5.1
  await pending.resolve(paId, answer);                       // Spec 07 §5.2
  await i.update({ components: [] });                         // disable buttons after one use
  await i.followUp(answer.kind === "go" ? "on it — merging now." : "cool, leaving it for you.");
});
```

- **Buttons give exact correlation for free** — the `customId` embeds the `PendingAction.id`, so there's
  zero ambiguity even in a multiplayer channel (no §4.2 ladder needed).
- **NL is always accepted too:** "merge it" / "send it" / "nah I'll handle it" / "merge but rebase
  first" all resolve via the §4.2 reply correlation + the Spec 07 grammar. A **variant** answer
  ([Spec 07 §5.1](./07-identity-agency.md)) *requires* NL — buttons only cover go/decline.
- **Reactions** (✅/❌ on the delivery message) are offered as the lightest-touch variant of buttons, same
  custom correlation via the message id. ⚠️ Reactions are easy to misfire and lack the variant path;
  buttons are preferred when we want a tap target. Defaulting buttons-on vs reactions-on is a
  chattiness-knob sub-setting (§7.3).
- **Timeout never fires the action** ([Spec 07 §5.4](./07-identity-agency.md)): an unanswered "merge?"
  leaves the PR open. Beckett posts one low-key nudge at ~50% of the window ("still holding the PR for
  you") then goes quiet — it does not re-ask on a loop (sparseness).

### 6.4 Restart / downtime reconciliation

On `ClientReady` after downtime (§1.2), `reconcileAfterDowntime()`:

1. Re-binds every persisted `AwaitingReply` (clarify/handshake/self-halt) to its in-memory index — the
   `promptMessageId` still exists in Discord, so reply-correlation keeps working. Already-posted
   questions are **not re-posted** ([Spec 07 §5.3](./07-identity-agency.md)).
2. For each channel with an outstanding question or active task, `messages.fetch({ after: lastSeenId })`
   pulls messages that arrived during the gap and replays them through the §2.2 handler — so an answer
   that landed while Beckett was down is reconciled, and a mention during downtime still gets picked up
   (covers the re-IDENTIFY no-replay case, §1.2). `lastSeenId` per channel is persisted in SQLite
   ([Spec 09](./09-persistence-data-model.md)).

---

## 7. Sparseness policy (LAW)

> **Sparseness is law** ([Spec 00](./00-overview.md#4-canonical-decisions-the-ledger),
> [open-questions §E2](../my-docs/open-questions.md)). Beckett posts only what a *good coworker* would
> say out loud. The default is **silence while working.** Tool calls, per-node progress, and per-worker
> "done" are **never** posted to Discord — they live on the CLI ([Spec 10](./10-cli.md)).

### 7.1 The table — state/event → produces a Discord message?

| State / event (Spec 04 / 03 / 07) | Discord message? | Notes |
|---|---|---|
| Mention received → **ack** (INTAKE, [04 T1](./04-state-machine.md)) | **YES** | the instant one-line read; the receipt ([06 §5.3](./06-brain-models.md)) |
| **Clarifying question** (CLARIFY, [04 T3](./04-state-machine.md)) | **YES** | ONE crisp question only; arms `AwaitingReply` (§4) |
| Chatter / FYI / recall answer ([04 T4](./04-state-machine.md)) | **YES** | conversational reply, no DAG ([06 B1/B2](./06-brain-models.md)) |
| PLAN built / STAFF done ([04 T9/T11](./04-state-machine.md)) | **no** | internal; the ack already told them what's happening |
| DISPATCH / worker spawned ([04 N4](./04-state-machine.md)) | **no** | invisible — sparseness |
| Per-tool-call / per-turn activity ([03 §1](./03-control-plane-supervise.md)) | **no** | **never.** This is the CLI's `tail` ([Spec 10](./10-cli.md)) |
| Smoke-alarm fired / Opus look ([03 §2–4](./03-control-plane-supervise.md)) | **no** | internal supervision; silent |
| Nudge / pause decided & applied ([03 §5](./03-control-plane-supervise.md)) | **no*** | silent unless it *escalates*; *a human-initiated steer gets a one-time ack (§5.3) |
| Per-node INTEGRATE / REVIEW / GATE pass ([04 N13–N18](./04-state-machine.md)) | **no** | per-node "done" is spam |
| **Escalation — "I'm stuck"** (SUPERVISE/GATE, [04 T13](./04-state-machine.md), [03 §4.3 `escalate`](./03-control-plane-supervise.md)) | **YES** | first-person account + options ([06 §8.2](./06-brain-models.md)) |
| **Self-halt** ("bigger than scoped", [07 §6](./07-identity-agency.md)) | **YES** | continue / narrow / stop ([06 §8.2](./06-brain-models.md)) |
| **Delivery** + handshake (DELIVER, [04 T18](./04-state-machine.md)) | **YES** | what/limits/artifact + the merge/send question (§6) |
| Handshake timeout half-window nudge ([07 §5.4](./07-identity-agency.md)) | **YES** (once) | "still holding the PR for you" — then quiet |
| Task FAILED/ABORTED terminal ([04 T16/T14](./04-state-machine.md)) | **YES** | honest close ([06](./06-brain-models.md)); not silent |

**The five YES moments, in one line:** *ack · clarifying question · escalation/"I'm stuck" · delivery ·
self-halt.* Everything else is silence or the CLI. (Plus the honest terminal close, and one-time
acks/nudges that are themselves human-initiated.)

### 7.2 Why this is law, not preference

A coworker who narrated every file they opened would be insufferable; one who silently shipped and said
"PR's up — merge?" is exactly right. The sparseness table *is* the coworker illusion. Any new event type
defaults to **no Discord message** until someone argues it into the YES column — fail-quiet.

### 7.3 The chattiness knob

A configurable per-user/per-channel chattiness level in `config.toml` (and overridable via memory per
person, [Spec 08](./08-memory-knowledge-graph.md)). It can **only loosen toward more silence or add a
small, bounded set of optional posts** — it can never turn on per-tool-call spam (that stays CLI-only,
always).

```toml
# ~/.beckett/config.toml
[discord]
chattiness = "normal"      # "quiet" | "normal" | "chatty"
#   quiet  : ack + delivery + escalation + self-halt only; suppress chatter replies, suppress the
#            handshake-timeout nudge. (the absolute floor — never less than the irreducible YES set)
#   normal : the §7.1 table as written (default).
#   chatty : normal + an optional one-line "plan summary" after PLAN for big-swing tasks
#            (scopeNote from PlanOutput, Spec 06 §4.3) + handshake-timeout nudge.
handshake_buttons = true   # attach Merge/decline buttons to delivery handshakes (§6.3)
reaction_acks     = true   # use a 👍 reaction instead of a text reply to acknowledge a nudge (§5.3)
typing_indicator  = true   # sendTyping() on intake (§3)
```

> **Floor invariant:** even `quiet` keeps ack · clarify · escalation · self-halt · delivery. Sparseness
> can tighten chatter and convenience posts; it can never drop the moments a coworker *must* speak.

---

## 8. Optional slash commands (`/beckett …`)

A **thin mirror** of the canonical `beckett` CLI ([Spec 10](./10-cli.md)) for when Jason wants explicit
control from inside Discord without SSHing. They are **convenience, not the management surface** — the
CLI remains canonical ([Spec 00 mgmt-surface](./00-overview.md#4-canonical-decisions-the-ledger),
[open-questions §L1/§E3](../my-docs/open-questions.md): "slash for control, NL for collaboration").

| Command | Mirrors | Returns | Visibility |
|---|---|---|---|
| `/beckett status` | `beckett status` | one-line health: N tasks running, M awaiting you, rate-limit state | **ephemeral** |
| `/beckett ps` | `beckett ps` ([Spec 10](./10-cli.md)) | compact list of active tasks (id, prompt snippet, state, channel) | **ephemeral** |
| `/beckett abort <taskId>` | `beckett abort` ([Spec 03 §5.3](./03-control-plane-supervise.md)) | confirms abort; aborts workers, captures partials ([04 T14](./04-state-machine.md)) | ephemeral + (a public terminal close per §7.1) |

```ts
// discord/slash.ts — registered with applications.commands scope (Spec 12)
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== "beckett") return;
  const sub = i.options.getSubcommand();
  switch (sub) {
    case "status": return i.reply({ content: await cli.statusLine(i.user.id), ephemeral: true });
    case "ps":     return i.reply({ content: await cli.psTable(i.user.id),  ephemeral: true });
    case "abort": {
      const id = i.options.getString("task", true);
      await control.abortTaskById(id, { userId: i.user.id, source: "discord" }); // Spec 03 §5.3
      return i.reply({ content: `aborted ${id}.`, ephemeral: true });
    }
  }
});
```

- **Ephemeral by default** — status/ps are for the asker only, so they don't clutter the channel
  (sparseness extends to slash output).
- Slash commands are **read/control only**; they never replace the conversational intake. There is no
  `/beckett task …` — you task Beckett by talking to it (`@beckett do X`). `tail`/`logs`/`nudge` stay
  CLI-only (too verbose / too live for Discord). ⚠️ Slash-command registration (global vs per-guild) and
  the exact subcommand set are confirmed against [Spec 10](./10-cli.md) when both land; this is the
  minimal mirror.

---

## 9. Formatting, error/timeout UX, rate limits

### 9.1 Message formatting conventions

| Concern | Convention |
|---|---|
| **Voice** | lowercase-friendly, casual, dry ([Spec 06 §5.1 persona](./06-brain-models.md)). Content owned by Haiku; this layer never rewrites it. |
| **Length** | A delivery/escalation is a short paragraph, not an essay. Hard cap at Discord's **2000 chars**; if a body would exceed it, summarize + link the full write-up (PR body / a gist / a file path) rather than chunk into multiple messages (chunking = spam). |
| **Code** | Inline `` `code` `` for identifiers; triple-backtick fenced blocks **only** when a snippet is genuinely needed (an error line, a diff hunk). Never paste worker transcripts — that's `beckett tail`. |
| **Embeds** | A slim embed for the **delivery artifact** only (PR title + url + check status). Acks/clarify/escalation are plain text — embeds there feel botty and break the coworker tone. |
| **Mentions** | Reply-to the asker's message (visual threading without threads); only `@`-ping a human on an escalation/self-halt that genuinely needs them *now*. |
| **Reactions** | A 👍 reaction is a valid, minimal acknowledgement of a nudge (§5.3) — cheaper than a sentence. |

### 9.2 Error & timeout UX

- **Brain/loop failure** ([Spec 06 §3.4](./06-brain-models.md)): if Beckett can't reach its planning/
  gating step, it says so honestly in-channel rather than going dark — *"can't reach my planning step
  right now, holding your task — will retry."* ([Spec 04 T19](./04-state-machine.md) for a failed
  delivery post: retry, then surface via CLI.)
- **Discord send failure**: posting is retried with backoff (§9.3); if it persistently fails, the event
  is logged and surfaced via the CLI ([Spec 04 T19](./04-state-machine.md)) — the task is **not** lost
  because Discord is down (the loop ran; only the notification failed).
- **Clarify/handshake timeout**: fail-safe, never fire the irreversible action
  ([Spec 04 T7/T8](./04-state-machine.md), [Spec 07 §5.4](./07-identity-agency.md)). Clarify → proceed
  on reversible fallback or escalate; handshake → leave PR/draft, one half-window nudge, then quiet.
- **Loop guard**: never react to bot authors (incl. self, §2.2) — prevents an ack-of-an-ack cascade.

### 9.3 Discord API rate-limit handling

discord.js has a **built-in REST rate-limit queue** (per-route buckets + global limit) — Beckett relies
on it rather than hand-rolling throttling; sends are awaited and the library spaces them. On top of
that:

- **`rateLimited` observability**: listen on `client.rest.on('rateLimited', …)` to log when we're being
  throttled (diagnostic; the library still handles the wait).
- **Sparseness *is* rate-limit defense.** Because Beckett posts only the five YES moments (§7), it
  essentially never approaches Discord's limits in normal operation — the policy that makes Beckett feel
  like a coworker also keeps it far under the API ceiling. A burst is only possible from many concurrent
  deliveries/escalations; those are naturally spaced by the library's queue.
- **Never retry-storm**: a 429 is awaited (via the library), not hammered; a 5xx on send uses bounded
  backoff (§9.2) and then degrades to the CLI surface rather than looping.
- **Outbound coalescing**: if two YES events for the *same task* would post within a tight window (e.g.
  a delivery immediately followed by a handshake), they're composed into **one** message (§6.1 already
  does this — delivery *includes* the handshake) rather than two posts.

---

## 10. Open gaps ⚠️

1. **Non-owner answering another user's clarify/handshake** (§4.3) — v1 treats native reply-to as
   authoritative and records the answerer; the *policy* (may Sam approve Jason's merge?) belongs to
   [Spec 07](./07-identity-agency.md)/multiplayer. Pin when multiplayer turns on.
2. **Steer-intent keyword vs Haiku classification** (§5.2) — "stop"/"pause" as bare keywords are a
   prior, not a rule; relies on the Haiku intent classifier ([Spec 06](./06-brain-models.md)) for cases
   like "don't stop on errors." Needs real-traffic calibration; confirm destructive-abort confirmation
   threshold.
3. **Which worker in a multi-node DAG a channel nudge targets** (§5.1) — owned by
   [Spec 03 §6.2](./03-control-plane-supervise.md); Discord asks when ambiguous, but the default
   routing (most-recently-active? the one the reply-to'd update was about?) needs pinning with Spec 03.
4. **Slash-command set + registration scope** (§8) — minimal mirror here; reconcile the exact
   subcommands and global-vs-guild registration with [Spec 10](./10-cli.md).
5. **Buttons vs reactions vs NL-only** default (§6.3) — recommended NL-primary + optional buttons;
   `reaction_acks`/`handshake_buttons` knobs are first-guess defaults, tune against real use.
6. **Downtime mention-scan window** (§6.4) — `messages.fetch({ after })` per active channel is bounded
   but unverified at scale; confirm the cursor-persistence shape with [Spec 09](./09-persistence-data-model.md).
7. **MessageContent privileged-intent approval** (§1.1) — fine under 100 guilds; verification is a
   [Spec 12](./12-roadmap-setup.md) item if Beckett ever scales past that.

---

## 11. Summary

1. **Ambient, no threads.** One discord.js client (intents: Guilds, GuildMessages, **MessageContent**
   [privileged], DirectMessages) listens for `@beckett` in any channel and replies **in that same
   channel** — never a thread, never an unsolicited DM. Management lives on the CLI
   ([Spec 10](./10-cli.md)); Discord carries only coworker-visible moments.
2. **Every message captures `messageId, userId, channelId, guildId, content, repliedToId`** —
   `user_id` on everything makes the interface multiplayer-ready by construction
   ([Spec 09](./09-persistence-data-model.md)).
3. **Intake → Brain → instant ack.** A mention becomes an intake event handed to the Haiku front door
   ([Spec 06](./06-brain-models.md)); the one-line honest **ack** posts first (a receipt, not a
   promise), then the loop runs in the background with no approval gate.
4. **Correlation via an `AwaitingReply` registry** keyed by `promptMessageId` (native reply-to,
   strongest), then `channelId+userId` (single-outstanding), else **ask which one** — handling
   concurrent tasks per channel and multiplayer ambiguity rather than guessing.
5. **Steering = nudge/pause/abort** ([Spec 03 §5](./03-control-plane-supervise.md)): a message where a
   user's task is running maps to a control primitive on that task's worker(s); reply-to/single-task
   resolve the target, ambiguity asks. The **claude-instant vs codex-deferred** asymmetry is surfaced
   honestly ("it'll pick that up at the next checkpoint"), never faked.
6. **Delivery = what / limits+assumptions / artifact + the handshake** ("merge?" / "send?"), gating a
   `PendingAction` ([Spec 07 §5](./07-identity-agency.md)); **NL replies primary, optional buttons/
   reactions** for the binary, variant requires NL, **timeout never fires the action**.
7. **Sparseness is law** (§7 table): YES = ack · clarify · escalation · delivery · self-halt; NO = tool
   calls, per-node progress, per-worker done. A `chattiness` knob can only tighten toward silence (never
   below the irreducible YES floor). Optional `/beckett status|ps|abort` mirror the CLI, ephemerally.

**Flagged inconsistencies / forks:** see §10 — chiefly the non-owner-answer policy (deferred to
[Spec 07](./07-identity-agency.md)/multiplayer), steer-intent keyword reliability, and multi-node nudge
targeting (owned by [Spec 03](./03-control-plane-supervise.md)). None contradict the
[Spec 00](./00-overview.md) ledger — ambient/no-threads, sparseness-is-law, CLI-as-management-surface,
and `user_id`-on-everything are all honored exactly.
