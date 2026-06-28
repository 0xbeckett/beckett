"""Drive headless Claude Code sessions as subprocesses.

One entry point: ``run_session`` spawns or resumes a session and streams parsed
stream-json events as they arrive. Continuity is the CLI's job — resuming the
same ``--session-id`` restores the full transcript across separate process
invocations, so Beckett never reassembles context by hand.

Two Beckett-specific touches over a vanilla driver:
  * ``_clean_env`` keeps ``GH_TOKEN`` (so the agent's ``gh`` is authenticated as
    0xbeckett) but scrubs the Discord token and the other vault secrets — the
    agent gets the one credential it is meant to wield and none of the others.
  * ``--settings`` points the worker at a settings file that registers the
    scope-guard PreToolUse hook (the hard write/read boundary).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from .config import SECRET_ENV_KEYS

# stream-json requires --verbose; confirmed empirically against the CLI.
_BASE = ["--output-format", "stream-json", "--verbose"]

# A single stream-json line can be huge when a tool result embeds a base64 image
# or a big file read; raise asyncio's 64 KiB line limit so readline() doesn't die.
_STREAM_LIMIT = 64 * 1024 * 1024  # 64 MiB


@dataclass
class ClaudeEvent:
    """A parsed line from the stream-json output."""

    raw: dict

    @property
    def type(self) -> str:
        return self.raw.get("type", "")

    @property
    def subtype(self) -> str | None:
        return self.raw.get("subtype")

    @property
    def session_id(self) -> str | None:
        return self.raw.get("session_id")

    def text_blocks(self) -> list[str]:
        out: list[str] = []
        msg = self.raw.get("message") or {}
        for block in msg.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text", "")
                if t:
                    out.append(t)
        return out

    def tool_uses(self) -> list[tuple[str, dict]]:
        out: list[tuple[str, dict]] = []
        msg = self.raw.get("message") or {}
        for block in msg.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                out.append((block.get("name", "tool"), block.get("input", {}) or {}))
        return out

    @property
    def is_error_result(self) -> bool:
        return self.type == "result" and bool(self.raw.get("is_error"))

    @property
    def result_text(self) -> str | None:
        if self.type == "result":
            return self.raw.get("result")
        return None


def _clean_env() -> dict[str, str]:
    """The subprocess environment for the agent.

    Inherits the box environment (claude.ai OAuth lives in ~/.claude) but scrubs
    Beckett's own vault secrets — the Discord token, GitHub PAT, Gmail creds — so
    they aren't sitting in the agent's environment. GH_TOKEN is intentionally
    KEPT: it authenticates ``gh`` as 0xbeckett, which is the whole point.
    """
    env = dict(os.environ)
    for key in SECRET_ENV_KEYS:
        env.pop(key, None)
    # Make the `beckett-job` console-script reachable from the agent's Bash: it's
    # installed alongside this interpreter (the venv bin), which isn't on the
    # bot's own PATH.
    bin_dir = os.path.dirname(sys.executable)
    path = env.get("PATH", "")
    if bin_dir and bin_dir not in path.split(os.pathsep):
        env["PATH"] = bin_dir + os.pathsep + path if path else bin_dir
    return env


def _build_args(
    *,
    prompt: str,
    session_id: str,
    resume: bool,
    permission_mode: str,
    model: str | None,
    system_prompt: str | None = None,
    settings_path: str | None = None,
) -> list[str]:
    args = ["claude", "-p"]
    if resume:
        args += ["--resume", session_id, prompt]
    else:
        args += [prompt, "--session-id", session_id]
    args += _BASE
    if permission_mode:
        args += ["--permission-mode", permission_mode]
    if model:
        args += ["--model", model]
    # The scope-guard PreToolUse hook is registered here (the hard boundary). It
    # is honoured even under --permission-mode bypassPermissions.
    if settings_path:
        args += ["--settings", settings_path]
    # Beckett's identity + operating rules + voice, appended fresh every turn so
    # edits to SOUL.md / memory take effect immediately.
    if system_prompt:
        args += ["--append-system-prompt", system_prompt]
    return args


async def run_session(
    *,
    prompt: str,
    session_id: str,
    cwd: str,
    resume: bool,
    permission_mode: str,
    model: str | None = None,
    system_prompt: str | None = None,
    settings_path: str | None = None,
    extra_env: dict[str, str] | None = None,
    should_interrupt: Callable[[], bool] | None = None,
) -> AsyncIterator[ClaudeEvent]:
    """Spawn (or resume) a session and yield parsed events as they stream.

    If ``should_interrupt`` is provided, it is polled after each event; when it
    returns True the process is terminated at the next *tool-use boundary* (once
    a tool result has been persisted to the transcript). Resuming the same
    session id then picks up exactly where it left off — this is how mid-turn
    steering works.
    """
    args = _build_args(
        prompt=prompt,
        session_id=session_id,
        resume=resume,
        permission_mode=permission_mode,
        model=model,
        system_prompt=system_prompt,
        settings_path=settings_path,
    )
    env = _clean_env()
    if extra_env:
        env.update(extra_env)
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        limit=_STREAM_LIMIT,
    )
    assert proc.stdout is not None
    interrupted = False
    tool_completed = False
    while True:
        try:
            raw = await proc.stdout.readline()
        except (ValueError, asyncio.LimitOverrunError):
            # One oversized stream-json line (huge embedded image/file read).
            # readline() advances past it; skip the record, keep the session.
            continue
        if not raw:
            break  # EOF
        line = raw.strip()
        if not line:
            continue
        try:
            ev = ClaudeEvent(json.loads(line))
        except json.JSONDecodeError:
            continue  # non-JSON noise
        yield ev
        if ev.type == "user":
            tool_completed = True
        if (
            should_interrupt is not None
            and tool_completed
            and ev.type in ("user", "assistant")
            and should_interrupt()
        ):
            interrupted = True
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            break

    if interrupted:
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
        return

    rc = await proc.wait()
    if rc and rc != 0:
        stderr = b""
        if proc.stderr is not None:
            stderr = await proc.stderr.read()
        detail = stderr.decode(errors="replace").strip()
        yield ClaudeEvent(
            {
                "type": "result",
                "subtype": "process_error",
                "is_error": True,
                "result": detail or f"claude exited with code {rc}",
                "session_id": session_id,
            }
        )
