# Beckett — Spec 07: Identity & Agency

> **The "self" made operational.** This spec turns the four pillars from [Spec 00 §2](./00-overview.md#2-the-four-pillars-of-self-what-makes-it-a-coworker-not-a-tool)
> and the agency-boundary decision from [Spec 00 §4](./00-overview.md#4-canonical-decisions-the-ledger)
> into concrete machinery: the `Identity` abstraction, the **action-class gate** (FREE /
> HANDSHAKE-GATED / ALWAYS-ASK), GitHub agency (its own account, branches, PRs, merges), Gmail agency
> (its own account, inbox poller, gated send), and the generalized **delivery handshake**. If this spec
> contradicts [Spec 00](./00-overview.md), Spec 00 wins (or we fix 00 first).
>
> Status: **draft v0.1** · Last updated 2026-06-27 · Owner: Jason
> Canon: [Spec 00](./00-overview.md). Research & rationale: [`../my-docs/open-questions.md`](../my-docs/open-questions.md)
> (esp. §F1 own accounts, §F2 email, §F3 GitHub, §F4 agency budget, §secrets zero-reauth).

---

## 0. Scope & cross-links

This document **owns**: the `Identity` TS abstraction, the **action-class gate model** and its full
classification table, the GitHub authentication + push/PR/merge mechanics, the Gmail authentication +
poll/classify/triage/draft + gated-send mechanics, the generalized `PendingAction` (delivery
handshake) lifecycle, the **self-halt** trigger conditions and message, and the **`.env` credential
list + blast-radius / least-privilege** policy.

It **defers**:

| Concern | Owner |
|---|---|
| Discord surfacing of handshakes/escalations, correlation of the answer back to the `PendingAction` | [Spec 05 — Discord Interface](./05-discord-interface.md) |
| How `PendingAction` rows persist + survive restart; event-log audit shape | [Spec 09 — Persistence & Data Model](./09-persistence-data-model.md) |
| The people/projects memory Beckett resolves email recipients + PR reviewers against | [Spec 08 — Memory & Knowledge Graph](./08-memory-knowledge-graph.md) |
| One-time provisioning of the GitHub/Gmail/Discord accounts + token minting | [Spec 12 — Roadmap & Setup](./12-roadmap-setup.md) |
| Spawning a task from an inbox-classified email (INTAKE) | [Spec 04 — State Machine](./04-state-machine.md) |
| Which model classifies an email / drafts a reply (Haiku vs Opus) | [Spec 06 — Brain & Models](./06-brain-models.md) |
| The merge as the *task-delivery* step of the loop | [Spec 04 §DELIVER](./04-state-machine.md), [Spec 00 §3](./00-overview.md#3-the-loop-canonical-state-machine) |

⚠️ At time of writing, **Spec 05 does not yet exist** and all sibling specs except [Spec 00](./00-overview.md)
and [Spec 04](./04-state-machine.md) are forward references. Discord correlation contracts below
(§5.3) are written as the interface Spec 05 must satisfy; mark them provisional until 05 lands.

---

## 1. The four pillars, operationalized

[Spec 00 §2](./00-overview.md#2-the-four-pillars-of-self-what-makes-it-a-coworker-not-a-tool) names four
pillars of "self." This spec is where two of them (standing identity, self-governance) and the agency
boundary get their concrete mechanisms. The map:

| Pillar (Spec 00 §2) | Mechanism in this spec |
|---|---|
| **1. Discretion over resources** | The **gate model** (§2) is discretion made safe: everything reversible is **FREE** — Beckett branches, drafts, labels, triages, opens PRs without asking. Discretion is the *default*; gating is the narrow exception for the irreversible/outward edge. |
| **2. Persistent home + earned knowledge** | A **single durable `Identity`** (§1.1) tied to OS user `beckett`, with long-lived tokens in `~/.beckett/.env` (§7) and persisted `claude`/`codex` logins — the "home" survives restarts with **zero re-auth**. The accounts (`@beckett-bot` on GitHub, Beckett's Gmail) are *its own*, accruing PR history and email relationships that are genuinely Beckett's, not Jason's. |
| **3. Standing to push back** | Identity = **clean attribution**: PRs, reviews, commits, and emails are signed by Beckett, so its opinions ("this contradicts itself," a requested-changes review) carry its name, not Jason's. The gate model gives it the standing to *refuse the irreversible step* — it can deliver a PR and decline to merge, or draft an email and decline to send, pending Jason's word. |
| **4. Self-governance** | The **self-halt** (§6): Beckett halts *itself* — not just its workers — on scope balloon / repeated gate failure / rate-limit wall, surfacing one honest "I don't think I should keep going — continue?" Plus the gate model is itself self-governance: Beckett polices its own outward actions. |

The governing rule, verbatim from [Spec 00 §4 (Agency boundary)](./00-overview.md#4-canonical-decisions-the-ledger):

> Reversible work free (branch, PR, draft); outbound/irreversible via **delivery handshake**
> ("review or merge?" / "send as me, or you handle it?").

Everything below is the implementation of that one line.

---

## 2. The `Identity` abstraction + the action-class gate

### 2.1 The `Identity` struct (TS)

There is exactly **one** `Identity` per Beckett daemon — its sense of self. It is loaded once at boot
from `~/.beckett/.env` + `config.toml`, held in memory, and threaded into every outward action so the
action is *signed as Beckett*.

```ts
// identity/identity.ts

export interface Identity {
  /** Display name + voice owner. "Beckett". */
  name: string;

  github: {
    account: string;           // GitHub login, e.g. "beckett-bot"
    pat: string;               // fine-grained PAT (from env GITHUB_PAT). NEVER logged.
    apiBase: string;           // "https://api.github.com" (or GHE base)
    noreplyEmail: string;      // "<id>+beckett-bot@users.noreply.github.com" for commits
  };

  gmail: {
    account: string;           // "beckett.coworker@gmail.com"
    auth: GmailAuth;           // discriminated union — OAuth tokens OR app-password (§4.2)
  };

  discord: {
    botUser: string;           // bot user id (the @beckett the user mentions)
    // token lives in env (DISCORD_TOKEN); the gateway connection is owned by Spec 05.
  };

  /** The OS account Beckett *is* on loom-desk. All subprocesses run as this uid. */
  osUser: "beckett";
}

export type GmailAuth =
  | { kind: "oauth"; clientId: string; clientSecret: string; refreshToken: string;
      accessToken?: string; expiresAt?: number }   // refreshed in-process; see §4.2
  | { kind: "app-password"; appPassword: string }; // IMAP/SMTP fallback; see §4.2
```

`Identity` is **read-mostly**: the only field that mutates at runtime is `gmail.auth.accessToken` /
`expiresAt` when an OAuth access token is refreshed. That refresh is written back to `.env` (or a
sidecar token cache, §7.3) so a restart keeps zero-reauth.

### 2.2 Action classes

Every action Beckett can take is exactly one of three classes. The class is a **property of the
action type**, decided at call time by `classify(action)` — not a per-task setting.

```ts
// identity/gate.ts

export enum ActionClass {
  FREE            = "FREE",            // reversible/internal → just do it, log it
  HANDSHAKE_GATED = "HANDSHAKE_GATED", // outward but expected → create PendingAction, ask once
  ALWAYS_ASK      = "ALWAYS_ASK",      // dangerous/irreversible-at-scale → never unattended, ever
}
```

- **FREE** — reversible or internal. Beckett does it on its own discretion and records it in the event
  log (Spec 09). No human in the loop. *This is the default and the bulk of activity.*
- **HANDSHAKE-GATED** — an outward/irreversible step that is the *expected* finish line of work.
  Beckett does **all** the work up to the irreversible click, then creates a `PendingAction` (§5),
  surfaces the **delivery handshake** in Discord, and executes only on a yes/variant answer. This is
  the merge and the email-send.
- **ALWAYS-ASK** — destructive, hard-to-undo even with a yes, or outside Beckett's remit. Beckett will
  **never** perform it unattended; even with a handshake it requires an *explicit, specific* Jason
  instruction in the conversation (not a generic "yes"). These are guardrails, not workflow.

The difference between HANDSHAKE-GATED and ALWAYS-ASK: a handshake-gated action is *Beckett's plan,
awaiting a go*; an always-ask action is *never Beckett's plan* — it only happens if Jason explicitly
directs it, and Beckett still confirms.

### 2.3 The full classification table

| Action | Class | Rationale |
|---|---|---|
| **GitHub** | | |
| Create/push a `beckett/*` branch | **FREE** | Reversible; isolated namespace; no shared history touched. |
| Commit to an owned worktree/branch | **FREE** | Local/branch-scoped. |
| Open a PR (from `beckett/*` → main) | **FREE** | A *proposal*, not a change to main. The integration handoff. |
| Update a PR (push more commits, edit body) | **FREE** | Still a proposal on Beckett's own branch. |
| Comment on / review a PR or issue (incl. request-changes) | **FREE** | Speech, not state change. Beckett's standing to push back. |
| Add labels / assign / set milestone on own PR | **FREE** | Reversible metadata. |
| **Merge a PR to main / protected branch** | **HANDSHAKE-GATED** | The irreversible integration step → *"PR's up — review or merge?"* (§3.4). |
| Delete a *merged* `beckett/*` branch | **FREE** | Tidy-up; history preserved in the merge. |
| Delete an *unmerged* branch (own) | **HANDSHAKE-GATED** | Discards unmerged work → confirm. |
| Force-push to a **shared** branch (main/release/someone else's) | **ALWAYS-ASK** | Rewrites others' history. *Never unattended.* (§3.5) |
| Force-push to Beckett's **own** `beckett/*` branch with an open PR | **HANDSHAKE-GATED** | Can surprise a mid-review reviewer → confirm. |
| Create/delete a repo, change repo settings/visibility, manage collaborators | **ALWAYS-ASK** | Org-level blast radius, outside normal task remit. |
| Edit/delete branch protection rules | **ALWAYS-ASK** | Disables the very guardrails this table relies on. |
| **Gmail** | | |
| Read / search / fetch threads | **FREE** | Read-only. |
| Apply/remove labels, archive, mark read, triage | **FREE** | Reversible org. |
| Create a draft (reply or new) | **FREE** | A draft is not sent; sits in *Beckett's* drafts/Jason's inbox. |
| Spawn a task from an inbox email (INTAKE) | **FREE** | Internal; the task itself re-enters this table at its own gates. |
| **Send an email (reply or new) — internal or external** | **HANDSHAKE-GATED** | The irreversible outward step → *"drafted it — send as me, or you handle it?"* (§4.3). |
| Reply on a cc'd thread Beckett is on | **HANDSHAKE-GATED** | Same as send — it leaves Beckett's outbox. |
| Auto-reply / vacation responder / filters that send | **ALWAYS-ASK** | Sends without a per-message human look. |
| Delete (permanently) a message/thread, empty trash | **ALWAYS-ASK** | Irrecoverable; archive is the FREE alternative. |
| Change account/security settings, add forwarding, change recovery | **ALWAYS-ASK** | Account-takeover surface. |
| **Cross-cutting** | | |
| Spend a worker / model call (subscription) | **FREE** | Beckett's discretion over resources (Pillar 1). |
| Create a project dir + register in memory | **FREE** | Local, reversible. |
| `rm -rf` outside owned paths / package publish / deploy / DNS / billing | **ALWAYS-ASK** | Out of remit and/or irreversible at scale. |
| Anything touching money, prod infra, or third-party accounts | **ALWAYS-ASK** | Hard floor. |

> ⚠️ **The table is the policy.** It lives in code as `CLASSIFICATION` (a `Map<ActionType,
> ActionClass>`) plus a small set of predicates (e.g. `isSharedBranch(ref)`,
> `isExternalRecipient(addr)`) that pick the row. `classify()` is *pure and total* — an unknown action
> type **defaults to ALWAYS-ASK** (fail-closed). New action types MUST be added here before use.

```ts
// identity/gate.ts (cont.)

export type ActionType =
  | "git.branch.push" | "git.commit" | "git.force_push"
  | "gh.pr.open" | "gh.pr.update" | "gh.pr.comment" | "gh.pr.review"
  | "gh.pr.merge" | "gh.branch.delete" | "gh.repo.admin" | "gh.branch_protection.edit"
  | "gmail.read" | "gmail.label" | "gmail.draft" | "gmail.send" | "gmail.delete"
  | "gmail.account.settings"
  | "fs.write_outside_scope" | "deploy" | "publish" | "money" /* … */;

export interface ActionContext {
  ref?: string;                 // git ref for branch/merge/force-push
  recipients?: string[];        // email addresses for gmail.send
  repo?: string;
  taskId?: string; userId?: string;
}

export function classify(type: ActionType, ctx: ActionContext): ActionClass {
  switch (type) {
    case "git.force_push":
      return isSharedBranch(ctx.ref!) ? ActionClass.ALWAYS_ASK
                                      : ActionClass.HANDSHAKE_GATED;
    case "gh.pr.merge":      return ActionClass.HANDSHAKE_GATED;
    case "gh.branch.delete": return isMerged(ctx.ref!) ? ActionClass.FREE
                                                       : ActionClass.HANDSHAKE_GATED;
    case "gmail.send":       return ActionClass.HANDSHAKE_GATED; // internal OR external
    case "git.branch.push": case "git.commit":
    case "gh.pr.open": case "gh.pr.update": case "gh.pr.comment": case "gh.pr.review":
    case "gmail.read": case "gmail.label": case "gmail.draft":
      return ActionClass.FREE;
    case "gh.repo.admin": case "gh.branch_protection.edit":
    case "gmail.delete": case "gmail.account.settings":
    case "fs.write_outside_scope": case "deploy": case "publish": case "money":
      return ActionClass.ALWAYS_ASK;
    default:
      return ActionClass.ALWAYS_ASK; // fail-closed
  }
}
```

### 2.4 The single choke point: `Gate.perform()`

**Every** outward action funnels through one method. There is no second path. This is the security
invariant: if it isn't in `classify()`, it can't happen (it defaults to ALWAYS-ASK and stalls).

```ts
// identity/gate.ts (cont.)

export class Gate {
  constructor(
    private id: Identity,
    private pending: PendingActionStore,   // Spec 09 persistence
    private events: EventLog,              // Spec 09 audit
  ) {}

  /**
   * The one door. `execute` is the irreversible thunk (merge / send).
   * Returns immediately for FREE; returns a PendingAction handle for gated;
   * throws GateRefused for ALWAYS_ASK without an explicit instruction.
   */
  async perform<T>(
    type: ActionType, ctx: ActionContext,
    execute: () => Promise<T>,
    handshake?: HandshakeSpec,             // required for HANDSHAKE_GATED
    explicitInstruction?: ExplicitInstruction, // required for ALWAYS_ASK
  ): Promise<GateResult<T>> {
    const cls = classify(type, ctx);
    this.events.append({ kind: "gate.classify", type, ctx, cls, ts: Date.now() });

    switch (cls) {
      case ActionClass.FREE:
        return { status: "done", value: await execute() };

      case ActionClass.HANDSHAKE_GATED: {
        if (!handshake) throw new Error(`gated action ${type} needs a HandshakeSpec`);
        const pa = await this.pending.create({ type, ctx, handshake, execute }); // §5
        return { status: "pending", pendingAction: pa };
      }

      case ActionClass.ALWAYS_ASK: {
        if (!explicitInstruction?.matches(type, ctx))
          throw new GateRefused(type, ctx); // never unattended
        // even with instruction, confirm via handshake before firing:
        const pa = await this.pending.create({ type, ctx, handshake: handshake!, execute });
        return { status: "pending", pendingAction: pa };
      }
    }
  }
}
```

---

## 3. GitHub agency

### 3.1 The account & access model

- Beckett has **its own GitHub account** (`@beckett-bot`, [Spec 00 Identity ledger](./00-overview.md#4-canonical-decisions-the-ledger)),
  provisioned in [Spec 12](./12-roadmap-setup.md). It is **added as a collaborator** (or org member
  with write) to the repos it works in — *not* a borrow of Jason's token. Clean attribution: every
  commit/PR/review reads "beckett-bot."
- Authn = a **fine-grained Personal Access Token** in `GITHUB_PAT` (§7), least-privilege scoped (§7.2)
  to the specific repos with only the permissions Beckett needs (Contents: RW, Pull requests: RW,
  Issues: RW, Metadata: RO). **No** admin, **no** org-management, **no** workflow scope unless a
  specific project needs it.

### 3.2 How it authenticates (two layers, both from the one PAT)

Beckett needs git auth (for `git push`) **and** API auth (for PR/review). Both ride `GITHUB_PAT`:

1. **git transport** — a **credential helper** so `git push` over HTTPS uses the PAT without
   interactive prompts and without writing the token to `~/.git-credentials` in plaintext:
   ```ts
   // configured once at boot, scoped to Beckett's osUser
   // git config --global credential.helper '!f() { echo "username=beckett-bot";
   //   echo "password=$GITHUB_PAT"; }; f'
   ```
   Remotes use HTTPS (`https://github.com/<org>/<repo>.git`). Commits are authored as
   `beckett-bot <…+beckett-bot@users.noreply.github.com>` via `git -c user.name -c user.email`.
   ⚠️ SSH-deploy-key alternative is possible but HTTPS+helper keeps a single credential (the PAT) and
   one rotation path — preferred.
2. **API** — either the **`gh` CLI** (`GH_TOKEN=$GITHUB_PAT gh …`) **or** direct REST
   (`Authorization: Bearer $GITHUB_PAT`). See §3.6 for the choice.

> **Why not `gh auth login`?** It stores creds in `gh`'s own config/keyring. For a headless daemon,
> passing `GH_TOKEN`/`GITHUB_TOKEN` env per-invocation is stateless, reproducible, and keeps the token
> in exactly one place (`.env`). `gh auth login` is fine as a one-time setup nicety but the daemon path
> is env-passing.

### 3.3 Push branches, open/update PRs **as itself**

The normal flow — all **FREE** (§2.3):

1. INTEGRATE (Spec 04) produces a merged node/task branch in the project repo's worktree.
2. Beckett pushes it under its own namespace: `git push origin HEAD:beckett/<task-slug>`.
   `beckett/*` is **Beckett's namespace** — it never pushes to `main`, `release/*`, or branches it
   doesn't own.
3. Open the PR as itself:
   ```bash
   GH_TOKEN=$GITHUB_PAT gh pr create \
     --repo <org>/<repo> --base main --head beckett/<task-slug> \
     --title "<task title>" --body "<what/why/criteria results/known limits>"
   ```
   The PR body is Beckett's delivery write-up: what it did, the acceptance-criteria results (checks +
   review, Spec 11), assumptions made under the reversible-clarify bias (Spec 00 §3 CLARIFY), and known
   limits. Subsequent commits → `git push` to the same branch updates the PR (FREE).
4. Comments/reviews (FREE) are Beckett's standing to push back — e.g. on a human PR it was asked to
   review, it can `gh pr review --request-changes --body "…"`.

The PR is the **integration handoff** ([Spec 00 §F3 rationale](../my-docs/open-questions.md)): Beckett
proposes; the merge is the gated step.

### 3.4 The merge delivery handshake

Merge-to-main is **HANDSHAKE-GATED**. At task DELIVER (Spec 04), Beckett has the PR up and green, then
funnels the merge through `Gate.perform("gh.pr.merge", …)`, which creates a `PendingAction` (§5) and
surfaces — via Discord (Spec 05) — the canonical line from [Spec 00 §3 DELIVER](./00-overview.md#3-the-loop-canonical-state-machine):

> **"PR's up — review or merge?"** (full: "I finished <task>. PR #<n> is up and green —
> want to review it yourself, or should I merge to main?")

The answer (correlated back by Spec 05, §5.3) drives the `execute` thunk:

| Answer | Effect |
|---|---|
| "merge" / "go" / "ship it" | `gh pr merge #<n> --squash --delete-branch` (merge strategy from `config.toml`). |
| "I'll review" / "leave it" | Resolve `PendingAction` as **declined-no-op**; task is DELIVERED with PR open. Not a failure. |
| variant ("merge but rebase" / "merge to `develop`") | Re-plan the merge with the variant, re-confirm if it changes class. |
| (timeout) | See §5.4 — defaults to **leave PR open**, never auto-merges. |

Standing auto-merge ("just merge when green") can be granted later as a per-repo policy flag that
*downgrades* `gh.pr.merge` to FREE for that repo — explicitly out of v1 ([Spec 00 §8 Later](./00-overview.md#8-phasing-north-star)).

### 3.5 Never force-push shared branches

Hard rule, encoded as `classify("git.force_push", …)` → `ALWAYS_ASK` when `isSharedBranch(ref)`:

```ts
const SHARED = [/^main$/, /^master$/, /^release\//, /^develop$/];
export const isSharedBranch = (ref: string) =>
  SHARED.some(re => re.test(ref)) || !ref.startsWith("beckett/");
```

Force-push to a *shared* branch is ALWAYS-ASK (effectively forbidden — it requires an explicit Jason
instruction *and* a confirm). Force-push to Beckett's **own** `beckett/*` branch is allowed but
HANDSHAKE-GATED if a PR is open on it (don't yank the rug from a live reviewer). Routine pushes to
`beckett/*` are fast-forward, FREE.

### 3.6 `gh` CLI vs REST — the choice

| | `gh` CLI | Direct REST (`fetch` + Bearer) |
|---|---|---|
| Setup | needs `gh` installed on loom-desk | zero extra deps (bun `fetch`) |
| Auth | `GH_TOKEN` env per call | `Authorization: Bearer` header |
| Ergonomics | high-level (`pr create/merge/review`) — less code | manual endpoints + pagination |
| Output | `--json` flags → structured | native JSON |
| Failure modes | parse CLI exit + stderr | HTTP status + body |

**Recommendation:** **`gh` CLI** as the primary driver for PR/issue/review ops (it already exists as a
robust, auth-aware wrapper, mirrors Beckett's "shell out to harnesses" philosophy from
[Spec 00 §1](./00-overview.md#the-spine-a-harness-over-harnesses)), with a **thin REST fallback** for
anything `gh` doesn't expose cleanly. `git push` itself is always plain git + credential helper.
⚠️ Confirm `gh` is on the loom-desk prereq list in [Spec 12](./12-roadmap-setup.md) (open-questions §A1
lists missing CLIs but not `gh`).

```ts
// github/client.ts — uniform surface regardless of gh-vs-REST underneath
export interface GitHubClient {
  pushBranch(repo: string, localRef: string, remoteBranch: string): Promise<void>; // git
  openPR(p: OpenPRParams): Promise<{ number: number; url: string }>;               // FREE
  updatePR(repo: string, n: number, p: UpdatePRParams): Promise<void>;             // FREE
  reviewPR(repo: string, n: number, r: ReviewParams): Promise<void>;               // FREE
  mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void>;        // GATED caller
  isGreen(repo: string, n: number): Promise<boolean>; // checks/status before the handshake
}
```

---

## 4. Gmail agency

### 4.1 Autonomous vs gated, at a glance

Per [Spec 00 §F2 / open-questions §F2](../my-docs/open-questions.md): Beckett's **own Gmail account**.
**Autonomous (FREE):** read, classify, label, triage, draft, and **spawn tasks** from email.
**Gated (HANDSHAKE):** *sending* anything (replies, new mail, cc'd-thread participation).

### 4.2 Gmail MCP vs direct API — the choice

This session exposes a **Gmail MCP** (`mcp__claude_ai_Gmail__*`: `search_threads`, `get_thread`,
`create_draft`, `list/create_label`, `label_thread`, etc.). loom-desk is a *standalone daemon*, so two
real options:

| | **Gmail MCP** | **Direct Gmail API** (googleapis) / **IMAP+SMTP** |
|---|---|---|
| Read/search/label/draft | first-class tools, no auth code | implement against REST or IMAP |
| Send | (MCP here exposes draft/label, **not a raw send** — note) | SMTP or `users.messages.send` |
| Auth | rides the MCP server's own OAuth | Beckett owns OAuth refresh token *or* app-password |
| Runs headless on loom-desk? | needs the MCP server reachable from the daemon | yes, self-contained |
| Zero-reauth (Spec 00) | depends on MCP server's token lifecycle | Beckett controls refresh → durable |
| Blast radius | broad MCP scopes | least-privilege Beckett can pin |

**Recommendation for loom-desk v1: direct Gmail API with an OAuth refresh token** (`GmailAuth.kind =
"oauth"`), because (a) it is self-contained on the daemon, (b) Beckett *owns* the refresh-token
lifecycle so zero-reauth (Spec 00 secrets) is in Beckett's hands, and (c) `users.messages.send` +
`users.drafts` + `users.threads` + `users.labels` give the exact least-privilege scopes (§7.2). The
**app-password + IMAP/SMTP** path (`GmailAuth.kind = "app-password"`) is the simpler fallback if OAuth
provisioning is painful — single `GMAIL_APP_PASSWORD` secret, IMAP poll + SMTP send, but coarser
scoping and no per-scope revocation. The **Gmail MCP** is the right tool when Beckett's brain is
running *inside a Claude session that already has it* (and a good future surface), but the standalone
daemon shouldn't take a hard dependency on an external MCP server for its core inbox loop. ⚠️ Note the
MCP exposed here has **no raw send tool** — another reason send rides the direct API.

A `GmailClient` interface hides which backend is live (mirrors §3.6's `GitHubClient`):

```ts
// gmail/client.ts
export interface GmailClient {
  poll(sinceHistoryId?: string): Promise<{ threads: Thread[]; historyId: string }>; // FREE
  getThread(id: string): Promise<Thread>;                  // FREE
  label(threadId: string, add: string[], remove: string[]): Promise<void>; // FREE
  draft(d: DraftSpec): Promise<{ draftId: string }>;       // FREE — sits in drafts
  send(d: DraftSpec | { draftId: string }): Promise<void>; // GATED caller (Gate.perform)
}
```

### 4.3 The inbox poller (cadence → classify → triage → spawn)

A scheduled loop, **FREE** throughout (no send):

```ts
// gmail/poller.ts
async function pollOnce(state: PollState) {
  const { threads, historyId } = await gmail.poll(state.historyId); // incremental via historyId
  for (const t of threads) {
    const c = await brain.classifyEmail(t);  // cheap model (Haiku) — Spec 06 owns model choice
    await gmail.label(t.id, [c.label], []);   // e.g. beckett/action, beckett/fyi, beckett/spam
    switch (c.disposition) {
      case "spawn_task":                       // → INTAKE (Spec 04), as if @beckett'd
        await taskIntake.fromEmail(t, c);      // FREE; the spawned task hits its own gates later
        break;
      case "draft_reply":                      // FREE — drafts, never sends
        await gmail.draft(await brain.draftReply(t, c));
        break;
      case "triage_only": break;               // labeled/archived, no further action
    }
  }
  state.historyId = historyId;                 // persisted (Spec 09) for incremental next poll
}
```

- **Cadence:** poll every **N minutes** (`config.toml: gmail.poll_interval`, default ~5m), using Gmail
  **`historyId`** for incremental deltas (cheap; avoids re-scanning). On webhook availability
  (Gmail push/Pub-Sub) this becomes event-driven — ⚠️ deferred, polling is the v1 baseline. The poller
  respects the same off-the-clock principle ([Spec 00 §1 cost principle](./00-overview.md#the-cost-principle-reframed-for-subscriptions)):
  Haiku classifies; Opus only wakes if a spawned task needs planning.
- **Classification → task intake:** "spawn_task" hands the thread to INTAKE (Spec 04) exactly like a
  Discord `@beckett` mention — same loop, same gates. Attribution: the task's `user_id` is resolved
  from the sender against memory (Spec 08); unknown/external senders get a quarantine label and do
  **not** auto-spawn (anti-prompt-injection — §7.4).
- **Drafting:** replies are drafted into Beckett's drafts (or surfaced to Jason's inbox per config),
  never sent.

### 4.4 The send handshake (incl. cc'd threads)

Send is **HANDSHAKE-GATED**. After drafting, Beckett funnels through `Gate.perform("gmail.send", {
recipients }, …)`, surfacing the canonical line from [Spec 00 §4](./00-overview.md#4-canonical-decisions-the-ledger):

> **"drafted it to your inbox — send as me, or you handle it?"**

| Answer | Effect |
|---|---|
| "send" / "send it" | `gmail.send({ draftId })` → leaves Beckett's outbox as Beckett. |
| "I'll handle it" | Resolve as declined-no-op; draft remains for Jason. |
| variant ("send but cc Sam" / edits) | Re-draft, re-confirm. |
| (timeout) | §5.4 — draft stays, nothing sends. |

**Cc'd-thread participation** is the same: when a poll finds Beckett cc'd on a thread and a reply is
warranted, it drafts and runs the *identical* send handshake. There is **no** "auto-participate"
shortcut — every outbound message is one human-confirmed `gmail.send`. (Internal vs external recipient
makes no difference to the class — both are HANDSHAKE-GATED; `isExternalRecipient` only affects the
*wording* of the handshake, e.g. flagging "this goes to someone outside the org.")

---

## 5. The delivery handshake, generalized (`PendingAction`)

The merge handshake (§3.4) and the send handshake (§4.4) are the same machine. A `PendingAction` is
**created at the finish line**, surfaced to Jason via Discord (Spec 05), and **awaits a yes/no/variant**
before its `execute` thunk runs or is discarded.

### 5.1 The type

```ts
// identity/pending-action.ts
export interface PendingAction {
  id: string;                       // ULID — the correlation key Discord echoes back (Spec 05)
  taskId: string;                   // owning task (Spec 04)
  userId: string;                   // who must answer (multiplayer-ready, Spec 00)
  type: ActionType;                 // "gh.pr.merge" | "gmail.send" | …
  ctx: ActionContext;
  handshake: HandshakeSpec;         // the question + the answer grammar
  status: "pending" | "executing" | "done" | "declined" | "expired" | "failed";
  createdAt: number; expiresAt: number;
  resolvedAt?: number; resolution?: HandshakeAnswer;
  // `execute` is NOT serialized — it is rehydrated from (type, ctx) on load (§5.3).
}

export interface HandshakeSpec {
  prompt: string;                   // "PR's up — review or merge?" — Beckett's voice (persona)
  grammar: AnswerGrammar;           // maps free-text → go | decline | variant
  timeoutMs: number;                // default from config.toml
}

export type HandshakeAnswer =
  | { kind: "go" }
  | { kind: "decline" }
  | { kind: "variant"; instruction: string }; // re-plan + re-confirm
```

### 5.2 Lifecycle

```
created (pending) ──surface→ Discord (Spec 05)
   │                              │
   │              ┌───────────────┼───────────────┐
   ▼              ▼               ▼               ▼
 (timeout)      "go"          "decline"        variant
 expired   →  executing   →   declined      re-plan→new PendingAction
              │  ↓ execute()    (no-op,        (re-confirm)
              │  done|failed     not a failure)
```

1. **create** — `Gate.perform` (§2.4) writes a `pending` row (Spec 09) and emits `pending.created`.
2. **surface** — Spec 05 posts the `handshake.prompt` to the right Discord channel, tagged with `id`.
3. **resolve** — Spec 05 correlates Jason's reply back to `id` (§5.3) and calls
   `pending.resolve(id, answer)`.
4. **execute / discard** — `go` → status `executing` → run `execute()` → `done` (or `failed`, which
   escalates per Spec 04). `decline` → `declined` (clean terminal, task still DELIVERED). `variant` →
   discard this one, re-plan, create a fresh `PendingAction`, re-confirm.

### 5.3 Persistence + restart (defer detail → Spec 09)

The hard requirement (Spec 00 durability): **a restart must not lose a pending handshake.** Because
`execute` is a live closure it can't be serialized, so:

- The **row** (`id, taskId, type, ctx, handshake, status, expiresAt`) persists in SQLite (Spec 09).
- On boot, Beckett **rehydrates** each `pending` row's `execute` thunk *from `(type, ctx)`* via a
  registry — `gh.pr.merge` + `{repo, prNumber}` reconstructs the merge call; `gmail.send` +
  `{draftId}` reconstructs the send. This is why `ctx` must carry everything the thunk needs (PR
  number, draft id) — **no** closure state beyond `ctx`.
- Already-surfaced rows are **not re-posted** (Spec 05 tracks the message id); Beckett just resumes
  waiting. An answer that arrived during downtime is reconciled on reconnect.

⚠️ **Correlation contract for Spec 05** (provisional until 05 exists): Discord must (a) render
`handshake.prompt`, (b) bind the reply to `PendingAction.id` (reply-to, button custom-id, or
single-outstanding-per-channel heuristic), (c) call `resolve(id, answer)` with the parsed
`HandshakeAnswer`. The `AnswerGrammar` (free-text → go/decline/variant) lives **here** in Spec 07 so
the policy is one place; Spec 05 owns only transport + which-message-is-this correlation.

### 5.4 Timeout behavior

Handshakes **do not expire into action.** On `expiresAt` (default `config.toml: handshake.timeout`,
e.g. 24h) with no answer:

- Status → `expired`. The `execute` thunk **never runs** — fail-safe: an unanswered "merge?" leaves
  the PR open; an unanswered "send?" leaves the draft. The irreversible side is always the one that
  needs a *yes*.
- Beckett posts a single low-key nudge before expiry (e.g. at 50% of the window) — "still holding the
  PR for you" — then goes quiet (sparseness, Spec 00 Discord). It does **not** re-ask on a loop.
- The task is **DELIVERED with the action unexecuted** (PR open / draft saved), which is an honest,
  non-failure terminal state. Jason can later just say "merge #12" / "send that draft" to re-trigger.

---

## 6. Self-governance / self-halt

Pillar 4 ([Spec 00 §2.4](./00-overview.md#2-the-four-pillars-of-self-what-makes-it-a-coworker-not-a-tool)):
Beckett halts *itself*, not just its workers. This is distinct from a worker abort (Spec 03) and from
the escalation points in the loop (Spec 04 CLARIFY/SUPERVISE/GATE) — it's Beckett stepping back from
the **whole task** and asking whether to continue at all.

### 6.1 Triggers (reframed for subscriptions — no dollars)

Per [Spec 00 §cost-principle](./00-overview.md#the-cost-principle-reframed-for-subscriptions) and
open-questions §I3, the scarce resources are **rate limits + wall-clock + attention**, never money:

| Trigger | Signal | Threshold (config) |
|---|---|---|
| **Scope ballooning** | DAG grew well past the planned node count / the work keeps spawning new nodes | actual nodes > `selfhalt.scope_factor` × planned (e.g. 2×), or new top-level work discovered |
| **Repeated gate failures** | A node burned its retry budget (Spec 04 ≤3) *and* re-planning isn't converging across nodes | ≥ `selfhalt.gate_fail_tasks` failing nodes, or the task as a whole stalls |
| **Rate-limit wall** | Failover (Spec 00) exhausted — *both* harnesses capped — and queue+backoff would block a long time | blocked > `selfhalt.ratelimit_block` (e.g. 30m) with no ETA |
| **Time wall** | Wall-clock far exceeds the rough estimate in the ack | elapsed > `selfhalt.time_factor` × estimate |
| **Drift of intent** | What it's now doing no longer matches the original ask (Opus judgment, not mechanical) | Opus self-check at a check-in flags divergence |

These feed a single `shouldSelfHalt(task): SelfHaltReason | null` evaluated at Opus check-ins
(Spec 03), so it stays off the clock between looks.

### 6.2 The message + the mechanism

On a trigger, Beckett does **not** silently grind. It **pauses the task** (workers checkpointed, not
aborted — recoverable), and surfaces one honest first-person line (persona voice, Spec 06) via Discord
— the [Spec 00 §2.4](./00-overview.md#2-the-four-pillars-of-self-what-makes-it-a-coworker-not-a-tool)
shape: *"I don't think I should keep going on this — here's why … continue?"* Concretely:

> "heads up — this ballooned. planned ~3 nodes, I'm at 7 and still finding work (the auth refactor
> pulls in the whole session layer). that's another team + maybe 2h. want me to keep going, narrow it,
> or stop here?"

This is a **`PendingAction`-shaped** decision (reuses §5: pause → surface → await answer), but its
class is its own — call it the **self-halt handshake**. Answers: **continue** (resume the paused task),
**narrow** (re-plan with a tighter scope — a variant), **stop** (graceful ABORT, Spec 04, with partial
work preserved and reported). Timeout → stays **paused** (never silently continues — same fail-safe as
§5.4; pressing forward is the thing that needs a yes).

The hard line ([Spec 00 §2.4](./00-overview.md#2-the-four-pillars-of-self-what-makes-it-a-coworker-not-a-tool)):
*"Knowing when to stop is what separates an agent with a viewpoint from a runaway loop."* Self-halt is
how Beckett *owns its decision* to stop — reported in first person, not a crash.

---

## 7. Security & blast radius

### 7.1 The `.env` credential list (`~/.beckett/.env`)

The complete key set this spec depends on (Spec 00 §5 layout; provisioning in Spec 12):

```bash
# ── Discord (interface; gateway owned by Spec 05) ──────────────────────────
DISCORD_TOKEN=                 # bot token for the @beckett bot user

# ── GitHub agency (§3) ─────────────────────────────────────────────────────
GITHUB_PAT=                    # fine-grained PAT, least-priv (§7.2). Used for git + gh/REST.
GITHUB_ACCOUNT=beckett-bot     # login (also Identity.github.account)

# ── Gmail agency (§4) ──────────────────────────────────────────────────────
GMAIL_ACCOUNT=beckett.coworker@gmail.com
# OAuth path (recommended, §4.2):
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REFRESH_TOKEN=     # long-lived; access tokens minted in-process (zero-reauth)
# App-password fallback path (§4.2) — use INSTEAD of OAuth, not both:
# GMAIL_APP_PASSWORD=

# ── Harness subscriptions (Spec 00 zero-reauth; auth dirs, not env) ────────
# claude/codex logins persist in ~/.claude and ~/.codex after one-time setup.
# No API keys here — Beckett runs on subscriptions (Spec 00 economics).
```

`.env` is `chmod 600`, owned by OS user `beckett`, **never** committed, **never** logged (the event
log redacts any value matching a known secret, §7.5).

### 7.2 Least-privilege scoping

- **GitHub PAT (fine-grained):** scoped to *exactly* the repos Beckett collaborates on, permissions =
  **Contents: RW, Pull requests: RW, Issues: RW, Metadata: RO**. **Excluded:** Administration,
  Org-management, Webhooks, Workflow (unless a project explicitly needs CI edits → add per-repo).
  Effect: even a fully-compromised PAT cannot delete repos, change protection, or touch other repos.
  This is what makes "force-push shared" / "repo admin" ALWAYS-ASK (§2.3) *also* mostly impossible by
  construction.
- **Gmail OAuth scopes:** `gmail.readonly` (poll/read) + `gmail.labels` (triage) + `gmail.compose`
  (draft) + `gmail.send` (the one gated capability). **Excluded:** full `https://mail.google.com/`
  (which allows permanent delete / settings). Effect: even compromised, no permanent deletion or
  account-settings changes — those ALWAYS-ASK rows are unreachable by token.
- **Principle:** the token can't do what the gate forbids. Gates are the *policy*; least-privilege
  scopes are the *enforcement floor* if the policy code is ever bypassed. Defense in depth.

### 7.3 Zero-reauth (Spec 00 goal)

- **Harness logins** (`claude`/`codex`) persist in `~/.claude` / `~/.codex` after one-time interactive
  setup (Spec 12) — Beckett's "home" keeps them; no API keys involved.
- **Gmail OAuth refresh token** is long-lived; Beckett mints short-lived access tokens in-process and
  caches them (`Identity.gmail.auth.accessToken/expiresAt`), refreshing transparently. The refresh
  token only dies if revoked → that's the *only* re-auth event, by design.
- **GitHub PAT** is long-lived (set an expiry per org policy — ⚠️ rotation reminder is a Spec 12 ops
  item). Until then, indefinite headless operation.

### 7.4 What Beckett must NEVER do unattended

The hard floor (the ALWAYS-ASK rows, §2.3, restated as prohibitions):

1. **Force-push / rewrite history on any shared branch** (main/release/others').
2. **Merge to a protected branch** without the handshake go.
3. **Send any email** without the handshake go (incl. cc'd threads, internal recipients).
4. **Permanently delete** email/threads, branches with unmerged work, or repos.
5. **Change account/security settings** (Gmail forwarding/recovery, GitHub branch protection, repo
   visibility, collaborators).
6. **Deploy, publish a package, touch DNS/billing/money, or `rm -rf` outside owned paths.**
7. **Auto-spawn a task from an untrusted/external email sender** (prompt-injection surface — quarantine
   + label, never auto-execute; §4.3).

All seven are unreachable via the normal `Gate.perform` path (default-ALWAYS-ASK + fail-closed) *and*
mostly unreachable via least-privilege tokens (§7.2).

### 7.5 Audit (defer → Spec 09)

Every gate decision and every executed action emits an event to the JSONL log (Spec 09): `gate.classify`,
`pending.created`, `pending.resolved`, `action.executed`, `action.failed`, `selfhalt.raised`. Secret
values are redacted. This is the after-the-fact accountability layer — "what did Beckett do as itself,
and on whose say-so" — and is the evidence trail for the standing/attribution pillar. Schema + retention
owned by [Spec 09](./09-persistence-data-model.md).

---

## 8. Calendar / Drive / Notion — future agency surfaces ⚠️ (later)

This session also exposes **Google Calendar, Google Drive, and Notion MCP** tools. These are natural
*future* extensions of Beckett's agency once GitHub + Gmail are solid — same model applies:

- They slot into the **same gate table** (§2): read/search/list = FREE; create/update a draft doc =
  FREE; **sending a calendar invite, sharing a Drive file externally, publishing a Notion page** =
  HANDSHAKE-GATED; deleting / changing sharing-settings / external-share = ALWAYS-ASK.
- They are the clearest case **for riding MCP** rather than building raw clients (no SMTP/REST
  equivalent worth hand-rolling), provided the MCP server is reachable from the loom-desk daemon — the
  inverse of the Gmail call (§4.2), where a self-contained API was preferred for the core loop.
- **Out of scope for v1.** Listed here so the `Identity`/`Gate` abstractions are designed wide enough
  to absorb them without a rewrite (add fields to `Identity`, rows to `classify()`). ⚠️ Defer concrete
  design to a post-v1 spec.

---

## 9. Open gaps ⚠️

1. **Spec 05 doesn't exist yet** — the handshake correlation contract (§5.3) is written as the
   interface 05 must satisfy; revisit when 05 lands.
2. **`gh` CLI on loom-desk** — open-questions §A1 lists missing CLIs but not `gh`; confirm it's a
   Spec 12 prereq (or commit fully to REST, §3.6).
3. **Gmail backend** — OAuth-refresh-token (recommended) vs app-password vs MCP (§4.2); pin in Spec 12
   provisioning. MCP here lacks a raw send tool — noted.
4. **`AnswerGrammar` location** — the free-text→go/decline/variant parser lives in Spec 07 (§5.3) but
   is exercised by Spec 05; confirm the split (07 = policy, 05 = transport).
5. **Self-halt thresholds** (§6.1) are config defaults guessed here — tune against real runs; shares
   the check-in scheduler with Spec 03.
6. **PAT rotation / token expiry ops** (§7.3) — an ops/runbook item for Spec 12, not automated in v1.
7. **Standing auto-merge** (§3.4) downgrade-to-FREE-per-repo is explicitly *later* (Spec 00 §8);
   confirm it's not snuck into v1.
8. **External-recipient detection** (`isExternalRecipient`, §4.4) needs the org-domain list — source it
   from memory/config (Spec 08).

---

## 10. Summary

1. **One `Identity`** (`name, github{account,pat}, gmail{account,auth}, discord{botUser}, osUser:
   'beckett'`) is Beckett's sense of self; every outward action is *signed as Beckett* and funnels
   through **one choke point** (`Gate.perform`), with `classify()` **fail-closed** to ALWAYS-ASK.
2. **Three action classes** — **FREE** (reversible: branch, commit, PR-open/update, comment/review,
   email read/label/draft, spawn-task), **HANDSHAKE-GATED** (merge-to-main, email-send incl. cc'd
   threads), **ALWAYS-ASK** (force-push-shared, repo/account admin, permanent delete, deploy/publish/
   money) — full table in §2.3.
3. **GitHub agency:** its own collaborator account; one fine-grained PAT drives both git (credential
   helper) and API (`gh` CLI primary, REST fallback); pushes `beckett/*`, opens PRs *as itself* as the
   integration handoff, **never force-pushes shared branches**, and merges only on the **"PR's up —
   review or merge?"** handshake.
4. **Gmail agency:** its own account; an **inbox poller** (~5m, incremental via `historyId`) that
   classifies → labels/triages → drafts → **spawns tasks** (all FREE), while **every send** (incl.
   cc'd-thread replies, internal *and* external) is the **"drafted it — send as me, or you handle
   it?"** handshake; recommended backend = direct Gmail API w/ OAuth refresh token over MCP/IMAP.
5. **Generalized handshake** = a persisted `PendingAction` created at the finish line, surfaced via
   Discord (Spec 05), awaiting go/decline/variant; survives restart by rehydrating `execute` from
   `(type, ctx)`; **timeout never fires the action** (fail-safe: PR stays open, draft stays saved).
   **Self-halt** reuses the same machine to let Beckett pause the *whole task* on scope-balloon /
   repeated-gate-fails / rate-limit-wall and ask "continue, narrow, or stop?"
6. **Security:** `.env` holds `DISCORD_TOKEN, GITHUB_PAT(+ACCOUNT), GMAIL_*` (no API keys — subscriptions);
   least-privilege PAT (Contents/PR/Issues RW, no admin) + Gmail scopes (read/labels/compose/send, no
   full-mailbox); zero-reauth via persisted harness logins + long-lived refresh tokens; seven hard
   NEVER-unattended actions; full audit via the Spec 09 event log.

**Flagged inconsistencies / forks:** see §9 — chiefly that **Spec 05 is unwritten** (the correlation
contract is provisional), the **`gh`-on-loom-desk prereq gap** (open-questions §A1 omits it), and the
**Gmail backend choice** (OAuth vs app-password vs MCP — the exposed MCP notably has *no raw send*).
None contradict the [Spec 00](./00-overview.md) ledger; all are deeper-than-canon decisions for sibling
specs (05 correlation, 09 persistence, 12 provisioning).
