/**
 * Beckett v5 — the capability spine (`src/capability/index.ts`)
 * =======================================================================================
 * Phase 0 of the extensibility refactor: ONE clean way to add a capability, generalized from
 * the one extension point that already works — the harness driver registry
 * (`src/drivers/index.ts`: add a factory entry, implement the interface, done).
 *
 * A {@link Capability} is a self-describing module declaring everything a feature hangs off
 * today by hand-wiring across 3+ files:
 *   - its CLI verbs (with an arg schema) — today: a branch in the `cli/beckett.ts` cascade
 *     plus a hand-maintained help string,
 *   - its control-bus commands — today: an `if (req.cmd === …)` in `Concierge.onBusRequest`,
 *   - its action-class (FREE / HANDSHAKE_GATED / ALWAYS_ASK, Spec 07 §2.2),
 *   - an optional skill doc pointer (the zero-coupling SKILL.md model stays file-based),
 *   - an optional COMPOSABLE system-prompt block — today: string concatenation in
 *     `buildSystemAppend`,
 *   - its own config-schema fragment — today: one monolithic zod block in `config.ts`.
 *
 * Wiring status: the CONTROL BUS dispatches through this registry (Phase 1b —
 * `Concierge.onBusRequest` walks the capabilities `buildBusCapabilities` registers);
 * `cli/beckett.ts` still behaves byte-for-byte as before pending its own migration. The
 * characterization suites (`src/cli/characterization.test.ts`,
 * `src/concierge/bus-characterization.test.ts`) snapshot the observable behavior as the
 * contract every phase must keep green.
 */

import type { z } from "zod";
import type { Config, Logger } from "../types.ts";
import { ActionClass } from "../types.ts";

export { ActionClass };

/** The parsed shape of a CLI invocation (what `cli/beckett.ts::parse` produces today). */
export interface CliArgs {
  /** Positional arguments after the verb. */
  _: string[];
  /** `--flag value` pairs; a bare `--flag` is `true`. */
  flags: Record<string, string | boolean>;
}

/** What a CLI verb handler needs beyond its parsed argv (threaded by the dispatcher, Phase 1). */
export interface CliContext {
  config: Config;
  logger: Logger;
}

/**
 * One `beckett <group> [sub]` verb. `name` is the space-joined path ("ticket create",
 * "status") — the registry indexes on it, help text is generated from `summary`/`usage`,
 * and `args` (a zod schema over {@link CliArgs}) replaces each verb's hand-rolled flag
 * validation. `run` is optional in Phase 0: declaring a verb must be possible before its
 * body migrates out of the cascade (Phase 1 wires dispatch through it).
 */
export interface CliVerb {
  name: string;
  summary: string;
  /** The one-line usage string printed on bad arguments (today's `fail("usage: …")`). */
  usage: string;
  /** Validates the parsed argv; the dispatcher rejects before `run` sees bad input. */
  args?: z.ZodTypeAny;
  /** Per-verb override of the capability's default action-class. */
  actionClass?: ActionClass;
  run?: (args: CliArgs, ctx: CliContext) => Promise<unknown>;
}

/** The control-bus request/response shapes (`shell/control-bus.ts` — kept structural here so
 *  the spine has no dependency on the bus transport). */
export interface BusRequestLike {
  cmd: string;
  args: Record<string, unknown>;
  token?: string;
}
export interface BusResponseLike {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * One control-bus command ("ticket.restaff", "channels.wipe"). `handle` is optional in
 * Phase 0 for the same reason as {@link CliVerb.run}: Phase 1 turns `onBusRequest`'s
 * sequential ifs into a registry walk over these.
 */
export interface BusCommand {
  name: string;
  summary: string;
  /** Per-command override of the capability's default action-class. */
  actionClass?: ActionClass;
  handle?: (req: BusRequestLike) => Promise<BusResponseLike>;
}

/**
 * A composable system-prompt block. `buildSystemAppend` (Phase 4) sorts registered blocks by
 * `priority` (lower first, ties by id) and joins what `render` returns; a block rendering the
 * empty string contributes nothing that turn.
 */
export interface PromptBlock {
  id: string;
  priority?: number;
  render: (ctx: { config: Config }) => string;
}

/**
 * The self-describing capability module. One of these per feature (github, dns+deploy,
 * image, memory, mail, secret, …) replaces today's bespoke wiring.
 */
export interface Capability {
  /** Unique kebab-case id ("github", "memory"). The registry key. */
  id: string;
  summary: string;
  /** Default action-class for every verb/command that doesn't override it (Spec 07 §2.2). */
  actionClass: ActionClass;
  cliVerbs: CliVerb[];
  busCommands: BusCommand[];
  /** Optional pointer to the capability's SKILL.md (stays a plain file — zero coupling). */
  skillDoc?: string;
  /** Optional composable system-prompt contribution. */
  promptBlock?: PromptBlock;
  /**
   * Optional config-schema fragment, mounted under `configKey` when the composed schema is
   * assembled (Phase 1 #N.4 kills the monolith by composing these).
   */
  configSchema?: z.ZodTypeAny;
  /** Where the fragment mounts in config.toml; defaults to `id`. */
  configKey?: string;
}

/** The effective action-class of a verb/command: its own override, else the capability default. */
export function effectiveActionClass(
  capability: Capability,
  item: { actionClass?: ActionClass },
): ActionClass {
  return item.actionClass ?? capability.actionClass;
}

/**
 * The capability registry — the same posture as the driver registry: consumers never reach
 * into a capability module directly, they ask the registry and hold only the typed interface.
 * Registration fails loudly on any collision (duplicate id, CLI verb, or bus command) so two
 * capabilities can never silently shadow each other; lookups for anything unregistered throw
 * a clear error rather than silently doing nothing.
 */
export class CapabilityRegistry {
  private readonly byId = new Map<string, Capability>();
  private readonly byCliVerb = new Map<string, { capability: Capability; verb: CliVerb }>();
  private readonly byBusCommand = new Map<string, { capability: Capability; command: BusCommand }>();

