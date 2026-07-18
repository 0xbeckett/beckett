---
name: jason-design-taste
description: >
  Jason hates AI-slop design (walls of text, neon glow, card grids); wants experience-first, editorial, awwwards-tier craft
metadata:
  type: feedback
  created: 2026-06-29T05:24:40.304Z
  updated: 2026-06-29T05:24:40.304Z
  source: conversation
---

[[jason]]'s design taste, learned when I rebuilt the [[beta-access-gate|0xbeckett.me]] site (2026-06-28). He rated my first attempt a **2/10** and called it "AI slop."

**What he reacts to:** walls of marketing text, generic-AI-site tells — dark theme + neon glow, three-column feature-card grids, metric counters, "Not X. A Y." copy, centered hero + two buttons. That whole median-landing-page look reads as cheap/slop to him.

**What he wants:** experience-first design. Cut ~80% of copy, commit to ONE strong idea (type-as-hero or one signature motion), real craft (smooth scroll, custom cursor, magnetic buttons, staggered reveals), editorial typography (a real display serif/grotesque, not Inter), strict spacing, unexpected palette. He references **awwwards.com** (2018-2023 era) as the bar — aim for award-tier, ~6/10+ minimum.

**What landed (the same site, iterated to 7/10):** a clean modern **SaaS/devtools product aesthetic** (Space Grotesk + Inter, near-black + a sharp accent, subtle product glow, bento grid, animated mark) beat the editorial-serif look once it was framed as a real product. The winning ratings tracked: 2/10 (slop) → 4/10 (less text, still preachy + editorial theme he didn't love) → 7/10 (SaaS reframe, animated SVG, matter-of-fact copy). His specific dials:
- **No eyebrow/kicker labels above headers, no badge "pills"** — he finds them slop-coded. Lead sections with the headline.
- **Copy must be matter-of-fact + product-voice, never preachy/manifesto.** Then lightly **gen-z coat** it (tasteful: "no cap", "built different", "locks in", "in your bag", "unlike your last intern") — he explicitly likes a bit of meme personality.
- **Never sell what isn't shipped** — gate unbuilt tiers/features as "Coming Soon", not selectable.
- He gives numeric ratings and crisp, specific deltas — implement them literally.

**How to apply:** when building anything user-facing, default to restraint + craft over copy. Show, don't tell. For product/marketing sites specifically, go SaaS-clean (Linear/Vercel/Railway energy) with a touch of gen-z voice. Self-screenshot with headless chrome (incl. `--force-prefers-reduced-motion` + a tall window for full-page) and judge it before delivering.
