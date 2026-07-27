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
 *      and noted. Doctrine and persona have no write path here at all.
 *   2. **The budget is a ceiling, not a target.** Model OUTPUT tokens are summed across calls;
 *      before each call the remaining budget is checked, and tripping the ceiling stops the
 *      pass cleanly with a partial journal entry marked truncated — never a silent death. A
 *      quiet day short-circuits before the first model call and costs nothing.
 *
 * Disk-gentle: everything is assembled in memory; the journal entry is written exactly once at
 * the end (memory files are each their own single create — a namespace, not churn).
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Logger, Paths } from "../types.ts";
import { extractVerdictJson } from "../concierge/triage.ts";
import { childEnv } from "../env.ts";
import { createMemory, DREAM_NAME_RE, type MemoryStore } from "../memory/index.ts";
import { createChannelContextStore, type ChannelContextStore } from "../concierge/channel-context.ts";
import { assembleDreamInputs, type DreamInputs, type DreamSourceSection } from "./assemble.ts";
import { DREAM_TRUNCATED_LINE, dreamEntryPath, writeDreamEntry } from "./journal.ts";

/** The dream's home timezone — matches the builtin routine's fire window. */
export const DREAM_TZ = "America/Los_Angeles";

/** A section longer than this is condensed by its own (budget-counted) model call first. */
const CONDENSE_AT_CHARS = 12_000;
/** Most dream memories worth keeping per night; the rest is journal material. */
const MEMORIES_PER_NIGHT_MAX = 5;
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

    return finish(synthesisBody(synthesis), { truncated: remaining() <= 0 });
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

function synthesisBody(s: DreamSynthesis): string[] {
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
  ];
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
    '  "memories":       array (0–' + String(MEMORIES_PER_NIGHT_MAX) + " entries; most nights 0–2) of durable INFERENCES worth",
    "                    keeping beyond tonight. Each: {\"slug\": kebab-case, \"description\": one",
    "                    line, \"note\": short markdown body, \"provenance\": array of source ids",
    "                    FROM THE LIST BELOW that the inference is actually derived from}.",
    "",
    "Rules: these are inferences, not facts — do not state them as observations. Do not propose",
    "doctrine, persona, or memory edits; you cannot make them and this pass will refuse. A quiet",
    "day deserves a short entry, not padding.",
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
 */
const DREAM_DISALLOWED_TOOLS =
  "Bash,BashOutput,KillShell,Read,Glob,Grep,LS,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite";

/** The default model seam: a tool-less one-shot `claude -p`, usage read from its JSON result. */
export function defaultDreamModelCall(config: Config, logger: Logger): DreamModelCall {
  const bin = config.harness.claude.bin;
  const model = config.dream.model.trim() || config.concierge.model;
  // A scratch cwd (not the repo, not $HOME) so even an allowed relative read has nothing to see.
  const cwd = join(tmpdir(), "beckett-dream");
  return async (prompt: string): Promise<DreamModelResult> => {
    mkdirSync(cwd, { recursive: true });
    const proc = Bun.spawn(
      [bin, "-p", prompt, "--model", model, "--output-format", "json", "--disallowedTools", DREAM_DISALLOWED_TOOLS],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() },
    );
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
      return parseModelResult(stdout, logger);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Pull result text + output-token usage out of `--output-format json` stdout, defensively. */
export function parseModelResult(stdout: string, logger?: Logger): DreamModelResult {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const text = typeof parsed.result === "string" ? parsed.result : stdout.trim();
  const usage = (parsed.usage ?? null) as Record<string, unknown> | null;
  const reported = usage && typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  if (reported === null) {
    // No usage in the frame (older CLI) — estimate so the ceiling still means something.
    logger?.warn("dream: no output_tokens in model result; estimating from length");
    return { text, outputTokens: Math.ceil(text.length / 4) };
  }
  return { text, outputTokens: reported };
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
