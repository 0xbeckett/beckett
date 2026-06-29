---
name: site
description: Use to edit and deploy Beckett's OWN public website at 0xbeckett.me (the apex/landing site, served from Cloudflare's edge). Edit files in web/public, then `beckett site deploy`. This is for the main apex site only — for throwaway mockups at <name>.0xbeckett.me use the deploy skill (tunnel) instead.
---

# site

`0xbeckett.me` is your own landing site. It's a **Cloudflare Worker (edge static assets)** — served
from Cloudflare's edge, not the tunnel, so it's up even when loom-desk isn't. You can edit it and
ship it yourself.

## Two different things — don't confuse them

| Thing | What | Tool |
|---|---|---|
| **Your apex site** (`0xbeckett.me`, `www`) | your permanent landing page, edge-deployed | **this skill** — edit `web/`, `beckett site deploy` |
| **A throwaway mockup** (`<name>.0xbeckett.me`) | a quick prototype you throw up off a chat | [[deploy]] — `beckett deploy <name> --port <p>` (tunnel) |

If someone says "update the site / the landing page / 0xbeckett.me" → this skill. If it's "throw a
mockup up" → [[deploy]].

## Editing + shipping

1. The site lives in **`~/beckett/web/`**: static files in `web/public/` (`index.html`,
   `beckett.svg`, assets), the edge worker in `web/src/index.js` (only does `www`→apex 301; the
   rest is static), config in `web/wrangler.jsonc`.
2. Edit `web/public/...` with your normal tools. Preview the HTML by eye; keep it one cohesive page.
3. Deploy:
   ```
   beckett site deploy
   ```
   That runs `wrangler deploy` for you with the Cloudflare token injected from `~/.beckett/.env`
   — it **never** needs `wrangler login`. Returns `{ deployed, urls, log }`. Check `urls`.
4. **Commit it** (`git add -A && git commit -m "site: <what>"` then push) — the repo is the source
   of truth for the site.
5. Verify: `curl -sI https://0xbeckett.me` → `200`, and `https://www.0xbeckett.me` → `301` to apex.

## Rules

- **Never run `wrangler login`** (it's interactive and will hang/fail headless). Never paste the
  Cloudflare token anywhere. `beckett site deploy` already has it.
- **Don't touch `web/wrangler.jsonc` routes** unless you mean to change which domains the site
  owns. It claims exactly `0xbeckett.me` + `www.0xbeckett.me` — adding a `*.0xbeckett.me` route
  would hijack your tunnel mockups. Leave the routes alone.
- This is an **outward** change (your public face) but reversible (git + redeploy). Ship sensible
  edits freely; for a big rewrite/redesign, it's worth a quick heads-up in channel first.
- If `beckett site deploy` errors with **"no CLOUDFLARE_API_TOKEN"**, the credential isn't in
  `~/.beckett/.env` — say so plainly, don't try to re-auth.