  register(capability: Capability): void {
    if (!capability.id.trim()) throw new Error("beckett: a capability needs a non-empty id");
    if (this.byId.has(capability.id)) {
      throw new Error(`beckett: capability "${capability.id}" is already registered`);
    }
    // Validate the WHOLE module before touching any index — a half-registered capability
    // (id claimed, verbs missing) would be worse than a loud refusal.
    for (const verb of capability.cliVerbs) {
      if (!verb.name.trim()) {
        throw new Error(`beckett: capability "${capability.id}" declares a CLI verb with an empty name`);
      }
      const existing = this.byCliVerb.get(verb.name);
      if (existing) {
        throw new Error(
          `beckett: CLI verb "${verb.name}" is already registered by capability "${existing.capability.id}" ` +
            `(capability "${capability.id}" tried to register it too)`,
        );
      }
    }
    const seenVerbs = new Set<string>();
    for (const verb of capability.cliVerbs) {
      if (seenVerbs.has(verb.name)) {
        throw new Error(`beckett: capability "${capability.id}" declares CLI verb "${verb.name}" twice`);
      }
      seenVerbs.add(verb.name);
    }
    for (const command of capability.busCommands) {
      if (!command.name.trim()) {
        throw new Error(`beckett: capability "${capability.id}" declares a bus command with an empty name`);
      }
      const existing = this.byBusCommand.get(command.name);
      if (existing) {
        throw new Error(
          `beckett: bus command "${command.name}" is already registered by capability "${existing.capability.id}" ` +
            `(capability "${capability.id}" tried to register it too)`,
        );
      }
    }
    const seenCommands = new Set<string>();
    for (const command of capability.busCommands) {
      if (seenCommands.has(command.name)) {
        throw new Error(`beckett: capability "${capability.id}" declares bus command "${command.name}" twice`);
      }
      seenCommands.add(command.name);
    }

    this.byId.set(capability.id, capability);
    for (const verb of capability.cliVerbs) this.byCliVerb.set(verb.name, { capability, verb });
    for (const command of capability.busCommands) this.byBusCommand.set(command.name, { capability, command });
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Registered capability ids, in registration order. */
  list(): string[] {
    return [...this.byId.keys()];
  }

  /** Resolve a capability by id. Throws the same loud shape as the driver registry. */
  get(id: string): Capability {
    const capability = this.byId.get(id);
    if (!capability) {
      throw new Error(
        `beckett: no capability registered for "${id}" ` +
          `(available: ${this.list().join(", ") || "none"})`,
      );
    }
    return capability;
  }

  /**
   * Resolve a CLI invocation to its verb, longest match first: for `["ticket", "create", …]`
   * a registered "ticket create" wins over a registered "ticket". Returns null when nothing
   * matches — the Phase 1 dispatcher turns that into today's `unknown command` failure.
   */
  resolveCliVerb(argv: string[]): { capability: Capability; verb: CliVerb; rest: string[] } | null {
    for (let take = Math.min(argv.length, 2); take >= 1; take--) {
      const name = argv.slice(0, take).join(" ");
      const hit = this.byCliVerb.get(name);
      if (hit) return { ...hit, rest: argv.slice(take) };
    }
    return null;
  }

  /** Resolve a bus command by its exact name, or null (→ today's `unknown command "x"`). */
  resolveBusCommand(name: string): { capability: Capability; command: BusCommand } | null {
    return this.byBusCommand.get(name) ?? null;
  }

  /** Every registered CLI verb (registration order) — the auto-generated help walks this. */
  cliVerbs(): Array<{ capability: Capability; verb: CliVerb }> {
    return [...this.byCliVerb.values()];
  }

  /** Every registered bus command (registration order). */
  busCommands(): Array<{ capability: Capability; command: BusCommand }> {
    return [...this.byBusCommand.values()];
  }

  /**
   * The composed config fragments: `configKey` (default: the capability id) → zod schema.
   * Phase 1 #N.4 mounts these into the top-level config schema instead of the monolith.
   * Two capabilities claiming the same key is a wiring bug — refuse loudly.
   */
  configFragments(): Map<string, z.ZodTypeAny> {
    const fragments = new Map<string, z.ZodTypeAny>();
    const claimedBy = new Map<string, string>();
    for (const capability of this.byId.values()) {
      if (!capability.configSchema) continue;
      const key = capability.configKey ?? capability.id;
      const holder = claimedBy.get(key);
      if (holder) {
        throw new Error(
          `beckett: config key "${key}" is claimed by both capability "${holder}" and "${capability.id}"`,
        );
      }
      claimedBy.set(key, capability.id);
      fragments.set(key, capability.configSchema);
    }
    return fragments;
  }

  /**
   * Compose the registered system-prompt blocks: sort by priority (lower first, ties by id),
   * render each, drop empties, join with blank lines. Phase 4 replaces `buildSystemAppend`'s
   * string concatenation with this.
   */
  composePrompt(ctx: { config: Config }): string {
    const blocks = [...this.byId.values()]
      .map((capability) => capability.promptBlock)
      .filter((block): block is PromptBlock => block !== undefined)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));
    return blocks
      .map((block) => block.render(ctx).trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
}
