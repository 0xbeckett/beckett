/**
 * Beckett — the overnight spike (`src/dream/spike.ts`)
 * =======================================================================================
 * The generative half of the dream engine (issue #38 / #24.3): when the nightly synthesis
 * pairs two open loops (or a loop and a recurring error) into one question worth asking in
 * code, this module builds a tiny prototype overnight to find out — inside the tightest walls
 * in the tree, because this is the only part of the machine that can produce something nobody
 * asked for. A spike is a QUESTION asked in code, not a contribution: its output is evidence
 * for a decision the owner makes awake, never work that lands because nobody stopped it.
 *
 * The walls, all structural:
 *
 *   - **One worktree, and it can write nowhere else.** The spike harness runs inside a fresh
 *     git worktree on its own `dream/spike/<date>-<slug>` branch, behind the SAME PreToolUse
 *     scope guard every worker runs behind ({@link ../hooks/scope-guard.ts}, root = the spike
 *     worktree). There is no second wall built here and no weakening of the first: if the
 *     guard gets in the way, the spike was too ambitious.
 *   - **Branch-only, forever.** This module has no merge verb, no push verb, no deploy verb —
 *     the same no-door-to-open design as the proposal store. The branch never enters the
 *     tracker, so no dispatcher path can ever integrate it or auto-close anything as done. The
 *     harness settings additionally DENY `git push` / `gh` / `beckett deploy` outright.
 *   - **A lookable artifact, always.** Every spike — done, over-budget, or failed — leaves a
 *     durable `finding.md` (plus `diff.patch` when there is a diff) OUTSIDE the worktree, in
 *     `<beckettDir>/dreams/spikes/<id>/`. The record dir survives garbage collection; the
 *     worktree and branch do not.
 *   - **A sub-budget, carved out of the nightly ceiling.** The caller passes the spike its
 *     token allowance; blowing it marks the spike `abandoned` with a note. The journal entry
 *     is never the thing sacrificed to a spike.
 *   - **The morning surface is the proposal queue (#24.2).** A finished spike files an inert
 *     `ticket`-kind proposal carrying the artifact path. Acting on it — filing real work,
 *     or rejecting it — is a waking decision walked through the queue's normal doors.
 *   - **GC keeps the learning, drops the branches.** {@link sweepSpikes} removes the worktree
 *     and branch of any spike past {@link SPIKE_TTL_DAYS} with no ACCEPTED proposal; the
 *     finding text stays. Thirty stale worktrees are not worth keeping; what was learned is.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import {
  commitWorktree,
  createWorktree,
  deleteBranch,
  headSha,
  readDiff,
  removeWorktree,
} from "../worker/worktree.ts";
import { scopeGuardSpec } from "../hooks/scope-guard.ts";
import { renderClaudeSettings } from "../hooks/registry.ts";
import { createProposal, readProposal } from "../proposal/store.ts";

/** Spike ids mirror the dream/proposal namespaces — also the record-dir traversal guard. */
export const SPIKE_ID_RE = /^spike-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** Every spike branch lives under this prefix; nothing else in the tree creates branches here. */
export const SPIKE_BRANCH_PREFIX = "dream/spike/";

/** Days a spike's worktree + branch survive without an ACCEPTED proposal before GC. */
export const SPIKE_TTL_DAYS = 30;

/** Turn cap on the spike harness — "tiny" is load-bearing; a spike is not an implementation. */
export const SPIKE_MAX_TURNS = 40;

/** Wall-clock cap on the spike harness run. */
export const SPIKE_TIMEOUT_MS = 20 * 60_000;

/** Tools the spike harness never gets: no subagents, no web — the question is asked in code. */
export const SPIKE_DISALLOWED_TOOLS = "Task,WebFetch,WebSearch";

/**
 * Permission rules baked into the spike's settings file, on top of the scope-guard hook: the
 * branch must never be pushed, never reach GitHub, never be deployed. Belt to the guard's
 * suspenders — the primary guarantee is that no code path here or downstream merges the branch.
 */
export const SPIKE_DENIED_PERMISSIONS = [
  "Bash(git push:*)",
  "Bash(gh:*)",
  "Bash(beckett gh:*)",
  "Bash(beckett deploy:*)",
  "Bash(beckett site:*)",
];

export const SPIKE_STATUSES = ["done", "abandoned", "failed", "gc"] as const;
export type SpikeStatus = (typeof SPIKE_STATUSES)[number];

/** The synthesis's validated pairing — selection happens in run.ts; this module only builds. */
export interface SpikePlan {
  slug: string;
  /** Exactly two source ids from tonight's assembly (`loop:*` / `calibration:*`). */
  pair: [string, string];
  /** The one question the prototype answers. */
  question: string;
  /** Why the combination is worth more than either loop alone — the load-bearing text. */
  rationale: string;
  /** A tiny plan; prose, not a spec. */
  plan: string;
}

