# Browser lane benchmark & tuning — findings (#92)

> Measure first, then tune, and be honest about nulls. This note records what the
> browser lane costs on **loom-desk** (Intel i7-4790, 4c/8t, AVX2, no AVX-512,
> 31 GB RAM, headless), which levers moved the numbers, which did not, and what
> would need a change in **betterwright** (third-party, pinned 1.3.1 — not ours
> to patch here).

## The benchmark

`scripts/bench/browser-lane.ts` — run with `bun run browser:bench`.

It drives the **production** betterwright/CloakBrowser stack through the real
isolated **bubblewrap** host (`createIsolatedBrowserRuntime({ backend: "betterwright" })`)
against a local deterministic fixture served on loopback (`Bun.serve`, permitted
by the existing `NetworkPolicy({ allowLoopback: true })` — no posture change). The
scripted interaction, identical every iteration, is: **navigate → wait for a
visible node → click a button → read the DOM (×2) → screenshot**.

Reported figures:

- **cold lease acquire ms** — `acquire()` wall time (spawn host + bubblewrap +
  launch CloakBrowser + the eager warm-up).
- **warm eval ms** — min / p50 / p95 / max over the repeated scripted interaction.
- **peak RSS** — sampled over the *whole* host + CloakBrowser + renderer tree.
- **CPU-seconds** — Σ(utime+stime) across that tree.

Process accounting wraps `Bun.spawn` to capture the host child PID, then walks its
`/proc` descendant tree on a 100 ms timer. This is deliberately **tree-scoped**,
not system-wide: the box also runs an unrelated `/opt/google/chrome`, and a
system-wide `ps` would double-count it. Per-PID CPU is kept as last-observed
(utime/stime are monotonic) so a renderer that exits mid-run still shows up.

Iterations default to 6; override with `BROWSER_BENCH_ITERATIONS`.

### Fixture gotcha worth remembering

An empty sentinel `<div id="ready">` is **never "visible"**, so
`page.waitForSelector('#ready')` (default `state: 'visible'`) times out — and a
timed-out betterwright eval leaves the session wedged for subsequent evals. The
fixture waits on a visible text node (`#content`) instead. If you extend the
fixture, wait on something that renders.

## Baseline (before any change)

Two consecutive runs, load avg ~2.3:

| metric | run 1 | run 2 |
|---|---|---|
| cold lease acquire | 1683 ms | 1645 ms |
| warm eval min | 154 ms | 166 ms |
| warm eval p50 | 168 ms | 189 ms |
| warm eval p95 / max | 918 ms | 1083 ms |
| peak RSS (tree) | 1109 MB | 1105 MB |
| CPU-seconds (cold + 6 evals) | 3.95 s | 4.11 s |
| host launches | 1 | 1 |

The **p95/max is always the first warm iteration**: after `acquire()` the browser
sits on `about:blank`, so the first fixture navigation is a genuine cold page
load. min/p50 (~155–190 ms) are the true steady-state warm numbers.

**Memory is plentiful on this box; cores are the constraint** — so CPU-seconds is
the figure worth moving.

## What helped

Nothing that is applicable within the constraints. No configuration change we can
make from our side survived measurement. That is the honest result, not a
placeholder — the detail is below.

## What did not help (null results, reverted)

### Removing the eager `return page.url()` warm-up in `acquire()`

