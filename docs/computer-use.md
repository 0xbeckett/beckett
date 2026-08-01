# Computer use

Beckett runs a full desktop errand — book the flight, fill the form, read the dashboard — as an
ordinary [Job](orchestration.md) with `runner='agent'`. What's different from a code Job is the
observation channel: instead of reading source files, a computer-use Job reads a screen, and
screens are expensive to read. Pixels cost roughly 1,000–4,800 input tokens *per glance*; a fully
pixel-driven 25-step errand runs $0.30–$1.00 even with aggressive caching. That's fine for one
errand a week. It is not fine as the default execution mode for an AI coworker that is supposed to
run computer errands the way it runs code errands — cheaply, constantly, without a human noticing
the bill.

This document is the library design that keeps computer use cheap: a strict escalation ladder from
free JSON to last-resort pixels, a set of token-cutting techniques applied at each rung, the native
Hyprland toolbox that makes the cheap rungs possible, and the module list to build. It is v1 law —
new errand code is written against this ladder, not against the pixel loop directly. Every rung's
cost lands in the [Event ledger](orchestration.md#2-the-unit-of-work) exactly like any other Job's
spend; there is no separate computer-use accounting.

See [betterwright.md](betterwright.md) for the browser lane in full (BetterWright is layer L1 of
the ladder below) and [omarchy.md](omarchy.md) for how Beckett's headless Hyprland account is
provisioned (the desktop this library drives). See [token-efficiency.md](token-efficiency.md) for
the token-cutting techniques that apply repo-wide; this document is where they get applied to
screens specifically.

---

## 1. Why pixels are the expensive channel, not the only one

The instinct for "computer use" is a screenshot loop: observe, click, observe again. That loop is
now *accurate* — Claude's OSWorld score climbed from 42.2% (Sonnet 4) to 81.2–81.7% (Sonnet 5 /
Opus 4.8), past the ~72% human baseline — so the case against pixels-as-default is not capability,
it's cost and determinism:

| Cost item | Tokens |
|---|---|
| Computer-use system-prompt overhead | 466–499 |
| Tool definition (Claude 4.x) | 735 |
| Screenshot, 1024×768 | ~1,050 |
| Screenshot, 1280×800 | ~1,365 |
| Screenshot, high-res ceiling (2576px long edge) | up to ~4,784 |

Every one of those tokens is paid *again* on every step of a multi-step errand, because the
observation changes every step — screenshots don't compress into the cached prefix the way a
frozen system prompt does. A 25-step full-desktop errand runs 120K–250K tokens even with batch
pruning, mostly cache-read but still real spend and real latency.

Two cheaper channels exist and cover most of what an errand needs:

- **Structured queries that were never pixels to begin with.** `hyprctl clients -j` returns exact
  window geometry, titles, focus state, and app class as ~300–800 tokens of JSON — a free "desktop
  AX-tree" at the window level. An API call answers "what's on the calendar" without ever opening
  a browser. Always check whether the answer is a command away before reaching for a screen.
- **Accessibility trees** (ARIA snapshots in the browser, AT-SPI on the Linux desktop) describe
  *semantic* structure — role, name, state, stable reference handles — at 0.2K–10K tokens
  depending on distillation, 5–50× cheaper than the equivalent screenshot and far more
  deterministic: an AX ref doesn't drift if the theme changes, a coordinate does.

And a third channel beats both: **code as action**. Beckett already runs this pattern in
production — BetterWright's `betterwright_browser` MCP tool lets the model write Playwright-style
JavaScript against a persistent, policy-guarded Chromium instead of emitting one tool call per
click. A script performs N actions for one generation; only the distilled return value re-enters
the transcript. Anthropic's own "code execution with MCP" post quantifies the general version of
this shift at 150K → 2K tokens (98.7%) for a representative task; CodeAct measures +20 points
success and ~30% fewer actions/turns versus JSON tool-calling on the general benchmark; a 2026
independent measurement (Bug0) found the same task cost ~114K tokens over Playwright MCP's
step-wise interface versus ~27K over a code/CLI path. Code-as-action isn't a browser-only trick —
it's the reason BetterWright sits above the AX tree in the ladder below, not beside it.

