import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeychainStore, type JingleRunner } from "./keychain.ts";

type Call = { args: string[]; stdin: string };

function recorder(showExists: boolean, failOn?: string): { runner: JingleRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: JingleRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "show") return { code: showExists ? 0 : 1, stderr: "" };
    if (failOn && args.includes(failOn)) return { code: 1, stderr: "boom" };
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

describe("keychain store", () => {
  test("creates the entry then sets remaining fields, secrets only on stdin", async () => {
    const { runner, calls } = recorder(false);
    const store = createKeychainStore(runner);
    await store({
      entry: "acme",
      service: "acme.example",
      fields: [
        { field: "username", value: "ro@acme" },
        { field: "password", value: "s3cret" },
      ],
    });

    expect(calls[0]!.args).toEqual(["show", "acme"]);
    // First field creates the entry via `add`, value on stdin.
    expect(calls[1]!.args).toEqual(["add", "acme", "--field", "username", "--stdin", "--service", "acme.example"]);
    expect(calls[1]!.stdin).toBe("ro@acme");
    // Second field via `set`.
    expect(calls[2]!.args).toEqual(["set", "acme", "password", "--stdin"]);
    expect(calls[2]!.stdin).toBe("s3cret");
    // No secret value ever appears in an argv.
    for (const c of calls) expect(c.args.join(" ")).not.toContain("s3cret");
  });

  test("uses set-only when the entry already exists", async () => {
    const { runner, calls } = recorder(true);
    const store = createKeychainStore(runner);
    await store({ entry: "acme", fields: [{ field: "password", value: "pw" }] });
    expect(calls[0]!.args).toEqual(["show", "acme"]);
    expect(calls[1]!.args).toEqual(["set", "acme", "password", "--stdin"]);
    expect(calls[1]!.stdin).toBe("pw");
  });

  test("throws when a jingle call fails", async () => {
    const { runner } = recorder(true, "set");
    const store = createKeychainStore(runner);
    await expect(store({ entry: "acme", fields: [{ field: "password", value: "pw" }] })).rejects.toThrow();
  });
});

// Guarded round-trip against the REAL jingle binary, pointed at a throwaway vault so the durable
// vault is never touched. Skipped where the binary is not installed.
const REAL_JINGLE = join(process.env.HOME ?? "", ".local", "lib", "jingle", "jingle");
const hasJingle = REAL_JINGLE !== "" && existsSync(REAL_JINGLE);
describe.if(hasJingle)("keychain store against real jingle", () => {
  test("a batch round-trips into an encrypted temp vault with redacted values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-jingle-"));
    const vault = join(dir, "vault.jingle");
    const keyfile = join(dir, "key");
    const base = ["--vault", vault, "--keyfile", keyfile];
    const runRaw = (args: string[], stdin: string) =>
      new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
        const proc = Bun.spawn([REAL_JINGLE, ...base, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(stdin);
        proc.stdin.end();
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
          ([stdout, stderr, code]) => resolve({ code, stderr, stdout }),
        );
      });
    try {
      expect((await runRaw(["init"], "")).code).toBe(0);
      const runner: JingleRunner = async (args, stdin) => {
        const r = await runRaw(args, stdin);
        return { code: r.code, stderr: r.stderr };
      };
      const store = createKeychainStore(runner);
      await store({
        entry: "acme",
        service: "acme.example",
        fields: [
          { field: "username", value: "ro@acme" },
          { field: "password", value: "s3cret-value" },
        ],
      });
      const shown = await runRaw(["show", "acme"], "");
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("password=[REDACTED]");
      expect(shown.stdout).toContain("username=[REDACTED]");
      // The plaintext secret never appears in jingle output.
      expect(shown.stdout).not.toContain("s3cret-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
