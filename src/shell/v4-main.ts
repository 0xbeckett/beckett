/**
 * Beckett v4 — the shell entrypoint (`src/shell/v4-main.ts`)
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
 * `bun run v4` (see package.json) or `bun src/shell/v4-main.ts`.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { log as rootLog } from "../log.ts";
import type { Config, Harness, Logger } from "../types.ts";
import type { Ticket } from "../plane/types.ts";
import { projectSlug } from "../plane/cast.ts";
import { createPlaneClient, type PlaneClient } from "../plane/client.ts";
import { createPlanePoller, type PlanePoller } from "../plane/poll.ts";
import { createDispatcher, type Dispatcher } from "../dispatch/dispatcher.ts";
import { createGitHubPrPoller, type GitHubPrPoller } from "../github/poll.ts";
import { createGitHubActivityPoller, type GitHubActivityPoller } from "../github/activity.ts";
import { parsePrUrl } from "../github/types.ts";
import { preflightFor } from "../drivers/index.ts";
import { createConcierge, currentGitCommit, type Concierge } from "../concierge/index.ts";
import { createQuickRunner, type QuickRunner } from "../quick/index.ts";
import { GitHubCli, loadIdentity } from "../agency/index.ts";
import { createMemory } from "../memory/index.ts";
import { startRoutineMaintenance } from "../memory/maintain.ts";

/**
 * Root under which every ticket builds its OWN project repo — one directory per code project,
 * e.g. `~/Projects/balloons`. Override via `BECKETT_PROJECTS_ROOT`.
 */
const PROJECTS_ROOT = process.env.BECKETT_PROJECTS_ROOT?.trim() || join(homedir(), "Projects");

/**
 * The git repo a ticket's worker runs in (v3.1): the ticket's OWN project repo at
 * `<PROJECTS_ROOT>/<slug>`, pushed to `0xbeckett/<slug>` — fully decoupled from Beckett's own
 * source repo (`~/beckett`, which a worker never touches). The slug is the ticket's
 * Concierge-named `project`, or the ticket identifier when unnamed (a per-ticket sandbox). The
 * dispatcher provisions the repo (clone if it exists on GitHub, else `git init`) before spawning.
 */
function resolveRepoRoot(ticket: Ticket): string {
  return join(PROJECTS_ROOT, projectSlug(ticket.project || ticket.identifier || "scratch"));
}

/**
 * Beckett version. v4.0 — the multiplayer release (OPS-80): channel-scoped shared context, so
 * everyone in a Discord channel collaborates with the same Beckett instead of getting isolated
 * per-user sessions. See CHANGELOG.md.
 */
// ONE version source (issue #29): package.json. The old hand-maintained constant drifted three
// ways (package.json 3.1.1 / this file 3.3.0 / CHANGELOG 3.3). Read at module load; the file
// sits at the repo root two levels up from src/shell/.
import pkg from "../../package.json" with { type: "json" };
export const BECKETT_VERSION: string = (pkg as { version: string }).version;

/** The live v4 system — held so {@link shutdown} can tear every part down in order. */
interface BootedSystem {
  config: Config;
  logger: Logger;
  client: PlaneClient;
  clients: Map<string, PlaneClient>;
  poller: PlanePoller;
  pollers: Map<string, PlanePoller>;
  prPoller: GitHubPrPoller | null;
  activityPoller: GitHubActivityPoller | null;
  dispatcher: Dispatcher;
  concierge: Concierge;
  quick: QuickRunner;
  memoryMaintenance: { stop(): void };
}

/**
 * Construct and start the whole v3 stack. Returns the booted system so the caller can wire
 * shutdown. The Concierge is started first (fail fast on a bad `claude` launch); the poller is
 * started last so events only flow once the dispatcher is ready to consume them.
 */
