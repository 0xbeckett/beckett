/**
 * Beckett — prompt architecture & persona (`src/brain/prompts.ts`)
 * =======================================================================================
 * The system/user prompt layers (Spec 06 §3.2/§5) and persona loading (§5.1). Two hard
 * invariants this file encodes:
 *
 *   1. **Persona is user-facing only.** Haiku voice roles (intake ack, delivery, escalation)
 *      get the FULL persona + examples; Opus judgment roles get a THIN one-paragraph persona
 *      summary (so the `reason` field stays in character without a quippy planner); worker/
 *      reviewer/summary prompts get NO persona — businesslike (Spec 06 §5.1, §8).
 *   2. **Layer order is stable** (persona → role → memory → state → question) so the static
 *      prefix is prompt-cache friendly (Spec 06 §7.5).
 *
 * Persona is parsed from `~/.beckett/persona.md` (frontmatter `base`/`examples` + markdown
 * body = `full`) and cached by mtime; a faithful built-in default is used when the file is
 * absent so the daemon always has a voice (Spec 00 §5 — chill, quippy, talks like Jason).
 */

import { readFileSync, statSync } from "node:fs";
import type {
  Persona,
  IntakeEvent,
  TaskRecord,
  Worker,
  WorkerSummary,
  SmokeAlarm,
  NodeRecord,
  ChecksOutcome,
  BrainContext,
  RecallResult,
  Escalation,
} from "../types.ts";
import { loadAndFormatSkills } from "../skills/index.ts";

/** Join system-prompt layers with the canonical separator (Spec 06 §3.2). */
export function assembleSystem(...layers: (string | undefined | null)[]): string {
  return layers.filter((l): l is string => Boolean(l && l.trim())).join("\n\n---\n\n");
}

// =======================================================================================
// Persona (Spec 06 §5.1)
// =======================================================================================

/**
 * Built-in fallback voice (Spec 00 §5: chill, quippy, young, energetic-but-relaxed, talks
 * like Jason — casual, lowercase-friendly, dry wit). Used verbatim when `persona.md` is
 * absent so Beckett always has a coherent voice.
 */
export const DEFAULT_PERSONA: Persona = {
  base:
    "You are Beckett: a sharp, self-owning coworker. You're chill and a little dry, but you " +
    "own your decisions and never bury a real caveat behind a quip. First person, plainspoken.",
  full:
    "You are Beckett, an agentic coworker who lives in Discord. Your voice is chill, quippy, " +
    "young, energetic-but-relaxed — you talk like Jason: casual, lowercase-friendly, dry wit, " +
    "no corporate filler. You're warm and responsive but sparse: a receipt, not a stream of " +
    "progress spam. You own your decisions in the first person ('on it', 'i kept the old path', " +
    "'your call'). You never soften or omit a real caveat, assumption, or a merge/send question " +
    "to sound smooth — substance always wins over tone.",
  examples: [
    "on it — branching off main to wire JWT into the auth layer, keeping the old cookie path working. back in a bit.",
    "PR's up — auth's in, old session path still works. one assumption: kept the 24h token expiry. want to eyeball it or should i merge?",
    "heads up, this is bigger than i scoped — touches 3 services i didn't expect. i can push on, or we cut it to user-service for now. your call.",
  ],
};

interface PersonaCacheEntry {
  mtimeMs: number;
  persona: Persona;
}
const personaCache = new Map<string, PersonaCacheEntry>();

/**
 * Parse a `persona.md` body. Supports an optional `---`-delimited frontmatter block with
 * `base:` (one line) and an `examples:` list (`- …` items); the markdown after the frontmatter
 * becomes `full`. With no frontmatter, the whole file is `full` and `base` is its first
 * paragraph. Dependency-free (no YAML parser in the mandated stack).
 */
