"""`beckett-job` — the CLI Beckett's conversation session uses to run work in the
background. SQLite is the IPC: this inserts/reads rows; the bot's JobManager
picks them up, runs them in isolated worktrees, and streams progress to Discord.

Deliberately minimal and token-free: it resolves only the db path (never
load_settings), so it works inside agent sessions where the Discord token is
scrubbed. The channel to stream into comes from BECKETT_CHANNEL_ID, which the
bot sets on the conversation subprocess.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import uuid

from .config import resolve_db_path
from .store import Job, Store


def _store() -> Store:
    return Store(resolve_db_path())


def _channel_id() -> int | None:
    raw = os.environ.get("BECKETT_CHANNEL_ID", "").strip()
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def _age(ts: float) -> str:
    secs = max(0, int(time.time() - ts))
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def _fmt(job: Job, *, verbose: bool = False) -> str:
    line = f"{job.id}  [{job.status}]  {job.spec[:70]}  ({_age(job.updated_at)})"
    if job.branch:
        line += f"\n  branch: {job.branch}"
    if verbose:
        if job.progress:
            line += f"\n  latest: {job.progress[:300]}"
        if job.summary:
            line += f"\n  result: {job.summary[:600]}"
    return line


def _cmd_start(args) -> int:
    channel_id = _channel_id()
    if channel_id is None:
        print(
            "error: can't tell which channel to stream into (BECKETT_CHANNEL_ID unset). "
            "this only works from inside a Beckett conversation.",
            file=sys.stderr,
        )
        return 2
    spec = args.spec.strip()
    if not spec:
        print("error: empty spec.", file=sys.stderr)
        return 2
    job_id = "job_" + uuid.uuid4().hex[:8]
    requested_by = None
    raw_uid = os.environ.get("BECKETT_USER_ID", "").strip()
    if raw_uid.isdigit():
        requested_by = int(raw_uid)
    _store().create_job(job_id, channel_id, spec, args.repo, requested_by)
    print(
        f"✅ started {job_id} — running in the background, i'll stream progress into "
        f"this channel. check on it with `beckett-job status {job_id}`."
    )
    return 0


def _cmd_status(args) -> int:
    store = _store()
    if args.job_id:
        job = store.get_job(args.job_id)
        if not job:
            print(f"no job {args.job_id}.")
            return 1
        print(_fmt(job, verbose=True))
        return 0
    # No id: show this channel's recent jobs.
    channel_id = _channel_id()
    jobs = store.recent_jobs(channel_id=channel_id, limit=10)
    if not jobs:
        print("no jobs yet in this channel.")
        return 0
    active = [j for j in jobs if j.status in ("requested", "running")]
    if active:
        print("running now:")
        for j in active:
            print("  " + _fmt(j, verbose=True))
    done = [j for j in jobs if j.status not in ("requested", "running")][:5]
    if done:
        print("recent:")
        for j in done:
            print("  " + _fmt(j))
    return 0


def _cmd_list(args) -> int:
    jobs = _store().recent_jobs(channel_id=_channel_id(), limit=15)
    if not jobs:
        print("no jobs yet.")
        return 0
    for j in jobs:
        print(_fmt(j))
    return 0


def _cmd_cancel(args) -> int:
    ok = _store().request_cancel(args.job_id)
    if ok:
        print(f"🛑 cancel requested for {args.job_id} — it'll stop at the next safe point.")
        return 0
    print(f"can't cancel {args.job_id} (not found, or already finished).")
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="beckett-job", description="Run and track Beckett background jobs."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_start = sub.add_parser("start", help="Start a background job.")
    p_start.add_argument("spec", help="What the job should do (a clear, self-contained brief).")
    p_start.add_argument("--repo", default=None, help="Existing repo to work in (isolated branch).")
    p_start.set_defaults(func=_cmd_start)

    p_status = sub.add_parser("status", help="Show a job's status (or this channel's jobs).")
    p_status.add_argument("job_id", nargs="?", default=None)
    p_status.set_defaults(func=_cmd_status)

    p_list = sub.add_parser("list", help="List recent jobs.")
    p_list.set_defaults(func=_cmd_list)

    p_cancel = sub.add_parser("cancel", help="Request cancellation of a job.")
    p_cancel.add_argument("job_id")
    p_cancel.set_defaults(func=_cmd_cancel)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
