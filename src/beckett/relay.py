"""Turn Claude Code stream-json events into Discord messages.

Beckett is ambient and sparse: assistant prose posts in full (chunked under
Discord's 2000-char cap); tool activity is folded into a single dimmed `-#`
status line that gets edited in place rather than spamming the channel; a turn
ends quietly (no job-report footer) unless ``show_footer`` is set.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator

from .claude import ClaudeEvent

DISCORD_LIMIT = 2000


def chunk_text(text: str, limit: int = DISCORD_LIMIT) -> list[str]:
    """Split text under the limit, preferring paragraph/line/space boundaries."""
    text = text.rstrip()
    if len(text) <= limit:
        return [text] if text else []
    out: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = window.rfind("\n\n")
        if cut < limit // 2:
            cut = window.rfind("\n")
        if cut < limit // 2:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = limit
        out.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip("\n")
    if rest:
        out.append(rest)
    return out


def _summarize_tool(name: str, tool_input: dict) -> str:
    """Compact one-line description of a tool call for the dimmed status line."""
    if name == "Bash":
        cmd = str(tool_input.get("command", "")).replace("\n", " ")
        return f"$ {cmd[:180]}"
    if name in ("Edit", "Write", "Read", "NotebookEdit"):
        path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        return f"{name} {path}"
    if name in ("Grep", "Glob"):
        return f"{name} {tool_input.get('pattern', '')}"
    if name == "Task":
        return f"Task: {str(tool_input.get('description', ''))[:120]}"
    preview = json.dumps(tool_input, default=str)[:160]
    return f"{name} {preview}"


async def _git_status(cwd: str | None) -> str | None:
    """Best-effort `repo@branch +N` summary for the session's working dir."""
    if not cwd:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD", "--show-toplevel",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode != 0:
            return None
        lines = out.decode(errors="replace").splitlines()
        if len(lines) < 2:
            return None
        branch = lines[0].strip() or "?"
        repo = os.path.basename(lines[1].strip()) or "repo"
        proc2 = await asyncio.create_subprocess_exec(
            "git", "-C", cwd, "status", "--porcelain",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out2, _ = await asyncio.wait_for(proc2.communicate(), timeout=5)
        dirty = sum(1 for line in out2.decode(errors="replace").splitlines() if line.strip())
    except (OSError, asyncio.TimeoutError):
        return None
    return f"{repo}@{branch}" + (f" +{dirty}" if dirty else "")


class Relay:
    """Posts streamed events into a Discord channel.

    `send` is an async callable (text) -> sent message (or None). When
    `collapse_tools` is set and an `edit` callable is supplied, a burst of
    consecutive tool calls is folded into one `-#` status line that is edited to
    the latest call; posting prose closes that line so the next burst starts
    fresh beneath the text. `show_footer` adds a `-# ✅ done · repo@branch` line.
    """

    def __init__(self, send, *, show_tools: bool = True, collapse_tools: bool = True,
                 edit=None, cwd: str | None = None, show_footer: bool = False):
        self._send = send
        self._edit = edit
        self._cwd = cwd
        self._show_footer = show_footer
        self._show_tools = show_tools
        self._collapse_tools = collapse_tools and edit is not None
        self.last_session_id: str | None = None
        self._tool_msg = None

    async def post(self, text: str) -> None:
        for part in chunk_text(text):
            if part:
                await self._send(part)
                self._tool_msg = None

    async def _emit_tool(self, line: str) -> None:
        if self._collapse_tools and self._tool_msg is not None:
            edited = await self._edit(self._tool_msg, line)
            if edited is not None:
                return
            self._tool_msg = None
        msg = await self._send(line)
        if self._collapse_tools:
            self._tool_msg = msg

    async def consume(self, events: AsyncIterator[ClaudeEvent]) -> None:
        saw_final_text = False
        async for ev in events:
            if ev.session_id:
                self.last_session_id = ev.session_id

            if ev.type == "assistant":
                for text in ev.text_blocks():
                    if text.strip():
                        await self.post(text)
                        saw_final_text = True
                if self._show_tools:
                    for name, tool_input in ev.tool_uses():
                        await self._emit_tool(f"-# 🔧 {_summarize_tool(name, tool_input)}")

            elif ev.type == "result":
                if ev.is_error_result:
                    detail = ev.result_text or "unknown error"
                    await self.post(f"⚠️ **Session error:** {detail[:1800]}")
                else:
                    if not saw_final_text and ev.result_text:
                        await self.post(ev.result_text)
                    if self._show_footer:
                        git = await _git_status(self._cwd)
                        footer = _result_footer(ev.raw, git=git)
                        if footer:
                            await self._send(footer)


def _result_footer(raw: dict, git: str | None = None) -> str:
    bits = []
    if git:
        bits.append(git)
    turns = raw.get("num_turns")
    if turns:
        bits.append(f"{turns} turns")
    dur = raw.get("duration_ms")
    if dur:
        bits.append(f"{dur / 1000:.1f}s")
    cost = raw.get("total_cost_usd")
    if cost:
        bits.append(f"${cost:.4f}")
    return f"-# ✅ {' · '.join(bits)}" if bits else "-# ✅ done"
