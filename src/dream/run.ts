/**
 * Beckett — the dream pass (`src/dream/run.ts`)
 * =======================================================================================
 * The nightly, budgeted, read-mostly replay of Beckett's own day (issue #36). Fired once per
 * night by the `nightly-dream` routine on the self lane's dispatch fork (see
 * {@link ../capability/modules/routines.ts}), run as its own `beckett dream run` process.
 *
 * The two properties everything here bends around, in order:
 *
 *   1. **A dream cannot launder an inference into a fact.** The reflection model never holds a
 *      tool: it reads ONE assembled document ({@link ./assemble.ts}, read-only, DM-free) and
 *      returns text. Every write the pass performs happens in THIS code, through two surfaces
 *      only — the dated journal entry ({@link ./journal.ts}) and create-only `dream`-namespace
 *      memories (`MemoryStore.rememberDream`, which forces `type: dream`/`inference: true`/a
 *      provenance list and refuses to touch any existing node). Proposed memories whose
 *      provenance names a source that was not actually assembled tonight are DROPPED, counted,
 *      and noted. Doctrine and persona have no write path here at all — the pass can only PROPOSE
 *      a change to them, as an inert record in the proposal queue ({@link ../proposal/store.ts},
 *      issue #37) that a waking session has to accept before anything moves.
 *   2. **The budget is a ceiling, not a target.** Model OUTPUT tokens are summed across calls;
 *      before each call the remaining budget is checked, and tripping the ceiling stops the
 *      pass cleanly with a partial journal entry marked truncated — never a silent death. A
 *      quiet day short-circuits before the first model call and costs nothing.
 *
 * The one generative exception is the overnight spike (issue #38, {@link ./spike.ts}): at most
 * ONE per night, only when the synthesis pairs two open loops with a written rationale, run in
 * a throwaway git worktree behind the worker scope guard, on a sub-budget carved out of the
 * same ceiling. Its branch is never merged and its output is a proposal + artifact — evidence
 * for a waking decision, never work that lands.
 *
 * Disk-gentle: everything is assembled in memory; the journal entry is written exactly once at
 * the end (memory files are each their own single create — a namespace, not churn).
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config, LaneHarness, Logger, Paths } from "../types.ts";
import { extractVerdictJson } from "../concierge/triage.ts";
import { buildLaneCommand, laneChildEnv, parseLaneOutput, resolveLaneSeat, warnLaneGaps } from "../drivers/lane.ts";
import { createMemory, DREAM_NAME_RE, type MemoryStore } from "../memory/index.ts";
import { createChannelContextStore, type ChannelContextStore } from "../concierge/channel-context.ts";
import { assembleDreamInputs, type DreamInputs, type DreamSourceSection } from "./assemble.ts";
import { DREAM_TRUNCATED_LINE, dreamEntryPath, writeDreamEntry } from "./journal.ts";
import { PROPOSAL_KINDS, createProposal, sweepExpiredProposals } from "../proposal/store.ts";
import {
  SPIKE_DISALLOWED_TOOLS,
  SPIKE_MAX_TURNS,
  SPIKE_TIMEOUT_MS,
  runSpike,
  sweepSpikes,
  type SpikeHarnessCall,
  type SpikeRecord,
} from "./spike.ts";

/** The dream's home timezone — matches the builtin routine's fire window. */
export const DREAM_TZ = "America/Los_Angeles";

/** A section longer than this is condensed by its own (budget-counted) model call first. */
const CONDENSE_AT_CHARS = 12_000;
/** Most dream memories worth keeping per night; the rest is journal material. */
const MEMORIES_PER_NIGHT_MAX = 5;
/** Most proposals raisable per night (issue #37). The queue is a gate, not an inbox. */
const PROPOSALS_PER_NIGHT_MAX = 3;
/** Wall-clock cap per model call — a wedged child must not hold the nightly pass forever. */
const MODEL_CALL_TIMEOUT_MS = 10 * 60_000;

export interface DreamModelResult {
  text: string;
  /** Output tokens this call cost (estimated from length when the harness reports none). */
  outputTokens: number;
}
/** The one model seam: prompt in, text + output-token cost out. No tools, ever. */
export type DreamModelCall = (prompt: string) => Promise<DreamModelResult>;

