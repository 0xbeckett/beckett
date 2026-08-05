# Beckett's GitHub identity — the kowo-co GitHub App

Beckett used to push as a machine account, `0xbeckett`. That account is **permanently lost** (2FA
unrecoverable), and it was the wrong shape anyway: a machine account can only reach repos somebody
adds it to as a collaborator. Beckett's identity is now a **GitHub App owned by the `kowo-co`
org**. It acts as **`beckett[bot]`**, and anyone — not just Jason — can install it on their own
repos in two clicks. That install flow *is* the product flow.

| | Old | New |
|---|---|---|
| Identity | `0xbeckett` machine account | GitHub App `beckett`, owned by `kowo-co` |
| Commits show as | `0xbeckett` | `beckett[bot]` |
| Credential | long-lived fine-grained PAT | 1-hour installation token, minted per call |
| Reach | repos it was added to | every repo an installation selected |
| Env | `GITHUB_PAT` | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` |

---

## What Jason has to do (the only manual part)

GitHub requires a human to confirm app creation in a browser. Everything around that click is
automated by `scripts/ops/github-app-register.ts`, which POSTs the checked-in manifest, catches
GitHub's redirect, exchanges the temporary code, and writes the private key out.

**1. Register the app** — on the Mac, signed into GitHub as a `kowo-co` owner:

```bash
cd ~/Code/beckett
bun scripts/ops/github-app-register.ts          # add --name 0xbeckett if "beckett" is taken
# → open http://127.0.0.1:7788/ in the browser
```

The browser lands on GitHub's **"Create GitHub App for kowo-co"** page — that is the click. On
confirm you are redirected back to the local server, which prints the app id, the slug, the
install link, and writes the private key to `~/.beckett/github-app.pem` (mode 0600).

> App **names are globally unique across GitHub**. If `beckett` is taken the POST is rejected on
> that page; re-run with `--name 0xbeckett`. (As of this writing `GET /apps/beckett` 404s, which
> means no *public* app holds it — a private one still could.)

Doing it by hand instead: <https://github.com/organizations/kowo-co/settings/apps/new>, fill in
the fields from `deploy/github-app-manifest.json`, then **Generate a private key** and download
the `.pem`. Same result, more typing.

**2. Install it on `kowo-co`** so Beckett can reach its own repo:

```
https://github.com/apps/<slug>/installations/new
```

Choose **Only select repositories → `kowo-co/beckett`** (least privilege). "All repositories" is
available if you'd rather not re-approve each new repo.

**3. Put the credentials on the box.** Copy the key to `beckett@desktop` and add the env lines:

```bash
scp ~/.beckett/github-app.pem beckett@desktop:~/.beckett/github-app.pem
ssh beckett@desktop 'chmod 600 ~/.beckett/github-app.pem'
```

In `~/.beckett/.env` on the box:

```dotenv
GITHUB_APP_ID=<numeric app id>
GITHUB_APP_SLUG=<slug>
GITHUB_APP_PRIVATE_KEY_PATH=/home/beckett/.beckett/github-app.pem
GITHUB_APP_INSTALLATION_ID=<from step 4>
```

Then delete the dead `GITHUB_PAT`, `GH_TOKEN`, and `GITHUB_USER` lines — the `0xbeckett` PAT is
revoked with the account.

The checkout on the box was seeded from a git bundle, so its `origin` is a local file. Repoint it
at GitHub and pull (git auth comes from the daemon's token injection, so run this via `beckett gh`
once the daemon is up — or as a one-off, plain HTTPS works for the initial pull of a public repo):

```bash
ssh beckett@desktop 'cd ~/beckett && git remote set-url origin https://github.com/kowo-co/beckett.git && git pull --ff-only'
```

**4. Restart and verify:**

```bash
ssh beckett@desktop 'systemctl --user restart beckett-v4.service'
beckett gh app status          # app id, slug, owner, who has installed it
beckett gh app installations   # → the id for GITHUB_APP_INSTALLATION_ID
beckett doctor                 # "identity: github app" + "identity: github token" green
```

**5. Re-encrypt the secrets backup** (`./deploy/backup-secrets.sh` from the Mac) — the `.env`
changed, and now there is a private key next to it.

---

## How the credential chain works

`src/github/app.ts` implements all three steps; nothing is stubbed.

1. **App JWT** — RS256 over `{iat: now-60, exp: now+540, iss: <app id>}`, signed with the private
   key. `iat` is backdated because GitHub rejects a JWT whose `iat` is even a second ahead of its
   clock; `exp` stays under GitHub's 10-minute ceiling. Used for `/app`, `/app/installations`,
   `/orgs/{org}/installation`, `/repos/{owner}/{repo}/installation`.
2. **Installation lookup** — one installation per account that installed the app. Beckett resolves
   in this order: the target repo's installation → the target owner's installation → the pinned
   `GITHUB_APP_INSTALLATION_ID` → the sole installation if there is exactly one. If none of those
   land it **throws with the real list and the install link** rather than guessing which stranger's
   repos to touch.
3. **Installation access token** — `POST /app/installations/{id}/access_tokens`, valid one hour,
   cached in-process and re-minted five minutes before expiry.

That token reaches subprocesses two ways, both through the environment and never through argv:

- **`gh`** — `GH_TOKEN` / `GITHUB_TOKEN`.
- **`git` over HTTPS** — an inline credential helper (`GIT_CONFIG_*`) that echoes
  `username=x-access-token` and `password=$GITHUB_PAT`, where `GITHUB_PAT` is the *carrier env
  slot* holding the short-lived token. `x-access-token` is the only username GitHub accepts for an
  installation token.

## Permissions

Least-privilege for an agent that reads and writes code and PRs. The manifest
(`deploy/github-app-manifest.json`) is the source of truth; keep it and the live app settings in
sync.

| Permission | Level | Why |
|---|---|---|
| `contents` | read & write | clone, push branches and tags |
| `pull_requests` | read & write | open, edit, review, merge PRs |
| `issues` | read & write | file and comment on issues (PR comments live here too) |
| `metadata` | read | mandatory for every app |
| `checks` | read | "is this PR green?" before a merge handshake |

No webhooks (`hook_attributes.active: false`) — Beckett polls. Widening permissions later
re-prompts **every existing installation** for approval, so add only what a task actually needs.

## Hard limits of an App identity

Worth knowing before promising something Beckett can't do:

- **Cannot browse or log into github.com.** There is no password, no session, no 2FA. Everything
  is the REST API and `git` over HTTPS.
- **Cannot touch a repo where it isn't installed.** No forking arbitrary repos, no drive-by PRs to
  strangers. The answer is always "install me here", never "let me in another way".
- **Cannot star, follow, or sponsor.** Those are *user* actions;
  `PUT /user/starred/...` returns `403 Resource not accessible by integration` under app auth.
  `beckett gh repo star` is legacy-PAT-only.
- **git-CLI commits are unverified.** Commits pushed via `git` are unsigned and attributed to
  whatever `user.email` the worktree has. Commits created through the **API** (`PUT
  /repos/{o}/{r}/contents/{path}`, the merge endpoint) are signed by GitHub and show **Verified**
  as `beckett[bot]`.
- **Org installs may need approval.** A non-owner requesting the install on an org creates a
  pending request an owner has to approve. Beckett sees the org as not-installed until then.

## Troubleshooting

The triage lives in the `troubleshooting` skill (`.claude/skills/troubleshooting/SKILL.md`) and is
backed by real commands:

```bash
beckett gh app status                                   # who am I, who installed me
beckett gh app installations                            # every account, with its repo selection
beckett gh app repos --owner <login>                    # what one installation can reach
beckett gh app diagnose --repo <owner>/<name>           # why a repo is out of reach
beckett gh app install-url                              # the link to hand a user
```

`diagnose` returns one of `ok`, `not-installed`, `repo-not-selected`,
`repo-not-selected-or-missing` (the one case GitHub genuinely cannot disambiguate: a private repo
that is either unselected or nonexistent looks identical from outside), or `no-such-owner`.

Common real error shapes:

| Symptom | Meaning | Fix |
|---|---|---|
| `401 A JSON web token could not be decoded` | wrong/corrupt private key, or host clock skew | re-download the key; check `timedatectl` |
| `404 Not Found` on `/repos/{o}/{r}/installation` | not installed, repo unselected, or no such repo | `beckett gh app diagnose` |
| `403 Resource not accessible by integration` | the app lacks that permission (or it's a user-only action) | widen the manifest + app settings, or don't |
| `422` on `access_tokens` | installation id is wrong or was uninstalled | `beckett gh app installations` |
