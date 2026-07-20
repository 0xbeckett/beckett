import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defaultKeychainStore, type KeychainStore } from "./keychain.ts";

const TOKEN_BYTES = 32; // 256 bits (acceptance requires >=128 bits)
const DEFAULT_TTL_MINUTES = 15;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_FIELDS = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// jingle field/entry names: keep to a conservative, injection-proof set. A jingle field is
// password | totp | api_key | any custom lowercase name; entry handles allow a path-like shape.
const JINGLE_FIELD_RE = /^[a-z][a-z0-9_]*$/;
const JINGLE_ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

/** A single named input the human fills behind the link. */
export type SecretFieldSpec = {
  /** Form field name. For env destination this is the ENV key; for keychain it is the jingle field. */
  name: string;
  /** Human-facing label shown above the input (defaults to `name`). */
  label?: string;
  /** Render as a masked password input. Defaults to true; set false for a non-secret like a username. */
  secret?: boolean;
};

/** Where the submitted batch lands. */
export type SecretDestination =
  | { kind: "env" }
  | { kind: "keychain"; entry: string; service?: string };

type SecretRequestRecord = {
  fields: SecretFieldSpec[];
  destination: SecretDestination;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
};

type SecretStore = {
  version: 2;
  requests: Record<string, SecretRequestRecord>;
};

export type SecretPaths = {
  beckettDir: string;
  envFile: string;
};

export type MintSecretRequestResult = {
  token: string;
  tokenHash: string;
  fields: SecretFieldSpec[];
  destination: SecretDestination;
  expiresAt: string;
  url: string;
};

export type SecretStatus =
  | { ok: true; fields: SecretFieldSpec[]; destination: SecretDestination; expiresAt: string }
  | { ok: false };

export type RedeemSecretResult =
  | { ok: true; fields: string[]; destination: SecretDestination["kind"]; redeemedAt: string }
  | { ok: false; reason: "invalid" | "bad-value" | "store-failed" };

export type SecretHandlerOptions = {
  paths: SecretPaths;
  now?: () => Date;
  /** Injected sink for keychain-destination requests (defaults to the real `jingle` subprocess). */
  storeInKeychain?: KeychainStore;
};

export function defaultSecretStorePath(beckettDir: string): string {
  return join(beckettDir, "secret-requests.json");
}

export function defaultSecretMarkerPath(beckettDir: string): string {
  return join(beckettDir, "secret-redemptions.jsonl");
}

export function validateSecretEnvName(name: string): string {
  const trimmed = name.trim();
  if (!ENV_KEY_RE.test(trimmed)) {
    throw new Error("secret request field must be a single environment key (A-Z, digits, underscore; not starting with a digit)");
  }
  return trimmed;
}

function validateJingleField(name: string): string {
  const trimmed = name.trim();
  if (!JINGLE_FIELD_RE.test(trimmed)) {
    throw new Error(`secret request keychain field "${name}" must be lowercase letters, digits, underscore (e.g. password, username, api_key)`);
  }
  return trimmed;
}

export function validateJingleEntry(name: string): string {
  const trimmed = name.trim();
  if (!JINGLE_ENTRY_RE.test(trimmed)) {
    throw new Error("secret request --entry must be a jingle entry handle (letters, digits, . _ - /, up to 64 chars)");
  }
  return trimmed;
}

/** Normalize + validate the field set against the chosen destination. */
export function normalizeSecretFields(fields: SecretFieldSpec[], destination: SecretDestination): SecretFieldSpec[] {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error("secret request needs at least one field");
  if (fields.length > MAX_FIELDS) throw new Error(`secret request supports at most ${MAX_FIELDS} fields`);
  const seen = new Set<string>();
  return fields.map((f) => {
    const name = destination.kind === "env" ? validateSecretEnvName(f.name) : validateJingleField(f.name);
    if (seen.has(name)) throw new Error(`duplicate secret field "${name}"`);
    seen.add(name);
    const label = f.label?.trim() ? f.label.trim() : name;
    if (/[\r\n]/.test(label)) throw new Error("secret field label cannot contain newlines");
    return { name, label, secret: f.secret !== false };
  });
}

