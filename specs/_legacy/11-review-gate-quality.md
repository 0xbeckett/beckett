# Beckett — Spec 11: Review, Gate & Quality

> **The quality canon.** A node is only `NODE_DONE` when it has *proven* it meets its acceptance
> criteria. This spec defines the criteria schema (authored at PLAN), how the executable checks are
> run safely in the worktree, the tiered review decision (self vs fresh adversarial vs cross-provider
> vs panel), the exact reviewer spawn + verdict schema, the GATE algorithm, and how a fail threads
> reviewer feedback back into the ≤3 retry loop before escalating with options. If this spec
> contradicts [Spec 00](./00-overview.md), Spec 00 wins (or we fix 00 first).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Anchor: [Spec 00 — Overview & Canon](./00-overview.md). Research & rationale:
> [`../my-docs/`](../my-docs/) ([open-questions.md](../my-docs/open-questions.md) §H1/H2/H3,
> [claude-code-headless.md](../my-docs/claude-code-headless.md) §7 `--json-schema`,
> [codex-exec.md](../my-docs/codex-exec.md) §3 `--output-schema`).

---

## 1. Scope of this spec & what it defers

This document owns: **the acceptance-criteria schema, check execution, the REVIEW tier decision, the
fresh/cross/panel reviewer spawn + the `ReviewVerdict` schema, the GATE algorithm, and the
feedback/escalation *contract*** consumed by the state machine.

| Concern | Owner |
|---|---|
| Criteria schema, check runner, tiered review, reviewer prompts/verdict, GATE, feedback shape | **This spec (11)** |
| The NODE FSM states `REVIEWING`/`GATING`/`RE_DISPATCH`, the retry loop wiring, resume-vs-fresh re-dispatch, the three escalation points | [Spec 04 — State Machine](./04-state-machine.md) |
| Worker spawn/abort, `SpawnSpec`, `doneSchemaPath`, scope enforcement, `WorkerEvent` | [Spec 02 — Worker Abstraction](./02-worker-abstraction.md) |
| Plan/criteria **authoring** (Opus writes the DAG + criteria at PLAN) | [Spec 06 — Brain & Models](./06-brain-models.md) |
| Gate-outcome logging to SQLite (learned model), event log | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) |
| Delivery of the escalation message in-channel; the delivery handshake | [Spec 05 — Discord Interface](./05-discord-interface.md) |
| When-to-intervene on a *running* worker (smoke-alarms, nudge/abort) | [Spec 03 — Control Plane & Supervise](./03-control-plane-supervise.md) |
| Concurrency cap (reviewers consume slots too) | [Spec 01 — Architecture](./01-architecture.md) |

This spec exposes **policy** (what "good enough" means and how it is verified). It is invoked by the
NODE FSM at `REVIEWING` → `GATING` (Spec 04 N13–N20) and returns a `GateResult` whose `feedback`
field Spec 04 threads into `RE_DISPATCH`.

Canon honored (Spec 00 §4): criteria are **mandatory per node** (executable checks + NL); review is
**tiered** (self for simple, fresh adversarial for critical; cross-provider post-v0); **GATE = all
checks exit 0 AND review verdict pass**; retry **≤3** then escalate with options; **never silent
retry, never silent failure**; **no dollar budget** (reviewers are bounded by turns/wall-clock, never
USD — Spec 02 §9).

---

## 2. Acceptance criteria schema (authored at PLAN)

Every node carries an `AcceptanceCriteria` written by Opus at PLAN time (Spec 04 `NodeRecord.criteria`;
authoring rules in Spec 06). **No node may be staffed without criteria** — that is the "definition of
done" GATE checks against. A node with empty `checks` *and* empty `nl` is a PLAN bug → `plan_infeasible`
(Spec 04 T10).

```ts
// ── owned by Spec 11; referenced opaquely by Spec 04 (NodeRecord.criteria) ──
export interface AcceptanceCriteria {
  /** Executable checks: shell commands run in the worker's worktree. exit 0 = pass.
   *  ALL must exit 0 for the "checks pass" half of the gate (§4). Strings exactly per
   *  Spec 00 ledger ("Criteria"); per-check timeout comes from config (§3.2). */
  checks: string[];

  /** Natural-language statements a reviewer judges true/false against the diff (§5).
   *  Each is one verifiable claim — the reviewer returns met/not-met per statement. */
  nl: string[];

  /** Optional interface contract for a node that shares a boundary with a parallel node
   *  (e.g. "exports `type Session = {id:string; userId:string}`"). Checked at INTEGRATE
   *  (Spec 04 §6.5) and re-asserted as an NL criterion at review. */
  interfaceContract?: string;
}
```

### 2.1 The two halves — and why both

| Half | Form | Judged by | Catches |
|---|---|---|---|
| **checks** | shell commands, exit-code semantics | the machine (deterministic) | regressions, build/test/lint/type failures — *objective*, cheap, non-negotiable |
| **nl** | English statements | a reviewer model (judgment) | "did it actually do the thing, well?" — design, completeness, security, intent — *subjective*, what tests can't encode |

Checks are the floor; NL is the ceiling. A node can pass every test and still fail review (it tested
the wrong thing, left a security hole, or ignored half the request). A node can satisfy the reviewer's
read of the diff but break the build. **GATE requires both** (§6).

### 2.2 Authoring criteria to be *checkable* (rules for PLAN)

Opus is instructed (Spec 06) to write criteria that GATE can actually evaluate:

- **Checks must be runnable as-is in the worktree**, non-interactive, and deterministic. Prefer the
  project's own scripts (`npm test`, `npm run build`, `npm run lint`, `npx tsc --noEmit`, `pytest -q`,
  `cargo test`). Each command's **exit code is the signal** — `0` = pass, anything else = fail.