/** The durable on-disk record (`<spikesDir>/<id>/spike.json`). Parsed field-by-field on read. */
export interface SpikeRecord {
  id: string;
  date: string;
  pair: string[];
  question: string;
  rationale: string;
  plan: string;
  repoRoot: string;
  branch: string;
  /** Worktree path while it exists; null once garbage-collected. */
  worktree: string | null;
  status: SpikeStatus;
  outputTokens: number;
  budget: number;
  /** The lookable artifact — survives GC. */
  findingPath: string;
  diffPath: string | null;
  proposalId: string | null;
  created: string;
  gcAt: string | null;
  note: string | null;
}

/** One harness turn-loop: prompt in, final text + output-token cost out. Injectable for tests. */
export type SpikeHarnessCall = (
  prompt: string,
  opts: { cwd: string; settingsPath: string },
) => Promise<{ text: string; outputTokens: number }>;

export interface SpikeRunDeps {
  /** `<beckettDir>/dreams/spikes`. */
  spikesDir: string;
  /** `<beckettDir>/proposals` — where the spike surfaces next morning (#24.2). */
  proposalsDir: string;
  /** The repo the throwaway worktree is cut from. */
  repoRoot: string;
  logger: Logger;
  /** The dream date (YYYY-MM-DD) — the spike belongs to that night's entry. */
  date: string;
  plan: SpikePlan;
  /** Output-token allowance, already carved out of the nightly ceiling by the caller. */
  budget: number;
  callHarness: SpikeHarnessCall;
  /** Defaults to the real hook script next to this module's compiled location. */
  scopeGuardScriptPath?: string;
  now?: () => Date;
}

// ── paths & reads ──────────────────────────────────────────────────────────────────────

/** The record dir for an id. Throws for anything that isn't a well-formed spike id. */
export function spikeDir(spikesDir: string, id: string): string {
  if (!SPIKE_ID_RE.test(id)) throw new Error(`spike: invalid id '${id}' (must be spike-YYYY-MM-DD-<kebab-slug>)`);
  return join(spikesDir, id);
}

