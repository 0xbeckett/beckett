# Telemetry harvester

`data/telemetry-runs.json` is the dashboard's single, committed input. It is a flat JSON
object whose `runs` array contains one normalized session run per row. Regenerate it with:

```sh
bun run telemetry:refresh
```

The command writes the file atomically enough for a static-dashboard rebuild (one complete
JSON write), prints skips to stderr, and exits after every readable source has been considered.
It does not contact any model provider.

## Row contract

Each row has `run_id`, `session_id`, `task_id` (or `null` when the transcript does not identify
a ticket), `harness`, `model`, `timestamp`, `wall_clock_seconds`, `cost_usd`,
`review_cycles`, `tokens`, and `rate_estimate`. `timestamp` is the start of the transcript;
wall clock is its first-to-last logged timestamp. `review_cycles` is the number of tracker
transitions from implementation (`in_progress` / `beckett_implement`) to review
(`in_review` / `beckett_review`) for that task.

## Sources

- **Claude Code:** `~/.claude/projects/**/*.jsonl`. Assistant API message usage is summed;
  duplicate entries for one Claude message id are counted once.
- **pi:** `~/.pi/agent/sessions/**/*.jsonl`. Assistant response usage (`input`, `output`,
  cache reads/writes) is summed. The model selected by `model_change` is used when a message
  does not repeat it.
- **Codex:** `~/.codex/sessions/**/*.jsonl`. Codex's `token_count` events are cumulative, so
  the harvester uses only the final `total_token_usage` snapshot, rather than summing every
  progress event.
- **bored tracker:** `~/.local/state/bored/runs/*.jsonl` (override with `BORED_STATE_DIR`).
  These are the durable event journals behind the loopback bored API that Beckett's
  `src/bored/client.ts` talks to. They supply review-cycle counts; they are deliberately not
  inferred from agent prose.

For fixture/recovery runs, source locations can be overridden without changing code:

```sh
bun run telemetry:refresh -- --claude-dir /tmp/claude --pi-dir /tmp/pi \
  --codex-dir /tmp/codex --bored-state-dir /tmp/bored --output /tmp/runs.json
```

Missing directories, malformed JSON lines, missing usage, an unknown model, and unreadable
files are all skipped with a `[telemetry]` stderr note. Thus a machine with no pi or Codex
history still produces a valid dataset. A row is skipped when it has no trustworthy model,
usage, or timestamps; costs are never invented as zero.

## Pricing and known gaps

All cost calculations use only `config/model-rates.json`, a dated table expressed in USD per
million tokens. The harvester recomputes cost from the recorded token categories; it does not
trust any runtime-provided dollar total. Cache reads and writes are priced separately.

Some requested runtime labels (the Claude `*-5`/`4-8` labels and generic Codex `gpt-5.6`) do
not have an exact public SKU. Their rate-table entries have `estimate: true` and a specific
reason/source. The UI can expose `rate_estimate` to distinguish them. Historical rows are
reproducible against the committed table date, but changing the table intentionally changes a
rebuild's historical estimates.

To add a model, add one lower-case key to `models` in `config/model-rates.json` with `input`,
`output`, `cache_read`, and `cache_write` rates, `estimate`, and a source note. Values are USD
per million tokens. Then rerun `bun run telemetry:refresh`; unknown models are reported rather
than silently priced.
