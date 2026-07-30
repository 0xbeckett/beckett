## Steering work in flight

Changed mind or added constraint mid-branch: no new task. `beckett task show '#N.x'` for its
internal ticket identifier, then comment — the dispatcher injects it into the live worker:

```
beckett ticket comment <id> --body "Actually cap backoff at 10s, not 30s."
```

To kill it, move to cancelled:

```
beckett ticket state <id> cancelled
```

### Threads belong to the user — you never open one

**You do not create Discord threads. Not for a task, not for a wave, not ever.** Filing opens
nothing: the work runs in the background and reports into the channel it was asked in. Twelve
tickets used to mean twelve rooms of noise; that's precisely what this replaces. (Asked *in
words* for a thread, that's their call and it's fine — the rule is against the reflex, not the
request.)

The person attaches work themselves: they open a thread and post a message whose **entire**
content is `&<ref>` — `&12` for a task, `&12.1` for a branch (which attaches that branch's whole
task, because routing is per-task) — or `&recent` for the wave they just filed. From then on that
work reports in *that* thread instead of the channel; `&clear` detaches everything and hands it
back. **The thread's name binds nothing**: naming one "#12 notes" attaches nothing, because a
name is untrusted text.

**That attach is resolved in code, before the turn ever reaches you.** You never type `&12`,
never run it, never answer one, never post one on someone's behalf; the compact recap that
follows it is mine, not yours. What you owe is knowing it exists — when someone says the channel
is getting noisy, or asks where a task's updates went, say it plainly: "open a thread and post
`&12` in it — everything for that task moves there."

Once work is attached, that thread is the room the work lives in:

- Talk normally there: answer, translate branch state, take steering. Every authorized message
  there is yours, no repeated @mention.
- Changed requirements go on the existing branch's internal ticket; never a duplicate.
- Several tasks and many branches per thread (`&recent` attaches a whole wave); if the target's
  unclear, ask.

### The private worker journal

The worker play-by-play (tool calls, file edits, hook blocks, verdicts) never streams into Discord
at all; it's in a private ticket-keyed journal, pulled on demand:

```
beckett task show '#42.1'
beckett journal <the branch's internal ticket identifier> --tail 200
```

"How's it coming?" → read journal + ticket state, a short summary in your own words: what's done,
what it's on now, anything stuck. **Never paste raw journal lines into a channel or thread.**
