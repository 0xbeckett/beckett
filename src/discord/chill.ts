/**
 * Beckett — chilltext collector (`src/discord/chill.ts`)
 * =======================================================================================
 * OPS-73/OPS-81: compress Beckett's long outgoing Discord replies into up to four short
 * casual messages via the chilltext collector API (https://chilltext.ssh.codes) before they hit Discord.
 * Applied in the gateway's send point (`gateway.ts` `sendNow`) ONLY for posts that opt in
 * with `ReplyOptions.chill` — the Concierge's conversational replies (the auto-posted turn
 * text and its `beckett discord reply` CLI path). Mechanical output (worker logs relayed
 * into progress threads, startup banners, fixed acks) never opts in and reaches Discord
 * verbatim — chilling a log stream destroys it for the models reading it.
 *
 * This is a transform-in-the-middle with a HARD PASSTHROUGH on any failure: unreachable
 * host, non-2xx (incl. a service whose /health would fail), timeout (~35s), malformed
 * response, or text the API can't take (>6000 chars) all return `null`, and the caller
 * sends the ORIGINAL text unchanged through the existing path. No message is ever dropped
 * or delayed beyond the timeout. `chillReply` never throws.
 */

/** The collector endpoint. POST {text, max_bubbles} → {messages: string[]}. No auth. */
const CHILL_URL = "https://chilltext.ssh.codes/chill";

/** The collector supports max_bubbles 1–4; ask for up to four Discord bubbles. */
export const CHILL_MAX_BUBBLES = 4;

/** Hard passthrough deadline: if the collector hasn't answered by then, send the raw text. */
export const CHILL_TIMEOUT_MS = 35_000;

/** The API rejects text over this length — skip the call entirely and pass through. */
const CHILL_MAX_CHARS = 6000;

/**
 * Reformat outgoing reply text into chilltext bubbles — the MODEL decides where to split
 * (up to {@link CHILL_MAX_BUBBLES}); each returned message is sent as its own Discord
 * message, per the API's contract ("never join them back into one block"). Returns the
 * `messages[]` to send in order, or `null` meaning "send the original text unchanged".
 * `fetchImpl` is injectable for tests only.
 */
export async function chillReply(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  if (text.trim().length === 0 || text.length > CHILL_MAX_CHARS) return null;
  try {
    const res = await fetchImpl(CHILL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, max_bubbles: CHILL_MAX_BUBBLES }),
      signal: AbortSignal.timeout(CHILL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(data.messages)) return null;
    const messages = data.messages
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .slice(0, CHILL_MAX_BUBBLES);
    return messages.length > 0 ? messages : null;
  } catch {
    // Timeout, DNS failure, refused connection, bad JSON — all mean: use the original text.
    return null;
  }
}
