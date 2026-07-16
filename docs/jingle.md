# Jingle credential vault

`jingle` is Beckett's CLI credential vault. It creates and stores account credentials while
keeping password/TOTP seed plaintext out of the agent transcript. Use this instead of putting a
credential in a command line, chat, log, or task description.

## Installed build and durable state

This loom-desk installation was built from a source clone of
[`frgmt0/jingle-jingle`](https://github.com/frgmt0/jingle-jingle):

| Item | Value |
| --- | --- |
| Source clone | `/home/beckett/.local/src/jingle-jingle` |
| Pinned source commit | `52239aa554b74a44f75f4d2702a21cd4fb0545f8` |
| Build | `cargo build --release --locked` |
| Installed CLI | `/home/beckett/.local/bin/jingle` (on the login `PATH`) |
| Release binary | `/home/beckett/.local/lib/jingle/jingle` |
| Binary SHA-256 | `df4e6864491a2233c605f4278d4da581dd5c6d49d023afe2bbb382fdc992a148` |
| Vault directory | `/home/beckett/.beckett/jingle` (mode `0700`) |
| Keyfile | `/home/beckett/.beckett/jingle/key` (mode `0600`) |
| Encrypted vault / audit log | `/home/beckett/.beckett/jingle/vault.jingle`, `/home/beckett/.beckett/jingle/audit.jsonl` |

The small launcher pins `--vault` and `--keyfile` to those durable paths, so the command uses
this vault in a fresh login and after a restart. The keyfile is 32 bytes of generated key
material; there is no master passphrase to retain separately. **Never read, copy, print, or
transmit the keyfile or raw vault.**

Rust was not present on loom-desk, so the standard `rustup` minimal profile installed stable
Rust 1.97.1; `clippy` and `rustfmt` components were added for validation. No OS package was
needed. The source checkout passed `cargo test --locked`, `cargo clippy --all-targets -- -D
warnings`, and `cargo fmt --check`.

## Cold-session operator commands

The installed `jingle` command is the normal interface. It is already initialized. These are the
exact commands to use in a future session.

### Initialize a new vault (only if the durable files were intentionally removed)

```sh
jingle init
stat -c '%a %n' ~/.beckett/jingle/key  # must print 600
```

Do **not** use `--force` on an existing vault: it replaces the key and makes the existing vault
unreadable.

### Create and store a generated site credential

```sh
jingle add example-site \
  --service example.com \
  --username bot@example.com \
  --generate --length 32
jingle show example-site
```

The final command must show `password=[REDACTED]`, not a password. `jingle list` similarly
shows metadata only. Do not ask it to print a generated password.

### Inject a stored credential into a login subprocess

Give the password to the login process as an environment variable. The process consumes it; it
must not echo it back.

```sh
jingle exec -s example-site=SITE_PASSWORD -- ./login-flow.sh
```

For an inline, non-leaking readiness check, use:

```sh
jingle exec -s example-site=SITE_PASSWORD -- sh -c \
  'test -n "$SITE_PASSWORD" && printf "credential-injected\\n"'
```

Only `credential-injected` is allowed in output. Never write a command that prints
`$SITE_PASSWORD`, and never pass a secret as an argument.

### Store a TOTP seed and get the current code

Obtain the TOTP URI/base32 seed directly from the site and provide it on stdin, not in argv. The
placeholder variable below stands for that sensitive input and must not be echoed or included in
the agent conversation.

```sh
printf %s "$TOTP_URI_OR_BASE32" | jingle set example-site totp --stdin
jingle totp example-site
```

`jingle totp` emits only the short-lived six-digit code; it never displays the seed. The code can
be entered into the site's login subprocess or browser before it expires.

## Smoke test: completed 2026-07-16

The persistent dummy entry `smoke-round-trip` was generated and stored with no password output.
Its `show` output was:

```text
name:     smoke-round-trip
service:  example.invalid
username: smoke@beckett.invalid
locked:   no
secrets:  password=[REDACTED]
```

It was then injected into a child process which checked that it was nonempty and exactly 32
characters, while printing only a non-secret marker:

```sh
jingle exec -s smoke-round-trip=LOGIN_PASSWORD -- sh -c \
  'test -n "$LOGIN_PASSWORD" && test "${#LOGIN_PASSWORD}" -eq 32 && printf "injected-ok\\n"'
# injected-ok
```

The shell did not see the generated value; `jingle list`/`jingle show` rendered it as
`[REDACTED]`, and the child emitted only `injected-ok`. A repeatable version is committed at
[`scripts/ops/jingle-smoke.sh`](../scripts/ops/jingle-smoke.sh):

```sh
scripts/ops/jingle-smoke.sh smoke-script-round-trip
```

It generates a new dummy entry, checks the masked list/show output, injects the secret into a
subprocess that validates its length without printing it, and emits only `injected-ok` plus a
pass marker. Each invocation leaves its named dummy entry in the encrypted vault; remove it with
`jingle rm <name> --yes` when it is no longer useful.