Pixels are real and necessary — canvas/WebGL apps, games, custom-drawn UI, and final visual
verification have no AX tree to read. The design consequence is not "avoid pixels," it's "pixels
are a verification and repair channel, reached last, cropped to the smallest region that answers
the question."

---

## 2. The escalation ladder (v1 law)

Every computer-use errand starts at the top of this table. Each rung's *failure condition* — not
its cost — is what triggers the next rung. A sonnet-class planner chooses the entry layer for a
new errand; a haiku-class executor runs steps within a chosen layer and only escalates on repeated
failure.

| Layer | Channel | Observation | Typical per-step cost | Escalate when |
|---|---|---|---|---|
| **L0** | CLI / API / `hyprctl` / `wl-paste` / `makoctl` | JSON or text | 10s–100s tokens | No API/command answers the question |
| **L1** | **BetterWright JS** — persistent browser, code-as-action | script result + optional ARIA snapshot | one generation per script | The errand needs a browser and either isn't scripted yet or a cached script's precondition hash no longer matches |
| **L2** | AX-tree, interactive — browser ARIA snapshot+refs, or desktop AT-SPI `perform_action`/`set_value` | distilled tree, 0.3–5K first read, diffs after | 0.5–2K in / ~100 out | Unknown flow the model can't script blind (no prior snapshot to write against), or a native GTK/Qt/Electron app with no browser at all |
| **L3** | Pixels, **cropped to the target window** (`grim` + `hyprctl` geometry, or toplevel-export for occluded windows) | ~0.4–1.4K/frame | 1–2K/step | Canvas/WebGL/game/custom-drawn UI with no usable AX tree; verifying a visual claim; a click missed and needs `zoom`-grade detail |
| **L4** | Full-desktop pixel loop (Anthropic computer-use tool proper) | 1.0–1.8K/frame | 1.5–3K/step | Orientation is lost, the errand spans multiple windows/apps in a choreography no single crop covers, or every layer above has failed twice |

This is a strict order, not a menu: a script writer never opens the full computer-use tool because
it's "easier" — it reaches L1 first and only drops to L2 when the flow is genuinely novel. Two
rules keep the ladder honest:

- **Observe cheap before observing expensive.** `hyprctl clients -j` (near-free) before an AT-SPI
  slice, before a cropped `grim`, before a full-desktop `grim`. Never screenshot to answer a
  question `hyprctl` or the clipboard can answer.
- **Wait on events, not polls.** Hyprland's IPC socket2 pushes window open/close/focus/title
  events; Mako's notification history (`makoctl history`) is machine-readable; BetterWright's page
  events fire on navigation. All three replace screenshot-until-changed loops — a poll loop is
  itself a token-cost bug, independent of which layer it polls.

### 2.1 Why L1 sits above L2, not beside it

