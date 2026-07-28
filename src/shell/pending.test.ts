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
    "missing GITHUB_PAT in ~/.beckett/.env",
    "Claude is not logged in",
    "Pi is enabled but not logged in",
    "GitHub username is still CHANGE_ME in ~/.beckett/config.toml",
  ]));

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