export function parseSecretTtlMinutes(raw: string | boolean | undefined): number {
  if (raw === undefined || raw === false) return DEFAULT_TTL_MINUTES;
  if (raw === true) throw new Error("secret request --ttl needs a value");
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 24 * 60) {
    throw new Error("secret request --ttl must be an integer number of minutes from 1 to 1440");
  }
  return n;
}

export function generateSecretToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSecretToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintSecretRequest(p: {
  paths: SecretPaths;
  /** Legacy single-field env shorthand; equivalent to `fields:[{name}], destination:{kind:"env"}`. */
  name?: string;
  fields?: SecretFieldSpec[];
  destination?: SecretDestination;
  ttlMinutes?: number;
  baseUrl: string;
  now?: Date;
  token?: string;
}): MintSecretRequestResult {
  const destination: SecretDestination = p.destination ?? { kind: "env" };
  if (destination.kind === "keychain") validateJingleEntry(destination.entry);
  const rawFields = p.fields ?? (p.name !== undefined ? [{ name: p.name }] : undefined);
  if (!rawFields) throw new Error("secret request needs --name or --fields");
  const fields = normalizeSecretFields(rawFields, destination);

  const ttlMinutes = p.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 24 * 60) {
    throw new Error("secret request ttl must be an integer number of minutes from 1 to 1440");
  }
  const token = p.token ?? generateSecretToken();
  if (!TOKEN_RE.test(token)) throw new Error("generated token failed validation");
  const now = p.now ?? new Date();
  const expires = new Date(now.getTime() + ttlMinutes * 60_000);
  const tokenHash = hashSecretToken(token);

  const storePath = defaultSecretStorePath(p.paths.beckettDir);
  const store = pruneExpired(loadStore(storePath), now);
  store.requests[tokenHash] = {
    fields,
    destination,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  saveStore(storePath, store);

  const base = p.baseUrl.replace(/\/+$/, "");
  return { token, tokenHash, fields, destination, expiresAt: expires.toISOString(), url: `${base}/s/${token}` };
}

export function secretRequestStatus(paths: SecretPaths, token: string, now = new Date()): SecretStatus {
  if (!TOKEN_RE.test(token)) return { ok: false };
  const record = loadStore(defaultSecretStorePath(paths.beckettDir)).requests[hashSecretToken(token)];
  if (!record || record.redeemedAt || Date.parse(record.expiresAt) <= now.getTime()) return { ok: false };
  return { ok: true, fields: record.fields, destination: record.destination, expiresAt: record.expiresAt };
}

export async function redeemSecretRequest(
  paths: SecretPaths,
  token: string,
  values: Record<string, string>,
  opts: { now?: Date; storeInKeychain?: KeychainStore } = {},
): Promise<RedeemSecretResult> {
  const now = opts.now ?? new Date();
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "invalid" };

  const storePath = defaultSecretStorePath(paths.beckettDir);
  const store = pruneExpired(loadStore(storePath), now);
  const tokenHash = hashSecretToken(token);
  const record = store.requests[tokenHash];
  if (!record || record.redeemedAt || Date.parse(record.expiresAt) <= now.getTime()) {
    saveStore(storePath, store);
    return { ok: false, reason: "invalid" };
  }

  // Collect + validate every declared field. Unknown submitted keys are ignored.
  const collected: { field: SecretFieldSpec; value: string }[] = [];
  for (const field of record.fields) {
    const value = values[field.name];
    if (typeof value !== "string" || value === "") return { ok: false, reason: "bad-value" };
    if (!isSafeSecretValue(value)) return { ok: false, reason: "bad-value" };
    if (record.destination.kind === "env" && !canFormatEnvValue(value)) return { ok: false, reason: "bad-value" };
    collected.push({ field, value });
  }

  // Route the batch to its destination BEFORE marking the token spent, so a sink failure leaves
  // the link live for a retry rather than burning it. Secret values move only into the sink.
  try {
    if (record.destination.kind === "env") {
      for (const { field, value } of collected) upsertEnvKey(paths.envFile, field.name, value);
    } else {
      const store = opts.storeInKeychain ?? defaultKeychainStore;
      await store({
        entry: record.destination.entry,
        service: record.destination.service,
        fields: collected.map(({ field, value }) => ({ field: field.name, value })),
      });
    }
  } catch {
    // Never surface the underlying error (it could reference the sink/args); fail generic.
    return { ok: false, reason: "store-failed" };
  }

  const redeemedAt = now.toISOString();
  record.redeemedAt = redeemedAt;
  store.requests[tokenHash] = record;
  saveStore(storePath, store);
  appendRedemptionMarker(defaultSecretMarkerPath(paths.beckettDir), record, redeemedAt);
  return {
    ok: true,
    fields: record.fields.map((f) => f.name),
    destination: record.destination.kind,
    redeemedAt,
  };
}

