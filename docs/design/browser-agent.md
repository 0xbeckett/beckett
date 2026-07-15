# Browser agent

Beckett's computer-use lane follows the useful part of Aside's published approach: give a strong
model a normal code-shaped browser surface instead of teaching it a large vocabulary of synthetic
click, type, wait, and snapshot tools. Asidewright itself is proprietary, so Beckett builds on the
maintained Playwright library rather than depending on an unavailable runtime.

## Model surface

The model receives one tool, `betterwright_browser`. It runs BetterWright’s guarded,
persistent Playwright-style facade: `page`, `pages`, `openPage`, `usePage`, `snapshot`,
`screenshot`, `human`, `dialogs`, and `captcha`. Related steps belong in one call and
`screenshot({ kind, name })` returns a controller-validated image artifact.

The replacement browser prompt, result schema, and tool definition are regression-tested
together and remain below the 3,000-token browser-tool budget.

## Runtime boundary

The daemon still owns the computer-use lease, capability token, Discord question flow, and
proof delivery, but BetterWright is the browser backend. The isolated Node host creates one
BetterWright instance for a lease; BetterWright owns the persistent profile, policy-guarded
browser worker, sandboxed model snippets, artifact generation, and network controls. Raw
Playwright/CDP handles never cross into model-authored JavaScript.

On Linux the host runs in the existing `bubblewrap` boundary with only the dedicated browser
profile and run artifacts writable; macOS uses the existing fail-closed `sandbox-exec` path.
BetterWright’s Chromium fallback is explicitly selected and uses the pinned Playwright
Chromium executable. The profile persists cookies and local storage across leases while the
host is recycled after a run. BetterWright blocks private-network targets by default while
loopback is enabled for Beckett’s deterministic local-page smoke test.

Downloads are denied for this MCP surface. Browser output remains bounded by Beckett before it
is returned to the model, and proof/question screenshots are copied into the run artifact
directory and PNG-validated before Discord can consume them.

## Human loop and evidence

Browser work detaches immediately. A real missing fact returns `needs_input`; Beckett leaves the
relevant page active, posts a redacted screenshot, and resumes the same model and browser lease only
from the initiating authorized user's native Discord reply. Any user admitted through Beckett's
normal access gate can start computer-use; another authorized person still cannot take over an
existing run.
Question text has whitespace normalized and uses Discord's `singleMessage` path, which rejects
splitting or formatting and reserves the screenshot attachment name `beckett-browser-question.png`.
The fixed reply suffix plus that reserved attachment marker lets the gateway recognize the question
after a restart; copied wording alone is not enough. Thus the screenshot, visible prompt, reply
target, and normal ledger anchor remain one Discord message.

The marker closes the crash window that the ledger alone cannot: if Discord accepted a question but
the daemon died before recording its message id, a later recognized reply is consumed before chat
memory, the orphan question is deleted, and the user is told the run is gone. Reference inspection is
tri-state. A confirmed marked question follows browser routing, a confirmed ordinary bot message
follows normal routing, and an uninspectable bot reference is consumed fail-closed with guidance to
resend as a fresh mention. If a normal ledger write fails, Beckett deletes the just-posted question
and aborts. Restarted questions become privacy tombstones; stale visible anchors are deletion-retried,
and their seven-day expiry starts only after Discord confirms deletion. The ledger stays capped at
1,000 without evicting unconfirmed anchors and refuses a new question if none can be compacted.
Every recognized answer message is deleted before its contents are inspected or forwarded, including
answers from the wrong user, answers after role revocation, stale replies, and uninspectable bot
references. If deletion cannot be confirmed, Beckett does not use the answer. The bot therefore needs
Discord's Manage Messages permission in addition to its normal read, send, and attachment permissions.

Visible completions get a fresh controller-owned proof screenshot. Model-requested screenshots are
also captured by the controller only after evaluator access ends. Pages that contain authentication,
OTP, recovery, or other secret signals use a fail-closed full-page placeholder; ordinary pages get
targeted field/media masking. User-facing summaries redact labelled, Markdown, JSON, URL, and
multiline credentials before Discord delivery. The runner exact-match redacts every resumed answer,
regardless of length, from later questions and terminal summaries, plus credential-shaped components.
A completion that requests proof but cannot produce a fresh proof image is downgraded to an error and
explicitly marked unverified rather than delivered as success. Terminal delivery first writes a
minimal outbox envelope containing only run, channel, state, redacted result, and proof paths. It
fails closed if that durable write fails, retries transient Discord errors while the daemon is still
live, and reloads pending envelopes after restart. A proof upload failure retains both the envelope
and screenshot for retry; it never converts verified success into a text-only post. Questions and
terminal results post directly to Discord without sending their sensitive content through the
third-party Chilltext formatter.

## Trust boundary

Computer-use uses Beckett's normal owner/access-list gate, and every run also gets an
unguessable capability bound to its initiating channel and user. Processes already running as the
same `beckett` Unix user remain part of the trusted computing base; the capability is defense in
depth, not a separate-UID security boundary. Chromium intentionally has network access.
Evaluator code controls Chromium, and both sibling sandboxes share the host network namespace so
the evaluator can reach Chromium's loopback CDP endpoint. The boundary therefore does not constrain
raw network access; the host should remain a dedicated Beckett machine rather than a multi-tenant box.

## References

- Aside engineering: <https://aside.com/blog/how-we-built-the-sota-browser-agent-that-outperforms-fable>
- Playwright pages and multi-page events: <https://playwright.dev/docs/pages>
- Playwright persistent contexts: <https://playwright.dev/docs/api/class-browsertype>
- Playwright browser/dependency management: <https://playwright.dev/docs/browsers>
- Bubblewrap security model: <https://github.com/containers/bubblewrap/blob/main/README.md>