export interface DreamRunDeps {
  config: Config;
  paths: Paths;
  logger: Logger;
  now?: () => Date;
  /** Injectable for tests; default = the real memory graph at paths.memoryDir. */
  memory?: MemoryStore | null;
  /** Injectable for tests; default = the real channel store at paths.channelsDir. */
  channels?: ChannelContextStore | null;
  /** Injectable for tests; default = a tool-less one-shot `claude -p` spawn. */
  callModel?: DreamModelCall;
  /** Routine id for provenance in the entry header ("manual" when hand-run). */
  routineId?: string;
  /** Replace an existing entry for the date (manual re-runs only). */
  force?: boolean;
  /** Injectable for tests; default = a real one-shot `claude -p` INSIDE the spike worktree. */
  spikeHarness?: SpikeHarnessCall;
  /** Injectable for tests; default = the real {@link runSpike}. */
  runSpikeImpl?: typeof runSpike;
}

export interface DreamRunOutcome {
  date: string;
  path: string | null;
  wrote: boolean;
  /** True when the day was empty and the pass wrote a thin entry without any model call. */
  quiet: boolean;
  /** True when the pass hit the output-token ceiling and stopped with a partial entry. */
  truncated: boolean;
  outputTokens: number;
  budget: number;
  memoriesWritten: string[];
  /** Slugs dropped with the reason (bad provenance, over the cap, name collision…). */
  memoriesDropped: string[];
  /** Proposal ids raised tonight (issue #37) — records in the queue, never edits. */
  proposalsRaised: string[];
  /** Proposed changes refused before they became records, with the reason. */
  proposalsDropped: string[];
  /** Proposal ids the pass auto-expired on the way in (14 days undecided). */
  proposalsExpired: string[];
  /** Tonight's overnight spike record (issue #38), or null — null is the common case. */
  spike: SpikeRecord | null;
  /** Why there is no spike (or why it was dropped/abandoned before starting). */
  spikeNote: string | null;
  /** Spike ids whose worktree + branch were garbage-collected on the way in (findings kept). */
  spikesGced: string[];
  note: string | null;
}

/** What the synthesis call must return. Parsed strictly; one retry, then an honest fallback. */
const DreamSynthesisSchema = z.object({
  what_happened: z.string(),
  differently: z.string(),
  remember: z.string(),
  forget: z.string(),
  /** Two open loops that might combine into a small overnight spike (#24.3 consumes this). */
  combine: z.string().nullable().optional(),
  /**
   * The overnight spike (issue #38): at most ONE per night, and almost always null — the
   * schema holds a single object, not an array, so "one spike per night" is structural. The
   * pass validates the pair against tonight's real source ids before anything is built.
   */
  spike: z
    .object({
      slug: z.string(),
      pair: z.array(z.string()).length(2),
      question: z.string(),
      rationale: z.string(),
      plan: z.string().default(""),
    })
    .nullable()
    .optional(),
  memories: z
    .array(
      z.object({
        slug: z.string(),
        description: z.string(),
        note: z.string().optional(),
        provenance: z.array(z.string()).min(1),
      }),
    )
    .default([]),
  /**
   * Proposed changes to how I work (issue #37). These become RECORDS in the proposal queue —
   * the schema has no field for a file, a path, or a patch, because a dream cannot make a
   * change, only ask a waking session for one.
   */
  proposals: z
    .array(
      z.object({
        kind: z.enum(PROPOSAL_KINDS),
        claim: z.string(),
        rationale: z.string(),
        provenance: z.array(z.string()).min(1),
      }),
    )
    .default([]),
});
type DreamSynthesis = z.infer<typeof DreamSynthesisSchema>;

