/**
 * V5 Phase 0 characterization safety net — the `beckett <cmd>` CLI surface.
 * =======================================================================================
 * Snapshots the observable behavior (exit code + stdout + stderr) of EVERY command group in
 * `cli/beckett.ts`, one spawn per case, in a hermetic sandbox: a fresh temp BECKETT_DIR and
 * HOME per case, and an environment stripped of every real credential. This is the contract
 * for the extensibility refactor — when Phase 1 turns the if/else cascade into a
 * CapabilityRegistry walk, THIS suite must stay green byte-for-byte.
 *
 * What "observable behavior" means here: each command is exercised up to its hermetic
 * boundary — full output for the in-process commands (memory, task, plan validation, config,
 * rpc, federation, …), and the exact usage/refusal/dead-daemon message for commands whose
 * happy path needs a live daemon, Discord, the tracker, GitHub, or Cloudflare. Those boundary
 * messages are load-bearing: the Concierge pattern-matches on them, so they are part of the
 * contract too. Dummy credentials (never real ones) are injected only to get PAST an env
 * gate to the command's own argument validation, never far enough to touch a network.
 *
 * If a change breaks one of these snapshots INTENTIONALLY, that is a behavior change, not a
 * refactor — call it out explicitly in review before regenerating.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const cliPath = join(repoRoot, "src", "cli", "beckett.ts");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one `beckett …` invocation hermetically. The env is built from scratch (PATH only),
 * so no real GITHUB_PAT / CLOUDFLARE_* / AGENTMAIL_API_KEY / PLANE_API_TOKEN on this host can
 * leak in; BECKETT_DIR and HOME point into a fresh temp sandbox so no host state is read and
 * the daemon socket is guaranteed absent (the dead-daemon paths are deterministic).
 */
async function beckett(
  argv: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<CliResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "beckett-cli-char-"));
  tmpDirs.push(sandbox);
  const home = join(sandbox, "home");
  const beckettDir = join(sandbox, ".beckett");
  mkdirSync(home, { recursive: true });
  mkdirSync(beckettDir, { recursive: true });
  const proc = Bun.spawn(["bun", cliPath, ...argv], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      BECKETT_HOME: home,
      BECKETT_DIR: beckettDir,
      ...opts.env,
    },
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exit,
    stdout: normalize(stdout, sandbox),
    stderr: normalize(stderr, sandbox),
  };
}

/** Strip the run-varying values so the snapshot captures only the behavioral contract. */
function normalize(text: string, sandbox: string): string {
  return (
    text
      .replaceAll(join(sandbox, ".beckett"), "<BECKETT_DIR>")
      .replaceAll(join(sandbox, "home"), "<HOME>")
      .replaceAll(sandbox, "<SANDBOX>")
      .replaceAll(repoRoot, "<REPO>")
      // ISO timestamps (task/identity records) and epoch-ms fields.
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ISO>")
      .replace(/"(created_at|updated_at|createdAt|updatedAt|ts)": \d+/g, '"$1": <EPOCH_MS>')
      // Generated record ids (task/branch ulid-ish ids).
      .replace(/"id": "[0-9a-zA-Z_-]{8,}"/g, '"id": "<ID>"')
      // The dead-socket connect error's OS-level suffix (bun/kernel wording) is not ours to pin.
      .replace(/shell not running \(socket <BECKETT_DIR>\/control\.sock\): [^\n)]*/g, "shell not running (socket <BECKETT_DIR>/control.sock): <CONNECT_ERROR>")
  );
}

/** Dummy credentials to get PAST an env gate to a command's own validation. Never real. */
const DUMMY_GH = { GITHUB_PAT: "dummy-pat" };
const DUMMY_CF = { CLOUDFLARE_API_TOKEN: "dummy-token", CLOUDFLARE_ZONE_ID: "dummy-zone" };

interface Case {
  name: string;
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
}