- **No check may depend on network** unless the node's `ResourceEnvelope.network === true` (Spec 02
  §6.3). A check that needs `npm install` first must either be preceded by an install step in the same
  command (`npm ci && npm test`) on a network-enabled node, or run against an already-installed tree.
- **Scope the checks to the node** where possible (`npm test -- src/auth`) so a green node isn't
  blocked by an unrelated pre-existing failure elsewhere. ⚠️ If the suite can't be scoped, see §3.4
  (baseline diffing).
- **NL statements are atomic and verifiable from the diff** — one claim each, phrased so a reviewer
  can answer met/not-met with a reason. Bad: "the code is good." Good: "every new endpoint validates
  its input and returns 400 on malformed bodies."
- **Cover the request, not just the happy path** — include at least one NL statement about error
  handling / edge cases and one about *not breaking the contract* with sibling nodes when relevant.

### 2.3 Examples

```jsonc
// Node: "Add JWT auth to the API, keep the old session-cookie path working"
{
  "checks": [
    "npm run build",
    "npx tsc --noEmit",
    "npm test -- src/auth",
    "npm run lint -- src/auth"
  ],
  "nl": [
    "New endpoints accept and verify a JWT bearer token.",
    "The existing session-cookie auth path still works (backward-compat preserved).",
    "Tokens are verified with the configured secret; no hardcoded keys in the diff.",
    "Malformed/expired tokens are rejected with 401, not a 500.",
    "No auth check was weakened or removed to make tests pass."
  ],
  "interfaceContract": "exports `verifyToken(req): Session | null` used by node `routes`"
}
```

```jsonc
// Node: "Write a CONTRIBUTING.md for the repo" (a low-criticality, mostly-NL node)
{
  "checks": ["test -f CONTRIBUTING.md", "npx markdownlint CONTRIBUTING.md"],
  "nl": [
    "Covers local setup, the test command, and the PR process.",
    "Commands shown match this repo's actual scripts in package.json.",
    "No placeholder/TODO text left in."
  ]
}
```

---

## 3. Running the checks (the deterministic half)

Before any reviewer runs, the GATE runner executes **every** command in `criteria.checks` inside the
node's worktree and collects a `CheckResult` per command. This happens at `REVIEWING` (Spec 04 N13),
**after INTEGRATE** — so checks run against the *merged* tree, catching "clean merge that still breaks
the build" (Spec 04 §6.5).

```ts
export interface CheckResult {
  cmd:       string;
  exitCode:  number;      // 124 convention for our timeout kill (see §3.2)
  stdout:    string;      // truncated, §3.3
  stderr:    string;      // truncated, §3.3
  durationMs: number;
  timedOut:  boolean;
  pass:      boolean;     // exitCode === 0 && !timedOut
}

export interface ChecksOutcome {
  results: CheckResult[];
  allPass: boolean;       // results.every(r => r.pass)  — the "checks pass" gate half
}
```

### 3.1 Execution model

Each command runs as a child process with **cwd = the worktree**, as the `beckett` OS user, inheriting
no extra privilege. We run through a shell so check strings may use `&&`, pipes, and redirection.

```ts
async function runCheck(cmd: string, ws: string, env: CheckEnv): Promise<CheckResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(["bash", "-lc", cmd], {
    cwd: ws,                               // the worker's git worktree (Spec 02 §8.1)
    env: env.vars,                         // scrubbed env (§3.5); PATH + project vars only
    stdout: "pipe", stderr: "pipe",
    // process group so a timeout kills the whole tree, not just bash
  });

  const timer = setTimeout(() => proc.kill("SIGKILL"), env.timeoutS * 1000);
  const [out, err] = await Promise.all([readCapped(proc.stdout), readCapped(proc.stderr)]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const timedOut = Date.now() - t0 >= env.timeoutS * 1000;
  return {
    cmd, exitCode: timedOut ? 124 : exitCode,
    stdout: out, stderr: err,
    durationMs: Date.now() - t0, timedOut,
    pass: !timedOut && exitCode === 0,
  };
}
```

Checks run **sequentially by default** (a failing build makes the test run meaningless, and ordering
gives legible output); a node may opt into parallel checks via config when they're independent. The
runner **does not short-circuit** — it runs all checks even after one fails, so the reviewer and Jason
see the *full* failure picture in one pass (don't make them fix-one-rerun-discover-the-next).

### 3.2 Timeouts

Per-check wall-clock from `config.toml` (`review.check_timeout_s`, default 600s); a node may override
via a longer envelope. A timed-out check is a **fail** (`pass:false`, `exitCode:124`, `timedOut:true`)
— never treated as a pass-by-omission. The aggregate check phase also bounds total wall-clock so a
pathological suite can't park a node forever (→ surfaces as a check failure, not a hang).

### 3.3 Output capture & truncation

Capture stdout+stderr separately, capped (default 16 KB each: keep the **head + tail**, drop the
middle with a `… [N bytes elided] …` marker — test failures live at both ends). The capped text is
what feeds the reviewer and the escalation summary; the full output is written to the worker log
(Spec 09) for `beckett logs`.

### 3.4 What "checks pass" means

> **Checks pass ⇔ every command in `criteria.checks` exits 0 within its timeout** (`ChecksOutcome.allPass`).

Empty `checks` is allowed only for genuinely non-code nodes (e.g. a research summary); such a node
leans entirely on NL review and is flagged so GATE knows there's no machine floor. ⚠️ A node that
*should* have checks but has none is a PLAN defect — Spec 06's authoring guard should reject it.

⚠️ **Pre-existing failures.** If the project's suite is already red before the node touched anything,
a scoped check (`npm test -- src/auth`) avoids penalizing the node. Where scoping is impossible, the
runner may diff against a **baseline** captured at the node's base ref (run the same checks on
`projectBranch` pre-merge; only *newly* failing checks count against the node). Baseline diffing is a
v1 refinement; v0 uses scoped checks. (Owned jointly with Spec 04 INTEGRATE.)

