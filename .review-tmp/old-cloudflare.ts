/**
 * Beckett — Cloudflare DNS agency (`src/agency/cloudflare.ts`)
 * =======================================================================================
 * A thin, zone-scoped client over the Cloudflare API v4 — the DNS half of Beckett's
 * "throw it up at <name>.0xbeckett.me" agency (powers `beckett dns` + the CNAME step of
 * `beckett deploy`). Modeled on {@link GitHubCli} in `./index.ts`: a single credential
 * (the env `CLOUDFLARE_API_TOKEN`, a DNS:Edit token scoped to the `0xbeckett.me` zone)
 * carried per-invocation via the `Authorization: Bearer` header, a `run()`-style request
 * helper that checks `result.success` and throws on `result.errors`, and a graceful
 * `available` getter so the CLI can fail clearly when the token is absent.
 *
 * The token is zone-scoped on purpose (Spec 07 spirit — least privilege): it can only edit
 * DNS on the one zone, so DNS work is FREE (a reversible proposal — a record you can delete),
 * never account-level admin. Names are expanded against the zone's apex (`x-tool` →
 * `x-tool.0xbeckett.me`) so callers can use short labels.
 */

import type { Logger } from "../types.ts";

/** Cloudflare API v4 base. All requests are made against this host. */
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** A single DNS record as returned by the Cloudflare API (the fields we care about). */
export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  zone_id?: string;
  zone_name?: string;
}

/** The envelope every Cloudflare API response shares (`success` + `errors` + `result`). */
interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code?: number; message?: string }>;
  messages?: unknown[];
  result: T;
}

/**
 * Thrown when a Cloudflare operation is attempted without a token configured. The CLI catches
 * the absence earlier (via {@link CfDns.available}); this guards direct/library use.
 */
export class CloudflareUnavailableError extends Error {
  constructor(op: string) {
    super(
      `agency.cloudflare: cannot ${op} — CLOUDFLARE_API_TOKEN is not configured ` +
        `(add a zone-scoped DNS:Edit token to ~/.beckett/.env)`,
    );
    this.name = "CloudflareUnavailableError";
  }
}