/** Run one nightly pass. Never throws for run-shaped failures — the journal entry is the report. */
export async function runDreamPass(deps: DreamRunDeps): Promise<DreamRunOutcome> {
  const { config, paths, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const date = localDate(now, DREAM_TZ);
  const budget = config.dream.output_token_budget;
  const routineId = deps.routineId ?? "manual";
  let spent = 0;

  const outcome: DreamRunOutcome = {
    date,
    path: null,
    wrote: false,
    quiet: false,
    truncated: false,
    outputTokens: 0,
    budget,
    memoriesWritten: [],
    memoriesDropped: [],
    proposalsRaised: [],
    proposalsDropped: [],
    proposalsExpired: [],
    spike: null,
    spikeNote: null,
    spikesGced: [],
    note: null,
  };

  // Exactly one entry per night: an existing entry ends the run before any read or model call.
  try {
    if (!deps.force) dreamEntryGuard(paths.dreamsDir, date);
  } catch (err) {
    outcome.note = (err as Error).message;
    logger.info("dream: skipped", { date, note: outcome.note });
    return outcome;
  }

  // The queue is swept on the way in, before anything is added to it: an undecided proposal is
  // expired with its claim intact rather than left to pile up into a backlog to feel guilty about.
  try {
    outcome.proposalsExpired = sweepExpiredProposals(paths.proposalsDir, now).map((p) => p.id);
  } catch (err) {
    logger.warn("dream: proposal expiry sweep failed", { error: String(err) });
  }

  // Spike GC rides the same way-in sweep (issue #38): worktrees + branches past their TTL with
  // no accepted proposal are dropped, findings kept. Thirty stale worktrees are not evidence.
  try {
    outcome.spikesGced = await sweepSpikes({
      spikesDir: paths.spikesDir,
      proposalsDir: paths.proposalsDir,
      logger,
      now,
    });
  } catch (err) {
    logger.warn("dream: spike gc sweep failed", { error: String(err) });
  }

  const memory = deps.memory !== undefined ? deps.memory : defaultMemory(paths, logger);
  const channels = deps.channels !== undefined ? deps.channels : defaultChannels(config, paths, logger);
  const callModel = deps.callModel ?? defaultDreamModelCall(config, logger);

  const inputs = assembleDreamInputs({
    journalDir: paths.journalDir,
    dispatchEventsPath: join(paths.eventsDir, "dispatch.jsonl"),
    memory,
    channels,
    logger,
    now: () => now,
  });

  const finish = (body: string[], opts: { truncated?: boolean; note?: string | null } = {}): DreamRunOutcome => {
    outcome.truncated = opts.truncated ?? outcome.truncated;
    outcome.note = opts.note ?? outcome.note;
    outcome.outputTokens = spent;
    const entry = composeEntry({
      date,
      routineId,
      inputs,
      spent,
      budget,
      truncated: outcome.truncated,
      memoriesWritten: outcome.memoriesWritten,
      memoriesDropped: outcome.memoriesDropped,
      proposalsRaised: outcome.proposalsRaised,
      proposalsDropped: outcome.proposalsDropped,
      proposalsExpired: outcome.proposalsExpired,
      spike: outcome.spike,
      spikeNote: outcome.spikeNote,
      spikesGced: outcome.spikesGced,
      body,
    });
    outcome.path = writeDreamEntry(paths.dreamsDir, date, entry, { force: deps.force });
    outcome.wrote = true;
    logger.info("dream: entry written", {
      date,
      truncated: outcome.truncated,
      quiet: outcome.quiet,
      outputTokens: spent,
      memories: outcome.memoriesWritten.length,
    });
    return outcome;
  };

  // The quiet-day short-circuit: prefer a thin honest entry over spending budget to pad one.
  if (inputs.empty) {
    outcome.quiet = true;
    return finish([
      "## what happened",
      "Nothing in the window — no worker journals, no ticket movement, no guild chatter, no ledger changes.",
      "",
      "## what i'd do differently",
      "Nothing to second-guess tonight.",
      "",
      "## worth remembering",
      "A quiet day is a quiet day; no inference worth keeping.",
      "",
      "## worth forgetting",
      "—",
    ]);
  }

  const remaining = () => budget - spent;
  const call = async (prompt: string): Promise<string> => {
    const r = await callModel(prompt);
    spent += Math.max(0, Math.floor(r.outputTokens) || 0);
    return r.text;
  };

  try {
    // 1. Condense any oversized section first (each its own counted call, ceiling-checked).
    for (const section of inputs.sections) {
      if (section.text.length <= CONDENSE_AT_CHARS) continue;
      if (remaining() <= 0) {
        return finish(truncatedBody(inputs, "the ceiling tripped while condensing the day's sections"), {
          truncated: true,
        });
      }
      try {
        section.text = (await call(condensePrompt(section))).trim();
      } catch (err) {
        // A failed condense keeps the (capped) raw text — worse prompt, same honesty.
        logger.warn("dream: condense failed; using raw section", { section: section.key, error: String(err) });
      }
    }

    // 2. The synthesis call — the dream itself.
    if (remaining() <= 0) {
      return finish(truncatedBody(inputs, "the ceiling tripped before synthesis"), { truncated: true });
    }
    let synthesis: DreamSynthesis | null = null;
    let raw = await call(synthesisPrompt(inputs, date));
    synthesis = parseSynthesis(raw);
    if (!synthesis && remaining() > 0) {
      raw = await call(
        `Your previous reply could not be parsed. Return ONLY the JSON object described before — no prose, no fences.\n\n${synthesisPrompt(inputs, date)}`,
      );
      synthesis = parseSynthesis(raw);
    }
    if (!synthesis) {
      return finish(
        [
          "## note to self",
          "Tonight's synthesis would not parse as the expected JSON twice. Keeping the raw text rather than fabricating structure:",
          "",
          "```",
          raw.trim().slice(0, 8_000),
          "```",
        ],
        { note: "synthesis unparseable; raw text kept", truncated: remaining() <= 0 },
      );
    }

    // 3. Memory writes — inference-only, create-only, provenance-checked against what was
    //    actually assembled. Everything else about the night lives in the journal entry.
    const known = new Set(inputs.sourceIds);
    const candidates = synthesis.memories.slice(0, MEMORIES_PER_NIGHT_MAX);
    for (const extra of synthesis.memories.slice(MEMORIES_PER_NIGHT_MAX)) {
      outcome.memoriesDropped.push(`${extra.slug} (over the ${MEMORIES_PER_NIGHT_MAX}-per-night cap)`);
    }
    for (const m of candidates) {
      const slug = m.slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const name = `dream-${date}-${slug}`;
      const unknown = m.provenance.filter((p) => !known.has(p.trim()));
      if (!slug || !DREAM_NAME_RE.test(name)) {
        outcome.memoriesDropped.push(`${m.slug} (unusable slug)`);
        continue;
      }
      if (unknown.length) {
        // Provenance must name REAL sources from tonight's assembly — an inference that cites
        // something that wasn't on the table is exactly the laundering this pass must refuse.
        outcome.memoriesDropped.push(`${slug} (provenance names unknown sources: ${unknown.join(", ")})`);
        continue;
      }
      if (!memory) {
        outcome.memoriesDropped.push(`${slug} (no memory store)`);
        continue;
      }
      try {
        await memory.rememberDream({
          name,
          description: m.description.trim(),
          body: (m.note ?? "").trim(),
          provenance: m.provenance.map((p) => p.trim()),
          reason: `nightly dream pass (${routineId})`,
        });
        outcome.memoriesWritten.push(name);
      } catch (err) {
        outcome.memoriesDropped.push(`${slug} (${(err as Error).message})`);
      }
    }

    // 4. Proposals (issue #37) — RECORDS in the queue, checked against the same provenance
    //    vocabulary as the memories. A proposal is the only way this pass can reach doctrine,
    //    persona, or an existing memory, and it reaches them by asking, not by writing.
    const wanted = synthesis.proposals.slice(0, PROPOSALS_PER_NIGHT_MAX);
    for (const extra of synthesis.proposals.slice(PROPOSALS_PER_NIGHT_MAX)) {
      outcome.proposalsDropped.push(`${extra.kind} (over the ${PROPOSALS_PER_NIGHT_MAX}-per-night cap)`);
    }
    for (const p of wanted) {
      const unknown = p.provenance.filter((s) => !known.has(s.trim()));
      if (unknown.length) {
        outcome.proposalsDropped.push(`${p.kind} (provenance names unknown sources: ${unknown.join(", ")})`);
        continue;
      }
      try {
        const record = createProposal(paths.proposalsDir, {
          kind: p.kind,
          claim: p.claim,
          rationale: p.rationale,
          provenance: p.provenance.map((s) => s.trim()),
          origin: `dream:${date}`,
          now,
        });
        outcome.proposalsRaised.push(record.id);
      } catch (err) {
        outcome.proposalsDropped.push(`${p.kind} (${(err as Error).message})`);
      }
    }

    // 5. The overnight spike (issue #38) — at most one, run LAST so the reflective outputs
    //    above are already secured, and gated on an explicit rationale plus a real pair. Most
    //    nights `spike` is null, and that is the system working: not spiking must stay cheap.
    const plan = synthesis.spike ?? null;
    if (!plan) {
      outcome.spikeNote = "no pairing worth a spike tonight";
    } else {
      const dropReason = spikePlanProblem(plan, known);
      if (dropReason) {
        outcome.spikeNote = `spike dropped: ${dropReason}`;
      } else if (remaining() <= 0) {
        // The ceiling was already spent on reflection: abandon the spike, never the journal.
        outcome.spikeNote = "spike abandoned before start: the nightly ceiling was already spent";
      } else {
        // The sub-budget is carved OUT of the nightly ceiling — never in addition to it.
        const spikeBudget = Math.min(config.dream.spike_output_token_budget, remaining());
        try {
          const impl = deps.runSpikeImpl ?? runSpike;
          const record = await impl({
            spikesDir: paths.spikesDir,
            proposalsDir: paths.proposalsDir,
            repoRoot: spikeRepoRoot(config, paths),
            logger,
            date,
            plan: {
              slug: plan.slug,
              pair: [plan.pair[0]!.trim(), plan.pair[1]!.trim()],
              question: plan.question,
              rationale: plan.rationale,
              plan: plan.plan,
            },
            budget: spikeBudget,
            callHarness: deps.spikeHarness ?? defaultSpikeHarnessCall(config, logger),
            now: () => now,
          });
          spent += Math.max(0, Math.floor(record.outputTokens) || 0);
          outcome.spike = record;
        } catch (err) {
          outcome.spikeNote = `spike failed before it could leave a record: ${String(err)}`;
          logger.warn("dream: spike failed", { date, error: String(err) });
        }
      }
    }

    return finish(synthesisBody(synthesis, outcome), { truncated: remaining() <= 0 });
  } catch (err) {
    // "Rather than dying silently": a model/system failure still leaves a dated, honest entry.
    logger.warn("dream: pass failed mid-run", { date, error: String(err) });
    return finish(
      ["## note to self", `The pass failed mid-run: ${String(err)}. Inputs were assembled; no synthesis tonight.`],
      { note: `failed: ${String(err)}`, truncated: remaining() <= 0 },
    );
  }
}

// ── entry composition ──────────────────────────────────────────────────────────────────

interface ComposeInput {
  date: string;
  routineId: string;
  inputs: DreamInputs;
  spent: number;
  budget: number;
  truncated: boolean;
  memoriesWritten: string[];
  memoriesDropped: string[];
  proposalsRaised: string[];
  proposalsDropped: string[];
  proposalsExpired: string[];
  spike: SpikeRecord | null;
  spikeNote: string | null;
  spikesGced: string[];
  body: string[];
}

function composeEntry(c: ComposeInput): string {
  const lines = [
    `# dream — ${c.date}`,
    "",
    "<!-- dream-meta",
    `routine: ${c.routineId}`,
    `window: ${c.inputs.fromIso} .. ${c.inputs.toIso}`,
    `output_tokens: ${c.spent} / ${c.budget}`,
    c.truncated ? DREAM_TRUNCATED_LINE : "truncated: false",
    `sources: ${c.inputs.sourceIds.join(", ") || "(none)"}`,
    `memories: ${c.memoriesWritten.join(", ") || "(none)"}`,
    ...(c.memoriesDropped.length ? [`memories_dropped: ${c.memoriesDropped.join("; ")}`] : []),
    `proposals: ${c.proposalsRaised.join(", ") || "(none)"}`,
    ...(c.proposalsDropped.length ? [`proposals_dropped: ${c.proposalsDropped.join("; ")}`] : []),
    ...(c.proposalsExpired.length ? [`proposals_expired: ${c.proposalsExpired.join(", ")}`] : []),
    c.spike
      ? `spike: ${c.spike.id} [${c.spike.status}] artifact: ${c.spike.findingPath}`
      : `spike: (none${c.spikeNote ? ` — ${c.spikeNote}` : ""})`,
    ...(c.spikesGced.length ? [`spikes_gced: ${c.spikesGced.join(", ")}`] : []),
    ...(c.inputs.notes.length ? [`notes: ${c.inputs.notes.join("; ")}`] : []),
    "-->",
    "",
    ...c.body,
    "",
  ];
  if (c.truncated) {
    lines.push(
      "",
      `> ⚠ truncated: this pass hit its ${c.budget}-output-token ceiling and stopped cleanly. Partial entry; nothing was padded to fill it.`,
    );
  }
  return lines.join("\n");
}

function synthesisBody(s: DreamSynthesis, outcome: DreamRunOutcome): string[] {
  return [
    "## what happened",
    s.what_happened.trim() || "—",
    "",
    "## what i'd do differently",
    s.differently.trim() || "—",
    "",
    "## worth remembering",
    s.remember.trim() || "—",
    "",
    "## worth forgetting",
    s.forget.trim() || "—",
    ...(s.combine?.trim() ? ["", "## loops that might combine", s.combine.trim()] : []),
    "",
    "## overnight spike",
    ...spikeBody(outcome),
  ];
}

/**
 * The journal's spike section (issue #38). The common case — no spike — is ONE line; the walls
 * only earn their tokens on a night something was actually built.
 */
function spikeBody(outcome: DreamRunOutcome): string[] {
  const spike = outcome.spike;
  if (!spike) return [`No spike tonight — ${outcome.spikeNote ?? "nothing paired"}.`];
  return [
    `${spike.id} [${spike.status}] — ${spike.pair.join(" + ")}`,
    `- question: ${spike.question}`,
    `- why together: ${spike.rationale}`,
    `- artifact: ${spike.findingPath}${spike.diffPath ? ` (diff: ${spike.diffPath})` : ""}`,
    `- branch: ${spike.branch} — branch-only; never merged, never pushed, never deployed`,
    spike.proposalId
      ? `- morning decision: proposal ${spike.proposalId} in the queue`
      : `- no proposal raised${spike.note ? ` (${spike.note})` : ""}`,
    ...(spike.proposalId && spike.note ? [`- note: ${spike.note}`] : []),
  ];
}

/**
 * Why a proposed pairing cannot run, or null when it is sound. The bar is explicit: two REAL,
 * DISTINCT sources from tonight's assembly, each an open loop or a calibration/recurring-error
 * record, at least one a loop — plus a written question and rationale. Anything else is a
 * one-line drop, because not spiking must be cheap and unembarrassing.
 */
export function spikePlanProblem(
  plan: { slug: string; pair: string[]; question: string; rationale: string },
  known: Set<string>,
): string | null {
  const pair = plan.pair.map((p) => p.trim());
  if (pair.length !== 2 || pair[0] === pair[1]) return "the pair must be two DISTINCT sources";
  const unknown = pair.filter((p) => !known.has(p));
  if (unknown.length) return `pair names unknown sources: ${unknown.join(", ")}`;
  if (!pair.every((p) => /^(loop|calibration):/.test(p))) {
    return "the pair must be open loops or calibration records (loop:* / calibration:*)";
  }
  if (!pair.some((p) => p.startsWith("loop:"))) return "at least one side must be an open loop";
  if (!plan.question.trim()) return "a spike needs the one question it answers";
  if (!plan.rationale.trim()) return "a spike needs a written rationale for why the pairing beats either loop alone";
  return null;
}

/** The repo a spike worktree is cut from: config override, else Beckett's own checkout. */
function spikeRepoRoot(config: Config, paths: Paths): string {
  return config.dream.spike_repo.trim() || join(paths.projects, "beckett");
}

function truncatedBody(inputs: DreamInputs, why: string): string[] {
  return [
    "## note to self",
    `Stopped early: ${why}.`,
    "",
    "What was on the table tonight, unreflected:",
    ...inputs.sections.filter((s) => s.text.trim()).map((s) => `- ${s.title} (${s.sourceIds.length} sources)`),
  ];
}

// ── prompts ────────────────────────────────────────────────────────────────────────────

function condensePrompt(section: DreamSourceSection): string {
  return [
    "You are Beckett, condensing one section of your own day's record for a private nightly review.",
    "Condense the section below to at most 40 lines. Keep concrete identifiers exactly as written",
    "(ticket refs, `journal:`/`loop:`/`channel:`/`calibration:`/`ticket:` ids), keep failures and",
    "surprises, drop routine noise. Output the condensed section only — no preamble.",
    "",
    `## ${section.title}`,
    section.text,
  ].join("\n");
}

function synthesisPrompt(inputs: DreamInputs, date: string): string {
  const sections = inputs.sections
    .filter((s) => s.text.trim())
    .map((s) => `## ${s.title}\n${s.text}`)
    .join("\n\n");
  return [
    `You are Beckett, replaying your own day (${date}) in a private nightly dream pass. This is`,
    "notes-to-self, not a report — nobody else reads it. Be terse, honest, and concrete.",
    "",
    "Everything you may consider is below; you have no tools and must not invent events. Every",
    "source has a stable id (journal:…, ticket:…, loop:…, calibration:…, channel:…).",
    "",
    "Return ONLY a JSON object (no fences, no prose) with these keys:",
    '  "what_happened":  markdown — the day in a few tight lines',
    '  "differently":    markdown — what you would do differently, if anything',
    '  "remember":       markdown — what is worth remembering',
    '  "forget":         markdown — what is worth letting go of',
    '  "combine":        markdown or null — ONLY if two OPEN LOOPS genuinely combine into one',
    "                    small overnight spike worth proposing; name both loop ids; else null",
    '  "spike":          object or null — ALMOST ALWAYS null; a spike every night is a bug.',
    "                    Only when two open loops (or a loop and a recurring error) combine into",
    "                    ONE tiny overnight prototype that teaches something NEITHER loop does",
    '                    alone: {"slug": kebab-case, "pair": [exactly two ids from the list',
    '                    below, loop:* or calibration:*, at least one loop], "question": the one',
    '                    question the prototype answers, "rationale": why the combination is',
    '                    worth more than either alone, "plan": 2-4 lines, tiny}. The prototype',
    "                    is branch-only evidence for a waking decision — never a contribution;",
    '                    if the idea needs a day of work, say so in "combine" and leave this null.',
    '  "memories":       array (0–' + String(MEMORIES_PER_NIGHT_MAX) + " entries; most nights 0–2) of durable INFERENCES worth",
    "                    keeping beyond tonight. Each: {\"slug\": kebab-case, \"description\": one",
    "                    line, \"note\": short markdown body, \"provenance\": array of source ids",
    "                    FROM THE LIST BELOW that the inference is actually derived from}.",
    '  "proposals":      array (0–' + String(PROPOSALS_PER_NIGHT_MAX) + " entries; most nights 0) of changes to how you WORK that",
    "                    tonight actually earned. Each: {\"kind\": one of " + PROPOSAL_KINDS.join("|") + ",",
    "                    \"claim\": ONE line stating the change, \"rationale\": why, \"provenance\":",
    "                    array of source ids FROM THE LIST BELOW}.",
    "",
    "Rules: these are inferences, not facts — do not state them as observations. You cannot EDIT",
    "doctrine, persona, or any memory — not tonight, not ever; a proposal is the only door, and a",
    "waking session decides it. Do not describe a file, a path, or a patch: state the claim. A",
    "quiet day deserves a short entry, not padding, and no proposals at all.",
    "",
    `Valid provenance ids: ${inputs.sourceIds.join(", ") || "(none)"}`,
    ...(inputs.notes.length ? ["", `Assembly caveats: ${inputs.notes.join("; ")}`] : []),
    "",
    "# the day",
    "",
    sections,
  ].join("\n");
}

function parseSynthesis(raw: string): DreamSynthesis | null {
  try {
    const parsed = JSON.parse(extractVerdictJson(raw));
    const checked = DreamSynthesisSchema.safeParse(parsed);
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}

// ── default dependencies ───────────────────────────────────────────────────────────────

function dreamEntryGuard(dreamsDir: string, date: string): void {
  // The same existence refusal writeDreamEntry enforces, probed up front so an already-dreamt
  // night ends the run before any read or model call.
  const path = dreamEntryPath(dreamsDir, date);
  if (existsSync(path)) {
    throw new Error(`dream: entry for ${date} already exists (${path}); re-run with --force to replace it`);
  }
}

function defaultMemory(paths: Paths, logger: Logger): MemoryStore | null {
  try {
    return createMemory({ memoryDir: paths.memoryDir, logger: logger.child("memory") });
  } catch (err) {
    logger.warn("dream: memory store unavailable", { error: String(err) });
    return null;
  }
}

function defaultChannels(config: Config, paths: Paths, logger: Logger): ChannelContextStore | null {
  try {
    return createChannelContextStore({
      channelsDir: paths.channelsDir,
      maxEntriesPerChannel: config.shared_context.max_entries_per_channel,
      maxAgeHours: config.shared_context.max_age_hours,
      logger: logger.child("channels"),
    });
  } catch (err) {
    logger.warn("dream: channel store unavailable", { error: String(err) });
    return null;
  }
}

/**
 * Tools the one-shot reflection child is explicitly denied. The containment does NOT rest on
 * this list (the write path is this process's code, not the child's hands) — it exists so the
 * dream model cannot even READ outside its assembled input: no shell, no filesystem, no web.
 *
 * This is the CLAUDE spelling of "no tools" (claude has no single switch for it). pi says the
 * same thing in one flag, `--no-tools`, which the lane seam emits instead — a stronger guarantee,
 * since it also covers tools this list was never updated to name.
 */
const DREAM_DISALLOWED_TOOLS =
  "Bash,BashOutput,KillShell,Read,Glob,Grep,LS,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite";

/**
 * The default model seam: a tool-less one-shot harness run, usage read from its result frames.
 *
 * pi by default since #125; `[harness.lanes.dream] harness = "claude"` pins it back, in which
 * case the model falls back to this lane's historical key (`dream.model` else `concierge.model`)
 * so the pinned behavior is exactly the pre-#125 one.
 */
export function defaultDreamModelCall(config: Config, logger: Logger): DreamModelCall {
  const seat = resolveLaneSeat(config, "dream", {
    claudeModel: config.dream.model.trim() || config.concierge.model,
  });
  // A scratch cwd (not the repo, not $HOME) so even an allowed relative read has nothing to see.
  const cwd = join(tmpdir(), "beckett-dream");
  return async (prompt: string): Promise<DreamModelResult> => {
    mkdirSync(cwd, { recursive: true });
    const command = buildLaneCommand(config, seat, {
      prompt,
      output: "json",
      noTools: true,
      disallowedTools: DREAM_DISALLOWED_TOOLS.split(","),
    });
    warnLaneGaps(logger, command);
    const proc = Bun.spawn([command.bin, ...command.args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: laneChildEnv(),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, MODEL_CALL_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (timedOut) throw new Error(`dream model call timed out after ${MODEL_CALL_TIMEOUT_MS / 60_000}m`);
      if (code !== 0) throw new Error(`dream model call exited ${code}: ${stderr.trim().slice(0, 400)}`);
      return parseModelResult(stdout, logger, seat.harness);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The default spike harness (issue #38): ONE one-shot run INSIDE the spike worktree — the only
 * dream-engine child that holds tools. Turn-capped where the harness supports it, wall-clock
 * capped always, and its output tokens are read from the result frames so the pass can charge
 * them against the nightly ceiling.
 *
 * CONTAINMENT, and what moving to pi (#125) costs. The spike's walls are, in order: (1) it runs
 * in a THROWAWAY git worktree on a `dream/spike/*` branch that no code path in the tree merges,
 * pushes, or hands to the tracker; (2) `runSpike` bakes a settings file carrying the worker scope
 * guard plus explicit deny rules for push/gh/deploy; (3) a tool denylist; (4) a turn cap.
 *
 * Walls (1) and (3) hold on both harnesses. Walls (2) and (4) are claude-only: pi has no
 * settings-file hook and no `--max-turns` (see `LANE_GAPS` in `src/drivers/lane.ts`). Under pi the
 * lane seam reports both as unsupported and {@link warnLaneGaps} logs them by name on every spike,
 * so this is a stated cost rather than a silent one — and the same trade the ticket workers have
 * already been running under since #121, since `PiDriver` ignores `SpawnSpec.settingsPath` too.
 * The named fix is a pi extension hooking `tool_call` to re-implement the scope guard and count
 * turns; that is its own branch, not this one. Pin the lane with
 * `[harness.lanes.dream_spike] harness = "claude"` to get walls (2) and (4) back today.
 */
export function defaultSpikeHarnessCall(config: Config, logger: Logger): SpikeHarnessCall {
  const seat = resolveLaneSeat(config, "dream_spike", {
    claudeModel: config.dream.model.trim() || config.concierge.model,
  });
  return async (prompt, opts) => {
    const command = buildLaneCommand(config, seat, {
      prompt,
      output: "json",
      unattended: true,
      settingsPath: opts.settingsPath,
      maxTurns: SPIKE_MAX_TURNS,
      disallowedTools: SPIKE_DISALLOWED_TOOLS.split(","),
    });
    warnLaneGaps(logger, command, { cwd: opts.cwd });
    const proc = Bun.spawn([command.bin, ...command.args], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: laneChildEnv(),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, SPIKE_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (timedOut) throw new Error(`spike harness timed out after ${SPIKE_TIMEOUT_MS / 60_000}m`);
      if (code !== 0) throw new Error(`spike harness exited ${code}: ${stderr.trim().slice(0, 400)}`);
      return parseModelResult(stdout, logger, seat.harness);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Pull result text + output-token usage out of a finished lane process's stdout, defensively.
 * The per-harness frame shapes live in {@link parseLaneOutput}; what's left here is the dream's
 * own policy — a harness that reported no usage still has to cost something against the ceiling,
 * so its output is estimated from length rather than counted as free.
 */
export function parseModelResult(
  stdout: string,
  logger?: Logger,
  harness: LaneHarness = "claude",
): DreamModelResult {
  const parsed = parseLaneOutput(harness, "json", stdout);
  if (parsed.error) throw new Error(`dream model call failed: ${parsed.error.slice(0, 400)}`);
  const text = parsed.text;
  if (parsed.outputTokens === null) {
    // No usage in the frames (an older CLI, or a run that died mid-turn) — estimate so the
    // ceiling still means something.
    logger?.warn("dream: no output tokens in model result; estimating from length", { harness });
    return { text, outputTokens: Math.ceil(text.length / 4) };
  }
  return { text, outputTokens: parsed.outputTokens };
}

/** Wall-clock local date (YYYY-MM-DD) in a tz — the entry's name and the memories' date stamp. */
export function localDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