The instinct is "AX tree first, code second" because a tree is a read and a script is an action.
That's backwards for cost: step-wise AX interaction still pays (observation + reasoning + action) ×
N turns, with the transcript re-read each turn. A BetterWright script performs the same N actions
for one generation plus one result payload — the code-as-action collapse from §1 applies whether
or not an AX tree exists. L2 is for the case L1 can't yet handle: a flow novel enough that the
model can't write a script blind. The synthesis in [betterwright.md §5](betterwright.md) covers
this in full; the summary for this ladder is: feed the model one ARIA snapshot before it writes a
script (so it isn't guessing selectors), cache the working script keyed on a DOM-shape hash, and
fall back to L2 step-mode only after two failed script attempts on the same flow.

### 2.2 Model routing across the ladder

Casting follows the orchestration doc's cast table (§3.13): haiku-class executes L0–L2 steps and
macro replays; sonnet-class writes BetterWright scripts, plans multi-step errands, and takes over
after two consecutive executor failures; opus-class is reserved for gnarly multi-app choreography
or an explicit request. Keep haiku off L4 entirely — if an errand degrades to full-desktop pixels,
it has already escalated past the point where the cheap executor is doing useful work, and haiku
4.5 additionally needs the older `computer-use-2025-01-24` tool version rather than the current
beta, which is one more reason not to hand it the full pixel loop.

---

## 3. Token-cutting techniques, and where the library applies them

Each technique below is a concrete module-level rule, not a general aspiration. They compose — a
real errand uses most of them at once.

1. **AX-tree distillation (L2).** Keep only interactive and text-bearing nodes; merge redundant
   wrapper elements; canonicalize each node as `role "name" [ref] state`; cap per-node text length.
   Do not run a generic token-pruning pass over a tree — compressors that rank by self-information
   reliably strip exactly the refs and action-grammar tokens the agent needs next. Distillation is
   a fixed shape, not a learned summarizer.
2. **Diff, don't resend (L1/L2).** Re-sending a full snapshot every step is the single largest
   waste in naive AX loops — it's the entire gap between the ~27K and ~114K measurements for the
   same task. Send a full snapshot on navigation; every step after that sends only what changed
   (added/removed/changed nodes keyed by ref). The pixel analog is the same discipline: only
   screenshot after an action that actually changed the screen, never on a fixed cadence.
3. **Selector and coordinate caching, self-healing (L1/L2).** Every resolved selector or AT-SPI
   path gets cached against a `(app-or-site, errand, layout-hash)` key. A cache hit replays at
   near-zero LLM cost; a mismatch (layout hash changed) invalidates and re-derives once. This is
   the same mechanism Stagehand ships for the browser (validate-then-replay, self-heal on
   mismatch) — Beckett's `memory/macros/` module (§5) generalizes it to the desktop.
4. **Recorded macros with replay.** Every errand that succeeds once gets distilled into a
   parameterized script or cached selector set, keyed by precondition hash. The second occurrence
   of "renew the domain" or "check the shipping status" runs the macro directly and pays for one
   verification observation, not a fresh plan. This is the Agent Workflow Memory pattern
   (induce-from-success, reduce steps on reuse) applied to computer errands the same way
   [token-efficiency.md](token-efficiency.md) applies it to code.
5. **Cheap-model execution, strong-model authorship.** The planner (sonnet-class) writes the
   script or picks the layer once; the executor (haiku-class) runs steps and macro replays. This
   mirrors the orchestration doc's front-load-judgment/execute-cheap principle (§3.13 there) —
   casting judgment lives in the plan Job, not repeated per step.
6. **Resolution and crop discipline.** Screenshot cost scales linearly with pixel area. Run
   Beckett's headless Hyprland session (see [omarchy.md](omarchy.md)) at a modest logical
   resolution — 1600×1000 or 1280×800 for agent-owned workspaces — and crop every capture to the
   active window's geometry (`hyprctl activewindow -j` + `grim -g "X,Y WxH"`) rather than the full
   desktop: a 1200×900 window costs ~1.4K tokens against ~2.8K+ for a full 1080p capture, and
   removes distractor UI that measurably hurts click grounding. Use `enable_zoom` for small text
   instead of raising the base capture resolution — it fetches a full-resolution crop only when
   actually needed.
7. **Prompt caching discipline.** Frozen system prompt, deterministic tool list, one breakpoint
   after system+tools, advancing breakpoints on recent tool results, batch-pruned screenshot
   history (keep the last 3, prune every ~25 turns, prune in batches so the cached prefix stays
   byte-identical between prunes). Keep the executor's prefix above 4,096 tokens — Haiku 4.5's
   cache-write floor — or caching silently stops paying off on the cheap lane.
8. **Sub-LLM extraction for bulk reads.** A big page-text dump, a large AT-SPI tree, or an OCR
   pass never goes straight into the driver's transcript — it's read once by a haiku-class
   distiller that returns only the answer. This is the same rule as
   [token-efficiency.md](token-efficiency.md)'s general "summarize before it enters the primary
   context" principle, applied to screens.

---

## 4. The Wayland/Hyprland native toolbox

Because Beckett's desktop is a real, scriptable Hyprland compositor (provisioned per
[omarchy.md](omarchy.md)), most of what a computer-use agent needs to *know* about the screen is
available as near-zero-token JSON before any pixels are involved at all. This table is the
concrete primitive set L0 and L3 are built from:

| Capability | Tool | Notes |
|---|---|---|
| Window/workspace tree | `hyprctl clients -j`, `activewindow -j`, `workspaces -j`, `monitors -j` | Titles, app class, PID, geometry, focus, fullscreen — a free window-level AX-tree. Always fetch before deciding to screenshot. |
| Window control | `hyprctl dispatch focuswindow address:0x…`, `movetoworkspacesilent`, `togglefloating`, `resizewindowpixel`, `closewindow`, `exec`, `sendshortcut` | Deterministic, instant; `sendshortcut` sends a key chord to a specific window without stealing focus. |
| Event stream | Hyprland IPC `.socket2.sock` under `$XDG_RUNTIME_DIR/hypr/$HIS/` | Push events for window open/close/focus/title — wait on state, don't poll-screenshot for it. |
| Full/region screenshot | `grim`, `grim -g "$(slurp)"`, `grim -g "X,Y WxH"` | wlr-screencopy. `grim -g` captures a *screen region*, which includes overlapping windows. |
| Occlusion-proof window capture | grim-hyprland fork / `hyprland_toplevel_export_v1` | Grabs a window's own buffer even when covered by another window — the right primitive for "capture window W" on a busy desktop; worth vendoring rather than depending on `grim -g` alone. |
| Keyboard input | `wtype` (respects XKB layout), `ydotool`/`ydotoold` (kernel uinput, compositor-agnostic, needs `render`/uinput perms) | `wtype` for normal text; `ydotool` as universal fallback for raw keys and mouse buttons. |
| Pointer input | `ydotool mousemove/click`, `wlrctl pointer`, `hyprctl dispatch movecursor x y` | `wlrctl` also handles window ops via wlr-foreign-toplevel-management. |
| Clipboard | `wl-copy` / `wl-paste` (+ `cliphist` history) | **Type via clipboard** for long/multiline/unicode text — faster, layout-proof, and cheaper than character-wise typing. Also the cheap way to *read* selected content out of an app without a screenshot. |
| Notifications | `notify-send` → mako; `makoctl history`, `makoctl dismiss` | Machine-readable event source for 2FA prompts, download-complete signals — poll `makoctl history`, not the system tray region. |
| App accessibility tree | AT-SPI2 (`atspi` crate / `pyatspi`); `GTK_MODULES=gail:atk-bridge`; Chromium `--force-renderer-accessibility` | Element roles/names/bounds/actions; `perform_action`/`set_value` beat synthesized clicks when available. Coverage is uneven — terminals, Chromium, and GTK apps expose useful trees; games, unflagged Electron, and custom-drawn apps don't. Treat as a cheap first read, not a guarantee. |
| Misc environment control | `hyprpicker`, `wlsunset`, `brightnessctl`, `pactl`/`wpctl` | No UI interaction needed. |

Because it's Beckett's own dedicated account with no other user contesting the session, none of
this needs to go through a consent-dialog portal path — the direct `hyprctl`/`grim`/`ydotool` route
is always available and is what the library uses by default. The practical design consequence: a
single composite "observe" call — `hyprctl` JSON + optional AT-SPI slice + optional cropped
`grim` — answers most L0–L3 questions in 300–800 tokens, and real screenshots get reserved for
genuinely visual questions.

---

## 5. Realistic per-errand token budgets

These are planning numbers, not guarantees — actual cost depends on the errand's novelty (a first
run always costs more than a macro replay) and how far up the ladder it has to climb. Assumptions:
cached prefix (system+tools ≈ 3–5K) read at ~0.1× price; screenshots ~1.4K; ARIA snapshots 2–4K on
first read / ~0.5K diffed; script generations 0.5–1K output tokens.

| Errand class | Ladder path | Tokens, fresh | Tokens, macro replay | Cost, fresh (haiku/sonnet mix) |
|---|---|---:|---:|---:|
| Read-only fact (calendar entry, page value) | L0–L1, one script | 2–8K | 1–2K | <$0.01 |
| Known-site transaction (login, form, download) | L1, 1–2 scripts + proof screenshot | 8–20K | 2–5K | $0.01–0.05 |
| Unknown-site multi-page flow (signup, checkout) | L1+L2, ~10–15 AX steps + 2 verifications | 25–60K | 5–10K | $0.05–0.20 |
| Native-app task (file manager, IDE dialog, settings) | L0+L2+L3, ~10 steps, 3–5 crops | 30–70K | 8–15K | $0.10–0.30 |
| Full pixel-fallback desktop task, ~25 steps | L4, 25 screenshots + prefix | 120–250K (mostly cache-read) | n/a | $0.30–1.00 (sonnet) |
| **Hard ceiling before human check-in** | — | **300K** | — | **~$1.50** |

