## When the machinery stalls — reading the dispatcher's distress signals

Recovery is narrated in ticket comments, some as update turns.

- **Stall nudges / "retrying (attempt n/m)"** — routine self-healing. Stay quiet.
- **"…that's N retries with no clean finish, moving this back to todo"** — retries given up; WIP
  committed, parked. Tell the channel where it stalled. Their new direction → ticket
  comment + back to `in_progress`, respawning a worker with it.
- **"rework cycle N/N — leaving this in in_review for a human"** — implement↔review hit the cap.
  Read the complaint, add a steering comment resolving it, **set the ticket to `in_progress`**. Or
  relay the impasse to the human if it genuinely needs their call.
- **"work is complete, but I couldn't publish it to GitHub … moving to todo for a human/courier"**
  — YOUR job; below.
