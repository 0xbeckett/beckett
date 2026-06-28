"""Configuration for Beckett, loaded from the environment.

Beckett's secrets live in ``~/.beckett/.env`` (mode 0600). That file is loaded
into the process environment first (real environment variables still win). The
worker subprocess does NOT inherit the whole of it — see ``claude._clean_env``,
which keeps ``GH_TOKEN`` (so ``gh`` works) but scrubs the Discord token and the
other vault secrets the agent has no business reading.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Vault keys that exist for the bot process only. They are loaded so config can
# read them, then stripped from the agent subprocess env (defence in depth — the
# scope-guard hook is the hard boundary). GH_TOKEN is deliberately NOT here: the
# agent needs it for gh, and that is the one credential it is meant to wield.
SECRET_ENV_KEYS = (
    "DISCORD_TOKEN",
    "DISCORD_HOME_SERVER_ID",
    "DISCORD_OWNER_ID",
    "DISCORD_LOG_CHANNEL_ID",
    "GITHUB_PAT",
    "GMAIL_ADDRESS",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "ANTHROPIC_API_KEY",
)


def _default_state_dir() -> Path:
    env = os.environ.get("BECKETT_STATE_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".beckett"


def _load_env_file(state_dir: Path) -> None:
    """Load STATE_DIR/.env into os.environ without overriding existing vars."""
    env_path = state_dir / ".env"
    try:
        text = env_path.read_text()
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and os.environ.get(key) is None:
            os.environ[key] = value


def _int_or_none(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


@dataclass
class Settings:
    token: str
    state_dir: Path
    owner_id: int | None
    guild_id: int | None
    log_channel_id: int | None
    default_cwd: Path
    home_root: Path  # the box boundary; scope-guard confines writes here
    permission_mode: str
    model: str | None
    soul_path: Path
    memory_dir: Path
    scope_guard_path: Path
    worker_settings_dir: Path  # holds the .claude/settings.json registering the hook

    @property
    def db_path(self) -> Path:
        # Beckett's own session store — NOT the old TS daemon's beckett.db.
        return self.state_dir / "sessions.db"


# Repo root (…/beckett), two parents up from this file (src/beckett/config.py).
_REPO_ROOT = Path(__file__).resolve().parents[2]


def load_settings() -> Settings:
    state_dir = _default_state_dir()
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    _load_env_file(state_dir)

    token = os.environ.get("DISCORD_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            f"DISCORD_TOKEN is required. Set it in {state_dir / '.env'} or the environment."
        )

    home_root = Path(os.environ.get("BECKETT_HOME_ROOT", str(Path.home()))).expanduser()

    default_cwd_env = os.environ.get("BECKETT_DEFAULT_CWD", "").strip()
    default_cwd = (
        Path(default_cwd_env).expanduser() if default_cwd_env else home_root / "projects"
    )

    soul_env = os.environ.get("BECKETT_SOUL_PATH", "").strip()
    soul_path = Path(soul_env).expanduser() if soul_env else _REPO_ROOT / "SOUL.md"

    scope_env = os.environ.get("BECKETT_SCOPE_GUARD", "").strip()
    scope_guard_path = (
        Path(scope_env).expanduser() if scope_env else _REPO_ROOT / "hooks" / "scope-guard.ts"
    )

    return Settings(
        token=token,
        state_dir=state_dir,
        owner_id=_int_or_none(os.environ.get("DISCORD_OWNER_ID")),
        guild_id=_int_or_none(os.environ.get("DISCORD_HOME_SERVER_ID")),
        log_channel_id=_int_or_none(os.environ.get("DISCORD_LOG_CHANNEL_ID")),
        default_cwd=default_cwd,
        home_root=home_root,
        permission_mode=os.environ.get("BECKETT_PERMISSION_MODE", "bypassPermissions").strip()
        or "bypassPermissions",
        model=os.environ.get("BECKETT_MODEL", "").strip() or None,
        soul_path=soul_path,
        memory_dir=state_dir / "memory",
        scope_guard_path=scope_guard_path,
        worker_settings_dir=state_dir / "worker",
    )
