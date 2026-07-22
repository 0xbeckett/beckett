/** Keychain read side: metadata via show --json, values via exec env carrier, fresh TOTP codes. */

import { describe, expect, test } from "bun:test";
import { createKeychainReader, type JingleReadRunner } from "./keychain-read.ts";

function fakeJingle(behaviors: {
  fields?: string[];
  values?: Record<string, string>;
  totpCode?: string;
  failShow?: boolean;
}): { runner: JingleReadRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: JingleReadRunner = async (args) => {
    calls.push(args);
    if (args[0] === "show") {
      if (behaviors.failShow) return { code: 1, stdout: "", stderr: "not found" };
      return {
        code: 0,
        stdout: JSON.stringify({ name: args[1], secret_fields: behaviors.fields ?? [] }),
        stderr: "",
      };
    }
    if (args[0] === "exec") {
      const mapping = args[args.indexOf("-s") + 1]!;
      const field = mapping.slice(mapping.indexOf(":") + 1, mapping.indexOf("="));
      const value = behaviors.values?.[field];
      if (value === undefined) return { code: 1, stdout: "", stderr: "missing" };
      return { code: 0, stdout: value, stderr: "" };
    }
    if (args[0] === "totp") {
      if (!behaviors.totpCode) return { code: 1, stdout: "", stderr: "no totp" };
      return { code: 0, stdout: `${behaviors.totpCode}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { runner, calls };
}

describe("keychain reader", () => {
  test("reads every non-totp field through the exec carrier and flags totp", async () => {
    const { runner, calls } = fakeJingle({
      fields: ["email", "password", "totp"],
      values: { email: "bot@example.com", password: "hunter2-secret" },
    });
    const secrets = await createKeychainReader(runner).read("x.com");
    expect(secrets).toMatchObject({
      entry: "x.com",
      fields: ["email", "password", "totp"],
      hasTotp: true,
      values: { email: "bot@example.com", password: "hunter2-secret" },
    });
    // The seed never rides the carrier: no exec call may name the totp field.
    const execMappings = calls.filter((args) => args[0] === "exec").map((args) => args[args.indexOf("-s") + 1]);
    expect(execMappings).toEqual(["x.com:email=BECKETT_KEYCHAIN_VALUE", "x.com:password=BECKETT_KEYCHAIN_VALUE"]);
    // No secret value ever appears in argv.
    for (const args of calls) expect(args.join(" ")).not.toContain("hunter2-secret");
  });

  test("mints fresh totp codes and validates their shape", async () => {
    const reader = createKeychainReader(fakeJingle({ totpCode: "739184" }).runner);
    expect(await reader.totp("x.com")).toBe("739184");
    await expect(createKeychainReader(fakeJingle({}).runner).totp("x.com")).rejects.toThrow(/totp/);
  });

  test("fails loudly on unknown entries and entries without fields", async () => {
    await expect(createKeychainReader(fakeJingle({ failShow: true }).runner).read("nope")).rejects.toThrow(/not readable/);
    await expect(createKeychainReader(fakeJingle({ fields: [] }).runner).read("empty")).rejects.toThrow(/no secret fields/);
  });
});