async function boot(): Promise<BootedSystem> {
  const config = loadConfig();
  const logger = rootLog.child("shell.v4");

  logger.info("booting beckett v4", {
    version: BECKETT_VERSION,
    plane: config.plane.base_url,
    workspace: config.plane.workspace_slug,
    defaultBoard: config.plane.default_board,
    boards: Object.keys(config.plane.boards),
    pollSecs: config.plane.poll_secs,
    conciergeModel: config.concierge.model,
    projectsRoot: PROJECTS_ROOT,
  });

  if (!process.env.PLANE_API_TOKEN) {
    logger.warn("PLANE_API_TOKEN is not set — Plane API calls will fail until it is provided");
  }

  // 2. PlaneClient — one board-scoped HTTP boundary per configured Plane board.
  const clients = new Map<string, PlaneClient>();
  for (const board of Object.keys(config.plane.boards)) {
    clients.set(board, createPlaneClient({ config, board, logger: logger.child(`plane.client.${board}`) }));
  }
  const client = clients.get(config.plane.default_board) ?? clients.values().next().value!;
  const clientByProjectId = new Map<string, PlaneClient>();
  const pollerByProjectId = new Map<string, PlanePoller>();

  // Deterministic GitHub publishing: when a ticket reaches done, its project repo is pushed to
  // `0xbeckett/<slug>` (public) so the links Beckett hands out actually resolve — instead of
  // relying on the worker to push, which it skipped and left repos that 404'd. Built from the
  // GitHub identity; a missing PAT makes it undefined → the dispatcher skips publishing and says so.
  const identity = loadIdentity(config);
  const publishRepo = identity.github.pat
    ? async (a: { slug: string; repoRoot: string; description: string; ticket?: string }) => {
        const gh = new GitHubCli({
          pat: identity.github.pat,
          account: identity.github.account,
          apiBase: identity.github.apiBase,
          resolveRepoDir: () => a.repoRoot,
          logger: logger.child("gh"),
        });
        const r = await gh.ensurePublished({
          slug: a.slug,
          sourceDir: a.repoRoot,
          description: a.description,
          ticket: a.ticket,
        });
        return { url: r.url, kind: r.kind, prUrl: r.prUrl };
      }
    : undefined;
  if (!publishRepo) {
    logger.warn("no GITHUB_PAT — project repos will stay local-only (not pushed to GitHub)");
  }

  // GitHub PR sense (OPS-124): watch the PRs Beckett opens on the 0xbeckett org and relay review/CI/
  // merge signal back to the ticket's channel. Registry-driven — the dispatcher's `onPrOpened` hook
  // (below) registers each PR at open time with its origin channel. Read-only: it observes and
  // relays, never replies or merges. Skipped without a PAT (nothing to read GitHub with).
  const paths = buildPaths(config);
  const beckettDir = paths.beckettDir;
  const prPoller: GitHubPrPoller | null = identity.github.pat
    ? createGitHubPrPoller({
        reader: new GitHubCli({
          pat: identity.github.pat,
          account: identity.github.account,
          apiBase: identity.github.apiBase,
          resolveRepoDir: () => PROJECTS_ROOT, // unused for reads (prSignals passes --repo)
          logger: logger.child("gh.read"),
        }),
        account: identity.github.account,
        pollSecs: config.github.poll_secs,
        statePath: join(beckettDir, "github-prs.json"),
        logger: logger.child("github.poll"),
      })
    : null;

  // OPS-128: a separate read-only feed for contributors pushing directly to Beckett's main or
  // merging PRs there. It uses the same credentialed GitHubCli boundary as every other GitHub
  // operation; deployment identities are advanced as watermarks but never become Discord lines.
  const activityConfig = config.github.activity;
  const activityPoller: GitHubActivityPoller | null = identity.github.pat && activityConfig.enabled
    ? createGitHubActivityPoller({
        reader: new GitHubCli({
          pat: identity.github.pat,
          account: identity.github.account,
          apiBase: identity.github.apiBase,
          resolveRepoDir: () => PROJECTS_ROOT,
          logger: logger.child("gh.activity.read"),
        }),
        repo: activityConfig.repo,
        branch: activityConfig.branch,
        pollSecs: activityConfig.poll_secs,
        statePath: join(beckettDir, "github-activity.json"),
        // Always suppress the actually configured daemon identity even if a box overrides it.
        ignoredAuthors: [...new Set([...activityConfig.ignored_authors, identity.github.account])],
        logger: logger.child("github.activity"),
      })
    : null;

  // 5. Concierge — owns Discord (and the private ticket journal the dispatcher feeds). Constructed
  //    here (cheap, no I/O) so its progress sink can be wired into the dispatcher below; started
  //    further down (FIRST of the live parts) so a bad claude launch fails the whole boot early.
  const concierge = createConcierge({ config, logger: logger.child("concierge"), plane: client });

  // 3. Pollers — one per board, all feeding the same dispatcher. `start()` primes the
  //    snapshot first (so we don't replay history) then self-schedules every poll_secs.
  //    Constructed BEFORE the dispatcher so the dispatcher's instant-advance path (issue #33)
  //    can reference the correct board poller.
  const pollers = new Map<string, PlanePoller>();
  for (const [board, boardClient] of clients) {
    pollers.set(
      board,
      createPlanePoller({
        client: boardClient,
        logger: logger.child(`plane.poll.${board}`),
        pollSecs: config.plane.poll_secs,
        commentCursorPath: join(
          beckettDir,
          board === config.plane.default_board ? "comment-cursors.json" : `comment-cursors-${board}.json`,
        ),
      }),
    );
  }
  const poller = pollers.get(config.plane.default_board) ?? pollers.values().next().value!;
  // Provision and then resolve boards SERIALly before polling. This is the deploy-time repair
  // path for a newly configured board (notably INT): each client lists first and creates only
  // missing project/states. Serializing avoids a four-board boot burst; each individual request
  // also uses PlaneClient's 429 Retry-After/exponential-backoff wrapper.
  // Failures remain non-fatal so a temporary Plane outage does not take Discord down; the poller
  // retries provisioning through its normal client bootstrap on later ticks.
  for (const [board, boardClient] of clients) {
    try {
      await boardClient.ensureProvisioned();
      const info = await boardClient.projectInfo();
      clientByProjectId.set(info.projectId, boardClient);
      const boardPoller = pollers.get(board);
      if (boardPoller) pollerByProjectId.set(info.projectId, boardPoller);
    } catch (err) {
      logger.warn("Plane board provisioning/pre-resolution failed", { board, error: (err as Error).message });
    }
  }
  const rememberRouting = (events: Ticket | Ticket[], board: string) => {
    const boardClient = clients.get(board);
    const boardPoller = pollers.get(board);
    for (const ticket of Array.isArray(events) ? events : [events]) {
      if (ticket.projectId && boardClient) clientByProjectId.set(ticket.projectId, boardClient);
      if (ticket.projectId && boardPoller) pollerByProjectId.set(ticket.projectId, boardPoller);
    }
  };

  // 4. Dispatcher — consumes PollEvents, owns the worker lifecycle. Its workers' granular event
  //    streams are mirrored into each ticket's Discord thread via the Concierge's progress hub.
  const dispatcher = createDispatcher({
    client,
    clients: [...clients.values()],
    clientForProjectId: (projectId) => clientByProjectId.get(projectId),
    config,
    resolveRepoRoot,
    publishRepo,
    progress: concierge.progressSink(),
    advanceOutboxPath: join(beckettDir, "advance-outbox.jsonl"),
    publishOutboxPath: join(beckettDir, "publish-outbox.jsonl"),
    runtimeStatePath: join(beckettDir, "dispatcher-state.json"),
    spendLedgerPath: paths.spend,
    // Harness health probe (issue #17): a dead harness (binary gone, login expired) becomes one
    // clear substitution comment instead of a wedged ticket. ~5-min cached per harness.
    preflight: (harness) => preflightFor(harness, config),
    // Instant milestone path (issue #33): a dispatcher-written advance reaches Discord NOW
    // (concierge.notify) instead of after the next poll, and the poller's snapshot is synced so
    // the same transition isn't re-emitted as a duplicate ping ≤5s later.
    onAdvance: (event) => {
      (pollerByProjectId.get(event.ticket.projectId) ?? poller).observe(event);
      concierge.notify(event);
    },
    // OPS-124: a PR Beckett just opened → start watching it, routed to the ticket's origin channel.
    // Parse the repo+number from the PR URL; a non-PR URL yields null and is ignored. The poller
    // itself drops PRs outside our org and (at relay time) PRs with no origin channel.
    onPrOpened: prPoller
      ? ({ prUrl, ticket }) => {
          const parsed = parsePrUrl(prUrl);
          if (!parsed) return;
          prPoller.watch({
            repo: parsed.repo,
            number: parsed.number,
            url: prUrl,
            title: ticket.title,
            ticket: ticket.identifier,
            channel: ticket.originChannel,
          });
        }
      : undefined,
    logger: logger.child("dispatch"),
  });

  // Wire the Concierge's intervention levers (issue #21): `beckett ticket restaff` on the control
  // bus routes here. Done post-construction because the Concierge is built first (progress sink).
  concierge.setDispatcherOps({
    restaff: (id, harness) => dispatcher.restaff(id, harness as Harness | undefined),
    courier: (id) => dispatcher.courier(id),
  });

  // Instant tick on filing (issue #33): `beckett ticket create --channel …` pings the control bus;
  // poking the poller staffs the fresh ticket in well under a second instead of the 0–5s poll gap.
  concierge.setTicketFiledListener(() => {
    for (const p of pollers.values()) p.poke();
  });

  // Quick agents — the no-ticket lane. The runner owns the short-lived specialist
  // harnesses; a run that outlives its sync window reports back through the Concierge as an
  // update turn, exactly like a ticket milestone.
  const quick = createQuickRunner({
    config,
    logger: logger.child("quick"),
    onDetachedResult: (run) => concierge.notifyQuickResult(run),
  });
  concierge.setQuickRunner(quick);

  // Ops visibility (issue #30): the `beckett status` bus command answers from this assembler —
  // the daemon-wide halves the Concierge can't see itself. The Concierge merges in its own
  // (Discord gateway, session) when serving the command.
  const bootedAt = Date.now();
  concierge.setStatusProvider(async () => ({
    version: BECKETT_VERSION,
    commit: (await currentGitCommit(join(import.meta.dir, "..", ".."))).short,
    pid: process.pid,
    uptimeSecs: Math.round((Date.now() - bootedAt) / 1000),
    workers: dispatcher.statusWorkers(),
    quick: quick.stats(),
    poller: {
      boards: Object.fromEntries([...pollers].map(([board, p]) => [board, p.stats()])),
      ...poller.stats(),
    },
    githubPr: prPoller ? prPoller.stats() : null,
    githubActivity: activityPoller ? { repo: activityConfig.repo, branch: activityConfig.branch } : null,
    plane: {
      baseUrl: config.plane.base_url,
      defaultBoard: config.plane.default_board,
      boards: Object.fromEntries([...clients].map(([board, c]) => [board, c.stats()])),
      ...client.stats(),
    },
  }));

  // Start the Concierge FIRST (of the live parts) so a bad claude launch fails the whole boot
  //    before we begin polling. (Constructed above so its progress sink could be wired in.)
  await concierge.start();
  await dispatcher.replayAdvances();
  await dispatcher.replayPublishes();

  // Crash recovery (issue #20): BEFORE the poller re-staffs anything, sweep worker processes a
  // crashed daemon orphaned, commit their ghost WIP, and arm session-resume hints so re-staffed
  // tickets continue their interrupted sessions instead of re-running from scratch.
  await dispatcher.recoverFromCrash();

  // Blip-proofing (OPS-125): with recovery done, arm the periodic worktree-checkpoint loop so a
  // HARD crash (SIGKILL / OOM / power) — where the graceful shutdown drain never runs — loses at
  // most one checkpoint window of in-flight WIP, not the whole session. The graceful path
  // (drainForShutdown) still commits WIP itself and stops this loop first.
  dispatcher.startCheckpointLoop();

  // Fan each board's poll batch to BOTH the dispatcher (acts on the work) and the Concierge
  // (surfaces milestones/errors back to the Discord conversation that filed the ticket).
  await Promise.all(
    [...pollers].map(([board, p]) =>
      p.start((events) => {
        rememberRouting(events.map((event) => event.ticket), board);
        concierge.notify(events);
        return dispatcher.handle(events);
      }),
    ),
  );
  // GitHub PR sense (OPS-124): start watching after the dispatcher is live, so any PR opened during
  // boot recovery already has a home. Each material transition lands as a Concierge update turn —
  // the same routing as ticket updates. Best-effort: a poll failure never affects the rest.
  if (prPoller) {
    await prPoller.start((events) => concierge.notifyPrEvents(events));
  }
  if (activityPoller) {
    await activityPoller.start((events) => concierge.relayGitHubActivity(events, activityConfig.channel_id));
  }

  // Memory self-healing (OPS-121): one maintenance pass shortly after boot, then daily —
  // archives expired/superseded facts and merges near-duplicates so the knowledge graph
  // doesn't rot between deploys. Failures log and never affect the rest of the daemon.
  const memory = createMemory({
    memoryDir: buildPaths(config).memoryDir,
    logger: logger.child("memory"),
    git: true,
  });
  const memoryMaintenance = startRoutineMaintenance({
    maintain: (opts) => memory.maintain(opts),
    logger: logger.child("memory.maintain"),
  });

  logger.info("beckett v4 online", { liveWorkers: dispatcher.live().length, boards: [...pollers.keys()] });

  return { config, logger, client, clients, poller, pollers, prPoller, activityPoller, dispatcher, concierge, quick, memoryMaintenance };
}

/** Tear the system down in reverse boot order. Best-effort: one failure never blocks the rest. */
async function shutdown(sys: BootedSystem, signal: string): Promise<void> {
  sys.logger.info("shutting down beckett v3", { signal });
  sys.memoryMaintenance.stop();
  sys.prPoller?.stop();
  sys.activityPoller?.stop();
  for (const p of sys.pollers.values()) p.stop();
  try {
    const drain = await sys.dispatcher.drainForShutdown(signal, 20_000);
    if (drain.timedOut) {
      sys.logger.warn("dispatcher shutdown drain did not finish before deadline", { ...drain });
    }
  } catch (err) {
    sys.logger.warn("dispatcher shutdown drain failed", { error: (err as Error).message });
  }
  // Quick agents are ephemeral by contract — kill any stragglers before the Concierge goes down
  // so their "daemon shut down" results can still route through it.
  try {
    sys.quick.stopAll();
  } catch (err) {
    sys.logger.warn("quick-runner shutdown failed", { error: (err as Error).message });
  }
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
    rootLog.child("shell.v4").error("beckett v4 failed to start", { err: String(err) });
    process.exit(1);
  });
}

export { boot, shutdown, main, resolveRepoRoot };
export type { BootedSystem };