export function createSecretHandler(opts: SecretHandlerOptions): (req: Request) => Promise<Response> | Response {
  const now = opts.now ?? (() => new Date());
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return text("ok", 200);

    const token = tokenFromPath(url.pathname);
    if (!token) return unavailable();

    if (req.method === "GET") {
      const status = secretRequestStatus(opts.paths, token, now());
      if (!status.ok) return unavailable();
      return html(renderSecretForm(status.fields, status.destination), 200);
    }

    if (req.method === "POST") {
      const len = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(len) && len > MAX_FORM_BYTES) return text("request too large", 413);
      let values: Record<string, string> = {};
      try {
        const form = await readBoundedForm(req, MAX_FORM_BYTES);
        values = form;
      } catch (err) {
        if (err instanceof FormBodyTooLargeError) return text("request too large", 413);
        return text("bad request", 400);
      }
      const redeemed = await redeemSecretRequest(opts.paths, token, values, {
        now: now(),
        storeInKeychain: opts.storeInKeychain,
      });
      if (redeemed.ok) return html(renderRedeemed(), 200);
      if (redeemed.reason === "bad-value") return text("bad request", 400);
      if (redeemed.reason === "store-failed") return text("could not store — try the link again", 503);
      return unavailable();
    }

    return text("method not allowed", 405, { Allow: "GET, POST" });
  };
}

class FormBodyTooLargeError extends Error {}

/** Consume an untrusted form stream without trusting Content-Length or buffering past the cap. */
async function readBoundedForm(req: Request, maxBytes: number): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type");
  if (!contentType) throw new Error("missing content type");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("missing request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FormBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

export function serveSecretIntake(p: {
  paths: SecretPaths;
  port: number;
  hostname?: string;
  storeInKeychain?: KeychainStore;
}): { stop: () => void; url: string } {
  const server = Bun.serve({
    hostname: p.hostname ?? "127.0.0.1",
    port: p.port,
    // Reject oversized chunked bodies before Bun allocates a full stream chunk for the handler.
    maxRequestBodySize: MAX_FORM_BYTES,
    fetch: createSecretHandler({ paths: p.paths, storeInKeychain: p.storeInKeychain }),
  });
  return { stop: () => server.stop(true), url: `http://${server.hostname}:${server.port}` };
}

export function upsertEnvKey(envFile: string, key: string, value: string): void {
  validateSecretEnvName(key);
  if (!isSafeSecretValue(value)) throw new Error("secret value cannot contain newlines or NUL bytes");
  const line = `${key}=${formatEnvValue(value)}`;
  const body = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = body.endsWith("\n") || body.length === 0;
  const lines = body.length === 0 ? [] : body.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && hadFinalNewline) lines.pop();

  const keyRe = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  let replaced = false;
  const next = lines.map((existing) => {
    if (!replaced && keyRe.test(existing)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) next.push(line);
  writeAtomic(envFile, next.join(eol) + eol);
}

function tokenFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/s\/([A-Za-z0-9_-]{32,128})\/?$/);
  return m?.[1] ?? null;
}

function loadStore(path: string): SecretStore {
  if (!existsSync(path)) return { version: 2, requests: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.requests !== "object" || parsed.requests === null) {
      return { version: 2, requests: {} };
    }
    return { version: 2, requests: migrateRequests(parsed.requests as Record<string, unknown>) };
  } catch {
    return { version: 2, requests: {} };
  }
}

