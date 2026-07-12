# Browser agent

Beckett's computer-use lane follows the useful part of Aside's published approach: give a strong
model a normal code-shaped browser surface instead of teaching it a large vocabulary of synthetic
click, type, wait, and snapshot tools. Asidewright itself is proprietary, so Beckett builds on the
maintained Playwright library rather than depending on an unavailable runtime.

## Model surface

The model receives one tool, `playwright_eval`. Its JavaScript has ordinary Playwright `page` and
`context` objects plus small helpers for AI ARIA snapshots, active-page selection, safe artifacts,
and redacted screenshots. Related steps belong in one call; independent tabs can use
`context.newPage()` and `Promise.all`.

The supported facade makes `context.browser()` and `page.context().browser()` return `null` and
rejects direct raw-CDP creation, which prevents accidental misuse. This is not a security boundary:
Playwright's private object graph and a raw CDP session must be assumed reachable from evaluator
JavaScript. Enforcement therefore lives in the trusted controller, not in those JavaScript facades.

The replacement browser prompt, result schema, and tool definition are regression-tested together.
They currently total 2,705 characters, or a deliberately conservative 902-token estimate at three
characters per token. This is below the hard 3,000-token ceiling.

## Runtime boundary

Model JavaScript never runs in the Beckett daemon or its browser controller. A computer-use task
owns one trusted controller and Chromium process for its full run, including waits for a Discord
answer. Each tool call gets a disposable Node evaluator connected to that controller over
Playwright/CDP. On Linux, the daemon starts the controller and every evaluator as separate sibling
`bubblewrap` processes rather than asking one sandbox to create another. Both drop all capabilities.
The evaluator receives a read-only evaluator plus Playwright client, bounded memory/process/file
limits, and no profile, artifact, full repo, home, `.env`, model credential, or control-socket mount.

The production process chain is explicit: the Bun daemon supervises a Node controller host; Node
manually starts the pinned Chromium binary with its dedicated profile and one ephemeral loopback CDP
port; Playwright then attaches with `connectOverCDP`. Chromium has no Playwright-managed debugging
pipe, and it remains in the Node host's process group so the Bun supervisor can reap the full tree.
This replaced the flaky combination of Playwright-managed WebSocket/pipe-plus-port launch behavior
under Bun without changing the persistent browser identity.

The daemon and controller enforce outer deadlines. A stuck or escaped evaluator is killed as a
process group without closing Chromium, so tabs, unsaved form values, cookies, and SPA state remain
available for a question reply or the next action. Browser-side work already initiated before a
timeout may still complete, so timeouts are reported as uncertain and current state must be inspected
before retrying a non-idempotent action. The configured output budget covers the complete serialized
tool result, not just its returned value; the default is 24,000 characters.

A lease may create at most four downloads and persist at most 100 MiB across them. Root CDP
`Browser.downloadWillBegin` events count each download GUID once, including downloads created by raw
or hidden targets. `Browser.downloadProgress` counts received bytes and the projected remainder of
concurrent transfers, cancelling while a download is still in flight when the aggregate would cross
the budget. The controller periodically restores its trusted download behavior if raw CDP changed it.
The later artifact stream is not the pre-completion guard; it copies within the same budget and
deletes failed or over-budget partials plus Chromium's temporary copies. The controller's 128 MiB
`RLIMIT_FSIZE` is an earlier per-file backstop. Cancellation is attempted against the default and
every currently live browser context id so a context-id mismatch cannot silently bypass the guard.

The controller enforces a 32 page-target ceiling from root CDP, including hidden targets that may not
appear in Playwright's page list and independently of the result-envelope page cap. It watches target
creation and polls Chromium's complete browser-context list every 100 ms, forcibly disposing every
non-default context. The poll covers contexts with no targets, and the regression suite creates one
through Playwright's private graph/raw CDP to verify that the controller removes it.

Profile accounting uses serialized asynchronous allocated-byte scans rather than blocking the Node
controller. A lease starts at a 100 ms scan cadence; quiet profiles back off adaptively to 2 seconds,
while rapid growth or low headroom returns the cadence to 100 ms. More than 100 MiB of growth during
one lease or 512 MiB total closes Chromium and fails the lease; a profile already above the absolute
ceiling fails before launch. The profile is not erased, and a bounded mode-`0600` controller snapshot
restores session-only cookies that Chromium would otherwise discard on exit, so login state survives
the controlled restart. The controller is otherwise recycled between tasks. Linux fails closed if
either sibling sandbox cannot start. macOS production also fails closed; the benchmark opts into
explicitly labelled process-only development mode because current Chromium is incompatible with the
legacy `sandbox-exec` policy.

## Human loop and evidence

Browser work detaches immediately. A real missing fact returns `needs_input`; Beckett leaves the
relevant page active, posts a redacted screenshot, and resumes the same model and browser lease only
from the initiating role-holder's native Discord reply. Starting computer-use requires Discord role
`1520985787062030456`; another holder of the role still cannot take over an existing run.
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

The Discord gate is role `1520985787062030456`, and every run also gets an unguessable capability
bound to its initiating channel and user. Processes already running as the same `beckett` Unix user
remain part of the trusted computing base; the capability is defense in depth, not a separate-UID
security boundary. Chromium intentionally has network access to complete browser work. Evaluator
code controls Chromium, and both sibling sandboxes share the host network namespace so the evaluator
can reach Chromium's loopback CDP endpoint. The boundary therefore does not constrain raw network
access; the host should remain a dedicated Beckett machine rather than a multi-tenant box.

## References

- Aside engineering: <https://aside.com/blog/how-we-built-the-sota-browser-agent-that-outperforms-fable>
- Playwright pages and multi-page events: <https://playwright.dev/docs/pages>
- Playwright persistent contexts: <https://playwright.dev/docs/api/class-browsertype>
- Playwright browser/dependency management: <https://playwright.dev/docs/browsers>
- Bubblewrap security model: <https://github.com/containers/bubblewrap/blob/main/README.md>
