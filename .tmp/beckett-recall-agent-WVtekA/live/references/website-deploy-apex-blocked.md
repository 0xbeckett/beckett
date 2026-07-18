---
name: website-deploy-apex-blocked
description: >
  0xbeckett.me apex is a CF Worker I can't deploy to (token 403 on Workers, apex DNS read-only); use wrangler deploy or tunnel-detach
metadata:
  type: reference
  created: 2026-06-29T05:24:40.427Z
  updated: 2026-06-29T05:24:40.427Z
  source: conversation
---

The website source lives in `web/` of [[github-identity|0xbeckett/beckett]] (Cloudflare Worker `beckett-frgmt`, static assets in `web/public`, `wrangler.jsonc` routes it to **0xbeckett.me** + beckett.frgmt.xyz).

**Correction (2026-07-07):** my `CLOUDFLARE_API_TOKEN` DOES have Workers Scripts:Edit — I deployed a brand-new Worker `beckett-tv` to **tv.0xbeckett.me** via plain `wrangler deploy` (custom domain provisioned, 24MB video asset uploaded, live). So I CAN ship net-new subdomain Workers myself. The apex block below is specific to the apex record being owned/managed by the existing `beckett-frgmt` Worker, NOT a token-scope problem.

**Constraint I hit (2026-06-28):** I CANNOT deploy to the apex `0xbeckett.me` — the apex DNS record is **read-only/Workers-managed** (`beckett dns rm` → error 1043; `beckett deploy 0xbeckett.me` → error 81062). The apex is owned by the `beckett-frgmt` Worker.

**To ship the apex, one of:** (1) someone runs `cd web && npx wrangler deploy` — recommended, the Worker already serves web/public; (2) remove the 0xbeckett.me custom domain from the beckett-frgmt Worker, then I can `beckett deploy 0xbeckett.me` via the tunnel; (3) add Workers Scripts:Edit to my CF token. I CAN freely deploy `<name>.0xbeckett.me` previews via `beckett deploy` (tunnel) — e.g. pitch.0xbeckett.me.

[[github-identity]]
