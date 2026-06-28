"""SQLite-backed state for Beckett.

Stores only routing/identity metadata — the channel<->session pointer that makes
context effortless (the Claude Code CLI owns the actual transcript) plus the
access allowlist. It never persists Discord message content or Beckett's replies.

The unit of continuity is the **channel** (or DM): one durable Claude Code
session per place, resumed every turn. There are no threads.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Session:
    channel_id: int
    session_id: str
    cwd: str
    owner_id: int
    guild_id: int | None
    status: str  # "active" | "closed"
    created_at: float


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    channel_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    owner_id   INTEGER NOT NULL,
    guild_id   INTEGER,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS access (
    user_id  INTEGER PRIMARY KEY,
    status   TEXT NOT NULL,            -- 'allowed' | 'pending'
    added_by INTEGER,
    added_at REAL NOT NULL
);
"""


class Store:
    def __init__(self, db_path: Path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self._db.commit()

    # --- sessions ---------------------------------------------------------
    def create_session(
        self,
        channel_id: int,
        session_id: str,
        cwd: str,
        owner_id: int,
        guild_id: int | None,
    ) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO sessions "
                "(channel_id, session_id, cwd, owner_id, guild_id, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, 'active', ?)",
                (channel_id, session_id, cwd, owner_id, guild_id, time.time()),
            )
            self._db.commit()

    def get_session(self, channel_id: int) -> Session | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM sessions WHERE channel_id = ?", (channel_id,)
            ).fetchone()
        return _row_to_session(row) if row else None

    def list_active_sessions(self) -> list[Session]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC"
            ).fetchall()
        return [_row_to_session(r) for r in rows]

    def close_session(self, channel_id: int) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE sessions SET status = 'closed' WHERE channel_id = ?",
                (channel_id,),
            )
            self._db.commit()

    # --- access -----------------------------------------------------------
    def set_access(self, user_id: int, status: str, added_by: int | None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO access (user_id, status, added_by, added_at) "
                "VALUES (?, ?, ?, ?)",
                (user_id, status, added_by, time.time()),
            )
            self._db.commit()

    def remove_access(self, user_id: int) -> None:
        with self._lock:
            self._db.execute("DELETE FROM access WHERE user_id = ?", (user_id,))
            self._db.commit()

    def access_status(self, user_id: int) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT status FROM access WHERE user_id = ?", (user_id,)
            ).fetchone()
        return row["status"] if row else None

    def list_access(self, status: str | None = None) -> list[tuple[int, str]]:
        with self._lock:
            if status:
                rows = self._db.execute(
                    "SELECT user_id, status FROM access WHERE status = ?", (status,)
                ).fetchall()
            else:
                rows = self._db.execute("SELECT user_id, status FROM access").fetchall()
        return [(r["user_id"], r["status"]) for r in rows]


def _row_to_session(row: sqlite3.Row) -> Session:
    return Session(
        channel_id=row["channel_id"],
        session_id=row["session_id"],
        cwd=row["cwd"],
        owner_id=row["owner_id"],
        guild_id=row["guild_id"],
        status=row["status"],
        created_at=row["created_at"],
    )