`src/browser/betterwright.ts` runs a `return page.url()` round-trip inside
`acquire()` to force the CloakBrowser launch during lease setup ("so unavailable
browser setup fails before the agent begins its turn"). Hypothesis: it serializes
a full round trip into acquire and dropping it would speed the lane.

Measured with the line removed:

| metric | baseline | no warm-up | verdict |
|---|---|---|---|
| cold lease acquire | ~1650 ms | **528 ms** | faster, but... |
| warm eval max (first eval) | ~920 ms | **3266 ms** | ...launch just moved here |
| warm eval p50 | ~168 ms | 273 ms | no better |
| CPU-seconds | ~4.0 s | **4.7 s** | **not reduced** |
| peak RSS | ~1108 MB | 1105 MB | unchanged |

The warm-up does not *do* extra work — it only forces the unavoidable
~1.1 s browser launch to happen at a known time. Removing it **relocates** that
latency from `acquire()` into the first `evaluate()` (making the first eval a 3.3 s
outlier), yields **no reduction in CPU-seconds or peak RSS** (the metrics that
matter on a core-bound box), and **forfeits the fail-fast** validation of browser
setup — a broken launch would now surface mid-turn instead of at lease setup.

**Reverted.** `betterwright.ts` is unchanged from baseline.

## What would need an upstream betterwright change

These are the real wins on a 4-core, no-GPU box, and all of them are blocked by
the same wall: **betterwright 1.3.1 exposes no passthrough for arbitrary Chromium
launch arguments.** `BetterWrightOptions` has no `args` field; internally
`worker.mjs` builds the CloakBrowser arg list solely from `managedCloakArgs()`
(`--test-type`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`,
`--fingerprint`) plus fingerprint/locale/timezone flags, and there is no env hook
in the launch path. cloakbrowser *does* accept a user `args` array
(`node_modules/cloakbrowser/dist/args.js`), but betterwright never forwards one.
So we cannot set any of the following without patching the library — which this
ticket explicitly forbids.

### 1. Kill the GPU process — highest-value item, measured

The headless CloakBrowser spawns a `--type=gpu-process` that burns **~26 % of a
core** on this box, which has **no usable GPU** — it is software SwiftShader
compositing, pure overhead for our navigate/read/screenshot workload. Observed
live in the process tree during a run (our CloakBrowser binary, not the unrelated
`/opt/google/chrome`):

```
cpu%   type
26.4   gpu-process     <- ~1/4 core, no real GPU present
25.0   renderer        <- our single fixture page
 3.1   utility
```

`--disable-gpu --disable-software-rasterizer --disable-gpu-compositing` would
reclaim that core-quarter. **Upstream ask:** a launch-args passthrough on
`BetterWright` (or a CloakBrowser "no-gpu"/low-power option). This is the single
biggest CPU win available and is entirely out of our hands today.

### 2. Renderer / raster thread caps

`--renderer-process-limit`, `--num-raster-threads`, and friends default to values
sized for many-core machines. On 4 cores they oversubscribe. Same blocker, same
fix: they ride the same missing args passthrough. Lower expected payoff than the
GPU process for our single-page workload, but free once (1) exists.

### 3. (Considered, rejected on fixed-posture grounds) warm-browser reuse across leases

Reusing one already-launched CloakBrowser across leases would erase the ~1.5 s
cold acquire **and** its launch CPU on every lease after the first — a real
recurring saving. But the isolation contract is fixed: `src/browser/isolated.ts`
runs **one host per lease and tears it down on release** specifically so escaped
JavaScript state cannot leak from one run into the next. Keeping the browser warm
across leases would weaken that boundary, so it is **not a win under the required
security posture** and was not applied. It could only become safe if betterwright
offered a per-session hard state reset provably equivalent to a fresh process —
an upstream/architecture item, not a config knob.

## Bottom line

The browser lane on loom-desk is dominated by (a) a ~1.5 s cold CloakBrowser
launch per lease and (b) a GPU process that wastes ~¼ core doing software
compositing we never look at. Both are the kind of win the ticket was after, and
both are gated on betterwright exposing a Chromium-args passthrough (or an
equivalent option). Nothing we can change from our side today moved CPU-seconds or
peak RSS, so — per the ticket's own rule — nothing was kept. The benchmark
(`bun run browser:bench`) is the durable deliverable: re-run it after any
betterwright upgrade to see if a passthrough has appeared and to re-measure.
