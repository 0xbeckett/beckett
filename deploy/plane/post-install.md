# Plane Post-Install Checklist

1. Open `https://plane.0xbeckett.me`.
2. Create the first Plane account.
3. Create a Workspace:
   - Slug: `beckett`
4. Create a Project:
   - Slug: `ops`
5. Generate a personal API token:
   - Go to `Settings > API Tokens`.
   - Create and store the token for Beckett automation.
6. Configure the project workflow States exactly as follows:

| Name | Group |
| --- | --- |
| Backlog | backlog |
| Todo | unstarted |
| In Progress | started |
| In Review | started |
| Done | completed |
| Cancelled | cancelled |

## Issue Description Convention

Beckett stores per-stage harness casting in each Plane issue description as a fenced `beckett-cast` JSON code block, followed by an `## Acceptance criteria` section with bullet items.

Example:

````markdown
```beckett-cast
{
  "stage": "example",
  "harness": "example-harness",
  "command": "bun test"
}
```

## Acceptance criteria

- The harness runs successfully.
- The result is recorded on the issue.
````
