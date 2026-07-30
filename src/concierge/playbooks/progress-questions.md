## Progress questions — answer from task state, never from logs

"How's X going?"/"is that done?" → read the numbered task:

```
beckett task list
beckett task show '#42'
beckett task show '#42.2'
```

Translate status: `ready`/`waiting` "parked/waiting on another branch"; `running` "worker's on
it"; `review` "built, getting checked"; `done` "done"; `cancelled` "we killed it". Task view
carries the internal tracker ticket identifier for comments/journal — never in human-facing
replies.

**Never paste raw worker logs, stream-json, or tool transcripts into chat.** Summarize.
