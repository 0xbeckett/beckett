# BetterWright 1.5.1 → 1.6.1 idle benchmark rerun (#162)

Run on 2026-08-01 on `loom-desk` (Linux 6.17, 8 logical CPUs), using a fresh
BetterWright process for every sample. Both package installs resolved
`cloakbrowser@0.4.10` and `playwright-core@1.61.1`; the browser on this host was
CloakBrowser Chromium `146.0.7680.177.5`.

## Raw results

Each sample opened five `data:` pages containing 200 boxes animated by a
`requestAnimationFrame` loop. `idle CPU` is the CPU used by the complete
BetterWright/Bun/browser descendant tree during a 12-second window that began
four seconds after the last eval. `RSS` is the final aggregate resident memory
of that tree at the end of that window. `tab open` includes launch and
sequentially navigating all five tabs. `eval` is the arithmetic mean of ten
back-to-back `page.evaluate(() => document.title)` BetterWright round trips.

| version | trial | idle CPU % | RSS MB | tab-open ms | eval round-trip ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1.5.1 | 1 | 1.083 | 897.863 | 803.258 | 6.522 |
| 1.5.1 | 2 | 1.000 | 903.309 | 795.528 | 7.033 |
| 1.5.1 | 3 | 1.167 | 903.977 | 762.700 | 6.965 |
| **1.5.1 mean** | **3 trials** | **1.083** | **901.716** | **787.162** | **6.840** |
| 1.6.1 | 1 | 1.833 | 902.387 | 753.799 | 6.687 |
| 1.6.1 | 2 | 1.167 | 900.895 | 748.533 | 7.851 |
| 1.6.1 | 3 | 1.000 | 904.418 | 897.723 | 9.868 |
| **1.6.1 mean** | **3 trials** | **1.333** | **902.567** | **800.018** | **8.135** |

The observed samples do not show the changelog's claimed idle-CPU reduction:
the 1.5.1 baseline is already only about 1% of one CPU, and the three-sample
mean is slightly higher for 1.6.1. The sample count and host noise make the
small differences non-actionable; they are reported rather than rounded away.

## Methodology caveats

- This workload is probably **insensitive to the claimed win**. Chromium can
  throttle/occlude background tabs, so sequentially opened headless tabs are
  not proof that five independent foreground frame loops were running. That is
  consistent with the unexpectedly low 1.5.1 baseline versus the changelog's
  approximately 110% five-tab example. The test did wait four seconds, which
  exceeds 1.6.1's 750 ms parking delay, but it did not independently verify
  each target's CDP parking state.
- `tab-open` deliberately includes cold launch; it is not a warm-tab metric.
  The ten evals were measured immediately after opening the tabs—there was no
  separate unmeasured eval warm-up. The CPU interval itself does exclude setup
  and includes a four-second settle period.
- Samples were alternated 1.5.1/1.6.1 to reduce drift, but were not CPU-pinned
  or run on an otherwise idle machine (one-minute load average ranged from
  2.22 to 3.20). The numbers are tree-scoped, so unrelated system Chrome
  processes were not counted, but host scheduling noise remains.
- RSS is aggregate RSS, so shared pages are counted per process as Linux RSS
  reports them; it is not proportional-set-size memory. All six trees contained
  ten processes. Three samples per version are enough to preserve the null
  observation, not to establish a small regression.
