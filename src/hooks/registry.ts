/**
 * Beckett — Hook Registry (additive extension of existing scope system)
 *
 * Baseline: only PreToolUse scope-guard exists (hardcoded wiring).
 * This registry allows pluggable hooks without changing existing behavior.
 *
 * Current scope-guard remains the default for Claude.
 * Future: skills can register additional Pre/PostToolUse logic.
 *
 * All changes are additive — if no extra hooks registered, behavior is identical.
 */

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";

export interface HookHandler {
  type: "command"; // for now, matches Claude settings
  command: string;
  matcher?: string;
}

export interface HookRegistration {
  event: HookEvent;
  handlers: HookHandler[];
}

const registry: HookRegistration[] = [];

/** Register a hook. Safe to call multiple times. */
export function registerHook(reg: HookRegistration) {
  registry.push(reg);
}

/** Get all registered hooks for an event (for settings generation). */
export function getHooksForEvent(event: HookEvent): HookHandler[] {
  return registry
    .filter(r => r.event === event)
    .flatMap(r => r.handlers);
}

/** Initialize with the baseline scope guard (called from manager). */
export function initBaselineHooks(scopeGuardCommand: string) {
  if (registry.length === 0) {
    registerHook({
      event: "PreToolUse",
      handlers: [
        {
          type: "command",
          command: scopeGuardCommand,
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
        },
      ],
    });
  }
}

/** Clear for tests (additive, does not affect production). */
export function _resetForTests() {
  registry.length = 0;
}