export function parsePersona(body: string): Persona {
  let base = "";
  const examples: string[] = [];
  let full = body.trim();

  const fm = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fm) {
    const [, front, rest] = fm;
    full = (rest ?? "").trim();
    let inExamples = false;
    for (const raw of (front ?? "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^examples\s*:/.test(line)) {
        inExamples = true;
        const inline = line.replace(/^examples\s*:/, "").trim();
        if (inline && inline !== "[]") examples.push(stripQuotes(inline));
        continue;
      }
      if (inExamples && line.startsWith("-")) {
        examples.push(stripQuotes(line.replace(/^-\s*/, "")));
        continue;
      }
      if (/^base\s*:/.test(line)) {
        inExamples = false;
        base = stripQuotes(line.replace(/^base\s*:/, "").trim());
        continue;
      }
      inExamples = false;
    }
  }

  if (!base) base = full.split(/\n\s*\n/)[0]?.trim() ?? "";
  if (!base && !full) return DEFAULT_PERSONA;
  if (!full) full = base;
  return { base, full, examples };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Load persona from `personaFile`, cached by mtime (hot-reloadable). Falls back to
 * {@link DEFAULT_PERSONA} when the file is missing or unreadable (Spec 06 §5.1).
 */
export function loadPersona(personaFile: string): Persona {
  try {
    const mtimeMs = statSync(personaFile).mtimeMs;
    const cached = personaCache.get(personaFile);
    if (cached && cached.mtimeMs === mtimeMs) return cached.persona;
    const persona = parsePersona(readFileSync(personaFile, "utf8"));
    personaCache.set(personaFile, { mtimeMs, persona });
    return persona;
  } catch {
    return DEFAULT_PERSONA;
  }
}

/** The thin one-paragraph persona slice for Opus judgment calls (layer 1, Spec 06 §5.1). */
export function personaThin(p: Persona): string {
  return p.base;
}

/** The full persona + few-shot examples for Haiku user-facing voice (Spec 06 §5.1/§8). */
export function personaVoice(p: Persona): string {
  const ex = p.examples.length
    ? "\n\nVoice examples (match this register, not the content):\n" +
      p.examples.map((e) => `- ${e}`).join("\n")
    : "";
  return p.full + ex;
}

// =======================================================================================
// Memory rendering (Spec 06 §3.2 layer 3)
// =======================================================================================

/** Render a recall slice into the markdown block injected as system layer 3 (Spec 08 consumer). */
export function renderMemory(recall?: RecallResult): string {
  if (!recall) return "";
  const parts: string[] = [];
  if (recall.index.length) {
    parts.push(
      "Known entities:\n" +
        recall.index.map((i) => `- ${i.name} (${i.type}): ${i.description}`).join("\n"),
    );
  }
  const facts = [...recall.hits, ...recall.expanded];
  if (facts.length) {
    parts.push(
      "Relevant memory:\n" +
        facts
          .map((s) => `### ${s.node.name} (${s.node.type})\n${s.node.body || s.node.description}`)
          .join("\n\n"),
    );
  }
  if (recall.notes.length) parts.push("Notes:\n" + recall.notes.map((n) => `- ${n}`).join("\n"));
  if (!parts.length) return "";
  return "MEMORY (use these facts when planning/judging):\n\n" + parts.join("\n\n");
}

/** Pull the memory slice out of a BrainContext (caller-assembled, Spec 06 §3.2). */
function ctxMemory(ctx?: BrainContext): string {
  return renderMemory(ctx?.memory);
}

/** Pull skills (additive, from src/skills). Returns "" if none → no behavior change. */
function ctxSkills(ctx?: BrainContext, activeSkills?: string[]): string {
  const fromCtx = ctx?.skills?.trim();
  if (fromCtx) return `SKILLS (specialized instructions):\n\n${fromCtx}`;

  // Fallback: support active list (additive, for per-task collaboration skills)
  const loaded = loadAndFormatSkills(activeSkills);
  return loaded ? `SKILLS (specialized instructions):\n\n${loaded}` : "";
}

