#!/usr/bin/env bun
/**
 * Register Beckett's GitHub App from the checked-in manifest (#114).
 * =======================================================================================
 * GitHub requires a human to confirm app creation in a browser — that one click is the ONLY
 * manual step. This script does everything around it:
 *
 *   1. serves a page at http://127.0.0.1:<port>/ that auto-POSTs `deploy/github-app-manifest.json`
 *      to `https://github.com/organizations/<org>/settings/apps/new?state=<csrf>`
 *   2. catches GitHub's redirect back to `/callback?code=…&state=…` (state is verified)
 *   3. exchanges the temporary code at `POST /app-manifests/{code}/conversions` — which returns
 *      the app id, the PEM private key, the webhook secret, and the client id/secret
 *   4. writes the PEM to `~/.beckett/github-app.pem` (mode 0600) and prints the exact `.env` lines
 *
 * The whole handshake must finish within one hour of step 1 (GitHub's limit on the temporary code).
 *
 *   bun scripts/ops/github-app-register.ts [--org kowo-co] [--port 7788] [--name beckett]
 *                                          [--manifest deploy/github-app-manifest.json]
 *                                          [--key-out ~/.beckett/github-app.pem]
 *
 * Nothing is written until GitHub returns a real key; there is no dry-run mode that pretends.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const opts = {
  org: "kowo-co",
  port: 7788,
  manifest: resolve(import.meta.dir, "..", "..", "deploy", "github-app-manifest.json"),
  keyOut: join(homedir(), ".beckett", "github-app.pem"),
  name: "",
};

function take(flag: string): string {
  const value = args.shift();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

while (args.length) {
  const flag = args.shift()!;
  switch (flag) {
    case "--org": opts.org = take(flag); break;
    case "--port": opts.port = Number(take(flag)); break;
    case "--manifest": opts.manifest = resolve(take(flag)); break;
    case "--key-out": opts.keyOut = resolve(take(flag).replace(/^~(?=$|\/)/, homedir())); break;
    case "--name": opts.name = take(flag); break;
    case "--help":
      console.log(
        "Usage: bun scripts/ops/github-app-register.ts [--org kowo-co] [--port 7788] " +
          "[--name beckett] [--manifest PATH] [--key-out PATH]",
      );
      process.exit(0);
      break;
    default:
      throw new Error(`unknown option: ${flag}`);
  }
}

const manifest = JSON.parse(readFileSync(opts.manifest, "utf8")) as Record<string, unknown>;
delete manifest.$comment; // documentation for humans; GitHub rejects unknown keys
if (opts.name) manifest.name = opts.name;
// The redirect must match the server this process is actually listening on.
manifest.redirect_url = `http://127.0.0.1:${opts.port}/callback`;

const state = randomUUID();
const createUrl = `https://github.com/organizations/${opts.org}/settings/apps/new?state=${state}`;

interface Conversion {
  id: number;
  slug: string;
  name: string;
  owner?: { login?: string };
  pem: string;
  webhook_secret: string | null;
  client_id: string;
  client_secret: string;
  html_url: string;
}

let resolveDone: (c: Conversion) => void;
let rejectDone: (e: Error) => void;
const done = new Promise<Conversion>((res, rej) => {
  resolveDone = res;
  rejectDone = rej;
});

function page(body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>beckett — GitHub App</title>${body}`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: opts.port,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      // An auto-submitting form: the manifest flow is a POST, which a plain redirect can't do.
      return page(
        `<body onload="document.forms[0].submit()">
           <p>Sending the manifest to GitHub…</p>
           <form action="${createUrl}" method="post">
             <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
             <button type="submit">Continue to GitHub</button>
           </form>
         </body>`,
      );
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const returned = url.searchParams.get("state");
      if (returned !== state) {
        const err = new Error(`state mismatch — expected ${state}, got ${returned ?? "nothing"}`);
        rejectDone(err);
        return page(`<p>Refused: ${escapeHtml(err.message)}</p>`);
      }
      if (!code) {
        const err = new Error("GitHub redirected without a code — the app was not created");
        rejectDone(err);
        return page(`<p>${escapeHtml(err.message)}</p>`);
      }
      try {
        const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "beckett",
          },
        });
        const body = (await res.json()) as Conversion & { message?: string };
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.message ?? "conversion failed"}`);
        resolveDone(body);
        return page(
          `<p>Created <b>${escapeHtml(body.name)}</b> (app ${body.id}, slug <code>${escapeHtml(body.slug)}</code>).</p>
           <p>The private key and the .env lines are in your terminal. You can close this tab.</p>`,
        );
      } catch (err) {
        rejectDone(err as Error);
        return page(`<p>Conversion failed: ${escapeHtml((err as Error).message)}</p>`);
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`\nOpen this in a browser signed in as a ${opts.org} owner:\n`);
console.log(`   http://127.0.0.1:${opts.port}/\n`);
console.log("GitHub will show a confirmation page — click 'Create GitHub App for " + opts.org + "'.");
console.log("Waiting for the redirect (this window must stay open)…\n");

const app = await done.finally(() => setTimeout(() => server.stop(true), 1_000));

mkdirSync(dirname(opts.keyOut), { recursive: true, mode: 0o700 });
writeFileSync(opts.keyOut, app.pem, { mode: 0o600 });
chmodSync(opts.keyOut, 0o600);

console.log("─".repeat(88));
console.log(`app:          ${app.name} (id ${app.id}, slug ${app.slug}, owner ${app.owner?.login ?? opts.org})`);
console.log(`settings:     ${app.html_url}`);
console.log(`install link: https://github.com/apps/${app.slug}/installations/new`);
console.log(`private key:  ${opts.keyOut} (mode 0600)`);
console.log("─".repeat(88));
console.log("\nAdd these to ~/.beckett/.env on the box, then restart the daemon:\n");
console.log(`GITHUB_APP_ID=${app.id}`);
console.log(`GITHUB_APP_SLUG=${app.slug}`);
console.log(`GITHUB_APP_PRIVATE_KEY_PATH=${opts.keyOut}`);
console.log("\nThen install it on kowo-co and pin the installation id:");
console.log(`  open https://github.com/apps/${app.slug}/installations/new`);
console.log("  beckett gh app installations   # → the id to put in GITHUB_APP_INSTALLATION_ID");
console.log("  beckett doctor                 # → 'identity: github app' should be green\n");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
