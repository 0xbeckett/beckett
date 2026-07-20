/**
 * Beckett — secret-link delivery to the requester (`src/secret/delivery.ts`)
 * =======================================================================================
 * A minted secret-intake link is meant for the ONE person who asked for it, not the public
 * channel. We DM the requester. If their DMs are closed (or Discord refuses for any reason) we
 * fall back to an ephemeral message — the caller posts the returned URL with the ephemeral flag,
 * so it is still visible only to the requester and never lands in the shared transcript.
 *
 * The link itself is a short-lived, single-use capability, not a credential — but it is still
 * sensitive, so we never write the URL to a log line; only the delivery channel is logged.
 */

import type { Logger } from "../types.ts";

export class DmUndeliverableError extends Error {}

/** Send a DM to a Discord user. Must throw `DmUndeliverableError` when the user's DMs are closed. */
export type DmSender = (recipientId: string, content: string) => Promise<void>;

export type DeliveryResult =
  | { via: "dm" }
  | { via: "ephemeral-fallback"; url: string };

const SNOWFLAKE_RE = /^[0-9]{5,25}$/;

export function isDiscordUserId(id: string): boolean {
  return SNOWFLAKE_RE.test(id);
}

/**
 * Deliver the link to the requester. Returns how it went so the caller can act on a fallback
 * (post the URL ephemerally). Logs the channel — never the URL.
 */
export async function deliverSecretLink(p: {
  requesterId: string;
  url: string;
  message?: string;
  sendDm: DmSender;
  logger?: Logger;
}): Promise<DeliveryResult> {
  if (!isDiscordUserId(p.requesterId)) throw new Error("deliverSecretLink: requester id is not a Discord user id");
  const body = p.message ? `${p.message}\n${p.url}` : p.url;
  try {
    await p.sendDm(p.requesterId, body);
    p.logger?.info("secret link delivered to requester DM", { requesterId: p.requesterId });
    return { via: "dm" };
  } catch (err) {
    p.logger?.warn("secret link DM undeliverable — falling back to ephemeral", {
      requesterId: p.requesterId,
      reason: err instanceof Error ? err.message : "unknown",
    });
    return { via: "ephemeral-fallback", url: p.url };
  }
}

const DISCORD_API = "https://discord.com/api/v10";

/**
 * A `DmSender` backed by the Discord REST API using the bot token. Opens (or reuses) the 1:1 DM
 * channel with the recipient, then posts the message. A 403 from either step means the recipient
 * does not accept DMs from us → `DmUndeliverableError`.
 */
export function discordDmSender(p: { token: string; fetchImpl?: typeof fetch }): DmSender {
  const doFetch = p.fetchImpl ?? fetch;
  const auth = { Authorization: `Bot ${p.token}`, "Content-Type": "application/json" };
  return async (recipientId, content) => {
    const openRes = await doFetch(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ recipient_id: recipientId }),
    });
    if (openRes.status === 403) throw new DmUndeliverableError("cannot open DM channel with recipient");
    if (!openRes.ok) throw new Error(`discord: open DM failed (${openRes.status})`);
    const channel = (await openRes.json()) as { id?: string };
    if (!channel.id) throw new Error("discord: open DM returned no channel id");

    const msgRes = await doFetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (msgRes.status === 403) throw new DmUndeliverableError("recipient does not accept DMs");
    if (!msgRes.ok) throw new Error(`discord: send DM failed (${msgRes.status})`);
  };
}
