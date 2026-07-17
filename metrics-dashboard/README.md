# Beckett — Proof of Work dashboard

Neo-brutalist, static **marketing** dashboard for Beckett — an autonomous coding agent — told
entirely in numbers and charts. Live at **https://metrics.0xbeckett.me**.

The page is the **front half** of the `metrics.0xbeckett.me` project. The **back half** is two
harvesters, each the single source of truth for its numbers:

- **Telemetry** (ticket #8, `../src/telemetry/harvest.ts`) — per-session model / cost / wall-clock
  / review-cycle rows.
- **Code stats** (ticket #26.3, `../src/code-stats/harvest.ts`) — git-history aggregates: lines,
  commits, files, per-project rollups, authorship, and daily velocity.

This app never recomputes cost, cycle counts, or LOC — it only reads, aggregates (sum/count),
and draws.

## Data flow

```
~/.claude · ~/.pi · ~/.codex · bored tracker        ~/Projects/* git history
        │  (telemetry harvester — #8)                       │  (code-stats harvester — #26.3)
        ▼                                                    ▼
data/telemetry-runs.json  (~1.6k run rows)          data/code-stats.json  (per-repo/author/day)
        └───────────────────┬────────────────────────────────┘
                            │  (scripts/prepare-data.mjs — build-time rollup, sum/count only)
                            ▼
             src/generated/metrics.json   telemetry aggregates + `codeStats` block (committed)
                            │  (vite build)
                            ▼
             dist/                          static site → metrics.0xbeckett.me
```

`prepare-data.mjs` reads both datasets, rolls them into the chart shapes plus the headline
totals, and writes `src/generated/metrics.json`. It **does not** re-derive any metric — cost
(`cost_usd`), wall-clock (`wall_clock_seconds`), review bounces (`review_cycles`) and every
code-stats figure come straight from the harvesters' rows and are only summed/counted. The
code-stats projection additionally strips local paths before publishing. Missing datasets degrade
to empty aggregates (never a crash), mirroring the harvesters' own fail-soft contract.

Point it at different datasets with `TELEMETRY_DATASET=/path/to/runs.json` and
`CODE_STATS_DATASET=/path/to/code-stats.json`.

## The page

A marketing piece, not an info panel: giant count-up hero figures (lines shipped, commits,
projects, spend, sessions, compute), a full-width commit-velocity timeline as the hero visual, a
strip of derived cost-per-outcome ratios (first-try rate, $/commit, lines/$, …), then a grid of
charts. Numbers count up on load and charts draw in — fast, and skipped under
`prefers-reduced-motion`. `src/derived.ts` computes the marketing projections; `src/motion.tsx`
holds the count-up hook and reveal wrapper.

## Charts

All views render with [**dither-kit**](https://www.tripwire.sh/dither-kit) (`@dither-kit/*`,
installed into `src/components/dither-kit/`). Each card is monochromatic (one palette colour) to
stay legible:

| View | Source | dither-kit component |
|------|--------|----------------------|
| Commit velocity (daily, hero) | code stats | `AreaChart` |
| Lines per project (top 8) | code stats | `BarChart` |
| Authorship (commits, top 7) | code stats | `BarChart` |
| API cost per model (USD) | telemetry | `BarChart` |
| Runs per day | telemetry | `AreaChart` |
| Wall-clock per model (hours) | telemetry | `BarChart` |
| Review-cycle distribution | telemetry | `BarChart` |
| Hero-stat sparklines | both | `Sparkline` |

## Develop / build

```sh
bun install
bun run prepare-data   # regenerate src/generated/metrics.json from the harvester dataset
bun run dev            # local dev server
bun run build          # → dist/ (runs prepare-data first)
bun run typecheck
```

To refresh the whole picture: re-run both harvesters in the repo root — `bun run
telemetry:refresh` (→ `data/telemetry-runs.json`) and `bun run code-stats:refresh` (→
`data/code-stats.json`) — then `bun run build` here.

## Deploy

Static build, served on `127.0.0.1:8971` by a durable `systemd --user` unit and exposed through
Beckett's Cloudflare tunnel.

```sh
# 1. build + stage
bun run build
cp -r dist /home/beckett/.local/share/beckett-metrics/dist

# 2. durable server (unit source: deploy/beckett-metrics.service)
cp deploy/beckett-metrics.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now beckett-metrics.service

# 3. tunnel + DNS (creates both) and verify
beckett deploy metrics --port 8971
curl -fsS -o /dev/null -w '%{http_code}\n' https://metrics.0xbeckett.me   # → 200
```

To redeploy after a data/code change: rebuild, re-copy `dist` into the staged dir, then
`systemctl --user restart beckett-metrics.service` (the tunnel rule is unchanged).

## Known data notes (flagged, not patched — see #8, out of scope here)

- **Opus dominates** both spend (~$871 of ~$1.1k) and wall-clock (~654h). The linear bars make
  the other five models look tiny — that is the honest shape of the data; exact values are on
  hover.
- **Rate estimates:** Claude `*-5`/`4-8` labels have no exact public SKU, so their cost is an
  estimate. The harvester marks these `rate_estimate: true`; the cost card footnotes which
  models are estimated.
- Anything that looks wrong is a harvester concern — flag it there, don't patch it in the UI.