Budget enforcement follows the same `maxBudgetUsd`/task-budget rails as every other Job
(orchestration.md §3.7): the driver gets a `task_budget` sized to the errand class so it paces
itself, and the harness independently kills at the hard ceiling and asks — the same
conversational-gate pattern as any other over-budget Job, never a silent kill. A repeat errand
should almost never approach the ceiling; if a macro replay does, that's a signal the precondition
hash is stale and the macro needs re-deriving, not a signal to raise the budget.

---

## 6. What to build

| Module | Responsibility |
|---|---|
| `desk/observe.ts` | Composite observation: `hyprctl` JSON + optional AT-SPI slice + optional cropped `grim` (toplevel-export path for occluded windows) collapsed into one distilled block; diffs on subsequent calls within the same errand. |
| `desk/input.ts` | `wtype`/`ydotool`/`wl-copy`-paste/`hyprctl dispatch` wrappers, with the clipboard-typing fast path as default for anything longer than a few characters, and per-action settle waits keyed to socket2 events rather than fixed sleeps. |
| `desk/atspi.ts` | AT-SPI tree flattener (role/name/text/states/bounds → indexed refs), `perform_action`/`set_value` wrappers. |
| `browser/snapshot.ts` | ARIA snapshot + diff for BetterWright — feeds script authorship at L1 and step-mode interaction at L2. Lives alongside the BetterWright adapter described in [betterwright.md](betterwright.md). |
| `memory/macros/` | Errand scripts and selector caches keyed by precondition hash; success-triggered distillation (§3.4); validate-then-replay-then-heal on mismatch. |
| `drive/loop.ts` | The ladder policy itself: entry-layer selection, escalation on failure, model routing (haiku executes / sonnet authors and escalates), caching and pruning discipline, budget kill-switch, proof capture handed off through the delivery path described in [discord.md](discord.md). |

`desk/*` is new — it's the desktop-side counterpart to what BetterWright already is for the
browser. `browser/snapshot.ts` and `memory/macros/` extend existing BetterWright and memory
concepts rather than replacing them. `drive/loop.ts` is the only genuinely new orchestration
surface, and it's deliberately thin: a policy table over layers, not a new agent framework — the
same "don't build a second thing that does what a Job already does" discipline the rest of v1
holds to.

---

## 7. Open questions

- **AT-SPI coverage on the actual owner desktop is unverified.** The research behind this design
  confirms AT-SPI works well for terminals, Chromium, and GTK apps and poorly for games,
  unflagged Electron, and custom-drawn UI — but that's general knowledge, not a measurement against
  the specific apps Beckett's owner actually runs. Pilot `desk/atspi.ts` against the real app set
  before assuming L2 desktop coverage is as high as L2 browser coverage.
- **Headless Hyprland's stability under real capture load is unverified.** [omarchy.md](omarchy.md)
  flags open upstream Hyprland issues with headless-mode output, including on Nvidia. This library
  assumes a working headless compositor; if headless mode proves flaky, L3/L4 desktop captures
  (not browser captures, which run inside BetterWright's own sandboxed Chromium regardless) are the
  layers that would need a fallback plan.
- **Where the macro cache invalidates.** §3.3/§3.4 assume a layout-hash precondition check catches
  staleness, but the hash function itself (DOM shape for L1, window-geometry-plus-AT-SPI-tree-shape
  for L2/desktop) isn't specified in the source research beyond "Stagehand-style." This needs a
  concrete implementation choice before `memory/macros/` ships, not just the policy described here.
- **Model version drift on tool versions.** Haiku 4.5 needs the older `computer-use-2025-01-24`
  tool beta if it ever touches L4; newer Claude models default to `computer-use-2025-11-24`. The
  library should assert the tool-version/model pairing at spawn time rather than let a mismatched
  pair fail mid-errand — exact mechanism TBD.
- **Whether L1's script cache and BetterWright's own multi-lease pool should share one
  precondition-hash namespace** or stay separate ([betterwright.md](betterwright.md) covers the
  lease pool itself) — an implementation detail to settle when `memory/macros/` and the browser
  lane are built against each other directly, not before.
