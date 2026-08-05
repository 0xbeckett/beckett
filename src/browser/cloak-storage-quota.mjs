/**
 * CloakBrowser wrapper shim: the one place the lane's storage quota reaches Chromium.
 *
 * CloakBrowser exposes `--fingerprint-storage-quota=<mebibytes>`, which is the only
 * supported way to move the figure `navigator.storage.estimate()` reports. BetterWright
 * reserves the whole `--fingerprint*` namespace from its `chromiumArgs` option — a
 * sound default, since those switches decide the browser's presented identity and a
 * caller who half-sets them gets an incoherent one — so the switch cannot be passed
 * through the normal option. BetterWright does support substituting the CloakBrowser
 * wrapper module wholesale (`BETTERWRIGHT_CLOAKBROWSER_PATH`), and that is this file:
 * the real wrapper, with one switch appended and nothing else touched.
 *
 * It is deliberately the entire surface BetterWright loads from a CloakBrowser wrapper
 * (see betterwright's cloak.js: `launchPersistentContext` and `binaryInfo`), so the
 * shim cannot drift into re-implementing any of it.
 *
 * Plain ESM rather than TypeScript because BetterWright imports it by path at runtime
 * from inside the sandbox; isolated.ts copies it beside the host bundle so `cloakbrowser`
 * resolves from the bound `/repo/node_modules`.
 */

import { binaryInfo as upstreamBinaryInfo, launchPersistentContext as upstreamLaunch } from "cloakbrowser";

/** Set by isolated.ts from the lane's resolved storage budget. */
const QUOTA_ENV = "BECKETT_BROWSER_STORAGE_QUOTA_MIB";

function storageQuotaArgs() {
  const mib = Number.parseInt((process.env[QUOTA_ENV] ?? "").trim(), 10);
  // No budget, or an unusable one, leaves CloakBrowser's own default in place rather
  // than emitting a switch whose value would be a worse lie than the one it replaces.
  if (!Number.isInteger(mib) || mib <= 0) return [];
  return [`--fingerprint-storage-quota=${mib}`];
}

export function launchPersistentContext(options = {}) {
  const extra = storageQuotaArgs();
  if (extra.length === 0) return upstreamLaunch(options);
  // Appended last: cloakbrowser's buildArgs keys by switch name and lets the caller's
  // value win, and nothing upstream sets this switch, so nothing is being overridden.
  return upstreamLaunch({ ...options, args: [...(options.args ?? []), ...extra] });
}

export function binaryInfo(...args) {
  return upstreamBinaryInfo(...args);
}
