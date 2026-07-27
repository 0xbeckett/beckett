/**
 * The overnight spike (issue #38): worktree + branch containment behind the REAL scope guard,
 * artifact-always, budget abandonment, morning proposal surfacing, and GC that keeps findings.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "../types.ts";
import { listProposals, readProposal, writeProposal } from "../proposal/store.ts";
import {
  SPIKE_BRANCH_PREFIX,
  SPIKE_DENIED_PERMISSIONS,
  SPIKE_TTL_DAYS,
  listSpikes,
  readSpike,
  runSpike,
  sweepSpikes,
  type SpikeHarnessCall,
  type SpikePlan,
} from "./spike.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-07-26T11:30:00.000Z");
const DATE = "2026-07-26";

function sh(args: string[], cwd: string): string {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A real target repo the spike worktree is cut from — with one commit on main. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "beckett-spike-repo-"));
  dirs.push(repo);
  sh(["git", "init", "-b", "main"], repo);
  sh(["git", "config", "user.email", "beckett@test"], repo);
  sh(["git", "config", "user.name", "Beckett"], repo);
  sh(["git", "config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "README.md"), "the project\n");
  sh(["git", "add", "-A"], repo);
  sh(["git", "commit", "-m", "init"], repo);
  return repo;
}

function world(): { spikesDir: string; proposalsDir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-spike-"));
  dirs.push(dir);
  return { spikesDir: join(dir, "dreams", "spikes"), proposalsDir: join(dir, "proposals"), repo: makeRepo() };
}

const PLAN: SpikePlan = {
  slug: "loop-pair-probe",
  pair: ["loop:alpha", "loop:beta"],
  question: "does alpha's ledger format already carry everything beta's report needs?",
  rationale: "both loops are secretly one rendering problem; a shared probe answers both at once",
  plan: "render alpha's ledger through beta's template and diff the output",
};

/** A harness that behaves: builds a tiny prototype and writes the FINDING.md it owes. */
const buildingHarness =
  (outputTokens = 900): SpikeHarnessCall =>
  async (_prompt, opts) => {
    writeFileSync(join(opts.cwd, "probe.ts"), "export const answer = 42;\n");
    writeFileSync(join(opts.cwd, "FINDING.md"), "Yes — the ledger carries everything; template needs one field.\n");
    return { text: "done, see FINDING.md", outputTokens };
  };

function depsFor(w: ReturnType<typeof world>, over: Partial<Parameters<typeof runSpike>[0]> = {}) {
  return {
    spikesDir: w.spikesDir,
    proposalsDir: w.proposalsDir,
    repoRoot: w.repo,
    logger: quiet,
    date: DATE,
    plan: PLAN,
    budget: 5_000,
    callHarness: buildingHarness(),
    now: () => NOW,
    ...over,
  };
}

test("a spike runs on its own branch in its own worktree, leaves an artifact + diff, and surfaces as a proposal", async () => {
  const w = world();
  const mainBefore = sh(["git", "rev-parse", "main"], w.repo).trim();

  const record = await runSpike(depsFor(w));

  expect(record.id).toBe(`spike-${DATE}-loop-pair-probe`);
  expect(record.status).toBe("done");
  expect(record.branch).toBe(`${SPIKE_BRANCH_PREFIX}${DATE}-loop-pair-probe`);
  expect(record.outputTokens).toBe(900);

  // The branch exists and holds the prototype; main NEVER moved — branch-only by construction.
  expect(sh(["git", "branch", "--list", record.branch], w.repo)).toContain(record.branch);
  expect(sh(["git", "rev-parse", "main"], w.repo).trim()).toBe(mainBefore);
  expect(sh(["git", "show", `${record.branch}:probe.ts`], w.repo)).toContain("answer = 42");

  // The lookable artifact lives OUTSIDE the worktree and quotes the worktree's FINDING.md.
  expect(record.findingPath).toBe(join(w.spikesDir, record.id, "finding.md"));
  const finding = readFileSync(record.findingPath, "utf8");
  expect(finding).toContain("the ledger carries everything");
  expect(finding).toContain("loop:alpha + loop:beta");
  expect(finding).toContain("never merged, never pushed");
  expect(readFileSync(record.diffPath!, "utf8")).toContain("probe.ts");

  // The morning surface: ONE open ticket-kind proposal in the #24.2 queue, artifact path attached.
  const open = listProposals(w.proposalsDir, { now: NOW });
  expect(open.length).toBe(1);
  expect(open[0]!.id).toBe(record.proposalId!);
  expect(open[0]!.kind).toBe("ticket");
  expect(open[0]!.claim).toContain(record.findingPath);
  expect(open[0]!.provenance).toEqual(["loop:alpha", "loop:beta"]);
  expect(open[0]!.origin).toBe(`dream:${DATE}`);
  expect(open[0]!.rationale).toContain(record.branch);

  // Readback round-trips.
  expect(readSpike(w.spikesDir, record.id)!.status).toBe("done");
  expect(listSpikes(w.spikesDir).map((s) => s.id)).toEqual([record.id]);
});

