# E2E harnesses

## Ambient interjection rollout (OPS-68 / T4)

The offline harness is:

```sh
bun scripts/e2e/ambient-interjection-e2e.ts
```

It uses fake normalized gateway messages plus stubbed triage/model/Discord so it exercises the full ambient pipeline without live services.

Rollout remains opt-in. The deploy example and schema defaults ship with `proactivity.enabled=false`, `default_mode="off"`, and no channel overrides. When Jason is ready, manually enable the master switch for the live daemon, flip exactly one channel to `suggest`, watch the `ambient triage verdict` logs for a few days, tune `triage_threshold` and `src/concierge/triage.md`, and only then consider owner-gated `auto` for a channel. Do not change repo defaults to on.