### 3.5 Safety / sandboxing

Check commands are authored by **Opus at PLAN** (trusted-ish) but execute arbitrary shell, so:

- Run **in the worktree only**, as `beckett`, with a **scrubbed env** (`config.toml`
  `[review.check_env]`: whitelist PATH/HOME/LANG + declared project vars; strip secrets/tokens so a
  rogue check can't exfiltrate them — mirrors Codex's `shell_environment_policy`, codex-exec.md §6).
- **Network off** unless `envelope.network` (firewall/`unshare` where available; otherwise documented
  trust boundary). The worktree is the blast radius; on the trusted single-user loom-desk this is
  acceptable in v1. Real isolation (containers) is **deferred** (Spec 00 §8) and is the right fix for
  untrusted criteria.
- Checks run **read-mostly** against an already-built tree; they may write within the worktree (test
  artifacts, coverage) but that's discarded with the worktree on teardown (Spec 02 §8.1).

---

## 4. The tiered review decision (self vs fresh vs cross vs panel)

After checks run, REVIEW judges the **NL** criteria. Spec 00 canon: *self-review for simple nodes, a
fresh adversarial reviewer for critical ones, cross-provider post-v0.* The tier is chosen per node:

```ts
export type ReviewTier =
  | "self"    // Opus reads diff + check results, judges vs NL criteria (cheap, has context)
  | "fresh"   // NEW claude -p reviewer: ONLY criteria + diff, no implementer context (adversarial)
  | "cross"   // fresh reviewer on the OTHER provider (Codex⇄Claude) — post-v0, §7
  | "panel";  // N fresh reviewers, majority vote — the most critical nodes only, §8
```

### 4.1 The simple-vs-critical heuristic

A node is **critical** (→ at least `fresh`) if **any** of these hold; otherwise it's **simple**
(→ `self`). Inputs come from the node's scope, diff stats (Spec 02 `WorkerSpend.diffLines`), and the
PLAN metadata.

```ts
interface CriticalitySignals {
  touchesSecurity:   boolean;  // auth/authz, crypto, secrets, session, permissions, payments
  touchesDeps:       boolean;  // package.json / lockfile / Dockerfile / CI / infra changed
  blastRadius:       number;   // # of OTHER nodes depending on this node (DAG fan-out)
  diffLines:         number;   // added + removed (post-integrate)
  filesChanged:      number;
  externalSurface:   boolean;  // public API / migration / deletes data / irreversible
  priorRetries:      number;   // node.attempts so far (a node that keeps failing earns scrutiny)
}

function chooseTier(s: CriticalitySignals, cfg: ReviewConfig): ReviewTier {
  const critical =
    s.touchesSecurity ||
    s.touchesDeps ||
    s.externalSurface ||
    s.blastRadius >= cfg.blastRadiusCritical ||   // default 2 (≥2 nodes depend on it)
    s.diffLines   >= cfg.diffLinesCritical ||      // default 150
    s.filesChanged >= cfg.filesCritical ||         // default 8
    s.priorRetries >= 1;                           // anything that already failed once → fresh eyes

  if (!critical) return "self";
  if (s.touchesSecurity || s.externalSurface) {
    if (cfg.crossProviderEnabled) return "cross";  // post-v0 default for security/irreversible
    if (cfg.panicNodes) return "panel";            // optional max-scrutiny dial (§8)
  }
  return "fresh";
}
```

- **Blast radius** — a node many others build on; a defect propagates. High fan-out → critical.
- **Security/auth touch** — any diff in auth/authz/crypto/secrets/session/permissions/payments is
  always critical (cheap to over-review, catastrophic to under-review).
- **Size** — large diffs hide more; over thresholds → critical.
- **Dependency changes** — lockfile/Dockerfile/CI edits can silently change behavior everywhere → critical.
- **External surface / irreversibility** — public API, data migration, deletes → always critical (and
  preferentially cross-provider once available).
- **Prior failure** — a node that already failed review once gets fresh adversarial eyes on the retry,
  even if otherwise "simple."

Defaults live in `config.toml [review]`; Opus may also flag a node `critical` explicitly at PLAN
(Spec 06) — an explicit flag forces ≥`fresh` regardless of the heuristic.

### 4.2 Self-review (simple nodes)

No new worker is spawned. Opus (the brain, Spec 06) is invoked statelessly with: the **diff**, the
**`ChecksOutcome`**, and the node's **NL criteria**, and returns a `ReviewVerdict` (§6 schema) — the
same schema a fresh reviewer fills. Self-review still *runs the checks* (§3); the difference is only
who judges the NL half. Self-review is appropriate when the cost of a missed defect is low and the
implementer's own context is an asset, not a liability.

### 4.3 Fresh review (critical nodes) — the adversarial spawn

For critical nodes Beckett spawns a **brand-new `claude -p` worker that has never seen the
implementer's reasoning** — only the criteria and the diff. Fresh context is the whole point (§8): the
implementer is invested in its own work; a cold reviewer with an adversarial brief is not. See §5 for
the exact spawn and §6 for the verdict.

---

## 5. The fresh reviewer — exact spawn + prompt

### 5.1 What the reviewer gets (and deliberately doesn't)