/** One spike record by id, or null when there is no readable record. */
export function readSpike(spikesDir: string, id: string): SpikeRecord | null {
  const path = join(spikeDir(spikesDir, id), "spike.json");
  if (!existsSync(path)) return null;
  try {
    return asSpikeRecord(id, JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** Every readable spike record, newest date first. Malformed records are deliberately absent. */
export function listSpikes(spikesDir: string): SpikeRecord[] {
  if (!existsSync(spikesDir)) return [];
  const found: SpikeRecord[] = [];
  for (const name of readdirSync(spikesDir)) {
    if (!SPIKE_ID_RE.test(name)) continue;
    const record = readSpike(spikesDir, name);
    if (record) found.push(record);
  }
  return found.sort((a, b) => b.id.localeCompare(a.id));
}

// ── the run ────────────────────────────────────────────────────────────────────────────

/**
 * Build one overnight spike. Never lets a harness failure escape as a throw-without-artifact:
 * whatever happens, a record dir with a readable `finding.md` exists when this resolves. The
 * only throws are before any work starts (bad slug, or a record for this id already on disk —
 * one spike per night is create-only, like the journal entry itself).
 */
export async function runSpike(deps: SpikeRunDeps): Promise<SpikeRecord> {
  const { spikesDir, proposalsDir, repoRoot, logger, date, plan, budget } = deps;
  const now = deps.now?.() ?? new Date();
  const slug = normalizeSlug(plan.slug);
  const id = `spike-${date}-${slug}`;
  if (!slug || !SPIKE_ID_RE.test(id)) throw new Error(`spike: unusable slug '${plan.slug}'`);

  const dir = spikeDir(spikesDir, id);
  if (existsSync(dir)) {
    throw new Error(`spike: '${id}' already exists — at most one spike per night, and records are create-only`);
  }
  mkdirSync(dir, { recursive: true });

  const worktree = join(dir, "worktree");
  const branch = `${SPIKE_BRANCH_PREFIX}${date}-${slug}`;
  const record: SpikeRecord = {
    id,
    date,
    pair: [...plan.pair],
    question: plan.question.trim(),
    rationale: plan.rationale.trim(),
    plan: plan.plan.trim(),
    repoRoot,
    branch,
    worktree,
    status: "failed",
    outputTokens: 0,
    budget,
    findingPath: join(dir, "finding.md"),
    diffPath: null,
    proposalId: null,
    created: now.toISOString(),
    gcAt: null,
    note: null,
  };

  let finding = "";
  try {
    // The branch is cut from the repo's current HEAD; baseSha anchors the diff readout.
    const baseSha = await headSha(repoRoot);
    await createWorktree({ repoRoot, workspace: worktree, branch, baseRef: "HEAD" });

    // The wall: the EXISTING worker scope guard, rooted at THIS worktree (whole worktree
    // writable — owned globs empty). Delivered via `--settings` so nothing inside the worktree
    // (and therefore nothing on the branch/diff) carries harness scaffolding.
    const settingsPath = join(dir, "settings.json");
    const scopeGuardScript = deps.scopeGuardScriptPath ?? join(import.meta.dir, "../hooks/scope-guard.ts");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          ...renderClaudeSettings([scopeGuardSpec(scopeGuardScript, worktree, [])]),
          permissions: { deny: SPIKE_DENIED_PERMISSIONS },
        },
        null,
        2,
      ),
    );

    const result = await deps.callHarness(spikePrompt(record), { cwd: worktree, settingsPath });
    record.outputTokens = Math.max(0, Math.floor(result.outputTokens) || 0);

    // The artifact the harness owes: FINDING.md at the worktree root. Its absence degrades to
    // the harness's final text — a worse artifact, same honesty.
    finding = readWorktreeFinding(worktree) ?? result.text.trim();
    if (!finding) finding = "(the spike ran but wrote no finding and produced no final text)";

    if (record.outputTokens > budget) {
      record.status = "abandoned";
      record.note = `hit its ${budget}-output-token sub-budget (spent ${record.outputTokens}); kept as-is, unfinished`;
    } else {
      record.status = "done";
    }

    // Whatever exists lands on the spike branch — branch-only by construction: neither this
    // module nor anything downstream has a verb that merges, pushes, or deploys it.
    await commitWorktree(worktree, `dream spike ${id} (${record.status})`);
    const diff = (await readDiff(worktree, baseSha ?? undefined)).trim();
    if (diff) {
      record.diffPath = join(dir, "diff.patch");
      writeFileSync(record.diffPath, `${diff}\n`);
    }
  } catch (err) {
    record.status = "failed";
    record.note = `failed: ${String(err)}`;
    if (!finding) finding = `The spike failed before producing a finding.\n\nError: ${String(err)}`;
    logger.warn("spike: run failed", { id, error: String(err) });
  }

  // The durable artifact — written OUTSIDE the worktree so GC can never take it.
  writeFileSync(record.findingPath, findingDocument(record, finding));

  // Morning surfacing (#24.2): an inert queue record carrying the artifact path. A failed
  // spike is journal material, not a proposal — there is nothing lookable to decide on.
  if (record.status !== "failed") {
    try {
      const proposal = createProposal(proposalsDir, {
        kind: "ticket",
        claim: spikeClaim(record),
        rationale: [
          record.rationale,
          "",
          `artifact: ${record.findingPath}`,
          ...(record.diffPath ? [`diff: ${record.diffPath}`] : []),
          `branch: ${record.branch} (branch-only — never merged, never pushed, never deployed)`,
          ...(record.note ? [`note: ${record.note}`] : []),
        ].join("\n"),
        provenance: record.pair,
        origin: `dream:${date}`,
        now,
      });
      record.proposalId = proposal.id;
    } catch (err) {
      record.note = [record.note, `proposal not raised: ${(err as Error).message}`].filter(Boolean).join("; ");
      logger.warn("spike: proposal not raised", { id, error: String(err) });
    }
  }

  writeSpikeRecord(dir, record);
  logger.info("spike: finished", { id, status: record.status, outputTokens: record.outputTokens });
  return record;
}

// ── garbage collection ─────────────────────────────────────────────────────────────────

/**
 * Drop the worktree + branch of every spike past {@link SPIKE_TTL_DAYS} whose proposal was
 * never accepted; keep the finding. An accepted proposal means the learning graduated into
 * real work, so its evidence branch is left alone. Never throws — a broken record is skipped.
 */
export async function sweepSpikes(deps: {
  spikesDir: string;
  proposalsDir: string;
  logger: Logger;
  now?: Date;
}): Promise<string[]> {
  const now = deps.now ?? new Date();
  const collected: string[] = [];
  for (const record of listSpikes(deps.spikesDir)) {
    try {
      if (record.status === "gc") continue;
      const created = Date.parse(record.created);
      if (!Number.isFinite(created) || now.getTime() - created < SPIKE_TTL_DAYS * 86_400_000) continue;
      if (record.proposalId) {
        const proposal = readProposal(deps.proposalsDir, record.proposalId);
        if (proposal?.status === "accepted") continue;
      }
      if (record.worktree) await removeWorktree(record.repoRoot, record.worktree);
      await deleteBranch(record.repoRoot, record.branch);
      const settled: SpikeRecord = {
        ...record,
        status: "gc",
        worktree: null,
        gcAt: now.toISOString(),
        note: [record.note, "worktree and branch garbage-collected; finding kept"].filter(Boolean).join("; "),
      };
      writeSpikeRecord(spikeDir(deps.spikesDir, record.id), settled);
      collected.push(record.id);
    } catch (err) {
      deps.logger.warn("spike: gc failed for record", { id: record.id, error: String(err) });
    }
  }
  return collected;
}

