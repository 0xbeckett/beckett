import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import { callBus } from "./control-bus.ts";
import { pendingConfigurationProblems, startPendingConfigurationDaemon } from "./pending.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("a clean install exposes a healthy-pending-configuration status socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-pending-"));
  dirs.push(dir);
  const config = validateConfig({ identity: { github_user: "CHANGE_ME" } });
  const problems = pendingConfigurationProblems(config, {}, dir);
  expect(problems).toEqual(expect.arrayContaining([
    "missing DISCORD_TOKEN in ~/.beckett/.env",
    "missing DISCORD_OWNER_ID in ~/.beckett/.env",
    "missing GitHub credentials in ~/.beckett/.env — set GITHUB_APP_ID + " +
      "GITHUB_APP_PRIVATE_KEY_PATH (see deploy/github-app.md), or a legacy GITHUB_PAT",
    "Claude is not logged in",
    "GitHub username is still CHANGE_ME in ~/.beckett/config.toml",
  ]));

  // Either credential satisfies the GitHub requirement — the App or the legacy PAT.
  const withApp = pendingConfigurationProblems(
    config,
    { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: "/x/key.pem" },
    dir,
  );
  expect(withApp.some((p) => p.includes("GitHub credentials"))).toBe(false);
  const withPat = pendingConfigurationProblems(config, { GITHUB_PAT: "ghp_x" }, dir);
  expect(withPat.some((p) => p.includes("GitHub credentials"))).toBe(false);

  const socket = join(dir, "control.sock");
  const stop = startPendingConfigurationDaemon({ config, version: "0.0.0-test", problems, socketPath: socket });
  try {
    const response = await callBus(socket, "status", {}, 1_000);
    expect(response).toMatchObject({
      ok: true,
      data: {
        version: "0.0.0-test",
        state: "healthy-pending-configuration",
        configuration: { pending: true, problems },
      },
    });
    await expect(callBus(socket, "ticket.list", {}, 1_000)).resolves.toMatchObject({ ok: false });
  } finally {
    stop();
  }
});
