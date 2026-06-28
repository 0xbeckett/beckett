"""Write the worker settings file that registers the scope-guard PreToolUse hook.

Claude Code loads ``--settings <file>``; we point every session at one that runs
``hooks/scope-guard.ts`` (via bun) before Edit/Write/Read/Bash. The hook confines
writes to the box root and denies any access to the secret vault paths.
"""

from __future__ import annotations

import json
import shlex

from .config import Settings


def deny_paths(settings: Settings) -> list[str]:
    """Absolute paths the agent may never read or write (defence in depth)."""
    home = settings.home_root
    return [
        str(settings.state_dir / ".env"),
        str(home / ".ssh"),
        str(home / ".git-credentials"),
        str(home / ".config" / "gh"),
    ]


def ensure_worker_settings(settings: Settings) -> str:
    """Create the worker settings.json registering the hook; return its path."""
    settings.worker_settings_dir.mkdir(parents=True, exist_ok=True)
    deny = ":".join(deny_paths(settings))
    command = (
        f"bun {shlex.quote(str(settings.scope_guard_path))} "
        f"--root {shlex.quote(str(settings.home_root))} "
        f"--deny {shlex.quote(deny)}"
    )
    config = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Read|Edit|Write|MultiEdit|NotebookEdit|Bash",
                    "hooks": [{"type": "command", "command": command}],
                }
            ]
        }
    }
    path = settings.worker_settings_dir / "settings.json"
    path.write_text(json.dumps(config, indent=2))
    return str(path)
