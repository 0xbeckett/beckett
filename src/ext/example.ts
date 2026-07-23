/**
 * Beckett v6 — a trivial example extension (`src/ext/example.ts`)
 * =======================================================================================
 * Proves the {@link Extension} contract end to end with the smallest thing that exercises
 * every facet: a manifest, a lifecycle (stateful — it counts its calls), a discovered +
 * dispatchable capability with input validation, and the carried-through v5 facets (a CLI
 * verb, a bus command, a prompt block, a config fragment).
 *
 * It is NOT wired into anything: no live surface imports it. Its only consumer is
 * {@link ./registry.test.ts}, which registers it to prove the seam compiles and dispatches.
 * When a real organ migrates (memory first, per the doc), it follows exactly this shape.
 */

import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "./contract.ts";

/** The validated shape of a `ping.echo` call — the registry checks args against this. */
const EchoArgs = z.object({
  message: z.string().min(1, "ping.echo needs a non-empty message"),
});

/**
 * Build the example extension. Holds a tiny bit of state (a call counter) purely to exercise
 * the lifecycle + health hooks a stateful organ like memory or browser will use for real.
 */
export const createPingExtension: ExtensionFactory = ({ logger }): Extension => {
  let started = false;
  let calls = 0;

  return {
    manifest: {
      id: "ping",
      version: "0.1.0",
      summary: "a demo extension that echoes a message back — proves the v6 contract",
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch ---
    capabilities: [
      {
        id: "ping.echo",
        description:
          "Echo a message straight back. Reach for it to prove the extension seam is live; " +
          "it does nothing else.",
        input: EchoArgs,
        examples: ["ping with 'hello'", "echo this back to me"],
      },
    ],
    invoke: async (call) => {
      if (call.capabilityId !== "ping.echo") {
        return { ok: false, error: `ping: unknown capability "${call.capabilityId}"` };
      }
      // Args are already validated by the registry against EchoArgs.
      const { message } = call.args as z.infer<typeof EchoArgs>;
      calls += 1;
      return { ok: true, data: { echoed: message, calls, startedFirst: started } };
    },

    // --- v6 lifecycle (stateful) ---
    lifecycle: {
      init: () => {
        logger?.debug?.("ping extension init");
      },
      start: () => {
        started = true;
      },
      stop: () => {
        started = false;
      },
      health: () => ({ ok: started, detail: started ? `served ${calls} calls` : "not started" }),
    },

    // --- v5 facets, carried through unchanged ---
    cliVerbs: [
      {
        name: "ping",
        summary: "echo the arguments back as JSON (demo extension)",
        usage: "beckett ping <words…>",
        run: async (argv) => ({ echoed: argv.join(" ") }),
      },
    ],
    busCommands: [
      {
        name: "ping.say",
        summary: "echo over the control bus",
        handle: async (req) => ({ ok: true, data: req.args }),
      },
    ],
    promptBlock: {
      id: "ping",
      priority: 90,
      render: () => "", // contributes nothing to worker personas — a real organ would render here
    },
    configKey: "ping",
    configSchema: z.object({ loudness: z.number().int().min(0).default(1) }).default({}),
  };
};
