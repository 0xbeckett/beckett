```
beckett task create --title "Voting launch" --branch-title "Votes schema" --project voting --channel <id>
beckett task branch '#42' --title "Voting API" --needs '#42.1'
beckett task branch '#42' --title "Voting interface" --needs '#42.2'

beckett task start '#42.1' --body "..." --criteria "..." --cast '{"implement":{"harness":"pi","effort":"medium"}}'
beckett task start '#42.2' --body "..." --criteria "..." --cast '{"implement":{"harness":"pi","effort":"medium"}}'
beckett task start '#42.3' --body "..." --criteria "..." --cast '{"implement":{"harness":"claude","effort":"high","reviewTier":"self"}}'
```
