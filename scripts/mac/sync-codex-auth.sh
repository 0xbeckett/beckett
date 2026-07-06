#!/usr/bin/env bash
# sync-codex-auth — keep beckett@loom-desk's OpenAI OAuth alive from Jason's Mac.
# =======================================================================================
# WHY THIS EXISTS: loom-desk's pi (worker harness) and codex (beckett image) auth files are
# COPIES of this Mac's ChatGPT OAuth login (~/.codex/auth.json). OpenAI ROTATES refresh
# tokens on every refresh, so the moment the Mac's codex refreshes, the copied refresh token
# on loom-desk is dead — pi then silently skips the provider ("No API key") and every pi
# worker returns nothing (the 2026-07-05 outage). Two boxes can't share one token lineage,
# so this Mac stays the ONE refresher and re-syncs the copies daily, always before the
# ~10-day access token on loom-desk would expire and tempt pi to refresh (and rotate) it.
#
# What one run does:
#   1. If the Mac's access token expires within REFRESH_AHEAD_DAYS, refresh it against
#      auth.openai.com (same client id the codex CLI uses) and write ~/.codex/auth.json back.
#   2. Push the (now fresh) auth.json to loom-desk: ~/.codex/auth.json verbatim, plus the
#      `openai-codex` entry of ~/.pi/agent/auth.json rebuilt from the same tokens.
# Idempotent, silent on success, loud on stderr on failure. Installed as a daily LaunchAgent
# (me.0xbeckett.codex-auth-sync); run it by hand any time pi complains about auth.

set -euo pipefail

AUTH="$HOME/.codex/auth.json"
HOST="beckett@loom-desk"
# The codex CLI's public OAuth client id — the refresh call must present the id the tokens
# were issued to. Not a secret.
CLIENT_ID="app_EMoamEEZ73f0CkXaXp7hrann"
REFRESH_AHEAD_DAYS=3

[ -f "$AUTH" ] || { echo "sync-codex-auth: $AUTH missing — run codex login on the Mac first" >&2; exit 1; }

# ── 1. refresh locally when the access token is close to expiry ─────────────────────────
python3 - "$AUTH" "$CLIENT_ID" "$REFRESH_AHEAD_DAYS" <<'PYEOF'
import base64, json, sys, time, urllib.request

auth_path, client_id, ahead_days = sys.argv[1], sys.argv[2], int(sys.argv[3])
auth = json.load(open(auth_path))
tokens = auth["tokens"]

payload = tokens["access_token"].split(".")[1]
payload += "=" * (-len(payload) % 4)
exp = json.loads(base64.urlsafe_b64decode(payload))["exp"]
remaining_days = (exp - time.time()) / 86400
if remaining_days > ahead_days:
    sys.exit(0)  # still fresh — nothing to refresh

req = urllib.request.Request(
    "https://auth.openai.com/oauth/token",
    data=json.dumps({
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": tokens["refresh_token"],
        "scope": "openid profile email",
    }).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=30) as res:
    fresh = json.loads(res.read())

tokens["access_token"] = fresh["access_token"]
tokens["refresh_token"] = fresh.get("refresh_token", tokens["refresh_token"])
if fresh.get("id_token"):
    tokens["id_token"] = fresh["id_token"]
auth["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime())
json.dump(auth, open(auth_path, "w"), indent=2)
print(f"sync-codex-auth: refreshed Mac token ({remaining_days:.1f}d left was under {ahead_days}d)")
PYEOF

# ── 2. push to loom-desk and rebuild pi's openai-codex entry from the same tokens ───────
scp -q -o BatchMode=yes "$AUTH" "$HOST:/tmp/codex-auth-sync.json"
ssh -o BatchMode=yes "$HOST" 'python3 - <<PYEOF
import base64, json, os, shutil

fresh = json.load(open("/tmp/codex-auth-sync.json"))
tokens = fresh["tokens"]

codex = os.path.expanduser("~/.codex/auth.json")
shutil.copy("/tmp/codex-auth-sync.json", codex)
os.chmod(codex, 0o600)

pi_path = os.path.expanduser("~/.pi/agent/auth.json")
pi = json.load(open(pi_path)) if os.path.exists(pi_path) else {}
old = pi.get("openai-codex", {})
payload = tokens["access_token"].split(".")[1]
payload += "=" * (-len(payload) % 4)
exp_ms = json.loads(base64.urlsafe_b64decode(payload))["exp"] * 1000
pi["openai-codex"] = {
    "type": old.get("type", "oauth"),
    "access": tokens["access_token"],
    "refresh": tokens["refresh_token"],
    "expires": exp_ms,
    "accountId": tokens.get("account_id") or old.get("accountId"),
}
os.makedirs(os.path.dirname(pi_path), exist_ok=True)
json.dump(pi, open(pi_path, "w"), indent=2)
os.chmod(pi_path, 0o600)
os.remove("/tmp/codex-auth-sync.json")
PYEOF'

echo "sync-codex-auth: loom-desk codex + pi auth synced ($(date))"
