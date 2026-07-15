/**
 * Beckett — CLI process plumbing (`src/cli/io.ts`)
 * =======================================================================================
 * The `beckett` CLI's I/O and argv contract, extracted from `cli/beckett.ts` so the
 * normalized capability modules (`src/capability/modules/`, V5 Phase 2) can share it without
 * importing the CLI entry itself. Nothing here is new behavior: these are the exact helpers
 * every verb handler has always used — `out`/`fail` ARE the CLI's observable contract
 * (stdout JSON / `error: …` on stderr / exit code), which the characterization suite pins.
 */

import type { Logger } from "../types.ts";

/** Print the result (string verbatim, anything else pretty JSON) and exit 0. */
export function out(data: unknown): never {
  process.stdout.write(typeof data === "string" ? data + "\n" : JSON.stringify(data, null, 2) + "\n");
  process.exit(0);
}

/** Print `error: <msg>` on stderr and exit 1. */
export function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** Minimal flag parser: returns { _: positional[], flags: {k:v|true} }. */
export function parse(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(t);
  }
  return { _, flags };
}

/** Validate a `--port` style flag into a usable port number, or fall back. */
export function parsePort(raw: string | boolean | undefined, fallback: number): number {
  if (raw === undefined || raw === false) return fallback;
  if (raw === true) fail("port flag needs a value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) fail("port must be an integer from 1 to 65535");
  return n;
}

/** A no-op logger: CLI invocations are short-lived and emit JSON, not log lines. */
export const quietLogger = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as unknown as Logger;
})();
