/**
 * Beckett — INTAKE / front door (`src/brain/intake.ts`)
 * =======================================================================================
 * The Haiku front door (Spec 06 §1). Every @beckett mention hits here first: classify it,
 * write the honest one-line ack in persona voice, and either answer it (chatter/FYI/recall)
 * or set the escalate flag so the orchestrator wakes Opus (Spec 06 §1.2). This is the only
 * brain step with no upstream context — it owns persona loading itself.
 *
 * No-silent-failure (Spec 06 §1.3): if the call or its schema fails entirely, we DEGRADE to
 * `{kind:"task", escalate:true, escalateRole:"decide"}` with a safe ack — a mention is never
 * dropped.
 */

import { z } from "zod";
import type { IntakeEvent, HaikuClassification, Persona } from "../types.ts";
import { callJSON, BrainCallError, type RoleDeps } from "./llm.ts";
import { intakeSystem, intakeUser } from "./prompts.ts";

/** The literal `--json-schema` payload for the front-door call (Spec 06 §1.3). */
export const HAIKU_CLASSIFICATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "withinPurview", "escalate", "ack"],
  properties: {
    kind: { enum: ["task", "question", "chatter", "fyi"] },
    withinPurview: {
      type: "boolean",
      description: "true iff Beckett can fully and safely resolve this now",
    },
    escalate: { type: "boolean" },
    escalateRole: { enum: ["clarify", "plan", "staff", "gate", "integrate", "decide"] },
    ack: {
      type: "string",
      minLength: 1,
      description: "the instant one-line reply in Beckett's voice; for a task, the honest one-line read",
    },
    answer: {
      type: "string",
      description: "present iff withinPurview && !escalate — the full conversational/recall reply",
    },
    memoryQuery: {
      type: "string",
      description: "optional recall query to enrich the escalated Opus call",
    },
    memoryWrite: { type: "string", description: "optional durable fact worth persisting" },
  },
};

const Classification = z.object({
  kind: z.enum(["task", "question", "chatter", "fyi"]),
  withinPurview: z.boolean(),
  escalate: z.boolean(),
  escalateRole: z.enum(["clarify", "plan", "staff", "gate", "integrate", "decide"]).optional(),
  ack: z.string().min(1),
  answer: z.string().optional(),
  memoryQuery: z.string().optional(),
  memoryWrite: z.string().optional(),
});

/**
 * Enforce the cross-field rules JSON Schema can't (Spec 06 §1.3): if Haiku can't own it,
 * someone must (withinPurview=false ⇒ escalate=true); escalate ⇒ a role is present; `answer`
 * only survives when actually handled here.
 */
function reconcile(c: HaikuClassification): HaikuClassification {
  const out: HaikuClassification = { ...c };
  if (!out.withinPurview && !out.escalate) out.escalate = true;
  if (out.escalate && !out.escalateRole) out.escalateRole = "decide";
  if (!(out.withinPurview && !out.escalate)) out.answer = undefined;
  return out;
}

/** The degradation result for a total intake failure (Spec 06 §1.3). */
function fallback(): HaikuClassification {
  return {
    kind: "task",
    withinPurview: false,
    escalate: true,
    escalateRole: "decide",
    ack: "got it — looking at this now.",
  };
}

/**
 * Classify a mention and write its ack (Spec 06 §1.3 / B0). Persona-full is applied (this is a
 * user-facing voice call). Never throws: a brain failure degrades to a safe escalate-to-Opus
 * classification so the mention is always acknowledged and routed.
 */
export async function classifyIntake(
  evt: IntakeEvent,
  persona: Persona,
  deps: RoleDeps,
  model: string,
): Promise<HaikuClassification> {
  try {
    const raw = await callJSON<HaikuClassification>({
      bin: deps.bin,
      model,
      system: intakeSystem(persona),
      prompt: intakeUser(evt),
      jsonSchema: HAIKU_CLASSIFICATION_SCHEMA,
      validate: (v) => Classification.parse(v) as HaikuClassification,
      schemaName: "intake",
      retry: deps.retry,
      logger: deps.logger,
    });
    return reconcile(raw);
  } catch (err) {
    deps.logger.error("intake classification failed; degrading to escalate", {
      kind: err instanceof BrainCallError ? err.kind : "unknown",
      error: (err as Error).message,
    });
    return fallback();
  }
}