| Gets | Does NOT get |
|---|---|
| The NL criteria + interface contract | The implementer's session/transcript or its `done-signal` rationale |
| The unified diff (`git diff <base>..<nodeBranch>`) | Any "here's why I did it this way" justification |
| **Read-only** access to the merged worktree (to inspect surrounding code) | Any write tool — it cannot edit, run mutating commands, or "fix" anything |
| The `ChecksOutcome` (which checks passed/failed) | The author's identity / model (so it can't defer to it) |

"No implementer context" means **no implementer reasoning**, not "no repo." A good reviewer reads the
surrounding code; we just deny it the author's narrative and any write capability so its only job is to
**find why this does NOT meet the criteria**.

### 5.2 Exact invocation (one-shot, read-only, schema-constrained)

The reviewer is a *one-shot* `claude -p` (not the long-lived steerable driver of Spec 02 §4) — it has
no nudge/turn loop to steer. It reuses Spec 02's spawn plumbing (`Bun.spawn`, cwd = worktree) with a
**read-only tool set** and the verdict schema instead of the done schema:

```bash
claude -p \
  --output-format json \                         # single structured result (no stream needed)
  --json-schema "$VERDICT_SCHEMA" \              # constrains result → ReviewVerdict (§6); read .structured_output
  --append-system-prompt "$REVIEWER_SYS" \       # the adversarial reviewer persona (§5.3)
  --allowedTools "Read,Glob,Grep" \              # READ-ONLY: no Edit/Write/Bash → cannot mutate anything
  --permission-mode dontAsk \                    # never prompt; anything unlisted is denied (headless §4.2)
  --model "$REVIEWER_MODEL" \                    # default Opus for critical nodes
  --max-turns "$REVIEW_TURN_CAP" \               # bounded; no $ budget (Spec 00 §4)
  --session-id "$REVIEWER_UUID" \                # own resume identity (kept for audit)
  "$REVIEW_PROMPT"                               # diff + criteria + checks (§5.3) as the user turn
# cwd = the node worktree (read-only inspection of surrounding code).
```

Why these flags (per [claude-code-headless.md](../my-docs/claude-code-headless.md)):
- `--allowedTools "Read,Glob,Grep"` + `--permission-mode dontAsk` is the doc's **locked-down pattern**
  (§4.2): only those three tools run; everything else (Edit/Write/Bash) is **denied**, so the reviewer
  is structurally incapable of editing or running the build — it can only read and judge.
- `--json-schema` → the validated verdict lands in `result.structured_output` (NOT `result`, which is
  free text); extract with `jq '.structured_output'` (headless §7). On
  `subtype:error_max_structured_output_retries` the verdict never validated → treat as an
  **inconclusive review = fail-closed** (§6.3).
- `--output-format json` (non-streaming) is enough: we want one verdict, not a live tail. (Use
  `stream-json` only if Spec 03 wants to show "reviewer is reading" — optional.)
- We do **not** pass `--bare` (same reason as Spec 02 §4.1: subscription auth in `~/.claude`).

⚠️ A read-only reviewer needs no PreToolUse scope hook (it has no write tools) — but if `Bash` is ever
re-enabled for richer checks, the scope hook (Spec 02 §8.2) must be wired and `--include-hook-events`
added. v1 keeps Bash off the reviewer entirely.

### 5.3 The reviewer prompt

**System append (`$REVIEWER_SYS`)** — businesslike, adversarial (internal prompt, not the Beckett
user-voice persona; Spec 00 §4):

```
You are an adversarial code reviewer. You did NOT write this code and you owe it no benefit of the
doubt. Your sole job is to find concrete reasons this change does NOT meet its acceptance criteria.
Read the diff and the surrounding code (read-only). For EACH natural-language criterion, decide
whether the diff actually satisfies it and say why or why not, citing file:line from the diff.
Hunt specifically for: criteria only partially met; tests that assert the wrong thing or were
weakened to pass; security holes (injection, missing authz, leaked secrets, unsafe deserialization);
unhandled errors/edge cases; broken backward-compat; scope the author skipped. A failing check is an
automatic blocker. If you cannot verify a criterion from the diff, treat it as NOT met. Do not
suggest you "would fix" anything — you have no write access. Output ONLY the verdict JSON.
```

**User turn (`$REVIEW_PROMPT`)** — assembled by the runner:

```
## Acceptance criteria (natural language) — judge each:
1. <criteria.nl[0]>
2. <criteria.nl[1]>
...
Interface contract (must hold): <criteria.interfaceContract or "none">

## Executable check results (machine-run, authoritative):
- `npm run build` → exit 0 (pass)
- `npm test -- src/auth` → exit 1 (FAIL)
  <truncated stdout/stderr, §3.3>
...

## The diff under review (base..nodeBranch):
```diff
<git diff output>
```

Return a ReviewVerdict per the schema. A FAILING check above means pass=false.
```

The diff is `git -C "$WS" diff "$BASE_REF"..HEAD` (or `--staged` for the node branch). For very large
diffs, send the diff plus let the reviewer `Read`/`Grep` the worktree for context rather than inlining
the whole repo.

### 5.4 The `ReviewVerdict` schema

The JSON schema file (`$VERDICT_SCHEMA`) passed to `--json-schema` (Claude) / `--output-schema`
(Codex, §7). Both providers fill the same shape:

```jsonc
{
  "type": "object",
  "required": ["pass", "criteriaMet", "issues", "confidence"],
  "properties": {
    "pass":     { "type": "boolean" },          // overall: does it meet ALL criteria?
    "criteriaMet": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["criterion", "met"],
        "properties": {
          "criterion": { "type": "string" },    // echo of the NL statement judged
          "met":       { "type": "boolean" },
          "note":      { "type": "string" }      // why / why not, with file:line
        }
      }
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "detail"],
        "properties": {
          "severity":  { "type": "string", "enum": ["blocker", "major", "minor"] },
          "criterion": { "type": "string" },     // which NL criterion this violates (optional)
          "detail":    { "type": "string" },     // the concrete problem
          "location":  { "type": "string" }      // file:line (optional)
        }
      }
    },
    "confidence": { "type": "number" }            // 0..1: reviewer's confidence in its own verdict
  }
}
```

