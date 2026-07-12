# Run of Show — design PDF build source

Source for `docs/dynamic-workflow-design.pdf` (OPS-151 rev 1 → OPS-152 rev 2).

- `index.html` — the whole document. One `.sheet` div per A4 page, manually
  paginated; every `.rf` footer carries `N / TOTAL`. All diagrams are inline
  SVG in this file — edit them directly, there is no external diagram
  toolchain. Shared SVG styles live in the `<style>` block (`svg .lbl`,
  `.box`, `.edge`, …).
- `fonts/` — vendored woff2 (Source Serif 4, Inter, JetBrains Mono) +
  `fonts.css`; the build needs no network. `fetch.ts` documents how they were
  pulled from Google Fonts.
- `build.sh` — headless Chrome print-to-pdf, writes
  `../../dynamic-workflow-design.pdf`.

Extending (v3+): add/edit `.sheet` sections, renumber footers (a
`sed 's| / 40<| / N<|g'` for the denominator), run `./build.sh`, then
rasterize and eyeball every page for overflow — sheets are fixed-height with
`overflow: hidden`, so overset text clips silently:

```sh
./build.sh
pdftoppm -png -r 50 ../../dynamic-workflow-design.pdf /tmp/page
```

Rev 2 was verified against the working tree at commit `29e4de0`; rev-1 ground
truth at `6fac13d`. If the dispatcher/driver internals have moved since,
re-verify the `file:line` receipts in §1 and §6 before extending them.
