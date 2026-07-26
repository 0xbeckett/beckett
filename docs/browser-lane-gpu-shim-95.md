# Browser lane `--disable-gpu` shim — negative result (#95)

> Follow-on to [#74.2 findings](./browser-lane-benchmark.md). #74.2 concluded
> "nothing on our side moves it" because betterwright exposes no Chromium-args
> passthrough on the managed CloakBrowser path. That conclusion was too strong:
> there **is** a local lever (`CLOAKBROWSER_BINARY_PATH`), and #95 was to test it.
> This note records the test and its result. **The lever works; the win does not
> exist. The code was fully reverted; only this writeup remains.**

Measured on **loom-desk** (Intel i7-4790, 4c/8t, no GPU, headless), `bun run
browser:bench`, betterwright 1.x driving the managed CloakBrowser (chromium
**146.0.7680.177.5**, free tier — the box has no betterwright chromium fork, so
`resolveChromiumForkBinary()` returns null and the managed CloakBrowser path runs).

## The lever, and that it fires

`node_modules/cloakbrowser/dist/config.js::getLocalBinaryOverride()` returns
`process.env.CLOAKBROWSER_BINARY_PATH` verbatim, and `playwright.js::launchPersistentContext`
uses it as `executablePath` (`process.env.CLOAKBROWSER_BINARY_PATH || ensureBinary(...)`).
So pointing it at a shell shim that `exec`s the real chrome with flags prepended
injects args betterwright will not pass — no patching of betterwright or cloakbrowser.

The prototype wired an opt-in `BECKETT_BROWSER_DISABLE_GPU` knob in
`src/browser/isolated.ts`: resolve the real binary from the cloak cache dir, write a
`#!/bin/sh … exec "<real chrome>" --disable-gpu --disable-software-rasterizer "$@"`
shim under the (sandbox-bound) profile dir, and export `CLOAKBROWSER_BINARY_PATH`
into the bubblewrap host.

**It fires.** With the knob on, the live chrome argv (captured from `/proc` during a
real bench run, scoped to the bench's own profile tree) was:

```
/home/beckett/.cloakbrowser/chromium-146.0.7680.177.5/chrome --disable-gpu --disable-software-rasterizer --disable-field-trial-config …
```

`argv[0]` is the real chrome (not the shim) — `exec` replaced the process, so the
pid/process-group/signal behaviour betterwright relies on to kill the browser is
unchanged. The bench ran end to end every time: page loaded, screenshot rendered
non-blank, scripted interaction returned its non-zero sentinel, no new stderr.

## The measurements (n=4 each, bench alone, no probe overhead)

| Metric                    | Baseline (off) | Shim on (`--disable-gpu`) | Δ                         |
|---------------------------|---------------:|--------------------------:|---------------------------|
| cold-launch ms            |         1601.3 |                    1819.8 | **+218 ms (~14% worse)**  |
| steady-state eval p50 ms  |          182.0 |                     181.2 | ~0 (noise)                |
| peak RSS MB               |         1107.5 |                    1039.5 | −68 MB (~6% lower)        |
| total CPU-seconds / run   |           4.13 |                      4.31 | +0.18 (no win / noise)    |
| **gpu-process CPU-s**     |         **0.23** |                  **0.25** | **~0 — gpu-process persists** |

gpu-process CPU is a separate tree-scoped `/proc` probe filtering chrome children
by `--type=gpu-process` under the bench profile (the box also runs an unrelated
`/opt/google/chrome`, whose long-lived gpu-process must be excluded — it was; an
early un-scoped probe read ~5000 CPU-s of that external process and was discarded).

## Why it is a null (two independent reasons)

1. **`--disable-gpu` does not remove the gpu-process on chromium 146.** The
   process is still spawned; its CPU is unchanged (0.23 → 0.25 CPU-s). Modern
   Chromium keeps a gpu-process for display-compositor coordination even when
   hardware acceleration is disabled — `--disable-gpu` switches it to a
   software/no-accel path, it does not kill it. The mechanism #74.2 assumed
   ("killing it needs `--disable-gpu`") does not hold.

2. **The gpu-process was never the CPU hog.** Over a whole run it costs ~0.24
   CPU-s — ~6% of the ~4 CPU-s total, not "~¼ core". In the bench workload the
   `browser/main` process (~1.1–1.25 CPU-s) dominates. #74.2's "~26% of a core"
   was a peak instantaneous reading on a compositing-heavy moment, not a per-run
   cost, and it is not addressable by this flag regardless.

Net: **no CPU win, cold-launch regresses ~14%** (the extra `sh`→`exec` hop plus a
different GPU-init path), steady-state flat. The only repeatable positive is ~6%
lower peak RSS (SwiftShader / software-rasterizer buffers not allocated) — real but
small, and not worth a slower, more complex launch.

## Viewport tradeoff the ticket flagged: a no-op here

cloakbrowser treats an override binary as unknown-version and stays on the
conservative `DEFAULT_VIEWPORT` (1920×947) instead of the headless-no-viewport
optimization. On this box that changes nothing: the optimization is gated on
chromium ≥ 148 (`HEADLESS_NO_VIEWPORT_MIN_VERSION`), and the installed binary is
**146**, so the un-shimmed lane already used `DEFAULT_VIEWPORT`. Separately,
betterwright's `managedCloakViewport()` keys off `cloakBinaryInfo()`, which
resolves version/tier from the cache dir and **ignores** `CLOAKBROWSER_BINARY_PATH`
entirely — so the override cannot perturb its viewport choice either. Viewport
stayed coherent and non-zero throughout (screenshots rendered correctly).

## Decision

Per the ticket's own rule — revert if the win is not meaningful or anything
regresses — the shim code (`src/browser/isolated.ts`, `src/browser/isolated.test.ts`)
was **fully reverted**. No opt-in knob was kept: it provides no benefit and
regresses cold-launch, so leaving dead launch machinery in a security-sensitive
path is not justified. This document is the deliverable.

## If revisited later

- The shim route itself is sound and reusable — the block is chromium's behaviour,
  not the plumbing. If a future chromium/cloakbrowser genuinely idles the
  gpu-process only under a *different* flag (e.g. `--disable-gpu-compositing`,
  `--in-process-gpu`, or `--disable-features=…`), re-test with the same shim and
  `bun run browser:bench` + the tree-scoped `--type=` CPU probe described above.
- The larger recurring cost remains the ~1.6 s per-lease cold launch (unchanged
  from #74.2); it is gated on warm-browser reuse, which the one-host-per-lease
  isolation contract forbids without an upstream per-session hard reset. That is
  the lever worth chasing, not the gpu-process.
