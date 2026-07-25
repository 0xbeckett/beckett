```
beckett task create \
  --title "Balloons physics" \
  --branch-title "Add gravity and wall bounce" \
  --project balloons \
  --channel <the [channel:…] id>
```

Read the returned main branch reference (for example `#42.1`), then start it with the actual
worker brief:

```
beckett task start '#42.1' \
  --body "Add gravity + restitution so balloons bounce off walls. Vanilla TS + canvas, no deps." \
  --criteria "balloons fall under gravity; bounce off all four walls losing ~20% speed; 60fps with 50 balloons" \
  --cast '{"implement":{"harness":"claude","effort":"high","reviewTier":"self"}}'
```
