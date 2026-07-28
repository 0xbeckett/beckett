/**
 * Beckett — outbound URL safety (`src/net/url-safety.ts`)
 * =======================================================================================
 * The ONE predicate for "is this URL internal — a host an outside recipient cannot reach". Two
 * boundaries need the SAME answer and must never drift apart:
 *   1. The Discord gateway redacts unsafe URLs before they cross the public boundary — the
 *      recorded `localhost-links` veto (#49): an internal/localhost link must never reach a channel.
 *   2. The preview feature must never RECORD or SURFACE a preview URL that isn't externally
 *      reachable. A host the gateway would strip is a host preview must never post in the first place.
 *
 * `isInternalUrl` is the classification the gateway used to keep private (`isUnsafeDiscordUrl`),
 * lifted here verbatim so the preview code can share the exact same denylist.
 */

/**
 * True when `value` is a URL whose host an outside recipient cannot reach: `localhost`, the IPv6
 * loopback, `0.0.0.0`, an mDNS `.local` name, or an RFC-1918 private IPv4 range (`127.x`, `10.x`,
 * `192.168.x`, `172.16–31.x`). A non-URL — or a URL that fails to parse — is NOT classified
 * internal: callers scan free prose and must not strip ordinary text. Ported verbatim from the
 * gateway's original `isUnsafeDiscordUrl` (behavior-identical).
 */
export function isInternalUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL.hostname brackets IPv6 literals in current runtimes; accept either representation.
  host = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host === "local" || host.endsWith(".local")) return true;
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) return false;
  const [first, second = 0] = octets.map(Number);
  return first === 127 || first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

/**
 * True when `value` is an absolute `http(s)` URL with an externally-reachable host — the gate a
 * preview URL must pass before it is recorded on a ticket or surfaced anywhere. Fails CLOSED:
 * anything that is not a parseable http/https URL, or whose host is internal per
 * {@link isInternalUrl}, returns false. This is a static routability check (protocol + host), NOT
 * a liveness probe — a preview must ALSO respond before it is surfaced (see `src/preview`).
 */
export function isExternalHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isInternalUrl(value);
}
