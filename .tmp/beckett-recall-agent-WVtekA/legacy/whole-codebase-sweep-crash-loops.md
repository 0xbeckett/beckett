---
name: whole-codebase-sweep-crash-loops
description: A single ticket that sweeps the WHOLE codebase crash-loops — split by area instead
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 012c4379-3ba7-4c02-967b-25ea3d74b2ce
---

A ticket scoped to "sweep EVERY file in the codebase and change each" (e.g. OPS-69, the XML-prompt-rewrap) crash-loops: the worker starts cold each retry (isResume:false), grinds the huge scope, and the harness dies at the full-suite verification step. Not a 600s timeout (`timedOut:false`) — a genuine crash from oversized context. Dispatcher auto-retries → same wall → infinite loop, no forward progress. Distinct from [[worker-timeout-silent-wedge]] (that's the 600s cap).

**Why:** one worker context can't hold a whole-codebase change plus read every file plus run the full test suite. It dies before a clean finish.

**How to apply:** when a request is "do X to every prompt/file/module in the codebase," DON'T file it as one ticket. Split by area into a handful of tight tickets, each naming its file set, each verifying with a cheap check (`bun typecheck`, not the full suite). Run them sequentially (in_progress the first, todo the rest, promote as each merges) so they share taxonomy and don't stomp each other's publish to the same repo.
