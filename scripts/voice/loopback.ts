#!/usr/bin/env bun
/**
 * Beckett — LIVE voice loopback (#81)
 * =======================================================================================
 * Proves the transport end-to-end against a REAL Discord voice channel: JOIN → wait for the
 * first person to speak → RECORD their utterance → PLAY the exact same audio back into the
 * channel. You (in the channel) hear your own words echoed, and the script prints which user id
 * it attributed the audio to. This is the audibility half of the acceptance loopback; the
 * deterministic half runs in CI as `src/discord/voice/loopback.test.ts`.
 *
 * Usage:
 *   DISCORD_TOKEN=... DISCORD_OWNER_ID=<your id> \
 *     bun scripts/voice/loopback.ts --guild <guildId> --channel "<voice channel name>"
 *
 * Requires the bot to be in the guild with Connect + Speak permissions on the channel, and the
 * optional voice deps (opusscript, libsodium-wrappers) installed — `bun install` brings them.
 * Owner/maintainer only, enforced the same way the daemon enforces it.
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { VoiceGateway } from "../../src/discord/voice/gateway.ts";
import {
  createDiscordVoiceBackendFactory,
  resolveVoiceChannel,
} from "../../src/discord/voice/backend-discordjs.ts";
import { pcmDurationMs } from "../../src/discord/voice/pcm.ts";
import type { AccessLevel } from "../../src/discord/voice/types.ts";
import type { Logger } from "../../src/types.ts";

const logger: Logger = (() => {
  const emit = (level: string) => (msg: unknown, meta?: unknown) =>
    process.stderr.write(`[voice-loopback:${level}] ${String(msg)}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`);
  const log = { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: emit("debug"), child() { return log; } };
  return log as unknown as Logger;
})();

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const ownerId = process.env.DISCORD_OWNER_ID?.trim();
  const guildId = arg("--guild");
  const channelName = arg("--channel");
  if (!token || !ownerId || !guildId || !channelName) {
    logger.error("need DISCORD_TOKEN + DISCORD_OWNER_ID env and --guild <id> --channel <name>");
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  await client.login(token);
  await new Promise<void>((r) => client.once(Events.ClientReady, () => r()));
  logger.info("logged in", { tag: client.user?.tag });

  const channel = await resolveVoiceChannel(client, guildId, channelName);
  if (!channel) {
    logger.error("voice channel not found", { guildId, channelName });
    process.exit(1);
  }

  // Owner/maintainer gate — here the owner runs it, so classify to 'owner' for the owner id only.
  const authorize = (userId: string): AccessLevel => (userId === ownerId ? "owner" : "outsider");
  const gateway = new VoiceGateway({
    backendFactory: createDiscordVoiceBackendFactory(client, { logger }),
    authorize,
    logger,
  });

  const session = await gateway.join({ guildId, channelId: channel.id, requestedByUserId: ownerId });
  logger.info("joined — SPEAK NOW; I'll echo your first utterance back", { channel: channel.name });

  session.onUtterance((u) => {
    logger.info("captured utterance — playing it back", {
      userId: u.userId,
      durationMs: Math.round(u.durationMs),
      pcmBytes: u.pcm.length,
      derivedMs: Math.round(pcmDurationMs(u.pcm.length)),
    });
    const handle = session.speak(u.pcm);
    void handle.done.then(async () => {
      logger.info("playback finished; leaving", { userId: u.userId });
      await gateway.leaveAll();
      await client.destroy();
      process.exit(0);
    });
  });

  // Safety timeout so a silent run doesn't hang forever.
  setTimeout(() => {
    logger.warn("no speech captured within 60s; leaving");
    void gateway.leaveAll().then(() => client.destroy()).then(() => process.exit(0));
  }, 60_000);
}

main().catch((err) => {
  logger.error("loopback failed", { error: String(err) });
  process.exit(1);
});