```ts
export interface ReviewVerdict {
  pass: boolean;
  criteriaMet: { criterion: string; met: boolean; note?: string }[];
  issues: { severity: "blocker" | "major" | "minor"; criterion?: string; detail: string; location?: string }[];
  confidence: number; // 0..1
}
```

**Consistency rule (runner-enforced, don't trust the model):** the runner recomputes
`pass := criteriaMet.every(c => c.met) && issues.every(i => i.severity !== "blocker")`. If the model's
`pass` disagrees, the runner's value wins and the discrepancy is logged. A `blocker` issue forces
`pass=false` even if the model said true (fail-closed).

---

## 6. The GATE algorithm

GATE (Spec 04 `GATING`, N18–N20) is the single pass/fail decision. It consumes the `ChecksOutcome`
(§3) and the `ReviewVerdict` (§5/§7/§8) and emits a `GateResult`.

```ts
export interface GateResult {
  pass:        boolean;
  checksPass:  boolean;
  reviewPass:  boolean;
  feedback:    ReviewerFeedback;   // ALWAYS produced — drives RE_DISPATCH on fail, logged on pass
}

// ── owned by Spec 11; Spec 04 stores these in NodeRecord.feedback[] and threads on RE_DISPATCH ──
export interface ReviewerFeedback {
  attempt:      number;            // node.attempts at the time of this gate
  tier:         ReviewTier;        // who judged ("self" | "fresh" | "cross" | "panel")
  reviewerId?:  string;            // session id of the fresh/cross reviewer (Spec 04 lastReviewerId)
  verdict:      ReviewVerdict;     // the NL judgment
  checkResults: CheckResult[];     // the machine half
  summary:      string;            // one-line human read, for retry brief + escalation
  at:           number;            // epoch ms
}
```

### 6.1 The decision

```ts
function gate(node: NodeRecord, checks: ChecksOutcome, verdict: ReviewVerdict, tier: ReviewTier): GateResult {
  const checksPass = checks.allPass;                      // §3.4 — ALL checks exit 0
  const reviewPass = verdict.pass;                        // §5.4 — runner-normalized, fail-closed
  const pass = checksPass && reviewPass;                  // ← THE GATE: both halves required

  const feedback: ReviewerFeedback = {
    attempt: node.attempts,
    tier,
    verdict,
    checkResults: checks.results,
    summary: summarize(checks, verdict),                  // "2/3 checks pass; review: 1 blocker (no token expiry check)"
    at: Date.now(),
  };
  return { pass, checksPass, reviewPass, feedback };
}
```

> **GATE passes iff (every check exits 0) AND (the review verdict's `pass` is true).** Anything else is
> a FAIL. There is no partial pass, no "checks failed but the review liked it," no override. (Spec 00
> §4 Review ledger.)

### 6.2 On pass / on fail

- **Pass** → Spec 04 N18: node → `NODE_DONE`, dependents unblocked. `feedback` is still recorded and
  the gate outcome logged to SQLite (Spec 09) for the learned model (Spec 00 §4 "log every gate
  outcome from day one").
- **Fail** → Spec 04 N19/N20: `feedback` (especially `verdict.issues` + failing `checkResults`) is
  appended to `node.feedback[]` and threaded into the retry loop (§7 below / Spec 04 §8).

### 6.3 Fail-closed cases

| Situation | GATE result |
|---|---|
| A check timed out (§3.2) | `checksPass=false` → FAIL |
| Reviewer schema never validated (`error_max_structured_output_retries`, headless §7) | review **inconclusive** → `reviewPass=false` → FAIL (re-run reviewer once; if it fails again, escalate as a review-infra problem) |
| Reviewer process crashed / `is_error` | inconclusive → FAIL (retry the reviewer, not the implementer; this consumes a *reviewer* re-run, not a node `attempt`) |
| Codex `--output-schema` corrupted by active MCP (codex-exec.md §3) | validate JSON ourselves; if invalid → inconclusive → FAIL + fall back to the other provider's reviewer |
| Empty `checks` (non-code node) | `checksPass=true` vacuously; gate rests entirely on `reviewPass` |

Quality bugs are never silently passed: an unverifiable review is a fail, not a pass-by-default.

---

## 7. Retry & escalation

GATE-fail (and worker-crash) route to `RE_DISPATCH` under a single per-node `attempts` counter capped
at **`MAX_RETRIES = 3`** (Spec 00 ledger; the constant lives in Spec 04 §2). The *mechanics* of the
loop — the NODE FSM transitions, the resume-vs-fresh decision — are **owned by Spec 04 §8**; this spec
owns **what feedback is threaded** and **the escalation message format**.

### 7.1 Threading reviewer feedback into the re-dispatch

On each fail, the `ReviewerFeedback` is handed to Spec 04's `redispatchStrategy` (Spec 04 §8.1), which
decides **resume same session** (default for a *quality* gate-fail — the worker keeps its worktree and
context, feedback delivered as the next user turn) vs **fresh spawn** (for crashes, a stuck-in-a-rut
node, or the last attempt before escalation). The feedback payload Spec 04 sends is built here:

```ts
function redispatchBrief(fb: ReviewerFeedback, strategy: "resume" | "fresh"): string {
  const failedChecks = fb.checkResults.filter(r => !r.pass)
    .map(r => `- \`${r.cmd}\` → exit ${r.exitCode}\n${indent(tail(r.stderr || r.stdout))}`);
  const blockers = fb.verdict.issues.filter(i => i.severity !== "minor")
    .map(i => `- [${i.severity}] ${i.detail}${i.location ? ` (${i.location})` : ""}`);

  if (strategy === "resume") {
    return [
      "Your change did not pass the gate. Fix these and keep your existing work:",
      failedChecks.length ? "Failing checks:\n" + failedChecks.join("\n") : "",
      blockers.length ? "Review found:\n" + blockers.join("\n") : "",
      "Re-run the checks yourself before signaling done.",
    ].filter(Boolean).join("\n\n");
  }
  // fresh: feedback becomes the brief, prior diff attached as a non-passing reference
  return [
    "A previous attempt failed review. Start fresh from the criteria.",
    "It failed for:", [...failedChecks, ...blockers].join("\n"),
    "The prior (non-passing) diff is attached as a reference of an approach that did NOT work.",
  ].join("\n\n");
}
```

The brief is delivered per Spec 02: a `sendNudge`/`user` message on resume (Claude lands it next turn;
Codex applies it on the next `exec resume`), or the initial prompt on a fresh spawn. The full
`feedback[]` history persists (Spec 04 `NodeRecord.feedback`, Spec 09) so the escalation can show what
each cycle tried.

### 7.2 Escalation after MAX_RETRIES — the exact message format

After the 3rd failed cycle the node hits `NODE_FAILED` (Spec 04 N20) and the task escalates
(`ESCALATED`, origin=`GATE`). This spec defines the **message shape**; [Spec 05](./05-discord-interface.md)
owns **delivery** (posting it in the origin channel in Beckett's first-person voice) and
[Spec 04 §9](./04-state-machine.md) owns the `Escalation`/`EscalationOption` records.

> **Canonical format:**
> `tried 3×, stuck here: <one-line summary>, options: A) <…> B) <…> C) <…>`

Built from the persisted `feedback[]`:

```ts
function buildGateEscalation(node: NodeRecord): Escalation {
  const last = node.feedback.at(-1)!;
  const summary = last.summary;                       // "checks green but review blocks: auth bypass on empty token"
  const perCycle = node.feedback.map((f, i) =>
    `  ${i + 1}. ${f.summary}`).join("\n");           // what each of the 3 cycles tried/hit

  return {
    origin: "GATE",
    nodeId: node.id,
    reason: `Node "${node.title}" failed the gate ${node.attempts}× (${last.tier} review).`,
    options: [
      { key: "A", label: "Give me more rope",  effect: "redispatch:+2 attempts with your guidance" },
      { key: "B", label: "Take it from here",  effect: "deliver partial diff/PR for you to finish" },
      { key: "C", label: "Drop this node",      effect: "abandon node; deliver the rest of the DAG" },
    ],
    raisedAt: Date.now(),
  };
}
```

Rendered to the channel (Spec 05 applies the persona/voice):

```
tried 3× on "add JWT auth", stuck here: checks pass but review keeps catching an auth bypass —
an empty/None token slips through verification (src/auth/jwt.ts:42). each pass I tightened it,
it regressed elsewhere. options:
  A) give me more rope — I take another 2 swings with a hint from you on the intended token contract
  B) take it from here — I hand you the branch/PR at its current state to finish
  C) drop it — I ship the rest (the cookie path + tests are green) and leave JWT out
