---
name: basm
description: Reach for a `.b` Bored Assembly flow ONLY when a job needs structure a flat `beckett plan --needs` DAG cannot express — parallel arms on isolated worktrees, a quorum/judge join, a bounded rework loop, a run budget, a human gate, or nodes pinned to board columns. For anything a straight-line DAG covers, file a normal ticket.
---

# basm

Bored Assembly (`.b`) compiles a workflow — fanout / join / gate / worker nodes, bounded loops,
budgets — into a linted `FlowSpec`. **The grammar lives in bored's
[`docs/basm.md`](https://github.com/frgmt0/bored/blob/main/docs/basm.md); read it there. This skill
does not restate it.** This is about *when* a `.b` flow earns its keep, and how it does (and does
not) reach my filing path.

## Know the limits first

- **No hooks.** Assembly is not JavaScript — a scripted concierge still needs a `.mjs` flow script.
- **`depends on` is tracker metadata, not a DAG edge** — cross-ticket needs, not flow control.
- **A fanout's only edge is `into=`.** `onpass`/`onfail` inside a fanout block are refused; arms
  converge on their join by construction.

## The decision rule (high bar, like `plan`)

Almost everything is still ONE `beckett ticket create`, or a `beckett plan` `--needs` DAG when the
pieces are separate and ordered. Reach for `.b` ONLY when you need something the flat DAG *provably
cannot* express:

- a **`fanout` with ≥2 `arm`s** on `isolation=worktree-each` — parallel writers on isolated branches;
- a **`join quorum k=<n>`** or **`join judge <cast>`** — converge N arms on agreement / a judge;
- a **bounded rework loop** — `onfail` back to an earlier label, fenced by `visits <n>`;
- a run **`budget usd/wall/seats`**, a **`gate human`**, or a **`statemap`** pinning nodes to columns.

If the job is a straight line of dependent steps, the DAG wins and a flow buys nothing.

```asm
;; assembles clean under `bored lint x.b` / `bored asm x.b`
init    parallel-build
entry   split
budget  usd 30
budget  seats 3
statemap review = in_review
cast    builder = claude model=claude-sonnet-5 effort=high

split:
  fanout  into=land isolation=worktree-each
  arm     builder "own the backend half"
  arm     builder "own the frontend half"
land:
  join    quorum k=2
  onpass  review
  onfail  split
review:
  gate    human
  onpass  done
  onfail  split
  visits  3
end
```

## The filing door — VERIFIED, and it does not reach my dispatcher today

A `.b` flow files through the **bored CLI**, not my path:
`bored file --title "…" --flow-script x.b`. My `beckett ticket create` / `beckett plan` path cannot
carry a flow — `CreateTicketInput` has no flow field.

I filed a trivial `.b` against the tracker to check, rather than assume. The honest finding:

- On the current bored build the `.b` assembles into a `flow` FlowSpec stored on a **bored** ticket.
- **It does NOT reach the beckett dispatcher as a flow.** My dispatcher has zero flow awareness — it
  staffs any `in_progress` ticket with one flat `implement` worker and never reads the flow, its
  statemap, or its arms.
- The tracker on `127.0.0.1:7770` today is a **pre-basm build**: it rejects `.b` at the door
  (`400 Unknown file extension ".b"`) and serves seats with `--worker /bin/false`, so bored's own
  engine cannot run the flow's workers either.

**So today a `.b` file is a reference for hand-run, hand-gated flows — not a live tool in my loop.**
Making flows first-class (bored upgraded on 7770 + a flow-aware dispatcher) is a separate ticket.