// ── prompt & artifact rendering ────────────────────────────────────────────────────────

function spikePrompt(r: SpikeRecord): string {
  return [
    "You are Beckett, running a tiny overnight SPIKE — a question asked in code, not a",
    "contribution. Nobody asked for this prototype; it exists so a waking Beckett and the owner",
    "can look at evidence in the morning and decide. It will NEVER land.",
    "",
    `The question: ${r.question}`,
    `The two loops paired tonight: ${r.pair.join(" + ")}`,
    `Why together: ${r.rationale}`,
    ...(r.plan ? [`The (tiny) plan: ${r.plan}`] : []),
    "",
    "Hard rules:",
    "- Work ONLY inside this directory — it is a throwaway git worktree on its own branch, and a",
    "  hook denies every write outside it. If the wall gets in the way, the spike is too",
    "  ambitious: stop and write down why.",
    "- NEVER `git push`, never merge, never deploy, never file a ticket, never touch GitHub.",
    "  This branch is evidence; it is garbage-collected in 30 days either way.",
    "- Tiny is load-bearing. Build just enough to learn whether the combined idea holds, thrown",
    '  away without regret. If the honest finding is "yes, and it is a day of work", STOP —',
    "  that sentence plus the evidence IS the artifact.",
    "- The deliverable is FINDING.md at the worktree root: the question, what you built, what",
    '  you learned (a clear "no" is a good finding), and what you would propose a waking Beckett',
    "  do about it — a few short paragraphs. Write it early, update it as you go; code is",
    "  supporting evidence only.",
    "",
    `You have roughly a ${r.budget}-output-token allowance and ${SPIKE_MAX_TURNS} turns; running`,
    "dry mid-thought is normal for a spike, which is why FINDING.md comes first.",
  ].join("\n");
}

/** One line for the morning queue: the question, with the artifact path visibly attached. */
function spikeClaim(r: SpikeRecord): string {
  const suffix = ` — artifact: ${r.findingPath}`;
  const room = Math.max(20, 240 - suffix.length - "overnight spike: ".length);
  const q = r.question.length > room ? `${r.question.slice(0, room - 1)}…` : r.question;
  return `overnight spike: ${q}${suffix}`;
}

/** The durable finding.md: a self-contained document readable long after the branch is gone. */
function findingDocument(r: SpikeRecord, finding: string): string {
  return [
    `# overnight spike — ${r.id}`,
    "",
    "<!-- spike-meta",
    `status: ${r.status}`,
    `pair: ${r.pair.join(" + ")}`,
    `question: ${r.question}`,
    `branch: ${r.branch} (branch-only; never merged, never pushed, never deployed)`,
    `output_tokens: ${r.outputTokens} / ${r.budget}`,
    ...(r.note ? [`note: ${r.note}`] : []),
    "-->",
    "",
    "## why these two together",
    r.rationale,
    "",
    "## finding",
    finding.trim(),
    "",
  ].join("\n");
}

// ── parsing & small helpers ────────────────────────────────────────────────────────────

/** Rebuild a record from raw JSON, field by field — the same trust boundary the queue uses. */
export function asSpikeRecord(id: string, raw: unknown): SpikeRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id !== id || !SPIKE_ID_RE.test(id)) return null;
  const status = SPIKE_STATUSES.includes(r.status as SpikeStatus) ? (r.status as SpikeStatus) : null;
  const pair = Array.isArray(r.pair) ? r.pair.filter((p): p is string => typeof p === "string") : [];
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const opt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  if (!status || pair.length !== 2 || !str(r.date) || !str(r.branch) || !str(r.repoRoot) || !str(r.created)) {
    return null;
  }
  return {
    id,
    date: str(r.date),
    pair,
    question: str(r.question),
    rationale: str(r.rationale),
    plan: str(r.plan),
    repoRoot: str(r.repoRoot),
    branch: str(r.branch),
    worktree: opt(r.worktree),
    status,
    outputTokens: typeof r.outputTokens === "number" ? r.outputTokens : 0,
    budget: typeof r.budget === "number" ? r.budget : 0,
    findingPath: str(r.findingPath),
    diffPath: opt(r.diffPath),
    proposalId: opt(r.proposalId),
    created: str(r.created),
    gcAt: opt(r.gcAt),
    note: opt(r.note),
  };
}

function writeSpikeRecord(dir: string, record: SpikeRecord): void {
  const path = join(dir, "spike.json");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

function readWorktreeFinding(worktree: string): string | null {
  try {
    const raw = readFileSync(join(worktree, "FINDING.md"), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