/** Thrown when a Cloudflare API call returns `success: false`; carries the API error list. */
export class CloudflareApiError extends Error {
  constructor(op: string, errors: Array<{ code?: number; message?: string }>) {
    const detail = errors.length
      ? errors.map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`).join("; ")
      : "no error detail";
    super(`agency.cloudflare: ${op} failed — ${detail}`);
    this.name = "CloudflareApiError";
  }
}

export interface CfDnsOptions {
  /** The zone-scoped API token (env CLOUDFLARE_API_TOKEN). Empty = unavailable → methods throw. */
  token: string;
  /** The zone id to operate within (env CLOUDFLARE_ZONE_ID). */
  zoneId: string;
  logger: Logger;
}

/**
 * Cloudflare DNS client scoped to a single zone. Idempotent by design: {@link upsert} updates
 * an existing record in place (so re-running a deploy never errors), and {@link remove} treats
 * "no match" as a no-op rather than a failure.
 */
export class CfDns {
  private readonly token: string;
  private readonly zoneId: string;
  private readonly logger: Logger;
  /** Cached apex name for the zone (e.g. `0xbeckett.me`), resolved lazily by {@link zoneName}. */
  private cachedZoneName: string | null = null;

  constructor(opts: CfDnsOptions) {
    this.token = opts.token;
    this.zoneId = opts.zoneId;
    this.logger = opts.logger;
  }

  /** Whether Cloudflare agency is usable (a token is configured). */
  get available(): boolean {
    return this.token.length > 0;
  }

  private requireToken(op: string): void {
    if (!this.available) throw new CloudflareUnavailableError(op);
  }

  /**
   * One Cloudflare API request. Sets the bearer token + JSON headers, parses the envelope, and
   * throws {@link CloudflareApiError} unless `result.success` is true. Returns `result`.
   */
  private async request<T>(
    op: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.requireToken(op);
    const res = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let env: CfEnvelope<T>;
    try {
      env = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new CloudflareApiError(op, [{ message: `non-JSON response (HTTP ${res.status})` }]);
    }
    if (!env.success) throw new CloudflareApiError(op, env.errors ?? []);
    return env.result;
  }

  /** The zone's apex name (e.g. `0xbeckett.me`), cached after the first lookup. */
  async zoneName(): Promise<string> {
    if (this.cachedZoneName) return this.cachedZoneName;
    const zone = await this.request<{ name: string }>("get zone", "GET", `/zones/${this.zoneId}`);
    this.cachedZoneName = zone.name;
    return zone.name;
  }

  /**
   * Expand a short label to a fully-qualified name within the zone: `x-tool` →
   * `x-tool.0xbeckett.me`. A name already ending in the zone apex (or equal to it) is returned
   * unchanged, so the apex `0xbeckett.me` and FQDNs pass through.
   */
  async normalizeName(name: string): Promise<string> {
    const zone = await this.zoneName();
    const trimmed = name.replace(/\.$/, "");
    if (trimmed === zone || trimmed.endsWith(`.${zone}`)) return trimmed;
    return `${trimmed}.${zone}`;
  }

  /** List DNS records in the zone, optionally filtered by (normalized) name and/or type. */
  async list(filter: { name?: string; type?: string } = {}): Promise<CfDnsRecord[]> {
    const params = new URLSearchParams();
    if (filter.name) params.set("name", await this.normalizeName(filter.name));
    if (filter.type) params.set("type", filter.type.toUpperCase());
    const qs = params.toString();
    return this.request<CfDnsRecord[]>(
      "list dns records",
      "GET",
      `/zones/${this.zoneId}/dns_records${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Create-or-update a DNS record by (name, type). Idempotent: if a record with the same
   * normalized name + type exists it is PUT-updated in place; otherwise a new one is POSTed.
   * Defaults to a proxied CNAME with automatic TTL (ttl=1) — the shape `beckett deploy` needs.
   */
  async upsert(p: {
    name: string;
    type?: string;
    content: string;
    proxied?: boolean;
    ttl?: number;
  }): Promise<CfDnsRecord> {
    const type = (p.type ?? "CNAME").toUpperCase();
    const name = await this.normalizeName(p.name);
    const proxied = p.proxied ?? true;
    const ttl = p.ttl ?? 1;
    const record = { type, name, content: p.content, proxied, ttl };

    const existing = (await this.list({ name, type })).find(
      (r) => r.name === name && r.type === type,
    );
    if (existing) {
      const updated = await this.request<CfDnsRecord>(
        "update dns record",
        "PUT",
        `/zones/${this.zoneId}/dns_records/${existing.id}`,
        record,
      );
      this.logger.info("dns record updated", { name, type });
      return updated;
    }
    const created = await this.request<CfDnsRecord>(
      "create dns record",
      "POST",
      `/zones/${this.zoneId}/dns_records`,
      record,
    );
    this.logger.info("dns record created", { name, type });
    return created;
  }

  /**
   * Delete every record matching the (normalized) name, and the type if given. Returns the
   * deleted records. No match is NOT an error — returns `{ deleted: [] }` (idempotent teardown).
   */
  async remove(name: string, type?: string): Promise<{ deleted: CfDnsRecord[] }> {
    const norm = await this.normalizeName(name);
    const wantType = type?.toUpperCase();
    const matches = (await this.list({ name: norm, type: wantType })).filter(
      (r) => r.name === norm && (!wantType || r.type === wantType),
    );
    const deleted: CfDnsRecord[] = [];
    for (const rec of matches) {
      await this.request<{ id: string }>(
        "delete dns record",
        "DELETE",
        `/zones/${this.zoneId}/dns_records/${rec.id}`,
      );
      deleted.push(rec);
      this.logger.info("dns record deleted", { name: rec.name, type: rec.type });
    }
    return { deleted };
  }
}