```

- The options are **A/B/C, action-oriented, and honest** — they map to Spec 04 resolutions (T15/T16/T17):
  re-enter `EXECUTING` with `attempts` reset/extended (A), deliver-partial / handshake (B → Spec 05/07),
  or drop the node and continue the DAG (C). Beckett may tailor the option set per situation, but the
  **"tried N×, stuck here: …, options: …"** spine is fixed.
- **SUPERVISE-origin** escalations (abort on a drifting worker, integration-worker failure, self-halt;
  Spec 04 §9) reuse the same builder with `origin:"SUPERVISE"` and a first-person account instead of a
  retry count ("I aborted this — it was rewriting the auth layer it didn't own — here's where it stands,
  options: …").

### 7.3 Invariants

- **Never silent retry:** every re-dispatch is logged (event log, Spec 09); a SUPERVISE view shows the
  attempt count.
- **Never silent failure:** a node never disappears — exhausting retries *always* produces the
  escalation message above. There is no path from `GATING` to a terminal state that skips Jason.
- **≤3:** the 4th need-to-retry escalates instead. (`attempts >= MAX_RETRIES` → N20.)

---

## 8. Adversarial-verify ethos & the quality dial

### 8.1 Why fresh-context review beats self-review for critical work

- **The implementer is invested.** A model that just wrote the code is primed to see it as correct
  (the same context that produced the bug rationalizes it). Self-review shares the author's blind spots.
- **Fresh context = no rationalization.** A reviewer given *only* criteria + diff, with an explicitly
  adversarial brief ("find why this does NOT meet the criteria") and **no write tools**, can't "just
  fix it" or defer to the author — its only move is to judge. That asymmetry is the value.
- **Different eyes catch different misses.** The reviewer reads the diff as a skeptic reading a PR from
  a stranger — which is exactly the posture that catches "tests assert the wrong thing," weakened
  auth, and skipped scope.
- **It's cheap relative to the cost of the miss.** For security/auth/external-surface nodes, an extra
  one-shot Opus pass is trivial against shipping an auth bypass. The tier heuristic (§4.1) spends this
  scrutiny only where blast radius justifies it — self-review keeps the simple majority fast.

This is the same principle the whole system runs on (Spec 00 pillar: standing to push back; the gate
is Beckett's standing to refuse its *own* workers' output).

### 8.2 N-reviewer voting (the `panel` tier) — a quality dial

For the most critical nodes (`config.toml [review] panic_nodes`, or an explicit PLAN flag), run **N
independent fresh reviewers** (default N=3, odd to break ties) and combine by vote:

```ts
function panelVerdict(verdicts: ReviewVerdict[], rule: "majority" | "unanimous"): ReviewVerdict {
  const passes = verdicts.filter(v => v.pass).length;
  const pass = rule === "unanimous" ? passes === verdicts.length : passes > verdicts.length / 2;
  return {
    pass,
    criteriaMet: mergeByCriterion(verdicts),                 // a criterion is "met" only if the panel agrees
    issues: dedupeIssues(verdicts.flatMap(v => v.issues)),   // union of all reviewers' findings
    confidence: avg(verdicts.map(v => v.confidence)),
  };
}
```

- **Voting rule is a dial:** `majority` (default) tolerates one outlier; `unanimous` (any reviewer
  blocks → fail) is the strictest, for irreversible/security-critical nodes.
- **Reviewers should be diverse** to be worth the cost: vary the provider (Claude + Codex, §7),
  the model tier, and the seed/temperature so they don't share a failure mode. A panel of three
  identical reviewers mostly just adds latency.
- Panels are **opt-in** (cost = latency + slots; they consume concurrency, Spec 01). The tier heuristic
  only auto-selects `panel` when explicitly enabled; otherwise critical → `fresh`/`cross`.

---

## 9. Cross-provider review (post-v0)

A `cross`-tier reviewer is a fresh reviewer **on the other harness** (Codex reviews Claude's work and
vice-versa). Different providers have different failure modes; a reviewer that doesn't share the
implementer's *provider* biases catches a different class of defect. This is a **v1+ upgrade for
critical nodes** (Spec 00 §4 "Cross-provider review post-v0"; §8 Later) — v0 is Claude-only, so v0
critical nodes use the same-provider `fresh` tier.

### 9.1 Codex as reviewer

Codex reviews a Claude-authored diff via a read-only, schema-constrained one-shot. Two paths:

**(a) The `codex exec review` subcommand** — Codex ships a first-class review mode that takes a base
branch and reviews the diff against it:

```bash
codex exec review --base "$PROJECT_BRANCH" -C "$WS" --json -o "$WS/.beckett/verdict.txt" "<criteria>"
```

⚠️ **`codex exec review` is not documented in [codex-exec.md](../my-docs/codex-exec.md)** (which covers
`codex exec`/`resume`/`app-server`); its exact flags, whether it accepts `--output-schema`, and the
shape of its output are **unverified** — confirm against the installed `codex-cli` (`codex exec review
--help`) during Spec 12 setup before relying on it. Until verified, prefer path (b).

**(b) Plain `codex exec`, read-only, schema-constrained** (the verified primitive, codex-exec.md §3/§5):

```bash
codex exec \
  --json \
  -C "$WS" \
  --sandbox read-only \                  # reviewer cannot write/edit/run mutating cmds (codex-exec.md §5.1)
  --ask-for-approval never \             # never hang on a prompt
  --output-schema "$VERDICT_SCHEMA" \    # → ReviewVerdict as final agent_message (validate ourselves!)
  -o "$WS/.beckett/verdict.json" \       # robust grab of the final message
  -c model='"gpt-5.6-codex"' \
  "$REVIEW_PROMPT"                        # same adversarial prompt as §5.3
