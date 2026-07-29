import { expect, test } from "bun:test";
import { childEnv, isForbiddenEnvKey } from "./env.ts";

test("isForbiddenEnvKey strips by PREFIX, not just the two exact keys", () => {
  // the exact keys the old hand-copies stripped…
  expect(isForbiddenEnvKey("ANTHROPIC_API_KEY")).toBe(true);
  expect(isForbiddenEnvKey("OPENAI_API_KEY")).toBe(true);
  // …and the holes they left open (issue #19 / #11)
  expect(isForbiddenEnvKey("ANTHROPIC_AUTH_TOKEN")).toBe(true);
  expect(isForbiddenEnvKey("ANTHROPIC_BASE_URL")).toBe(true);
  expect(isForbiddenEnvKey("OPENAI_ORG_ID")).toBe(true);
  expect(isForbiddenEnvKey("CLAUDE_CODE_ENTRYPOINT")).toBe(true);
});

test("isForbiddenEnvKey keeps ordinary vars", () => {
  for (const k of ["PATH", "HOME", "GITHUB_PAT", "DISCORD_TOKEN", "LANG", "OPENROUTER_API_KEY"]) {
    expect(isForbiddenEnvKey(k)).toBe(false);
  }
});

test("isForbiddenEnvKey allowlists ANTHROPIC_OAUTH_TOKEN but keeps the other Anthropic creds forbidden (#127)", () => {
  // the subscription OAuth token pi needs for --provider anthropic must pass through…
  expect(isForbiddenEnvKey("ANTHROPIC_OAUTH_TOKEN")).toBe(false);
  // …while the API key, per-token API auth, and endpoint override all stay stripped
  expect(isForbiddenEnvKey("ANTHROPIC_API_KEY")).toBe(true);
  expect(isForbiddenEnvKey("ANTHROPIC_AUTH_TOKEN")).toBe(true);
  expect(isForbiddenEnvKey("ANTHROPIC_BASE_URL")).toBe(true);
});

test("childEnv passes ANTHROPIC_OAUTH_TOKEN through but strips ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL (#127)", () => {
  process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat0-sentinel";
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-api-sentinel";
  process.env.ANTHROPIC_BASE_URL = "https://foreign.example";
  try {
    const env = childEnv();
    expect(env.ANTHROPIC_OAUTH_TOKEN).toBe("sk-ant-oat0-sentinel");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  } finally {
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  }
});

test("childEnv strips forbidden vars from the live environment and layers extras", () => {
  process.env.ANTHROPIC_TEST_SENTINEL = "leak";
  process.env.BECKETT_TEST_SENTINEL = "keep";
  try {
    const env = childEnv({ EXTRA_VAR: "yes" });
    expect(env.ANTHROPIC_TEST_SENTINEL).toBeUndefined();
    expect(env.BECKETT_TEST_SENTINEL).toBe("keep");
    expect(env.EXTRA_VAR).toBe("yes");
    expect(env.PATH).toBe(process.env.PATH);
  } finally {
    delete process.env.ANTHROPIC_TEST_SENTINEL;
    delete process.env.BECKETT_TEST_SENTINEL;
  }
});
