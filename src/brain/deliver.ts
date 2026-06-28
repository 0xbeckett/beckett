/**
 * Beckett — DELIVER & escalation voice (`src/brain/deliver.ts`)
 * =======================================================================================
 * The Haiku voice roles (Spec 06 §8). Content always originates upstream (the gated result,
 * Opus's `reason`/`question`, recorded assumptions); persona governs PHRASING, never SUBSTANCE
 * — Beckett never quips away a real caveat or the merge/send handshake (Spec 06 §8 / §8.1).
 *
 * No-silent-failure (Spec 00): if the voice call fails entirely, we fall back to a plain
 * (non-persona) message assembled from the structured input — a delivery/escalation is never
 * dropped, just less stylish.
 */

import type { TaskRecord, BrainContext, Escalation, Persona } from "../types.ts";
import { callText, type RoleDeps } from "./llm.ts";
import {
  deliverySystem,
  deliveryUser,
  escalationSystem,
  escalationUser,
} from "./prompts.ts";

/**
 * The final in-channel delivery message (B11). Persona-full applied. `ctx.fields` should carry
 * the gated result, the artifact (PR/branch/file), known limits, and any handshake the
 * orchestrator wants surfaced (Spec 06 §8.1). Falls back to a plain summary on brain failure.
 */
export async function composeDelivery(
  task: TaskRecord,
  ctx: BrainContext | undefined,
  persona: Persona,
  deps: RoleDeps,
  model: string,
): Promise<string> {
  try {
    return await callText({
      bin: deps.bin,
      model,
      system: deliverySystem(persona),
      prompt: deliveryUser(task, ctx),
      retry: deps.retry,
      logger: deps.logger,
    });
  } catch (err) {
    deps.logger.error("delivery voice failed; using plain fallback", {
      task: task.id,
      error: (err as Error).message,
    });
    return plainDelivery(task, ctx);
  }
}

/**
 * The escalation message asking Jason to decide (B12). Persona-full applied. Falls back to a
 * plain "tried it, here are the options" message on brain failure (Spec 06 §8.2 / Spec 11 §7.2).
 */
export async function composeEscalation(
  escalation: Escalation,
  ctx: BrainContext | undefined,
  persona: Persona,
  deps: RoleDeps,
  model: string,
): Promise<string> {
  try {
    return await callText({
      bin: deps.bin,
      model,
      system: escalationSystem(persona),
      prompt: escalationUser(escalation, ctx),
      retry: deps.retry,
      logger: deps.logger,
    });
  } catch (err) {
    deps.logger.error("escalation voice failed; using plain fallback", {
      origin: escalation.origin,
      error: (err as Error).message,
    });
    return plainEscalation(escalation);
  }
}

// ── plain (non-persona) fallbacks — never drop a user-facing message ──

function plainDelivery(task: TaskRecord, ctx?: BrainContext): string {
  const lines = ["Done."];
  const fields = ctx?.fields ?? {};
  if (typeof fields.summary === "string") lines.push(fields.summary);
  if (typeof fields.artifact === "string") lines.push(`Artifact: ${fields.artifact}`);
  if (Array.isArray(fields.limits) && fields.limits.length) {
    lines.push("Known limits:\n" + fields.limits.map((l) => `- ${l}`).join("\n"));
  }
  if (task.assumptions.length) {
    lines.push("Assumptions:\n" + task.assumptions.map((a) => `- ${a}`).join("\n"));
  }
  if (typeof fields.handshake === "string") lines.push(fields.handshake);
  return lines.join("\n");
}

function plainEscalation(escalation: Escalation): string {
  const opts = escalation.options.map((o) => `${o.key}) ${o.label} — ${o.effect}`).join("\n");
  return [escalation.reason, opts].filter(Boolean).join("\n\n");
}