```

⚠️ Codex `--output-schema` can be silently ignored/corrupted when MCP tools are active (codex-exec.md
§3, #15451/#19816) — the runner **validates the verdict JSON itself** and falls back to the
`-o verdict.json` file; if still invalid → inconclusive → fail-closed (§6.3) and re-run on Claude.

### 9.2 Claude reviewing Codex

Symmetric: the §5.2 Claude reviewer spawn, pointed at a Codex-authored diff. No changes — the reviewer
doesn't know or care which provider wrote the code (and is deliberately not told, §5.1).

The `WorkerEvent` normalization (Spec 02 §7) makes both reviewers' telemetry uniform; the
`ReviewVerdict` schema is provider-agnostic, so GATE (§6) treats a Claude verdict and a Codex verdict
identically.

---

## 10. End-to-end walkthrough (a critical node)

```ts
// Spec 04 N11 fired: worker exited ok → INTEGRATING → (merge clean) → REVIEWING
async function reviewAndGate(node: NodeRecord, ws: string, baseRef: string): Promise<GateResult> {
  // 1. run ALL checks in the worktree (post-merge), full picture, no short-circuit (§3)
  const checks = await runChecks(node.criteria.checks, ws, checkEnv(node));   // ChecksOutcome

  // 2. pick the tier from criticality signals (§4.1)
  const signals = criticalitySignals(node, ws);                              // diff stats + scope + DAG
  const tier = chooseTier(signals, cfg.review);                              // "fresh" for an auth node

  // 3. judge the NL criteria (§4.2 self | §5 fresh | §9 cross | §8 panel)
  const diff = await gitDiff(ws, baseRef);                                   // base..HEAD
  let verdict: ReviewVerdict;
  switch (tier) {
    case "self":  verdict = await opusSelfReview(node.criteria, diff, checks); break;
    case "fresh": verdict = await spawnFreshReviewer("claude", node.criteria, diff, checks, ws); break;
    case "cross": verdict = await spawnFreshReviewer("codex",  node.criteria, diff, checks, ws); break; // post-v0
    case "panel": verdict = panelVerdict(await spawnPanel(node, diff, checks, ws), cfg.review.voteRule); break;
  }

  // 4. GATE = checksPass AND reviewPass (§6) — runner re-normalizes verdict.pass, fail-closed
  const result = gate(node, checks, verdict, tier);

  // 5. log the outcome (Spec 09 learned model) regardless of pass/fail
  await logGateOutcome(node, result);

  return result;   // Spec 04: pass → N18 NODE_DONE; fail → N19 RE_DISPATCH (thread result.feedback) / N20 escalate
}
```

The fail path: Spec 04 appends `result.feedback` to `node.feedback[]`, picks resume-vs-fresh (§7.1 /
Spec 04 §8.1), and re-dispatches with `redispatchBrief(...)`. After the 3rd fail, `buildGateEscalation`
(§7.2) produces the `tried 3×, …, options A/B/C` message for Spec 05 to deliver.

---

## 11. Configuration (`config.toml [review]`)

```toml
[review]
check_timeout_s        = 600        # per-check wall-clock (§3.2)
check_output_cap_bytes = 16384      # head+tail truncation per stream (§3.3)
blast_radius_critical  = 2          # ≥N dependents → critical (§4.1)
diff_lines_critical    = 150
files_critical         = 8
review_turn_cap        = 12         # reviewer --max-turns (no $ budget)
reviewer_model         = "claude-opus-4-9"
cross_provider_enabled = false      # v0 = false (Claude-only); flip on once Codex is wired (§9)
panic_nodes            = false      # auto-select the N-reviewer panel for security/irreversible (§8)
panel_n                = 3
vote_rule              = "majority" # "majority" | "unanimous"

