/**
 * Beckett v3 — the shell entrypoint (`src/shell/v3-main.ts`)
 * =======================================================================================
 * Boots the v3 Plane ticket-queue system and wires the four moving parts together:
 *
 *   1. Config + env — `loadConfig()` reads `~/.beckett/config.toml` (the `[plane]` /
 *      `[concierge]` sections) and loads `~/.beckett/.env` so `PLANE_API_TOKEN` lands in
 *      `process.env` for the {@link PlaneClient}.
 *   2. PlaneClient — the only module that speaks HTTP to the self-hosted Plane instance.
 *   3. Poller — polls the Plane REST API every `config.plane.poll_secs`, diffs snapshots, and
 *      hands each batch of {@link PollEvent}s to the dispatcher.
 *   4. Dispatcher — the v3 state machine: spawns implement/review workers, steers them from
 *      ticket comments, aborts on cancel, advances ticket state on finish.
 *   5. Concierge — the long-lived `claude -p` Opus agent that owns Discord and files tickets.
 *
 * The Concierge and the poll→dispatch loop are independent: the Concierge writes tickets into
 * Plane, the poller observes them, the dispatcher acts. They never call each other directly —
 * Plane is the shared queue. This mirrors the architecture in `docs/V3.md` §0.
 *
 * This is a NEW entrypoint; the v2 `src/shell/main.ts` is left untouched. Run it with
 * `bun run v3` (see package.json) or `bun src/shell/v3-main.ts`.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { log as rootLog } from "../log.ts";
import type { Config, Logger } from "../types.ts";
import type { Ticket } from "../plane/types.ts";
import { createPlaneClient, type PlaneClient } from "../plane/client.ts";
import { createPlanePoller, type PlanePoller } from "../plane/poll.ts";
import { createDispatcher, type Dispatcher } from "../dispatch/dispatcher.ts";
import { createConcierge, type Concierge } from "../concierge/index.ts";

/** Repo root = two levels up from `src/shell/` (matches `main.ts`'s `REPO_ROOT`). */
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Resolve the absolute git repo root a ticket's worktrees are allocated under. v1 runs against a
 * single shared project VM (one repo), so every ticket maps to the same root: `BECKETT_REPO_ROOT`
 * if set, else the Beckett repo itself. The dispatcher creates each worker's worktree under
 * `<repoRoot>/.beckett/worktrees/<workerId>` (see `src/dispatch/spawn.ts`).
 */
function resolveRepoRoot(_ticket: Ticket): string {
  return process.env.BECKETT_REPO_ROOT?.trim() || REPO_ROOT;
}

/**
 * Beckett version. v3.1 — the "go faster" release: workers run in the project checkout (no
 * per-stage worktrees), effort-scaled review (trivial work self-reviews in one pass), and
 * Sonnet 5 @ xhigh workers. See CHANGELOG.md.
 */
export const BECKETT_VERSION = "3.1";

/** The live v3 system — held so {@link shutdown} can tear every part down in order. */
interface BootedSystem {
  config: Config;
  logger: Logger;
  client: PlaneClient;
  poller: PlanePoller;
  dispatcher: Dispatcher;
  concierge: Concierge;
}

/**
 * Construct and start the whole v3 stack. Returns the booted system so the caller can wire
 * shutdown. The Concierge is started first (fail fast on a bad `claude` launch); the poller is
 * started last so events only flow once the dispatcher is ready to consume them.
 */
async function boot(): Promise<BootedSystem> {
  const config = loadConfig();
  const logger = rootLog.child("shell.v3");

  logger.info("booting beckett v3", {
    version: BECKETT_VERSION,
    plane: config.plane.base_url,
    workspace: config.plane.workspace_slug,
    project: config.plane.project_slug,
    pollSecs: config.plane.poll_secs,
    conciergeModel: config.concierge.model,
    repoRoot: resolveRepoRoot({} as Ticket),
  });

  if (!process.env.PLANE_API_TOKEN) {
    logger.warn("PLANE_API_TOKEN is not set — Plane API calls will fail until it is provided");
  }

  // 2. PlaneClient — the sole HTTP boundary to Plane (token from env).
  const client = createPlaneClient({ config, logger: logger.child("plane.client") });

  // 4. Dispatcher — consumes PollEvents, owns the worker lifecycle.
  const dispatcher = createDispatcher({
    client,
    config,
    resolveRepoRoot,
    logger: logger.child("dispatch"),
  });

  // 3. Poller — feeds each batch of events straight to the dispatcher. `start()` primes the
  //    snapshot first (so we don't replay history) then self-schedules every poll_secs.
  const poller = createPlanePoller({
    client,
    logger: logger.child("plane.poll"),
    pollSecs: config.plane.poll_secs,
  });

  // 5. Concierge — owns Discord, files tickets. Start it FIRST so a bad claude launch fails the
  //    whole boot before we begin polling.
  const concierge = createConcierge({ config, logger: logger.child("concierge") });
  await concierge.start();

  // Fan each poll batch to BOTH the dispatcher (acts on the work) and the Concierge (surfaces
  // milestones/errors back to the Discord conversation that filed the ticket — the closed loop).
  await poller.start((events) => {
    concierge.notify(events);
    return dispatcher.handle(events);
  });
  logger.info("beckett v3 online", { liveWorkers: dispatcher.live().length });

  return { config, logger, client, poller, dispatcher, concierge };
}

/** Tear the system down in reverse boot order. Best-effort: one failure never blocks the rest. */
async function shutdown(sys: BootedSystem, signal: string): Promise<void> {
  sys.logger.info("shutting down beckett v3", { signal });
  sys.poller.stop();
  try {
    await sys.concierge.stop();
  } catch (err) {
    sys.logger.warn("concierge shutdown failed", { error: (err as Error).message });
  }
}

/** Boot the system and install graceful-shutdown signal handlers. */
async function main(): Promise<void> {
  const sys = await boot();

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      void shutdown(sys, sig).finally(() => process.exit(0));
    });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    rootLog.child("shell.v3").error("beckett v3 failed to start", { err: String(err) });
    process.exit(1);
  });
}

export { boot, shutdown, main, resolveRepoRoot };
export type { BootedSystem };
