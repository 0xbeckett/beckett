import { expect, test } from "bun:test";
import { CodexDriver } from "./codex.ts";
import type { Config } from "../types.ts";

const config = {
  harness: {
    codex: {
      default_model: "",
      sandbox_mode: "workspace-write",
      approval_policy: "never",
      network_default: false,
    },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

test("resume pins the captured codex thread id instead of --last", () => {
  const driver = new CodexDriver(config, quietLog) as unknown as {
    sessionId: string | null;
    spec: unknown;
    buildResumeArgs(prompt: string): string[];
  };
  driver.sessionId = "thread-123";
  driver.spec = {
    workspace: "/tmp/work",
    envelope: {},
  };

  const args = driver.buildResumeArgs("continue");

  expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-123"]);
  expect(args).not.toContain("--last");
  expect(args.at(-1)).toBe("continue");
});