[review.check_env]                  # scrubbed env for checks (§3.5)
inherit  = "core"                   # PATH/HOME/LANG …
exclude  = ["*_TOKEN", "*_SECRET", "*_KEY", "DISCORD_*", "GITHUB_PAT"]
```

---

## 12. Open gaps (⚠️ summary)

| Gap | Status |
|---|---|
| `codex exec review` subcommand (flags / `--output-schema` support / output shape) | ⚠️ not in codex-exec.md — verify on installed `codex-cli` (Spec 12); prefer plain `codex exec --sandbox read-only` until then (§9.1) |
| Baseline-diff for pre-existing test failures | ⚠️ v1 refinement; v0 uses scoped checks (§3.4) — shared with Spec 04 INTEGRATE |
| Shared vs separate retry budget for crash (Spec 04 N12) vs gate-fail (N19) | ⚠️ Spec 04 §5.2 flags it; this spec assumes **one shared `attempts`** counter (§7) — confirm |
| Real isolation for arbitrary check commands | ⚠️ worktree + scrubbed env only in v1; containers deferred (Spec 00 §8) |
| Reviewer self-`pass` vs runner-normalized `pass` divergence | handled fail-closed (§5.4), but log volume / tuning TBD |
| Codex `--output-schema` corruption with MCP active | ⚠️ validate ourselves + `-o` fallback + cross-fail to Claude (§6.3/§9.1) |
| Claude `--append-system-prompt` / `--allowedTools` on reviewer | ⚠️ standard flags, unverified in wire-format doc — confirm `claude --help` (Spec 12), same caveat as Spec 02 §11 |
| Panel reviewer diversity (provider/seed/temp) actually reducing correlated misses | ⚠️ design intent (§8.2); measure once outcome logging (Spec 09) has data |

---

## 13. Summary

1. **Criteria are mandatory per node** (`AcceptanceCriteria { checks: string[], nl: string[] }`, +
   optional `interfaceContract`), authored by Opus at PLAN (Spec 06): `checks` are shell commands
   (exit 0 = pass) — the deterministic floor; `nl` are atomic English statements a reviewer judges —
   the judgment ceiling.
2. **Checks run in the worktree post-INTEGRATE**, as `beckett` with a scrubbed env, all-run-no-
   short-circuit, output truncated head+tail; **"checks pass" = every command exits 0** within timeout
   (`ChecksOutcome.allPass`); timeouts/crashes fail-closed.
3. **Review is tiered by criticality** (security/auth touch, blast radius, diff size, dependency
   changes, external surface, prior retries): simple → **Opus self-review**; critical → a **fresh
   adversarial `claude -p` reviewer** given only criteria + diff, **read-only, no write tools**
   (`--allowedTools Read,Glob,Grep --permission-mode dontAsk --json-schema`), briefed to *find why this
   does NOT meet the criteria*.
4. Reviewers (self/fresh/cross/panel) all emit the same **`ReviewVerdict { pass, criteriaMet[],
   issues[], confidence }`**; the runner re-derives `pass` fail-closed (any blocker / unmet criterion /
   unvalidated schema → fail).
5. **GATE passes iff `ChecksOutcome.allPass && verdict.pass`** — no partial pass, no override. Fail →
   `ReviewerFeedback` (failing checks + blocker issues) threads into the **≤3** retry loop (resume vs
   fresh per Spec 04 §8); after 3 → **escalate**: `tried 3×, stuck here: <summary>, options: A) … B) …
   C) …` (delivered by Spec 05). Never silent retry, never silent failure.
6. **Adversarial ethos:** fresh context beats self-review on critical work because a cold,
   write-disabled reviewer can't rationalize the author's bugs; an opt-in **N-reviewer panel**
   (majority/unanimous, diverse providers) is the quality dial; **cross-provider review** (Codex⇄Claude,
   `codex exec review`/`codex exec --sandbox read-only`) is the post-v0 upgrade for the most critical
   nodes. Deferred to siblings: retry-loop FSM wiring (04), spawn mechanics (02), criteria authoring
   (06), outcome logging (09), delivery (05).
</content>
</invoke>
