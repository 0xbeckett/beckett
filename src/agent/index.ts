/**
 * Beckett — Agent registry (`src/agent/index.ts`)
 * =======================================================================================
 * A live, no-redeploy registry of reusable worker personas (issue #66, foundation for #55).
 * Public surface for the daemon (`boot()`), the CLI (`beckett agent`), and tests.
 */

export * from "./types.ts";
export * from "./builtins.ts";
export { AgentStore, type AgentStoreOptions } from "./store.ts";
export { LiveAgentRegistry, type LiveAgentRegistryOptions } from "./registry.ts";
export {
  createAgentRunner,
  buildAgentArgs,
  AGENT_RUN_TIMEOUT_SECS,
  type AgentRunner,
  type AgentRunOutcome,
  type AgentRunOptions,
  type AgentRunState,
  type CreateAgentRunnerDeps,
} from "./invoke.ts";