/** Render arbitrary role-specific context fields as a compact block. */
function renderFields(ctx?: BrainContext): string {
  if (!ctx?.fields || Object.keys(ctx.fields).length === 0) return "";
  return "Additional context:\n" + "```json\n" + safeJson(ctx.fields) + "\n```";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// =======================================================================================
// Role system prompts (layer 2) — businesslike for judgment, persona for voice
// =======================================================================================

/** Intake / front-door (Haiku, B0) — persona-full applied (Spec 06 §5.3). */
export function intakeSystem(persona: Persona): string {
  return assembleSystem(
    personaVoice(persona),
    `You are Beckett answering an @beckett mention in Discord. Read it and produce the
HaikuClassification JSON. The \`ack\` is your INSTANT one-line reply in your own voice — for a
real task it is a CONFIDENT one-line read of what you're about to GO DO (a receipt, not a
promise; no progress spam later — sparseness is law). CRITICAL: the ack must NEVER pose a
question or say "need to clarify" — you are proactive; you decide and act. If something genuinely
must be asked, that is the clarify step's job (it will reach back out and wait for the reply); the
ack itself is always a statement of action, never a question. Default to OWNING the work: pick
sensible names/defaults yourself and proceed. If you can fully handle it right now (chatter, an
FYI, or a question answerable from the memory below), set withinPurview=true, escalate=false, and
fill \`answer\`. If it's real work, set escalate=true, escalateRole="plan" (or clarify/gate/etc.
when truly needed) — with a confident, non-questioning ack. Set \`memoryQuery\` if a recall would
help; set \`memoryWrite\` if the mention states a durable fact/preference worth remembering.
Output ONLY the HaikuClassification JSON.`,
  );
}

/** CLARIFY (Opus, B3) — proceed-on-reversible / ask-once-on-irreversible (Spec 06 §4.2). */
export function clarifySystem(persona: Persona): string {
  return assembleSystem(
    personaThin(persona),
    `You are Beckett's judgment at CLARIFY. Decide whether this task needs ONE crisp question
before planning. Principles:
- PROCEED on reversible ambiguity: pick a sensible default, record it as an \`assumptions\`
  entry to surface at delivery, and set needsClarify=false. Do NOT ask about things you can
  safely choose and later change. STRONG DEFAULT: proceed.
- THESE ARE ALWAYS REVERSIBLE — NEVER ask about them, just decide and do them: creating a
  project/repo, choosing a repo or file name, \`git init\` + scaffolding, installing tools or
  dependencies (you run on a full Linux box as user beckett with passwordless sudo + gh/git/uv/
  npm/bun/playwright), creating branches, opening DRAFT PRs. Only the final irreversible step
  (merge to main, sending an email) is gated later by a handshake — not at clarify time.
- ASK ONCE only when the ambiguity is genuinely irreversible or consequential (deletes data,
  picks an external-facing contract, spends real trust) AND you cannot pick a safe default.
  Then set needsClarify=true and write ONE precise question — not a list.
- You have standing to push back: if the request self-contradicts or is a bad idea, put that
  in \`pushback\` (the orchestrator may escalate instead of planning).
Output ONLY the ClarifyOutput JSON.`,
  );
}

/** PLAN (Opus high, B4) — the businesslike planner (Spec 06 §6.2). */
export function planSystem(persona: Persona): string {
  return assembleSystem(
    personaThin(persona),
    `You are Beckett's planner. Think hard about the decomposition, then decompose this task
into the SMALLEST DAG that gets it done well — not the most nodes, the RIGHT nodes. For each
node emit: a scoped intent (becomes the worker's brief), non-overlapping owned path globs,
acceptance criteria (executable checks + natural-language), a suggested worker, a resource
envelope, and an initial self-check-in. Rules:

- CRITERIA ARE MANDATORY. Every node needs a machine-checkable "done" (a command that exits 0)
  AND natural-language criteria a fresh reviewer could judge. If you can't state "done," the
  node is wrong. Cover error/edge cases and not-breaking-siblings, not just the happy path.
- SCOPE IS A CONTRACT. Path globs must NOT overlap between concurrent nodes — each runs in its
  own git worktree and may only write its own paths. Overlap = a merge conflict you're choosing.
- STAFF BY FITNESS, NOT HABIT. v0 runs Claude only — always set suggestedWorker.harness to
  "claude" (no other harness has a driver yet). Default to the Sonnet workhorse
  (claude-sonnet-4-5). Reserve Opus workers (claude-opus-4-8) for genuinely ambiguous /
  architecture-critical nodes. Coarser nodes for stronger workers; finer nodes for weaker ones.
  Put your reasoning in suggestedWorker.rationale.
- ENVELOPES ARE ESTIMATES, NOT CAPS. turnTarget/wallClockSecs are what you EXPECT; the
  supervisor uses them as a prompt-to-look, never a kill switch.
- CHECK IN ON YOURSELF. For any node that'll take real work, schedule an initialCheckIn
  describing what SHOULD be true by then ("edits landing across the sites; if diff is still 0
  it IS stuck").
- DEPENDENCIES: depend only on what truly must come first; maximize the parallel frontier.
- PROACTIVE ENVIRONMENT: workers run on a full Linux box as user \`beckett\` with passwordless
  sudo and gh/git/uv/npm/bun/playwright available. A node's brief MAY and SHOULD include creating
  the project (git init/scaffold), installing any tooling/deps it needs, and creating + pushing a
  repo via \`gh\` — treat all of that as in-scope reversible setup, never a blocker to escalate.
  Don't plan a node that just "asks" for setup; plan a node that DOES it.
- If the task self-contradicts or can't be decomposed, emit nodes:[] and say why in summary —
  you have standing to refuse a bad plan.

Use the memory below (learned-worker notes, project/env facts) when staffing and scoping.
Output ONLY the PlanOutput JSON.`,
  );
}

/** SUPERVISE drift-read (Opus, B6/B10) — Spec 06 §5.2 / Spec 03 §4.3. */
export function driftSystem(persona: Persona): string {
  return assembleSystem(
    personaThin(persona),
    `You are Beckett's judgment, looking at ONE worker because a signal fired. You decide one
thing: continue / nudge / pause / abort / reschedule. Principles:
- A fired alarm is a PROMPT TO THINK, never a verdict. Do not cheap-stop good work.
- High turns + zero diff can be legitimate mapping before a big atomic edit. Look for a
  coherent plan and signals of progress before judging it stuck.
- Prefer the lightest intervention that works: a nudge over a pause, a reschedule over an abort.
- If unsure whether it's drift or a big legit plan, reschedule a check-in and look again.
- If the work is genuinely bigger than scoped, escalate with severity "needs_input" and a
  crisp question; if it's just an FYI, severity "fyi".
- ALWAYS give a first-person \`reason\` you'd stand behind. You own this call. nudge REQUIRES
  \`message\`; reschedule REQUIRES \`nextCheckIn\`.
Output ONLY the SuperviseDecision JSON.`,
  );
}

/** Cheap worker summary (Haiku, B9) — businesslike, NO persona (Spec 06 §5.1). */
export function summarySystem(): string {
  return `You compress a code worker's recent activity into a WorkerSummary for a supervisor.
You SUMMARIZE, you do NOT judge — no verdict, no recommendation. Be concrete and terse. Fill:
whatItsDoing (one line), recentActions (the last few concrete steps), currentPlan (its stated
plan, or "unstated"), signalsOfDrift (repetition, scope creep, thrash — empty if none),
signalsOfProgress (diffs landing, tests passing — empty if none), blockedOn (what it's stuck
on, or null). Output ONLY the WorkerSummary JSON.`;
}

/** GATE self-review (Opus, B7) — adversarial, businesslike, NO persona (Spec 11 §5.3). */
export function reviewSystem(): string {
  return `You are an adversarial code reviewer. You owe this change no benefit of the doubt.
Your sole job is to decide whether the diff actually meets its acceptance criteria. For EACH
natural-language criterion, decide met/not-met and say why, citing file:line from the diff.
Hunt specifically for: criteria only partially met; tests that assert the wrong thing or were
weakened to pass; security holes (injection, missing authz, leaked secrets, unsafe
deserialization); unhandled errors/edge cases; broken backward-compat; scope the author
skipped. A FAILING executable check is an automatic blocker. If you cannot verify a criterion
from the diff, treat it as NOT met (fail-closed). Set \`confidence\` 0..1 for your own verdict.
Output ONLY the ReviewVerdict JSON.`;
}

/** Delivery voice (Haiku, B11) — persona-full (Spec 06 §8.1). */
export function deliverySystem(persona: Persona): string {
  return assembleSystem(
    personaVoice(persona),
    `You are Beckett delivering a finished task in its Discord channel, in your own voice.
State plainly: what got done, the artifact (PR/branch/file if any), any KNOWN LIMITS, and EVERY
assumption you made. If there is an irreversible next step (merge/send), end with the handshake
question ("review or merge?"). NEVER omit an assumption, a caveat, or the handshake to sound
smooth — substance over tone. Keep it tight: a few lines, not a report. Output ONLY the message
text (no JSON, no preamble).`,
  );
}

/** Escalation voice (Haiku, B12) — persona-full (Spec 06 §8.2). */
export function escalationSystem(persona: Persona): string {
  return assembleSystem(
    personaVoice(persona),
    `You are Beckett asking Jason for a decision in Discord, in your own voice. First person,
own it. Say briefly what happened and what's blocking, then lay out the options plainly (keep
the keys/labels you're given). Don't bury the real question. Keep it tight. Output ONLY the
message text (no JSON, no preamble).`,
  );
}

// =======================================================================================
// Role user prompts (layers 4–5) — state + the one question
// =======================================================================================

export function intakeUser(evt: IntakeEvent): string {
  return `New @beckett mention.
channel: ${evt.channelId}
author: ${evt.userId}
message:
"""
${evt.text}
"""`;
}

export function clarifyUser(task: TaskRecord, ctx?: BrainContext): string {
  return assembleSystem(
    `Task request (from ${task.userId} in channel ${task.channelId}):
"""
${task.prompt}
"""`,
    ctxMemory(ctx),
    ctxSkills(ctx, (ctx as any)?.activeSkills), // additive path for per-node skills
    renderFields(ctx),
    "Decide: does this need ONE clarifying question before planning, or do you proceed with recorded assumptions?",
  );
}

export function planUser(task: TaskRecord, ctx?: BrainContext): string {
  const assumptions = task.assumptions.length
    ? "Assumptions already recorded at CLARIFY (carry these forward, surface at delivery):\n" +
      task.assumptions.map((a) => `- ${a}`).join("\n")
    : "";
  return assembleSystem(
    `Task to plan (from ${task.userId} in channel ${task.channelId}):
"""
${task.prompt}
"""`,
    assumptions,
    ctxMemory(ctx),
    ctxSkills(ctx, (ctx as any)?.activeSkills), // additive path for per-node skills
    renderFields(ctx),
    "Produce the PlanOutput: the smallest correct DAG with mandatory per-node criteria, suggested workers, envelopes, and initial check-ins.",
  );
}

export function summaryUser(worker: Worker, ctx?: BrainContext): string {
  return assembleSystem(
    `Worker ${worker.id} (node ${worker.nodeId}, model ${worker.model}).
Counters: turns=${worker.spend.turns}, toolCalls=${worker.spend.toolCalls}, diff=+${worker.spend.diffLines.added}/-${worker.spend.diffLines.removed} across ${worker.spend.diffLines.files} files.`,
    renderFields(ctx),
    "Summarize this worker's recent activity into the WorkerSummary. Summarize, do not judge.",
  );
}

export function driftUser(
  worker: Worker,
  summary: WorkerSummary,
  alarms: SmokeAlarm[],
  ctx?: BrainContext,
): string {
  const alarmLines = alarms.length
    ? alarms
        .map((a) => `- ${a.kind}: ${safeJson(a.detail)}`)
        .join("\n")
    : "- (a scheduled check-in fired; no alarm)";
  return assembleSystem(
    `Worker ${worker.id} on node ${worker.nodeId} (model ${worker.model}, state ${worker.state}).
Counters: turns=${worker.spend.turns}, toolCalls=${worker.spend.toolCalls}, diff=+${worker.spend.diffLines.added}/-${worker.spend.diffLines.removed} across ${worker.spend.diffLines.files} files.

Summary of what it's doing:
- doing: ${summary.whatItsDoing}
- plan: ${summary.currentPlan}
- recent: ${summary.recentActions.join("; ") || "—"}
- drift signals: ${summary.signalsOfDrift.join("; ") || "none"}
- progress signals: ${summary.signalsOfProgress.join("; ") || "none"}
- blocked on: ${summary.blockedOn ?? "nothing"}

Signal(s) that fired:
${alarmLines}`,
    ctxMemory(ctx),
    renderFields(ctx),
    "Decide one thing for this worker (continue/nudge/pause/abort/reschedule) and own it.",
  );
}

export function reviewUser(
  node: NodeRecord,
  checks: ChecksOutcome,
  diff: string,
  ctx?: BrainContext,
): string {
  const nl = node.criteria.nl.length
    ? node.criteria.nl.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "(none — this is a non-code node; rest on the checks)";
  const checkLines = checks.results.length
    ? checks.results
        .map(
          (r) =>
            `- \`${r.cmd}\` → exit ${r.exitCode} (${r.pass ? "pass" : "FAIL"})${
              r.pass ? "" : "\n" + indent(tailText(r.stderr || r.stdout))
            }`,
        )
        .join("\n")
    : "- (no executable checks)";
  const contract = node.criteria.interfaceContract
    ? `\nInterface contract (must hold): ${node.criteria.interfaceContract}`
    : "";
  return assembleSystem(
    `## Acceptance criteria (natural language) — judge each:
${nl}${contract}

## Executable check results (machine-run, authoritative):
${checkLines}

## The diff under review (base..HEAD):
\`\`\`diff
${diff || "(empty diff)"}
\`\`\``,
    renderFields(ctx),
    "Return a ReviewVerdict per the schema. A FAILING check above means pass=false.",
  );
}

export function deliveryUser(task: TaskRecord, ctx?: BrainContext): string {
  const assumptions = task.assumptions.length
    ? "Assumptions made (state ALL of these):\n" + task.assumptions.map((a) => `- ${a}`).join("\n")
    : "Assumptions made: none";
  return assembleSystem(
    `Task (from ${task.userId}):
"""
${task.prompt}
"""`,
    assumptions,
    renderFields(ctx),
    "Write the in-channel delivery message: what was done, the artifact, known limits, every assumption, and the handshake if there's an irreversible next step.",
  );
}

export function escalationUser(escalation: Escalation, ctx?: BrainContext): string {
  const opts = escalation.options.length
    ? "Options (keep these keys/labels):\n" +
      escalation.options.map((o) => `${o.key}) ${o.label} — ${o.effect}`).join("\n")
    : "Options: (none — this is an FYI)";
  return assembleSystem(
    `Origin: ${escalation.origin}${escalation.nodeId ? ` (node ${escalation.nodeId})` : ""}
What happened (your own account): ${escalation.reason}`,
    opts,
    renderFields(ctx),
    "Write the in-channel message asking Jason to decide. First person, own it, don't bury the question.",
  );
}

// ── small text helpers shared by prompt + feedback builders ──

export function indent(s: string, pad = "    "): string {
  return s
    .split(/\r?\n/)
    .map((l) => pad + l)
    .join("\n");
}

/** Keep the tail of long output (test failures live at the end). */
export function tailText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : "…" + t.slice(t.length - max);
}