test("the wall is the EXISTING scope guard: the real hook denies a write outside the spike worktree", async () => {
  const w = world();
  const record = await runSpike(depsFor(w));

  // runSpike baked the guard into the settings file the harness is launched with.
  const settings = JSON.parse(readFileSync(join(w.spikesDir, record.id, "settings.json"), "utf8"));
  const hookCmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
  expect(hookCmd).toContain("scope-guard.ts");
  expect(hookCmd).toContain(record.worktree!);
  // Belt to the suspenders: the branch can never be pushed, GitHubbed, or deployed.
  expect(settings.permissions.deny).toEqual(SPIKE_DENIED_PERMISSIONS);

  // Run the ACTUAL hook script the settings point at, rooted at the spike worktree.
  const hook = join(import.meta.dir, "../hooks/scope-guard.ts");
  const decide = (filePath: string): Record<string, unknown> => {
    const r = Bun.spawnSync(["bun", hook, "--root", record.worktree!, "--owned", ""], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath }, cwd: record.worktree }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  };

  // Outside the worktree (the repo itself, the record dir, /tmp) → DENIED.
  for (const outside of [join(w.repo, "README.md"), join(w.spikesDir, record.id, "finding.md"), "/tmp/escape.txt"]) {
    const decision = decide(outside) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
  }
  // Inside the worktree → passes through to the normal permission flow.
  expect(decide(join(record.worktree!, "FINDING.md"))).toEqual({});
});

test("blowing the sub-budget abandons the spike with a note — but keeps the artifact and still surfaces it", async () => {
  const w = world();
  const record = await runSpike(depsFor(w, { budget: 500, callHarness: buildingHarness(9_999) }));

  expect(record.status).toBe("abandoned");
  expect(record.note).toContain("sub-budget");
  expect(record.outputTokens).toBe(9_999);
  expect(readFileSync(record.findingPath, "utf8")).toContain("status: abandoned");
  // An abandoned prototype is still evidence: the proposal carries the note forward.
  const proposal = readProposal(w.proposalsDir, record.proposalId!)!;
  expect(proposal.rationale).toContain("sub-budget");
});

test("a harness failure still leaves a record and a readable finding, and raises NO proposal", async () => {
  const w = world();
  const record = await runSpike(
    depsFor(w, {
      callHarness: async () => {
        throw new Error("harness exploded");
      },
    }),
  );

  expect(record.status).toBe("failed");
  expect(record.note).toContain("harness exploded");
  expect(readFileSync(record.findingPath, "utf8")).toContain("failed before producing a finding");
  expect(record.proposalId).toBeNull();
  expect(listProposals(w.proposalsDir, { now: NOW })).toEqual([]);
});

test("one spike per night: a second run for the same id refuses before touching git", async () => {
  const w = world();
  await runSpike(depsFor(w));
  await expect(runSpike(depsFor(w))).rejects.toThrow(/create-only|already exists/);
});

test("GC past the TTL drops worktree + branch but keeps the finding; accepted and fresh spikes are untouched", async () => {
  const w = world();
  const record = await runSpike(depsFor(w));
  const dir = join(w.spikesDir, record.id);

  // Age the record past the TTL by rewriting its create stamp (the only test-visible clock).
  const raw = JSON.parse(readFileSync(join(dir, "spike.json"), "utf8"));
  raw.created = new Date(NOW.getTime() - (SPIKE_TTL_DAYS + 1) * 86_400_000).toISOString();
  writeFileSync(join(dir, "spike.json"), JSON.stringify(raw, null, 2));

  // First: with its proposal ACCEPTED, the evidence branch is left alone.
  const accepted = { ...readProposal(w.proposalsDir, record.proposalId!)!, status: "accepted" as const, decided: NOW.toISOString(), became: "task:#9" };
  writeProposal(w.proposalsDir, accepted);
  expect(await sweepSpikes({ spikesDir: w.spikesDir, proposalsDir: w.proposalsDir, logger: quiet, now: NOW })).toEqual([]);
  expect(existsSync(record.worktree!)).toBe(true);

  // Then: undecided (back to open) → collected. Worktree and branch gone, finding intact.
  writeProposal(w.proposalsDir, { ...accepted, status: "open", decided: null, became: null });
  const collected = await sweepSpikes({ spikesDir: w.spikesDir, proposalsDir: w.proposalsDir, logger: quiet, now: NOW });
  expect(collected).toEqual([record.id]);
  expect(existsSync(record.worktree!)).toBe(false);
  expect(sh(["git", "branch", "--list", record.branch], w.repo).trim()).toBe("");
  expect(readFileSync(record.findingPath, "utf8")).toContain("the ledger carries everything");
  const after = readSpike(w.spikesDir, record.id)!;
  expect(after.status).toBe("gc");
  expect(after.worktree).toBeNull();
  expect(after.gcAt).toBe(NOW.toISOString());

  // Idempotent: a second sweep collects nothing.
  expect(await sweepSpikes({ spikesDir: w.spikesDir, proposalsDir: w.proposalsDir, logger: quiet, now: NOW })).toEqual([]);
});
