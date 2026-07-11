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

const TOKEN_BYTES = 32; // 256 bits (acceptance requires >=128 bits)
const DEFAULT_TTL_MINUTES = 15;
const MAX_FORM_BYTES = 16 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type SecretRequestRecord = {
  name: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
};

type SecretStore = {
  version: 1;
  requests: Record<string, SecretRequestRecord>;
};

export type SecretPaths = {
  beckettDir: string;
  envFile: string;
};

export type MintSecretRequestResult = {
  token: string;
  tokenHash: string;
  name: string;
  expiresAt: string;
  url: string;
};

export type SecretStatus =
  | { ok: true; name: string; expiresAt: string }
  | { ok: false };

export type RedeemSecretResult =
  | { ok: true; name: string; redeemedAt: string }
  | { ok: false; reason: "invalid" | "bad-value" };

export type SecretHandlerOptions = {
  paths: SecretPaths;
  now?: () => Date;
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
    throw new Error("secret request --name must be a single environment key (A-Z, digits, underscore; not starting with a digit)");
  }
  return trimmed;
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
  name: string;
  ttlMinutes?: number;
  baseUrl: string;
  now?: Date;
  token?: string;
}): MintSecretRequestResult {
  const name = validateSecretEnvName(p.name);
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
    name,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  saveStore(storePath, store);

  const base = p.baseUrl.replace(/\/+$/, "");
  return { token, tokenHash, name, expiresAt: expires.toISOString(), url: `${base}/s/${token}` };
}

export function secretRequestStatus(paths: SecretPaths, token: string, now = new Date()): SecretStatus {
  if (!TOKEN_RE.test(token)) return { ok: false };
  const record = loadStore(defaultSecretStorePath(paths.beckettDir)).requests[hashSecretToken(token)];
  if (!record || record.redeemedAt || Date.parse(record.expiresAt) <= now.getTime()) return { ok: false };
  return { ok: true, name: record.name, expiresAt: record.expiresAt };
}

export function redeemSecretValue(paths: SecretPaths, token: string, value: string, now = new Date()): RedeemSecretResult {
  if (!isSafeSecretValue(value) || !canFormatEnvValue(value)) return { ok: false, reason: "bad-value" };
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "invalid" };

  const storePath = defaultSecretStorePath(paths.beckettDir);
  const store = pruneExpired(loadStore(storePath), now);
  const tokenHash = hashSecretToken(token);
  const record = store.requests[tokenHash];
  if (!record || record.redeemedAt || Date.parse(record.expiresAt) <= now.getTime()) {
    saveStore(storePath, store);
    return { ok: false, reason: "invalid" };
  }

  upsertEnvKey(paths.envFile, record.name, value);
  const redeemedAt = now.toISOString();
  record.redeemedAt = redeemedAt;
  store.requests[tokenHash] = record;
  saveStore(storePath, store);
  appendRedemptionMarker(defaultSecretMarkerPath(paths.beckettDir), record.name, redeemedAt);
  return { ok: true, name: record.name, redeemedAt };
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
      return html(renderSecretForm(status.name), 200);
    }

    if (req.method === "POST") {
      const len = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(len) && len > MAX_FORM_BYTES) return text("request too large", 413);
      let value = "";
      try {
        const form = await readBoundedForm(req, MAX_FORM_BYTES);
        const raw = form.get("value");
        value = typeof raw === "string" ? raw : "";
      } catch (err) {
        if (err instanceof FormBodyTooLargeError) return text("request too large", 413);
        return text("bad request", 400);
      }
      const redeemed = redeemSecretValue(opts.paths, token, value, now());
      if (!redeemed.ok) return redeemed.reason === "bad-value" ? text("bad request", 400) : unavailable();
      return html(renderRedeemed(), 200);
    }

    return text("method not allowed", 405, { Allow: "GET, POST" });
  };
}

class FormBodyTooLargeError extends Error {}

/** Consume an untrusted form stream without trusting Content-Length or buffering past the cap. */
async function readBoundedForm(
  req: Request,
  maxBytes: number,
): Promise<{ get(name: string): unknown }> {
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
  return new Response(body, { headers: { "content-type": contentType } }).formData();
}

export function serveSecretIntake(p: { paths: SecretPaths; port: number; hostname?: string }): { stop: () => void; url: string } {
  const server = Bun.serve({
    hostname: p.hostname ?? "127.0.0.1",
    port: p.port,
    // Reject oversized chunked bodies before Bun allocates a full stream chunk for the handler.
    maxRequestBodySize: MAX_FORM_BYTES,
    fetch: createSecretHandler({ paths: p.paths }),
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
  if (!existsSync(path)) return { version: 1, requests: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.requests !== "object" || parsed.requests === null) {
      return { version: 1, requests: {} };
    }
    return { version: 1, requests: parsed.requests as Record<string, SecretRequestRecord> };
  } catch {
    return { version: 1, requests: {} };
  }
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
  return { version: 1, requests };
}

function appendRedemptionMarker(path: string, name: string, redeemedAt: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ts: redeemedAt, name, event: "secret_redeemed" }) + "\n", { mode: 0o600 });
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

function renderSecretForm(name: string): string {
  const escaped = escapeHtml(name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beckett secret intake</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.4}label,input,button{display:block;width:100%;font-size:1rem}input{box-sizing:border-box;margin:.5rem 0 1rem;padding:.7rem}button{padding:.7rem}.key{font-family:ui-monospace,monospace}</style>
</head><body><main>
<h1>Beckett secret intake</h1>
<p>Target key: <strong class="key">${escaped}</strong></p>
<form method="post" autocomplete="off">
<label for="value">Secret value</label>
<input id="value" name="value" type="password" required autofocus autocomplete="off">
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
