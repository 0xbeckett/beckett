"""Detached background jobs — Beckett's "agency".

The conversation session launches work with `beckett-job start`, which writes a
`requested` row. This manager (one asyncio poller in the bot) picks it up, sets
up an isolated git worktree/branch, runs its OWN `claude -p` session to
completion, streams sparse progress into the channel, and writes progress/summary
back to the row. A check-in (`beckett-job status`) reads that row from a separate
process, so it NEVER touches the running job — the whole point of M2.

Honesty over magic: a bot restart kills in-flight jobs (they're child processes).
On startup we sweep `running` rows to `interrupted` and say so, rather than
letting a check-in report progress on a dead job.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path

from .claude import run_session
from .config import Settings
from .prompts import build_job_prompt
from .relay import _summarize_tool, chunk_text
from .store import Job, Store

log = logging.getLogger("beckett.jobs")

_MAX_CONCURRENT = 3
_POLL_INTERVAL = 1.5


class JobManager:
    def __init__(self, bot, settings: Settings, store: Store):
        self.bot = bot
        self.settings = settings
        self.store = store
        self._tasks: dict[str, asyncio.Task] = {}
        self._cancels: dict[str, asyncio.Event] = {}
        self._poller: asyncio.Task | None = None

    # --- lifecycle --------------------------------------------------------
    async def start(self) -> None:
        await self._reconcile_startup()
        if self._poller is None:
            self._poller = asyncio.create_task(self._poll_loop())

    async def _reconcile_startup(self) -> None:
        """Any job left 'running' belongs to a dead process — mark it and own up."""
        for job in self.store.jobs_by_status("running"):
            self.store.update_job(
                job.id,
                status="interrupted",
                summary=(job.summary or "")
                + "\n[interrupted: Beckett restarted while this job was running]",
            )
            await self._say(job.channel_id, f"⚠️ `{job.id}` was interrupted by a restart. "
                            f"its branch (if any) is intact; ask me to pick it back up.")

    async def _poll_loop(self) -> None:
        while True:
            try:
                # Launch queued jobs, up to the concurrency cap.
                running = sum(1 for t in self._tasks.values() if not t.done())
                for job in self.store.jobs_by_status("requested"):
                    if running >= _MAX_CONCURRENT:
                        break
                    self._launch(job)
                    running += 1
                # Honor cancellations flagged via the CLI (separate process).
                for job in self.store.jobs_by_status("running"):
                    if job.cancel_requested and job.id in self._cancels:
                        self._cancels[job.id].set()
            except Exception:  # noqa: BLE001
                log.exception("job poll loop error")
            await asyncio.sleep(_POLL_INTERVAL)

    # --- execution --------------------------------------------------------
    def _launch(self, job: Job) -> None:
        self.store.update_job(job.id, status="running")
        ev = asyncio.Event()
        self._cancels[job.id] = ev
        self._tasks[job.id] = asyncio.create_task(self._run(job, ev))

    async def _run(self, job: Job, cancel: asyncio.Event) -> None:
        cwd, branch = await self._prepare_workspace(job)
        session_id = str(uuid.uuid4())
        self.store.update_job(job.id, cwd=cwd, branch=branch, session_id=session_id)

        where = f" on branch `{branch}`" if branch else ""
        await self._say(job.channel_id, f"🔧 `{job.id}` started{where}: {job.spec[:200]}")

        system_prompt = build_job_prompt(self.settings, job.spec, cwd, branch)
        state = {"last_prose": "", "tool_msg": None, "had_error": False, "error": None}

        async def send(text: str):
            return await self._say(job.channel_id, text)

        try:
            async for ev in run_session(
                prompt=job.spec,
                session_id=session_id,
                cwd=cwd,
                resume=False,
                permission_mode=self.settings.permission_mode,
                model=self.settings.model,
                system_prompt=system_prompt,
                settings_path=self.bot._settings_path,
                extra_env={"BECKETT_CHANNEL_ID": str(job.channel_id)},
                should_interrupt=lambda: cancel.is_set(),
            ):
                if ev.type == "assistant":
                    for text in ev.text_blocks():
                        if text.strip():
                            for part in chunk_text(text):
                                await send(part)
                            state["last_prose"] = text.strip()
                            self.store.update_job(job.id, progress=text.strip()[:500])
                    for name, tool_input in ev.tool_uses():
                        line = f"-# 🔧 {_summarize_tool(name, tool_input)}"
                        await send(line)
                        self.store.update_job(job.id, progress=line[:500])
                elif ev.type == "result" and ev.is_error_result:
                    state["had_error"] = True
                    state["error"] = ev.result_text or "unknown error"
        except asyncio.CancelledError:
            cancel.set()
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("job %s crashed", job.id)
            state["had_error"] = True
            state["error"] = str(exc)

        await self._finalize(job, branch, cancel, state)
        self._tasks.pop(job.id, None)
        self._cancels.pop(job.id, None)

    async def _finalize(self, job: Job, branch: str | None, cancel: asyncio.Event, state: dict) -> None:
        if cancel.is_set():
            self.store.update_job(job.id, status="cancelled", summary="cancelled")
            await self._say(job.channel_id, f"🛑 `{job.id}` cancelled.")
            return
        if state["had_error"]:
            self.store.update_job(job.id, status="failed", summary=(state["error"] or "")[:1500])
            await self._say(job.channel_id, f"⚠️ `{job.id}` failed: {(state['error'] or '')[:300]}")
            return
        summary = state["last_prose"][:1500] or "done"
        self.store.update_job(job.id, status="done", summary=summary)
        tail = f" review/merge `{branch}` when you're ready." if branch else ""
        await self._say(job.channel_id, f"✅ `{job.id}` done.{tail}")

    # --- workspace --------------------------------------------------------
    async def _prepare_workspace(self, job: Job) -> tuple[str, str | None]:
        """Resolve cwd; for an existing repo, cut an isolated worktree+branch."""
        default = str(self.settings.default_cwd)
        repo_dir = self._resolve_repo(job.repo) if job.repo else None
        if not repo_dir:
            return default, None
        branch = f"beckett/{job.id}"
        wt = self.settings.home_root / "worktrees" / job.id
        wt.parent.mkdir(parents=True, exist_ok=True)
        ok = await self._git(repo_dir, "worktree", "add", str(wt), "-b", branch)
        if ok:
            return str(wt), branch
        log.warning("worktree add failed for %s; running in repo dir", job.id)
        return repo_dir, None

    def _resolve_repo(self, hint: str) -> str | None:
        hint = (hint or "").strip().strip("`").strip()
        if not hint:
            return None
        roots = [self.settings.default_cwd, self.settings.home_root / "projects", self.settings.home_root]
        candidates = [Path(hint).expanduser()] if ("/" in hint or hint.startswith("~")) else []
        candidates += [r / hint for r in roots]
        for c in candidates:
            if (c / ".git").exists():
                return str(c)
        return None

    async def _git(self, cwd: str, *args: str) -> bool:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", cwd, *args,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await asyncio.wait_for(proc.communicate(), timeout=30)
            if proc.returncode != 0:
                log.warning("git %s failed: %s", args, err.decode(errors="replace")[:200])
            return proc.returncode == 0
        except (OSError, asyncio.TimeoutError) as exc:
            log.warning("git %s errored: %s", args, exc)
            return False

    # --- discord ----------------------------------------------------------
    async def _say(self, channel_id: int, text: str):
        if not text:
            return None
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(channel_id)
            except Exception:  # noqa: BLE001
                return None
        try:
            return await channel.send(text[:2000])
        except Exception as exc:  # noqa: BLE001
            log.warning("job say failed: %s", exc)
            return None