/** Accept both the v1 (`{name}`) and v2 (`{fields,destination}`) on-disk record shapes. */
function migrateRequests(raw: Record<string, unknown>): Record<string, SecretRequestRecord> {
  const out: Record<string, SecretRequestRecord> = {};
  for (const [hash, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    if (typeof rec.createdAt !== "string" || typeof rec.expiresAt !== "string") continue;
    let fields: SecretFieldSpec[];
    let destination: SecretDestination;
    if (Array.isArray(rec.fields) && rec.destination && typeof rec.destination === "object") {
      fields = rec.fields as SecretFieldSpec[];
      destination = rec.destination as SecretDestination;
    } else if (typeof rec.name === "string") {
      fields = [{ name: rec.name, label: rec.name, secret: true }];
      destination = { kind: "env" };
    } else {
      continue;
    }
    out[hash] = {
      fields,
      destination,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      ...(typeof rec.redeemedAt === "string" ? { redeemedAt: rec.redeemedAt } : {}),
    };
  }
  return out;
}

function saveStore(path: string, store: SecretStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(store, null, 2) + "\n", 0o600);
}

function pruneExpired(store: SecretStore, now: Date): SecretStore {
  const requests: Record<string, SecretRequestRecord> = {};
  for (const [hash, rec] of Object.entries(store.requests)) {
    if (rec.redeemedAt) {
      requests[hash] = rec;
      continue;
    }
    if (Date.parse(rec.expiresAt) > now.getTime()) requests[hash] = rec;
  }
  return { version: 2, requests };
}

function appendRedemptionMarker(path: string, record: SecretRequestRecord, redeemedAt: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Log destination + field NAMES only. Secret values never reach this ledger.
  const entry = {
    ts: redeemedAt,
    event: "secret_redeemed",
    destination: record.destination.kind,
    ...(record.destination.kind === "keychain" ? { entry: record.destination.entry } : {}),
    fields: record.fields.map((f) => f.name),
  };
  appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

function isSafeSecretValue(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

function canFormatEnvValue(value: string): boolean {
  try {
    formatEnvValue(value);
    return true;
  } catch {
    return false;
  }
}

function formatEnvValue(value: string): string {
  if (value === "") return "''";
  if (/^[^\s#]+$/.test(value) && !(value.startsWith("'") && value.endsWith("'")) && !(value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error("secret value contains both quote types and cannot be represented safely in this .env parser");
}

function renderSecretForm(fields: SecretFieldSpec[], destination: SecretDestination): string {
  const dest = destination.kind === "keychain"
    ? `jingle keychain entry <strong class="key">${escapeHtml(destination.entry)}</strong>`
    : `environment variables`;
  const inputs = fields
    .map((f) => {
      const id = escapeHtml(f.name);
      const label = escapeHtml(f.label ?? f.name);
      const type = f.secret === false ? "text" : "password";
      return `<label for="f-${id}">${label} <span class="key">(${id})</span></label>
<input id="f-${id}" name="${id}" type="${type}" required autocomplete="off" autocapitalize="off" spellcheck="false">`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beckett secret intake</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.4}label,input,button{display:block;width:100%;font-size:1rem}label{margin-top:1rem}input{box-sizing:border-box;margin:.35rem 0 .5rem;padding:.7rem}button{margin-top:1.25rem;padding:.7rem}.key{font-family:ui-monospace,monospace;color:#555;font-weight:400}</style>
</head><body><main>
<h1>Beckett secret intake</h1>
<p>These values are stored to ${dest}. Nothing you type is shown in chat.</p>
<form method="post" autocomplete="off">
${inputs}
<button type="submit">Submit once</button>
</form>
<p>This link is single-use and expires automatically.</p>
</main></body></html>`;
}

function renderRedeemed(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redeemed</title></head><body><main><h1>Redeemed</h1><p>You can close this.</p></main></body></html>`;
}

function unavailable(): Response {
  return text("link unavailable", 410);
}

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: secureHeaders("text/html; charset=utf-8") });
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body + "\n", { status, headers: { ...secureHeaders("text/plain; charset=utf-8"), ...extra } });
}

function secureHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function writeAtomic(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, { mode: mode ?? 0o600 });
  renameSync(tmp, path);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