const CASES: Case[] = [
  // ── no args / unknown → the canonical command list (the hand-maintained help contract) ──
  { name: "bare invocation prints the unknown-command help", argv: [] },
  { name: "unknown group prints the unknown-command help", argv: ["wat"] },
  { name: "bare discord group falls through to the help", argv: ["discord"] },

  // ── mail ────────────────────────────────────────────────────────────────────────────────
  { name: "mail: bare prints help", argv: ["mail"] },
  { name: "mail: --help prints help", argv: ["mail", "--help"] },
  { name: "mail: inbox without AGENTMAIL_API_KEY is refused", argv: ["mail", "inbox"] },
  { name: "mail: unknown sub without AGENTMAIL_API_KEY is refused first", argv: ["mail", "bogus"] },

  // ── recall / memory ─────────────────────────────────────────────────────────────────────
  { name: "recall: no query prints usage", argv: ["recall"] },
  { name: "recall: query on an empty graph", argv: ["recall", "deploys"] },
  { name: "recall: --as-self combined with --viewer is rejected", argv: ["recall", "x", "--as-self", "--viewer", "1"] },
  { name: "recall: bad --viewer-role is rejected", argv: ["recall", "x", "--viewer-role", "boss"] },
  { name: "memory: recall without args prints usage", argv: ["memory", "recall"] },
  { name: "memory: show without a name prints usage", argv: ["memory", "show"] },
  { name: "memory: show of an unknown node fails", argv: ["memory", "show", "nope"] },
  { name: "memory: remember without --name prints usage", argv: ["memory", "remember"] },
  { name: "memory: unknown sub fails", argv: ["memory", "bogus"] },

  // ── spend ───────────────────────────────────────────────────────────────────────────────
  { name: "spend: empty ledger summary", argv: ["spend"] },
  { name: "spend: bad --since is rejected", argv: ["spend", "--since", "yesterdayish"] },

  // ── journal ─────────────────────────────────────────────────────────────────────────────
  { name: "journal: no ticket prints usage", argv: ["journal"] },
  { name: "journal: unknown ticket reports no journal", argv: ["journal", "OPS-999"] },
  { name: "journal: non-integer --tail is rejected", argv: ["journal", "OPS-1", "--tail", "x"] },

  // ── identity ────────────────────────────────────────────────────────────────────────────
  { name: "identity: set without --user prints usage", argv: ["identity", "set"] },
  { name: "identity: set with --user but nothing to set fails", argv: ["identity", "set", "--user", "123456789012345678"] },
  { name: "identity: show without an id prints usage", argv: ["identity", "show"] },
  { name: "identity: show of an unknown user returns null", argv: ["identity", "show", "--user", "42"] },
  { name: "identity: list returns the seeded map", argv: ["identity", "list"] },
  { name: "identity: unknown sub fails", argv: ["identity", "bogus"] },

  // ── gh (dummy PAT gets past the env gate to the usage contract; no network) ────────────
  { name: "gh: without GITHUB_PAT is refused", argv: ["gh", "repo", "create", "x"] },
  { name: "gh: bare prints usage", argv: ["gh"], env: DUMMY_GH },
  { name: "gh: repo create without a name prints usage", argv: ["gh", "repo", "create"], env: DUMMY_GH },
  { name: "gh: pr without an action prints usage", argv: ["gh", "pr"], env: DUMMY_GH },
  { name: "gh: pr create without flags is refused", argv: ["gh", "pr", "create"], env: DUMMY_GH },
  { name: "gh: pr merge without repo/number prints usage", argv: ["gh", "pr", "merge"], env: DUMMY_GH },
  { name: "gh: pr status without repo prints usage", argv: ["gh", "pr", "status", "1"], env: DUMMY_GH },
  { name: "gh: push without flags prints usage", argv: ["gh", "push"], env: DUMMY_GH },

  // ── dns ─────────────────────────────────────────────────────────────────────────────────
  { name: "dns: without CLOUDFLARE_API_TOKEN is refused", argv: ["dns", "ls"] },
  { name: "dns: without CLOUDFLARE_ZONE_ID is refused", argv: ["dns", "ls"], env: { CLOUDFLARE_API_TOKEN: "dummy-token" } },
  { name: "dns: add without content prints usage", argv: ["dns", "add", "x"], env: DUMMY_CF },
  { name: "dns: rm without a name prints usage", argv: ["dns", "rm"], env: DUMMY_CF },
  { name: "dns: unknown sub prints usage", argv: ["dns", "bogus"], env: DUMMY_CF },

  // ── secret ──────────────────────────────────────────────────────────────────────────────
  { name: "secret: bare prints usage", argv: ["secret"] },
  { name: "secret: request without --name prints usage", argv: ["secret", "request"] },
  { name: "secret: request without Cloudflare creds is refused", argv: ["secret", "request", "--name", "MY_KEY"] },
  { name: "secret: request with a bad env name is rejected", argv: ["secret", "request", "--name", "not a key"] },

  // ── deploy ──────────────────────────────────────────────────────────────────────────────
  { name: "deploy: without CLOUDFLARE_API_TOKEN is refused", argv: ["deploy", "ls"] },
  { name: "deploy: ls without a tunnel id is refused", argv: ["deploy", "ls"], env: DUMMY_CF },
  { name: "deploy: rm without a name prints usage", argv: ["deploy", "rm"], env: DUMMY_CF },
  { name: "deploy: name without a port/service prints usage", argv: ["deploy", "myapp"], env: DUMMY_CF },
  { name: "deploy: bare prints usage", argv: ["deploy"], env: DUMMY_CF },

  // ── image ───────────────────────────────────────────────────────────────────────────────
  { name: "image: no prompt prints usage", argv: ["image"] },
  { name: "image: video without a fal model is refused", argv: ["image", "video", "a", "cat"] },

  // ── eval ────────────────────────────────────────────────────────────────────────────────
  { name: "eval: no model prints usage", argv: ["eval"] },
  { name: "eval: unknown flag is rejected", argv: ["eval", "a/b", "--bogus"] },
  { name: "eval: --short and --full together are rejected", argv: ["eval", "a/b", "--short", "--full"] },

  // ── site ────────────────────────────────────────────────────────────────────────────────
  { name: "site: bare prints usage", argv: ["site"] },
  { name: "site: deploy without CLOUDFLARE_API_TOKEN is refused", argv: ["site", "deploy"] },
  { name: "site: deploy with no wrangler config in --dir is refused", argv: ["site", "deploy", "--dir", "."], env: { CLOUDFLARE_API_TOKEN: "dummy-token" } },

  // ── access / maintainer / federation ────────────────────────────────────────────────────
  { name: "access: ls on an empty whitelist", argv: ["access", "ls"] },
  { name: "access: grant without an id prints usage", argv: ["access", "grant"] },
  { name: "access: revoke without an id prints usage", argv: ["access", "revoke"] },
  { name: "access: revoke of an unknown id", argv: ["access", "revoke", "123456789012345678"] },
  { name: "access: unknown sub prints usage", argv: ["access", "bogus"] },
  { name: "maintainer: ls returns the bundled seed", argv: ["maintainer", "ls"] },
  { name: "maintainer: grant without an id prints usage", argv: ["maintainer", "grant"] },
  { name: "maintainer: revoke without an id prints usage", argv: ["maintainer", "revoke"] },
  { name: "federation: ls on an empty peers file", argv: ["federation", "ls"] },
  { name: "federation: add without an id prints usage", argv: ["federation", "add"] },
  { name: "federation: add of an invalid id is rejected", argv: ["federation", "add", "abc"] },
  { name: "federation: add of a valid bot id", argv: ["federation", "add", "12345678901234567"] },
  { name: "federation: remove without an id prints usage", argv: ["federation", "remove"] },
  { name: "federation: unknown sub prints usage", argv: ["federation", "bogus"] },

  // ── channels (daemon down → the at-rest files fallback) ─────────────────────────────────
  { name: "channels: list falls back to files with the daemon down", argv: ["channels", "list"] },
  { name: "channels: search without a query prints usage", argv: ["channels", "search"] },
  { name: "channels: search falls back to files with the daemon down", argv: ["channels", "search", "deploy"] },
  { name: "channels: recall without a channel prints usage", argv: ["channels", "recall"] },
  { name: "channels: recall of an unknown channel fails", argv: ["channels", "recall", "#nope"] },
  { name: "channels: wipe falls back to files with the daemon down", argv: ["channels", "wipe"] },
  { name: "channels: unknown sub prints usage", argv: ["channels", "bogus"] },

  // ── task (local store in the sandbox) ───────────────────────────────────────────────────
  { name: "task: create without a title prints usage", argv: ["task", "create"] },
  { name: "task: create allocates #1 with an initial branch", argv: ["task", "create", "--title", "Ship the widget"] },
  { name: "task: create against the restricted self-project is bounced", argv: ["task", "create", "--title", "x", "--project", "beckett"] },
  { name: "task: branch without args prints usage", argv: ["task", "branch"] },
  { name: "task: branch on an unknown task fails", argv: ["task", "branch", "#9", "--title", "x"] },
  { name: "task: start without a ref prints usage", argv: ["task", "start"] },
  { name: "task: start of an unknown branch fails", argv: ["task", "start", "#9.1"] },
  { name: "task: show without a ref prints usage", argv: ["task", "show"] },
  { name: "task: show of an unknown task fails", argv: ["task", "show", "#1"] },
  { name: "task: list on an empty store", argv: ["task", "list"] },
  { name: "task: unknown sub prints usage", argv: ["task", "bogus"] },

  // ── ticket (validation layer only — everything past it needs the tracker) ───────────────
  { name: "ticket: trace without an id prints usage", argv: ["ticket", "trace"] },
  { name: "ticket: trace with no events file", argv: ["ticket", "trace", "OPS-1"] },
  { name: "ticket: create without a title prints usage", argv: ["ticket", "create"] },
  { name: "ticket: create against the restricted self-project is bounced", argv: ["ticket", "create", "--title", "x", "--project", "beckett"] },
  { name: "ticket: create with --intensive plus a different --board is rejected", argv: ["ticket", "create", "--title", "x", "--intensive", "--board", "ops"] },
  { name: "ticket: create on an unknown board is rejected", argv: ["ticket", "create", "--title", "x", "--board", "nope"] },
  { name: "ticket: comment without an id prints usage", argv: ["ticket", "comment"] },
  { name: "ticket: state without args prints usage", argv: ["ticket", "state"] },
  { name: "ticket: restaff without an id prints usage", argv: ["ticket", "restaff"] },
  { name: "ticket: restaff with the daemon down fails on the bus", argv: ["ticket", "restaff", "OPS-1"] },
  { name: "ticket: courier without an id prints usage", argv: ["ticket", "courier"] },
  { name: "ticket: show without an id prints usage", argv: ["ticket", "show"] },
  { name: "ticket: unknown sub prints usage", argv: ["ticket", "bogus"] },

  // ── preset ──────────────────────────────────────────────────────────────────────────────
  { name: "preset: ls seeds and lists the presets file", argv: ["preset", "ls"] },
  { name: "preset: show without a name prints usage", argv: ["preset", "show"] },
  { name: "preset: show of an unknown preset fails", argv: ["preset", "show", "nope"] },
  { name: "preset: unknown sub prints usage", argv: ["preset", "bogus"] },

  // ── plan (full validation layer runs before any tracker call) ───────────────────────────
  { name: "plan: non-JSON stdin is rejected", argv: ["plan"], stdin: "not json" },
  { name: "plan: empty ticket list prints usage", argv: ["plan"], stdin: "{}" },
  { name: "plan: a ticket without a key is rejected", argv: ["plan"], stdin: '{"tickets":[{"title":"x"}]}' },
  { name: "plan: duplicate keys are rejected", argv: ["plan"], stdin: '{"tickets":[{"key":"a","title":"x"},{"key":"a","title":"y"}]}' },
  { name: "plan: a ticket without a title is rejected", argv: ["plan"], stdin: '{"tickets":[{"key":"a"}]}' },
  { name: "plan: an unknown needs edge is rejected", argv: ["plan"], stdin: '{"tickets":[{"key":"a","title":"x","needs":["z"]}]}' },
  { name: "plan: a self-dependency is rejected", argv: ["plan"], stdin: '{"tickets":[{"key":"a","title":"x","needs":["a"]}]}' },
  { name: "plan: a dependency cycle is rejected", argv: ["plan"], stdin: '{"tickets":[{"key":"a","title":"x","needs":["b"]},{"key":"b","title":"y","needs":["a"]}]}' },
  { name: "plan: an unknown board is rejected", argv: ["plan"], stdin: '{"board":"nope","tickets":[{"key":"a","title":"x"}]}' },
  { name: "plan: the restricted self-project is bounced", argv: ["plan"], stdin: '{"tickets":[{"key":"a","title":"x","project":"beckett"}]}' },
  { name: "plan: INT tickets without a channel are rejected", argv: ["plan"], stdin: '{"board":"int","tickets":[{"key":"a","title":"x"}]}' },

  // ── status / config ─────────────────────────────────────────────────────────────────────
  { name: "status: daemon down fails with the service hint", argv: ["status"] },
  { name: "config: print-default emits the full default TOML", argv: ["config", "print-default"] },
  { name: "config: bare prints usage", argv: ["config"] },

  // ── discord / proactivity / quick (control-bus commands with the daemon down) ───────────
  { name: "discord reply: daemon down fails on the bus", argv: ["discord", "reply", "--channel", "123", "hi"] },
  { name: "discord decline: daemon down fails on the bus", argv: ["discord", "decline"] },
  { name: "proactivity: status with the daemon down fails on the bus", argv: ["proactivity", "status"] },
  { name: "proactivity: set with bad args prints usage", argv: ["proactivity", "set", "123", "loud"] },
  { name: "proactivity: unknown sub prints usage", argv: ["proactivity", "bogus"] },
  { name: "quick: list with the daemon down fails on the bus", argv: ["quick", "list"] },
  { name: "quick: no agent/task prints usage", argv: ["quick"] },
  { name: "quick: agent without a task prints usage", argv: ["quick", "quick-code"] },

  // ── rpc / reload / persona ──────────────────────────────────────────────────────────────
  { name: "rpc: status writes the status file", argv: ["rpc", "status", "test details", "idle"] },
  { name: "rpc: bare prints usage", argv: ["rpc"] },
  { name: "reload: daemon down fails on the bus", argv: ["reload"] },
  { name: "persona: daemon down fails on the bus", argv: ["persona"] },
];

for (const c of CASES) {
  test(`cli: ${c.name}`, async () => {
    expect(await beckett(c.argv, { env: c.env, stdin: c.stdin })).toMatchSnapshot();
  });
}

// ── doctor: real host probes — characterize the shape, not the machine ───────────────────
// `beckett doctor` inspects THIS host (binaries, versions, auth artifacts), so its full
// output cannot be a byte-exact cross-machine snapshot. The contract we can pin: it runs,
// prints a report (or --json a JSON object with the report's top-level keys), and exits 0/1.
test("cli: doctor --json emits a report object and a 0/1 exit", async () => {
  const res = await beckett(["doctor", "--json"]);
  expect([0, 1]).toContain(res.exit);
  const report = JSON.parse(res.stdout);
  expect(typeof report.ok).toBe("boolean");
  expect(Array.isArray(report.checks)).toBeTrue();
}, 30_000);
