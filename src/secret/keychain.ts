/**
 * Beckett — jingle keychain sink for redeemed secret-intake batches (`src/secret/keychain.ts`)
 * =======================================================================================
 * When a secret-link request targets the keychain (the default), each submitted field is written
 * into the durable `jingle` vault so Beckett can reuse the credential on later browser /
 * computer-use runs. This is the intake counterpart to the jingle skill's subprocess-injection
 * rule: secret values enter jingle ONLY on the child's stdin — never in argv, never on stdout,
 * never in a log line. We shell out to the same `jingle` launcher the skill documents.
 */

/** One field → one jingle secret field on the entry. `value` is sensitive and only ever piped to stdin. */
export type KeychainField = { field: string; value: string };

export type KeychainStore = (p: {
  entry: string;
  service?: string;
  fields: KeychainField[];
}) => Promise<void>;

export type JingleRunner = (
  args: string[],
  stdin: string,
) => Promise<{ code: number; stderr: string }>;

/** Spawn `jingle` (the durable launcher on PATH) with a secret piped on stdin and no stdout capture. */
const spawnJingle: JingleRunner = async (args, stdin) => {
  const proc = Bun.spawn(["jingle", ...args], {
    stdin: "pipe",
    // Discard stdout entirely: jingle redacts secrets, but we never want its output near a log.
    stdout: "ignore",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
};

/**
 * Store a batch into a jingle entry. Creates the entry on first use, then sets each field.
 * Every secret goes in on stdin; the value never appears in the argv we build here.
 */
export function createKeychainStore(run: JingleRunner = spawnJingle): KeychainStore {
  return async ({ entry, service, fields }) => {
    if (fields.length === 0) throw new Error("keychain store got no fields");
    const exists = (await run(["show", entry], "")).code === 0;

    let index = 0;
    if (!exists) {
      const first = fields[0]!;
      const args = ["add", entry, "--field", first.field, "--stdin"];
      if (service) args.push("--service", service);
      const r = await run(args, first.value);
      // Do not echo r.stderr verbatim to callers that might log it; jingle keeps secrets out of
      // its own stderr, but the redeem path already swallows this into a generic failure.
      if (r.code !== 0) throw new Error(`jingle add failed (${r.code})`);
      index = 1;
    }

    for (; index < fields.length; index++) {
      const f = fields[index]!;
      const r = await run(["set", entry, f.field, "--stdin"], f.value);
      if (r.code !== 0) throw new Error(`jingle set ${f.field} failed (${r.code})`);
    }
  };
}

/** The default sink used in production: the real `jingle` subprocess. */
export const defaultKeychainStore: KeychainStore = createKeychainStore();
