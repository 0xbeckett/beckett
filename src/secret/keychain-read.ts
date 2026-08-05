/**
 * Beckett — jingle keychain READ side for the background browser agent (`src/secret/keychain-read.ts`)
 * ====================================================================================================
 * The browser agent references credentials as `secrets.<field>` inside browser code; the daemon
 * resolves the actual values here and injects them below the model's view. Values leave jingle
 * ONLY through `jingle exec` child-process env injection into a pipe we read in memory — never
 * via argv, never through a logger, never onto disk. TOTP codes are minted fresh per evaluation
 * with `jingle totp` (the seed itself never leaves the vault).
 */

import { existsSync } from "node:fs";

/** Everything the browser agent needs to expose a keychain entry as `secrets.*`. */
export interface KeychainEntrySecrets {
  entry: string;
  /** Field names visible to the model (safe to print); `totp` means codes are minted per eval. */
  fields: string[];
  /** field → secret value. Held in daemon memory only; NEVER persisted or logged. */
  values: Record<string, string>;
  /** The entry carries a TOTP seed; resolve a fresh code with {@link KeychainReader.totp}. */
  hasTotp: boolean;
}

export interface KeychainReader {
  read(entry: string): Promise<KeychainEntrySecrets>;
  totp(entry: string): Promise<string>;
  /** Entry NAMES in the vault (metadata only). Used to resolve a dispatch that named one in prose. */
  list(): Promise<string[]>;
}

/** Test seam mirroring `src/secret/keychain.ts`, plus captured stdout for the exec/show paths. */
export type JingleReadRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function resolveJingleBin(): string {
  const override = process.env.JINGLE_BIN;
  if (override && override.trim()) return override.trim();
  const home = process.env.HOME;
  if (home) {
    const installed = `${home}/.local/bin/jingle`;
    if (existsSync(installed)) return installed;
  }
  return "jingle";
}

const spawnJingleRead: JingleReadRunner = async (args) => {
  const proc = Bun.spawn([resolveJingleBin(), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** Reserved env var the value crosses the jingle→beckett boundary in; consumed, never exported. */
const CARRIER_ENV = "BECKETT_KEYCHAIN_VALUE";

/**
 * What jingle's leak tripwire substitutes when a child prints an injected secret. Our carrier child
 * prints the value BY DESIGN into a private in-memory pipe, so the guard is off for that call
 * (`--no-leak-guard`) — but if a jingle build ever ignores the flag, the marker would sail on as if
 * it were the credential. It is a plausible-looking 20-character string, so nothing downstream
 * would notice: the browser agent would type it into the login form and the site would answer
 * "incorrect password" (it did, for hours, against x.com). Detect it and fail loudly instead.
 */
const JINGLE_REDACTION_MARKER = "[REDACTED by jingle]";

/**
 * Create the production reader. Field names come from `jingle show --json` (metadata only —
 * jingle redacts values in every output mode). Each value is then pulled through
 * `jingle exec -s entry:field=VAR --no-inherit-env --no-leak-guard -- sh -c 'printf %s "$VAR"'`:
 * the value exists in the child's env and our captured pipe, nowhere else.
 *
 * `--no-leak-guard` is REQUIRED here and is not a weakening of jingle's tripwire. That guard
 * exists to stop a secret reaching a terminal a human or transcript can see; it streams the
 * child's stdout and rewrites any injected value to {@link JINGLE_REDACTION_MARKER}. Our child's
 * stdout is a Bun pipe read into daemon memory — the sanctioned handoff, not an egress — so with
 * the guard on, every credential arrives as the marker string and gets typed into login forms
 * verbatim. Redaction of anything user- or model-facing is enforced separately and still applies
 * (see `redactKnownBrowserInputs` in src/browser/agent.ts).
 */
export function createKeychainReader(run: JingleReadRunner = spawnJingleRead): KeychainReader {
  return {
    async read(entry) {
      if (!entry.trim()) throw new Error("keychain read needs an entry name");
      const shown = await run(["show", entry, "--json"]);
      if (shown.code !== 0) throw new Error(`jingle entry "${entry}" is not readable (${shown.code})`);
      let fields: string[];
      try {
        const parsed = JSON.parse(shown.stdout) as { secret_fields?: unknown; entry?: { secret_fields?: unknown } };
        const raw = Array.isArray(parsed.secret_fields)
          ? parsed.secret_fields
          : Array.isArray(parsed.entry?.secret_fields)
            ? parsed.entry!.secret_fields
            : [];
        fields = (raw as unknown[]).filter((field): field is string => typeof field === "string" && !!field.trim());
      } catch {
        throw new Error(`jingle show --json for "${entry}" returned unparseable metadata`);
      }
      if (fields.length === 0) throw new Error(`jingle entry "${entry}" has no secret fields`);
      const hasTotp = fields.includes("totp");
      const values: Record<string, string> = {};
      for (const field of fields) {
        // The TOTP SEED must never egress; only short-lived codes do, via totp() below.
        if (field === "totp") continue;
        const fetched = await run([
          "exec",
          "-s",
          `${entry}:${field}=${CARRIER_ENV}`,
          "--no-inherit-env",
          "--no-leak-guard",
          "--",
          "/bin/sh",
          "-c",
          `printf %s "$${CARRIER_ENV}"`,
        ]);
        if (fetched.code !== 0) throw new Error(`jingle could not resolve ${entry}:${field} (${fetched.code})`);
        if (fetched.stdout === JINGLE_REDACTION_MARKER) {
          throw new Error(
            `jingle redacted ${entry}:${field} on its way to beckett — the carrier read came back as ` +
              `"${JINGLE_REDACTION_MARKER}" instead of the credential. This jingle build ignored ` +
              `--no-leak-guard; upgrade it (a credential typed as this marker looks like a wrong password).`,
          );
        }
        values[field] = fetched.stdout;
      }
      return { entry, fields, values, hasTotp };
    },

    async list() {
      const listed = await run(["list", "--json"]);
      if (listed.code !== 0) return [];
      try {
        const parsed = JSON.parse(listed.stdout) as { entries?: { name?: unknown }[] };
        return (parsed.entries ?? [])
          .map((e) => e.name)
          .filter((name): name is string => typeof name === "string" && !!name.trim());
      } catch {
        return [];
      }
    },

    async totp(entry) {
      const result = await run(["totp", entry]);
      if (result.code !== 0) throw new Error(`jingle totp ${entry} failed (${result.code})`);
      const code = result.stdout.trim();
      if (!/^\d{6,8}$/.test(code)) throw new Error(`jingle totp ${entry} did not return a code`);
      return code;
    },
  };
}

export const defaultKeychainReader: KeychainReader = createKeychainReader();
