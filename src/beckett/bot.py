"""Beckett Discord bot — ambient, single-session-per-channel.

Routing model (no threads, ever):
  * A DM is one persistent session per DM channel.
  * In a guild, Beckett responds when addressed: an @mention, or a native reply
    to one of its own messages.
  * Either way, the message is fed to that CHANNEL's one durable Claude Code
    session (resumed via --resume). The CLI owns the transcript, so context is
    total: "create the repo", "how's it going", "what about the repo" are three
    turns in one session and Beckett always knows what you mean.

Work happens in the background of that same session: a follow-up steers the
in-flight turn at the next tool boundary rather than spawning anything new.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import discord

from .claude import run_session
from .config import Settings
from .hooks import ensure_worker_settings
from .jobs import JobManager
from .prompts import build_system_prompt
from .relay import Relay, chunk_text
from .store import Store

log = logging.getLogger("beckett")

_MENTION_RE = re.compile(r"<@[!&]?\d+>")
_STOP_EMOJI = {"🛑", "⛔", "✋"}


class BeckettBot(discord.Client):
    def __init__(self, settings: Settings, store: Store):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.messages = True
        intents.reactions = True
        super().__init__(intents=intents)
        self.settings = settings
        self.store = store
        self.tree = discord.app_commands.CommandTree(self)
        # One persistent worker per channel/DM session (keyed by channel id).
        self._workers: dict[int, SessionWorker] = {}
        # The worker settings file registering the scope-guard hook (built once).
        self._settings_path = ensure_worker_settings(settings)
        # Detached background jobs (the agency).
        self.jobs = JobManager(self, settings, store)
        self.started_at = time.time()

    # --- lifecycle --------------------------------------------------------
    async def setup_hook(self) -> None:
        register_commands(self)
        await self.tree.sync()
        if self.settings.guild_id:
            guild = discord.Object(id=self.settings.guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        log.info("commands synced")

    async def on_ready(self) -> None:
        log.info("connected as %s (id=%s)", self.user, self.user and self.user.id)
        # Reconcile jobs left running by a previous process, then start the poller.
        await self.jobs.start()

    # --- access -----------------------------------------------------------
    def is_allowed(self, user_id: int) -> bool:
        if self.settings.owner_id and user_id == self.settings.owner_id:
            return True
        return self.store.access_status(user_id) == "allowed"

    # --- addressing -------------------------------------------------------
    def _is_for_beckett(self, message: discord.Message) -> bool:
        """Is this message addressed to Beckett? DM, @mention, or reply-to-Beckett."""
        if message.guild is None:
            return True
        # @mention (discord also lands a reply-ping in mentions by default).
        if self.user and self.user in message.mentions:
            return True
        # Native reply to one of Beckett's messages, even if the ping was toggled off.
        ref = message.reference
        if ref is not None and ref.message_id:
            resolved = ref.resolved
            if (
                isinstance(resolved, discord.Message)
                and self.user
                and resolved.author.id == self.user.id
            ):
                return True
        return False

    # --- message routing --------------------------------------------------
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or (self.user and message.author.id == self.user.id):
            return
        if not self._is_for_beckett(message):
            return
        if not await self._gate(message):
            return

        prompt = _MENTION_RE.sub("", message.content).strip()
        if not prompt:
            await self._ack(message, busy=False)
            await _safe_send(message.channel, "yeah? what do you need.")
            return

        channel = message.channel
        await self._ack(message, busy=self._busy(channel.id))
        await self.submit(
            channel,
            prompt=prompt,
            owner_id=message.author.id,
            guild_id=message.guild.id if message.guild else None,
        )

    async def on_raw_reaction_add(self, payload: discord.RawReactionActionEvent) -> None:
        """A 🛑 reaction stops the current turn at the next tool boundary."""
        if self.user and payload.user_id == self.user.id:
            return
        if str(payload.emoji) not in _STOP_EMOJI:
            return
        if not self.is_allowed(payload.user_id):
            return
        worker = self._workers.get(payload.channel_id)
        if worker is None or worker.closed:
            return
        if worker.request_stop():
            channel = self.get_channel(payload.channel_id)
            if channel is not None:
                await _safe_send(channel, "🛑 stopping here. session's still open, keep talking.")

    async def _ack(self, message: discord.Message, *, busy: bool) -> None:
        """👀 = seen, starting; ⏳ = a turn is running, this will steer it next."""
        try:
            await message.add_reaction("⏳" if busy else "👀")
        except discord.HTTPException:
            pass

    async def _gate(self, message: discord.Message) -> bool:
        if self.is_allowed(message.author.id):
            return True
        status = self.store.access_status(message.author.id)
        if status == "pending":
            await _safe_send(message.channel, "⏳ your access request is pending.")
        else:
            await _safe_send(message.channel, "👋 you're not set up yet. run `/setup` to request access.")
        return False

    # --- session execution ------------------------------------------------
    def _busy(self, channel_id: int) -> bool:
        w = self._workers.get(channel_id)
        return bool(w and w.in_turn)

    async def submit(
        self,
        channel: discord.abc.Messageable,
        *,
        prompt: str,
        owner_id: int,
        guild_id: int | None,
    ) -> None:
        """Feed a message to the channel's session worker, creating one if needed.

        A live worker just queues the message (steering any in-flight turn).
        Otherwise we resume the channel's existing session, or start a fresh one.
        """
        import uuid

        cid = getattr(channel, "id", 0)
        worker = self._workers.get(cid)
        if worker is not None and not worker.closed:
            await worker.submit(prompt)
            return

        session = self.store.get_session(cid)
        if session and session.status == "active":
            session_id, run_cwd, started = session.session_id, session.cwd, True
        else:
            session_id = str(uuid.uuid4())
            run_cwd = str(self.settings.default_cwd)
            self.store.create_session(cid, session_id, run_cwd, owner_id, guild_id)
            started = False

        worker = SessionWorker(self, channel, session_id, run_cwd, started=started)
        self._workers[cid] = worker
        worker.start()
        await worker.submit(prompt)

    def end_worker(self, channel_id: int) -> None:
        worker = self._workers.pop(channel_id, None)
        if worker:
            worker.close()
        self.store.close_session(channel_id)


class _NullCtx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _typing(target):
    try:
        return target.typing()
    except Exception:  # noqa: BLE001
        return _NullCtx()


class SessionWorker:
    """Owns one channel's Claude Code session as a persistent run loop.

    One turn at a time. A message arriving mid-turn interrupts at the next
    tool-use boundary and steers the next resume turn, so follow-ups refine the
    same session instead of spawning a new one.
    """

    def __init__(self, bot: BeckettBot, target, session_id: str, cwd: str, *, started: bool):
        self.bot = bot
        self.target = target
        self.session_id = session_id
        self.cwd = cwd
        self.started = started  # has at least one turn run (=> resumable)?
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.in_turn = False
        self.closed = False
        self._stop = False
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def submit(self, prompt: str) -> None:
        await self.queue.put(prompt)

    def request_stop(self) -> bool:
        if self.in_turn:
            self._stop = True
            return True
        return False

    def close(self) -> None:
        self.closed = True
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        try:
            while True:
                prompt = await self.queue.get()
                while not self.queue.empty():
                    prompt += "\n\n" + self.queue.get_nowait()

                self.in_turn = True
                # Rebuild the system prompt each turn so SOUL.md / memory edits land.
                system_prompt = build_system_prompt(self.bot.settings)
                relay = Relay(
                    lambda text: _safe_send(self.target, text),
                    collapse_tools=True,
                    edit=_safe_edit,
                    cwd=self.cwd,
                    show_footer=False,
                )
                try:
                    async with _typing(self.target):
                        await relay.consume(
                            run_session(
                                prompt=prompt,
                                session_id=self.session_id,
                                cwd=self.cwd,
                                resume=self.started,
                                permission_mode=self.bot.settings.permission_mode,
                                model=self.bot.settings.model,
                                system_prompt=system_prompt,
                                settings_path=self.bot._settings_path,
                                extra_env={"BECKETT_CHANNEL_ID": str(getattr(self.target, "id", 0))},
                                should_interrupt=lambda: self._stop or not self.queue.empty(),
                            )
                        )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.exception("session run failed")
                    await _safe_send(self.target, f"⚠️ session crashed: `{exc}`")
                finally:
                    self.started = True
                    self.in_turn = False
                    self._stop = False
        except asyncio.CancelledError:
            pass
        finally:
            self.closed = True


async def _safe_send(channel, text: str):
    if not text:
        return None
    try:
        return await channel.send(text)
    except discord.HTTPException as exc:
        log.warning("send failed: %s", exc)
        return None


async def _safe_edit(message, text: str):
    if message is None or not text:
        return None
    try:
        return await message.edit(content=text)
    except discord.HTTPException as exc:
        log.warning("edit failed: %s", exc)
        return None


async def _safe_dm(user: discord.User, text: str, view: discord.ui.View | None = None):
    try:
        if view is not None:
            await user.send(text, view=view)
        else:
            await user.send(text)
    except discord.HTTPException as exc:
        log.warning("dm failed: %s", exc)


def _fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    mins, secs = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if mins:
        parts.append(f"{mins}m")
    parts.append(f"{secs}s")
    return " ".join(parts)


# --- slash commands -------------------------------------------------------
def register_commands(bot: BeckettBot) -> None:
    store = bot.store
    settings = bot.settings

    def is_owner(uid: int) -> bool:
        return bool(settings.owner_id) and uid == settings.owner_id

    @bot.tree.command(name="setup", description="Request access to talk to Beckett.")
    async def setup_cmd(interaction: discord.Interaction):
        uid = interaction.user.id
        if bot.is_allowed(uid):
            await interaction.response.send_message("✅ you already have access.", ephemeral=True)
            return
        store.set_access(uid, "pending", added_by=None)
        await interaction.response.send_message(
            "📨 access requested. an admin will approve you shortly.", ephemeral=True
        )
        if settings.owner_id:
            owner = bot.get_user(settings.owner_id) or await bot.fetch_user(settings.owner_id)
            if owner:
                await _safe_dm(
                    owner,
                    f"🔑 access request from **{interaction.user}** (`{uid}`). "
                    f"`/approve` them if you want.",
                )

    @bot.tree.command(name="approve", description="(owner) Approve a user.")
    @discord.app_commands.describe(user="User to approve")
    async def approve_cmd(interaction: discord.Interaction, user: discord.User):
        if not is_owner(interaction.user.id):
            await interaction.response.send_message("owner only.", ephemeral=True)
            return
        store.set_access(user.id, "allowed", added_by=interaction.user.id)
        await interaction.response.send_message(f"✅ approved {user.mention}.", ephemeral=True)
        await _safe_dm(user, "✅ you're in. mention me or DM me to start.")

    @bot.tree.command(name="deny", description="(owner) Revoke a user.")
    @discord.app_commands.describe(user="User to remove")
    async def deny_cmd(interaction: discord.Interaction, user: discord.User):
        if not is_owner(interaction.user.id):
            await interaction.response.send_message("owner only.", ephemeral=True)
            return
        store.remove_access(user.id)
        await interaction.response.send_message(f"🚫 removed {user.mention}.", ephemeral=True)

    @bot.tree.command(name="reset", description="Start a fresh session in this channel.")
    async def reset_cmd(interaction: discord.Interaction):
        ch = interaction.channel
        cid = getattr(ch, "id", 0)
        bot.end_worker(cid)
        await interaction.response.send_message(
            "🧹 fresh start. i've cleared this channel's session.", ephemeral=True
        )

    @bot.tree.command(name="sessions", description="List active channel sessions.")
    async def sessions_cmd(interaction: discord.Interaction):
        rows = store.list_active_sessions()
        if not rows:
            await interaction.response.send_message("no active sessions.", ephemeral=True)
            return
        lines = [f"• <#{s.channel_id}> — `{s.session_id[:8]}` (cwd `{s.cwd}`)" for s in rows[:25]]
        await interaction.response.send_message("\n".join(lines), ephemeral=True)

    @bot.tree.command(name="jobs", description="Show background jobs in this channel.")
    async def jobs_cmd(interaction: discord.Interaction):
        cid = getattr(interaction.channel, "id", 0)
        rows = store.recent_jobs(channel_id=cid, limit=10)
        if not rows:
            await interaction.response.send_message("no jobs in this channel yet.", ephemeral=True)
            return
        lines = []
        for j in rows:
            tag = f" · `{j.branch}`" if j.branch else ""
            lines.append(f"`{j.id}` **{j.status}** — {j.spec[:60]}{tag}")
        await interaction.response.send_message("\n".join(lines), ephemeral=True)

    @bot.tree.command(name="status", description="Beckett status + your access.")
    async def status_cmd(interaction: discord.Interaction):
        you = "owner" if is_owner(interaction.user.id) else (
            store.access_status(interaction.user.id) or "none"
        )
        msg = (
            f"**beckett** — permission `{settings.permission_mode}`, cwd `{settings.default_cwd}`.\n"
            f"your access: **{you}** · active sessions: {len(store.list_active_sessions())}"
        )
        await interaction.response.send_message(msg, ephemeral=True)

    @bot.tree.command(name="uptime", description="How long Beckett has been up.")
    async def uptime_cmd(interaction: discord.Interaction):
        elapsed = time.time() - bot.started_at
        since = int(bot.started_at)
        await interaction.response.send_message(
            f"⏱️ up {_fmt_duration(elapsed)} (since <t:{since}:f>)"
        )
