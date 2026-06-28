"""Entry point: `beckett` (run the bot) and `beckett invite` (print invite URL)."""

from __future__ import annotations

import base64
import logging
import sys

import discord

from .bot import BeckettBot
from .config import load_settings
from .store import Store


def _client_id_from_token(token: str) -> str | None:
    head = token.split(".")[0]
    pad = "=" * (-len(head) % 4)
    try:
        return base64.b64decode(head + pad).decode()
    except Exception:  # noqa: BLE001
        return None


def _invite_url(token: str) -> str:
    perms = discord.Permissions(
        view_channel=True,
        send_messages=True,
        read_message_history=True,
        add_reactions=True,
        attach_files=True,
        embed_links=True,
        use_application_commands=True,
    )
    client_id = _client_id_from_token(token)
    if not client_id:
        return "Could not decode the application ID from DISCORD_TOKEN."
    return discord.utils.oauth_url(
        client_id, permissions=perms, scopes=("bot", "applications.commands")
    )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = load_settings()

    if len(sys.argv) > 1 and sys.argv[1] == "invite":
        print(_invite_url(settings.token))
        return

    store = Store(settings.db_path)
    bot = BeckettBot(settings, store)
    bot.run(settings.token, log_handler=None)


if __name__ == "__main__":
    main()
