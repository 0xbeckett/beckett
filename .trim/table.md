#### The quick table

| Work is mostly… | implement | effort | review |
|---|---|---|---|
| **Backend / systems, spec is really specific** | `pi` | `medium` | default (don't cast) |
| **Backend / systems, spec leaves decisions** | `pi` | `high` | default (don't cast) |
| **Frontend / UI / design / taste** | `claude` (Opus) | `high` + `"reviewTier":"self"` | none (one-pass) |
| **Judgment-heavy / fuzzy spec** | `claude` (Opus) | `high` (`xhigh` if truly hard) | default (don't cast) |
| **Long ticket, risk is missing work** | best fit of the above | per model | `pi` @ `high` (criteria vs reality) |
| **Correctness-critical / hard-to-reverse / touches Beckett itself** | best fit of the above | `high`–`xhigh` | `claude-fable-5` @ `high` — **confirm with the human first** |
