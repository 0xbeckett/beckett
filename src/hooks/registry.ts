/**
 * Beckett — Hook Registry (the single source of truth for claude hook settings)
 * =======================================================================================
 * Baseline behavior: the only hook is the PreToolUse scope-guard, whose per-worker settings
 * the WorkerManager writes to `<workspace>/.claude/settings.json` (Spec 02 §8.2).
 *
 * Consolidation: previously the registry was inert (registered the scope guard into an array
 * nothing read) while the real settings were built by a *separate* hardcoded path in
 * scope-guard.ts. Now BOTH flow through {@link renderClaudeSettings}: scope-guard.ts supplies
 * its per-worker spec, this registry supplies any EXTRA hooks (Phase 3: skills-contributed
 * Pre/PostToolUse), and one renderer emits the claude settings shape. With no extras
 * registered (the default), the output is byte-for-byte identical to the old hardcoded JSON.
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
  /**
   * Additive (session scoping): the session/task/server id this registration belongs to, so
   * Phase 3 can tag hook events with their scope and keep one session's hooks out of another's.
   */
  sessionOrTaskId?: string;
}

/** A flat hook definition (one matcher + one command for one event). */
export interface HookSpec {
  event: HookEvent;
  matcher?: string;
  command: string;
}

/** One entry in a claude settings hook array (matcher omitted when undefined). */
export interface ClaudeHookEntry {
  matcher?: string;
  hooks: { type: "command"; command: string }[];
}

/** The claude settings object written to `<workspace>/.claude/settings.json`. */
export interface ClaudeHookSettings {
  hooks: Record<string, ClaudeHookEntry[]>;
}

const registry: HookRegistration[] = [];

/** Register an EXTRA hook (beyond the baseline scope-guard). Safe to call multiple times. */
export function registerHook(reg: HookRegistration) {
  registry.push(reg);
}

/** Get all registered handlers for an event (for settings generation / introspection). */
export function getHooksForEvent(event: HookEvent): HookHandler[] {
  return registry.filter((r) => r.event === event).flatMap((r) => r.handlers);
}

/** Flatten every registered EXTRA hook into specs (consumed by {@link renderClaudeSettings}). */
export function registeredHookSpecs(): HookSpec[] {
  return registry.flatMap((r) =>
    r.handlers.map((h) => ({ event: r.event, matcher: h.matcher, command: h.command })),
  );
}

/**
 * Render hook specs into the claude settings shape. Pure: specs sharing an event are grouped
 * into that event's array in order, each as `{matcher?, hooks:[{type:"command", command}]}`.
 */
export function renderClaudeSettings(specs: HookSpec[]): ClaudeHookSettings {
  const hooks: Record<string, ClaudeHookEntry[]> = {};
  for (const s of specs) {
    const entry: ClaudeHookEntry =
      s.matcher !== undefined
        ? { matcher: s.matcher, hooks: [{ type: "command", command: s.command }] }
        : { hooks: [{ type: "command", command: s.command }] };
    (hooks[s.event] ??= []).push(entry);
  }
  return { hooks };
}

/** Clear registered extras for tests (does not affect the always-present scope-guard baseline). */
export function _resetForTests() {
  registry.length = 0;
}
