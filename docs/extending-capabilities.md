# Extending Beckett: add a capability (V5)

V5 gives Beckett **one** way to add a capability, generalized from the extension point that
always worked — the harness driver registry (`src/drivers/index.ts`). A capability is a
self-describing module ([`src/capability/index.ts`](../src/capability/index.ts)); registering
it lights up every surface at once:

| Declared on the `Capability` | Surface it lights up |
|---|---|
| `cliVerbs` | `beckett <verb>` dispatch (`src/cli/beckett.ts` walks the registry) |
| `cliHelp` | the auto-generated `beckett` command list (never hand-edit help again) |
| `busCommands` | the concierge control bus (`Concierge.onBusRequest` walks the registry) |
| `configSchema` + `configKey` | its own `config.toml` slice, composed into the top-level schema (`src/config.ts::composeConfigSchema`) |
| `promptBlock` | a composed block in every ticket worker's system prompt (`src/dispatch/stages.ts::workerSystemAppend`) |
| `actionClass` | FREE / HANDSHAKE_GATED / ALWAYS_ASK posture (Spec 07 §2.2) |
| `skillDoc` | pointer to its SKILL.md (skills stay plain files — zero coupling) |

Worker **stages** (implement / review / design / …) have the same shape one registry over:
add a `StageDefinition` in [`src/dispatch/stages.ts`](../src/dispatch/stages.ts) — prompt
builder, system-append, default cast, done-parser, finish handler, all in one place.

## The recipe

**1. Write the module** — `src/capability/modules/echo.ts`:

```ts
import { z } from "zod";
import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import { out } from "../../cli/io.ts";

export function createEchoCapability({ config, paths, logger }: CapabilityDeps): Capability {
  return {
    id: "echo",
    summary: "say a thing back (demo capability)",
    actionClass: ActionClass.FREE,

    // `beckett echo <words>` — parsed, validated, and listed in help automatically.
    cliHelp: "echo <words>",
    cliVerbs: [
      {
        name: "echo",
        summary: "print the arguments back as JSON",
        usage: "beckett echo <words…>",
        run: async (argv) => out({ echoed: argv.join(" ") }),
      },
    ],

    // A control-bus command the concierge can reach: `bus("echo.say", {...})`.
    busCommands: [
      {
        name: "echo.say",
        summary: "echo over the bus",
        handle: async (req) => ({ ok: true, data: req.args }),
      },
    ],

    // Its own config slice: `[echo] loudness = 3` in config.toml, validated at boot.
    configKey: "echo",
    configSchema: z.object({ loudness: z.number().int().min(0).default(1) }).default({}),

    // A composed system-prompt contribution: rides into every ticket worker's persona,
    // sorted by priority (github guidance is 10, stage extras 20, the deploy recipe 30).
    // Render "" to contribute nothing for that ticket.
    promptBlock: {
      id: "echo",
      priority: 40,
      render: ({ ticket }) => (ticket ? `ECHO: the ticket is ${ticket.identifier}.` : ""),
    },
  };
}
```

**2. Register the factory** — one entry in
[`src/capability/modules/index.ts`](../src/capability/modules/index.ts):

```ts
const FACTORIES: Record<string, CapabilityFactory> = {
  // …existing entries…
  echo: createEchoCapability,
};
```

**3. Reference it from the surfaces that should carry it** — for the CLI, one
`createCapability("echo", capabilityDeps)` line in `buildCliCapabilities`
(`src/cli/beckett.ts`); the registry composes help, dispatch, and collision checks from
there. Bus commands ride the concierge's registry the same way.

That's it. No if/else cascade, no hand-maintained help string, no monolithic schema edit, no
string surgery in the prompt builder.

## The safety net

The observable behavior of every CLI verb and bus command is pinned by the characterization
suites — [`src/cli/characterization.test.ts`](../src/cli/characterization.test.ts) and
[`src/concierge/bus-characterization.test.ts`](../src/concierge/bus-characterization.test.ts)
(166+ snapshots), plus the composed worker-persona snapshots in
[`src/dispatch/stages.test.ts`](../src/dispatch/stages.test.ts). Run the full gate with:

```sh
bun x tsc --noEmit && bun test
```

A new capability adds snapshots; an edit to an existing one that changes observable behavior
fails loudly. That contract is what made the V5 refactor provable, and it is the same
contract your capability inherits the moment it registers.
