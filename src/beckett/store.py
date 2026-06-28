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


@dataclass
class Job:
    id: str
    channel_id: int
    spec: str
    repo: str | None
    cwd: str | None
    branch: str | None
    # requested | running | done | failed | cancelled | interrupted
    status: str
    session_id: str | None
    progress: str | None
    summary: str | None
    requested_by: int | None
    cancel_requested: int
    created_at: float
    updated_at: float


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

CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    channel_id       INTEGER NOT NULL,
    spec             TEXT NOT NULL,
    repo             TEXT,
    cwd              TEXT,
    branch           TEXT,
    status           TEXT NOT NULL,    -- requested|running|done|failed|cancelled|interrupted
    session_id       TEXT,
    progress         TEXT,
    summary          TEXT,
    requested_by     INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at       REAL NOT NULL,
    updated_at       REAL NOT NULL
);
"""


class Store:
    def __init__(self, db_path: Path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # WAL + a busy timeout so the bot, the beckett-job CLI, and a concurrent
        # `status` read don't trip "database is locked" — they're three separate
        # processes on this one file (the in-process lock coordinates none of it).
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
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


    # --- jobs -------------------------------------------------------------
    def create_job(
        self,
        job_id: str,
        channel_id: int,
        spec: str,
        repo: str | None,
        requested_by: int | None,
    ) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO jobs "
                "(id, channel_id, spec, repo, status, requested_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)",
                (job_id, channel_id, spec, repo, requested_by, now, now),
            )
            self._db.commit()

    def get_job(self, job_id: str) -> "Job | None":
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _row_to_job(row) if row else None

    def jobs_by_status(self, status: str) -> list["Job"]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at", (status,)
            ).fetchall()
        return [_row_to_job(r) for r in rows]

    def recent_jobs(self, channel_id: int | None = None, limit: int = 15) -> list["Job"]:
        with self._lock:
            if channel_id is not None:
                rows = self._db.execute(
                    "SELECT * FROM jobs WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?",
                    (channel_id, limit),
                ).fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [_row_to_job(r) for r in rows]

    def update_job(self, job_id: str, **fields) -> None:
        if not fields:
            return
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self._lock:
            self._db.execute(
                f"UPDATE jobs SET {cols} WHERE id = ?", (*fields.values(), job_id)
            )
            self._db.commit()

    def request_cancel(self, job_id: str) -> bool:
        """Flag a job for cancellation. Returns True if it was cancellable."""
        with self._lock:
            row = self._db.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row or row["status"] not in ("requested", "running"):
                return False
            self._db.execute(
                "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
                (time.time(), job_id),
            )
            self._db.commit()
        return True


def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        id=row["id"],
        channel_id=row["channel_id"],
        spec=row["spec"],
        repo=row["repo"],
        cwd=row["cwd"],
        branch=row["branch"],
        status=row["status"],
        session_id=row["session_id"],
        progress=row["progress"],
        summary=row["summary"],
        requested_by=row["requested_by"],
        cancel_requested=row["cancel_requested"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


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
