# Beckett — Model Metrics dashboard

Neo-brutalist, static dashboard of Beckett's own model performance. Live at
**https://metrics.0xbeckett.me**.

It is the **front half** of the `metrics.0xbeckett.me` project. The **back half** is the
telemetry harvester (ticket #8, `../src/telemetry/harvest.ts`), which is the single source of
truth for the numbers. This app never recomputes cost or cycle counts — it only reads,
aggregates (sum/count), and draws.

## Data flow

```
~/.claude · ~/.pi · ~/.codex · bored tracker
        │  (harvester — ticket #8)
        ▼
data/telemetry-runs.json          one normalized row per run (~1.6k rows)
        │  (scripts/prepare-data.mjs — build-time rollup, sum/count only)
        ▼
src/generated/metrics.json        tiny per-model / per-day aggregates (committed)
        │  (vite build)
        ▼
dist/                             static site → metrics.0xbeckett.me
```

`prepare-data.mjs` reads `../data/telemetry-runs.json`, rolls it into the four chart shapes plus
the headline totals, and writes `src/generated/metrics.json`. It **does not** re-derive any
metric — cost (`cost_usd`), wall-clock (`wall_clock_seconds`) and review bounces
(`review_cycles`) come straight from the harvester's rows and are only summed/counted. Missing
fields degrade to skips (never a crash), mirroring the harvester's own fail-soft contract.

Point it at a different dataset with `TELEMETRY_DATASET=/path/to/runs.json`.

## Charts

All four required views render with [**dither-kit**](https://www.tripwire.sh/dither-kit)
(`@dither-kit/*`, installed into `src/components/dither-kit/`):

| View | dither-kit component |
|------|----------------------|
| API cost per model (USD, current rates) | `BarChart` |
| Wall-clock per model (hours) | `BarChart` |
| Review-cycle distribution (implement→review bounces) | `BarChart` |
| Runs over time (daily) | `AreaChart` |

dither-kit natively covers every chart type this dashboard needs, so **no fallback substitution
was required**. Each card is monochromatic (one palette colour) to stay legible and uncluttered.

## Develop / build

```sh
bun install
bun run prepare-data   # regenerate src/generated/metrics.json from the harvester dataset
bun run dev            # local dev server
bun run build          # → dist/ (runs prepare-data first)
bun run typecheck
```

To refresh the whole picture: re-run the harvester (`bun run telemetry:refresh` in the repo
root) to rebuild `data/telemetry-runs.json`, then `bun run build` here.

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
