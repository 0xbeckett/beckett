/**
 * Beckett — the shell entrypoint (`src/shell/main.ts`)
 * =======================================================================================
 * Boots the ticket-queue system and wires the four moving parts together:
 *
 *   1. Config + env — `loadConfig()` reads `~/.beckett/config.toml` (the `[tracker]` /
 *      `[concierge]` sections) and loads `~/.beckett/.env`.
 *   2. BoredClient — the only module that speaks HTTP to the loopback bored tracker
 *      (BECKETT_BORED_URL, default http://127.0.0.1:7770).
 *   3. Poller — polls bored every `config.tracker.poll_secs`, diffs snapshots, and
 *      hands each batch of {@link PollEvent}s to the dispatcher.
 *   4. Dispatcher — the state machine: spawns implement/review workers, steers them from
 *      ticket comments, aborts on cancel, advances ticket state on finish.
 *   5. Concierge — the long-lived `claude -p` Opus agent that owns Discord and files tickets.
 *
 * The Concierge and the poll→dispatch loop are independent: the Concierge writes tickets into
 * the tracker, the poller observes them, the dispatcher acts. They never call each other
 * directly — the tracker is the shared queue.
 *
 * Run it with `bun run v4` (see package.json) or `bun src/shell/main.ts`. The `v4` script name
 * and the `beckett-v4.service` unit are kept for continuity with the 4.0.0 multiplayer release;
 * only the file was renamed from `v4-main.ts` (see docs/ARCHITECTURE.md "Entrypoint & cutover").
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { log as rootLog } from "../log.ts";
import type { Config, Harness, Logger } from "../types.ts";
import type { Ticket } from "../tracker/types.ts";
import { projectSlug } from "../tracker/cast.ts";
import { createTrackerClient, type TrackerClient } from "../tracker/client.ts";
import { boredBaseUrl } from "../bored/client.ts";
import { createTrackerPoller, type TrackerPoller } from "../tracker/poll.ts";
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
import { RoutineStore } from "../routine/store.ts";
import { startRoutineScheduler, type RoutineScheduler } from "../routine/scheduler.ts";
import { LiveAgentRegistry } from "../agent/registry.ts";
import { createAgentRunner } from "../agent/invoke.ts";
import { TaskStore } from "../task/store.ts";
import { createBranchStatusService } from "../task/status.ts";
import { readLocalBranchStats } from "../git/branch-stats.ts";
import { reconcileTaskTickets } from "../task/reconcile.ts";
import { createAgentMailApi, defaultMailStateFile, safeMailError } from "../mail/index.ts";
import { createAgentMailPoller, defaultMailListenerStateFile, type AgentMailPoller } from "../mail/listener.ts";

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
 * per-user sessions. v4.2 adds per-CHANNEL sessions (OPS-80 §9.3): conversations in different
 * channels run concurrently through a bounded turn gate instead of queueing behind one global
 * session, and a DM's transcript is structurally partitioned from every guild channel's.
 * See CHANGELOG.md.
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
  client: TrackerClient;
  clients: Map<string, TrackerClient>;
  poller: TrackerPoller;
  pollers: Map<string, TrackerPoller>;
  prPoller: GitHubPrPoller | null;
  activityPoller: GitHubActivityPoller | null;
  mailPoller: AgentMailPoller | null;
  dispatcher: Dispatcher;
  concierge: Concierge;
  quick: QuickRunner;
  memoryMaintenance: { stop(): void };
  routineScheduler: RoutineScheduler;
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
    tracker: boredBaseUrl(),
    defaultBoard: config.tracker.default_board,
    boards: config.tracker.boards,
    pollSecs: config.tracker.poll_secs,
    conciergeModel: config.concierge.model,
    projectsRoot: PROJECTS_ROOT,
  });

  // bored serves ONE managed board per instance — poll only the default board.
  const activeBoards = [config.tracker.default_board];
  const clients = new Map<string, TrackerClient>();
  for (const board of activeBoards) {
    clients.set(board, createTrackerClient({ config, board, logger: logger.child(`tracker.client.${board}`) }));
  }
  const client = clients.get(config.tracker.default_board) ?? clients.values().next().value!;
  const clientByProjectId = new Map<string, TrackerClient>();
  const pollerByProjectId = new Map<string, TrackerPoller>();

  // Deterministic GitHub publishing: when a ticket reaches done, its project repo is pushed to
  // `0xbeckett/<slug>` (public) so the links Beckett hands out actually resolve — instead of
  // relying on the worker to push, which it skipped and left repos that 404'd. Built from the
  // GitHub identity; a missing PAT makes it undefined → the dispatcher skips publishing and says so.
  const identity = loadIdentity(config);
  const publishRepo = identity.github.pat
    ? async (a: { slug: string; repoRoot: string; description: string; ticket?: string; targetBranch?: string }) => {
        const gh = new GitHubCli({
          pat: identity.github.pat,
          account: identity.github.account,
          owner: identity.github.owner,
          apiBase: identity.github.apiBase,
          resolveRepoDir: () => a.repoRoot,
          logger: logger.child("gh"),
        });
        const r = await gh.ensurePublished({
          slug: a.slug,
          sourceDir: a.repoRoot,
          description: a.description,
          ticket: a.ticket,
          targetBranch: a.targetBranch,
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
  // One daemon-owned store serves bus recall and routine maintenance. Its warm graph/Moss handle
  // survives each short-lived `beckett recall` process.
  const memory = createMemory({
    memoryDir: paths.memoryDir,
    logger: logger.child("memory"),
    git: true,
    warm: true,
  });
  const tasks = new TaskStore(join(beckettDir, "tasks.json"));
  const syncTaskBranch = async (ticket: Ticket, board: string, snapshot = false): Promise<void> => {
    if (!ticket.branchRef) return;
    const branch = await tasks.syncTicket(ticket, board);
    if (!snapshot || !branch?.git?.workspace || !branch.git.baseSha) return;
    try {
      const stats = await readLocalBranchStats(branch.git.workspace, branch.git.baseSha);
      await tasks.setDiff(branch.ref, {
        additions: stats.additions,
        deletions: stats.deletions,
        files: stats.changedFiles,
        commits: stats.commits,
      });
    } catch (err) {
      logger.warn("task branch diff snapshot failed", { branch: branch.ref, error: String(err) });
    }
  };
  const githubReader = identity.github.pat
    ? new GitHubCli({
        pat: identity.github.pat,
        account: identity.github.account,
        owner: identity.github.owner,
        apiBase: identity.github.apiBase,
        resolveRepoDir: () => PROJECTS_ROOT,
        logger: logger.child("gh.read"),
      })
    : null;
  const prPoller: GitHubPrPoller | null = identity.github.pat
    ? createGitHubPrPoller({
        reader: githubReader!,
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
        reader: githubReader!,
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
  const concierge = createConcierge({
    config,
    logger: logger.child("concierge"),
    tracker: client,
    tasks,
    branchStatus: createBranchStatusService({
      store: tasks,
      ...(githubReader ? { github: githubReader } : {}),
      githubOwner: identity.github.owner,
    }),
    memory,
  });

  // 3. Pollers — one per board, all feeding the same dispatcher. `start()` primes the
  //    snapshot first (so we don't replay history) then self-schedules every poll_secs.
  //    Constructed BEFORE the dispatcher so the dispatcher's instant-advance path (issue #33)
  //    can reference the correct board poller.
  const pollers = new Map<string, TrackerPoller>();
  for (const [board, boardClient] of clients) {
    pollers.set(
      board,
      createTrackerPoller({
        client: boardClient,
        logger: logger.child(`tracker.poll.${board}`),
        pollSecs: config.tracker.poll_secs,
        commentCursorPath: join(
          beckettDir,
          board === config.tracker.default_board ? "comment-cursors.json" : `comment-cursors-${board}.json`,
        ),
        snapshotPath: join(
          beckettDir,
          board === config.tracker.default_board ? "poll-snapshot.json" : `poll-snapshot-${board}.json`,
        ),
      }),
    );
  }
  const poller = pollers.get(config.tracker.default_board) ?? pollers.values().next().value!;
  // Health-check the tracker and pre-resolve board routing before polling. Boards are
  // independent, so run their within-board sequential checks concurrently. Each request uses the
  // client's 429 Retry-After/exponential-backoff wrapper. Failures remain non-fatal so a temporary
  // tracker outage does not take Discord down; the poller retries through its normal client
  // bootstrap on later ticks.
  await Promise.all(
    [...clients].map(async ([board, boardClient]) => {
      try {
        await boardClient.ensureProvisioned();
        const info = await boardClient.projectInfo();
        clientByProjectId.set(info.projectId, boardClient);
        const boardPoller = pollers.get(board);
        if (boardPoller) pollerByProjectId.set(info.projectId, boardPoller);
        // Poller priming intentionally emits recovery events only for active work. Reconcile the
        // complete board here as well so terminal/parked changes made while offline cannot leave
        // the public task registry stale or a dependent permanently held.
        await reconcileTaskTickets(tasks, await boardClient.listIssues(), board, (ticket, err) => {
          logger.warn("task branch boot reconciliation failed", {
            branch: ticket.branchRef,
            error: String(err),
          });
        });
      } catch (err) {
        logger.warn("tracker board health-check/pre-resolution failed", { board, error: (err as Error).message });
      }
    }),
  );
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
    // OPS-167: append before relaying to Discord. `postDispatchEvent` is deliberately not awaited
    // by the bus, so gateway outages degrade to an on-disk timeline rather than blocking dispatch.
    dispatchEventsPath: join(paths.eventsDir, "dispatch.jsonl"),
    dispatchLiveSink: (event) => concierge.postDispatchEvent(event),
    runtimeStatePath: join(beckettDir, "dispatcher-state.json"),
    spendLedgerPath: paths.spend,
    // Harness health probe (issue #17): a dead harness (binary gone, login expired) becomes one
    // clear substitution comment instead of a wedged ticket. ~5-min cached per harness.
    preflight: (harness) => preflightFor(harness, config),
    onBeforePublish: async ({ ticket }) => {
      if (!ticket.branchRef) return;
      const board = clientByProjectId.get(ticket.projectId)?.board() ?? config.tracker.default_board;
      // Snapshot against the original task base before an owned-repo push rebases onto a parallel
      // branch that reached main first. This persisted aggregate survives worktree teardown.
      await syncTaskBranch(ticket, board, true);
    },
    // Instant milestone path (issue #33): a dispatcher-written advance reaches Discord NOW
    // (concierge.notify) instead of after the next poll, and the poller's snapshot is synced so
    // the same transition isn't re-emitted as a duplicate ping ≤5s later.
    onAdvance: async (event) => {
      (pollerByProjectId.get(event.ticket.projectId) ?? poller).observe(event);
      if (event.ticket.branchRef) {
        const board = clientByProjectId.get(event.ticket.projectId)?.board() ?? config.tracker.default_board;
        try {
          // Publication snapshots completed contributions before any rebase. State advances only
          // update lifecycle here so the accurate pre-publish aggregate is never overwritten.
          await syncTaskBranch(event.ticket, board);
        } catch (err) {
          logger.warn("task branch state sync failed", { branch: event.ticket.branchRef, error: String(err) });
        }
      }
      concierge.notify(event);
    },
    onPublished: async ({ url, kind, ticket }) => {
      if (!ticket.branchRef) return;
      try {
        await tasks.setPublication(ticket.branchRef, {
          repo: `${identity.github.owner}/${projectSlug(ticket.project || ticket.identifier)}`,
          url,
          kind,
        });
      } catch (err) {
        logger.warn("task branch publication sync failed", { branch: ticket.branchRef, error: String(err) });
      }
    },
    // OPS-124: a PR Beckett just opened → start watching it, routed to the ticket's origin channel.
    // Parse the repo+number from the PR URL; a non-PR URL yields null and is ignored. The poller
    // itself drops PRs outside our org and (at relay time) PRs with no origin channel.
    onPrOpened: async ({ prUrl, ticket }) => {
      const parsed = parsePrUrl(prUrl);
      if (!parsed) return;
      if (ticket.branchRef) {
        try {
          await tasks.setPullRequest(ticket.branchRef, { repo: parsed.repo, number: parsed.number, url: prUrl });
        } catch (err) {
          logger.warn("task branch PR sync failed", { branch: ticket.branchRef, error: String(err) });
        }
      }
      if (prPoller) {
        const taskThread = tasks.findByTicket(ticket.id)?.task.threadId;
        prPoller.watch({
          repo: parsed.repo,
          number: parsed.number,
          url: prUrl,
          title: ticket.title,
          ticket: ticket.identifier,
          channel: taskThread ?? ticket.originChannel,
        });
      }
    },
    onBranchWorkspace: ({ ticket, workspace, gitRef, baseSha }) => {
      if (!ticket.branchRef) return;
      void tasks.setGit(ticket.branchRef, {
        project: projectSlug(ticket.project || ticket.identifier),
        workspace,
        gitRef,
        baseSha,
      }).catch((err) => logger.warn("task branch Git sync failed", { branch: ticket.branchRef, error: String(err) }));
    },
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
    tracker: {
      baseUrl: boredBaseUrl(),
      defaultBoard: config.tracker.default_board,
      boards: Object.fromEntries([...clients].map(([board, c]) => [board, c.stats()])),
      ...client.stats(),
    },
  }));

  // Start the Concierge FIRST (of the live parts) so a bad claude launch fails the whole boot
  //    before we begin polling. (Constructed above so its progress sink could be wired in.)
  await concierge.start();
  if (prPoller) {
    for (const task of tasks.list()) {
      if (!task.threadId) continue;
      for (const branch of task.branches) {
        if (!branch.pullRequest || !branch.ticket) continue;
        prPoller.watch({
          repo: branch.pullRequest.repo,
          number: branch.pullRequest.number,
          url: branch.pullRequest.url,
          title: branch.title,
          ticket: branch.ticket.identifier,
          channel: task.threadId,
        });
      }
    }
  }
  await dispatcher.replayAdvances();
  await dispatcher.replayPublishes();
  await dispatcher.reconcileDependents();

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
        for (const event of events) {
          if (!event.ticket.branchRef) continue;
          void syncTaskBranch(event.ticket, board).catch((err) =>
            logger.warn("task branch poll sync failed", { branch: event.ticket.branchRef, error: String(err) })
          );
        }
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

  // OPS-173: AgentMail has no public daemon endpoint to register against (this service exposes
  // only its local Unix control socket), so use the durable polling fallback. The first poll is a
  // silent watermark; later IDs produce one queued SYSTEM turn through Concierge.notifyIncomingEmail.
  let mailPoller: AgentMailPoller | null = null;
  const agentMailApiKey = process.env.AGENTMAIL_API_KEY?.trim();
  if (agentMailApiKey) {
    try {
      mailPoller = createAgentMailPoller({
        api: createAgentMailApi(agentMailApiKey),
        inboxStateFile: defaultMailStateFile(beckettDir),
        stateFile: defaultMailListenerStateFile(beckettDir),
        onIncomingEmail: (email) => concierge.notifyIncomingEmail(email),
      });
      await mailPoller.start();
      logger.info("AgentMail incoming-email poller online");
    } catch (err) {
      // Email notify is additive: a transient AgentMail outage must not prevent Discord/tickets
      // from coming up. Keep SDK errors redacted just as the mail CLI does.
      logger.warn("AgentMail incoming-email poller failed to start", {
        error: safeMailError(err, agentMailApiKey),
      });
      mailPoller?.stop();
      mailPoller = null;
    }
  } else {
    logger.info("AgentMail incoming-email poller disabled (AGENTMAIL_API_KEY is not set)");
  }

  // Memory self-healing (OPS-121): one maintenance pass shortly after boot, then daily —
  // archives expired/superseded facts and merges near-duplicates so the knowledge graph
  // doesn't rot between deploys. Failures log and never affect the rest of the daemon.
  const memoryMaintenance = startRoutineMaintenance({
    maintain: (opts) => memory.maintain(opts),
    logger: logger.child("memory.maintain"),
  });

  // Agent registry (issue #66): reusable worker personas defined/added WITHOUT a daemon redeploy —
  // agents.json is read LIVE (defensively; a bad/partial file logs-and-skips, never crashes the
  // daemon) every time the concierge enumerates OR a routine invokes an agent. This is the runtime
  // discovery surface #55.3 builds on.
  const agentRegistry = new LiveAgentRegistry(join(beckettDir, "agents.json"), {
    logger: logger.child("agent"),
  });
  concierge.setAgentRegistry(agentRegistry);

  // The generic invoke-lane (issue #55/#72): runs ANY registered agent by its definition. The
  // routine dispatcher below uses it to run the `social-media` agent, which AUTHORS the post; the
  // routine never composes text itself. Adding a future agent is `beckett agent add` — this runner
  // already knows how to run it, no core edit.
  const agentRunner = createAgentRunner({ config, logger: logger.child("agent-run") });

  // Routines (issue #62): named recurring tasks with HUMANIZED fire times. The store is the
  // durable source of truth (routines.json, same atomic-write spirit as the task registry); the
  // scheduler ticks, rolls each period's fuzzed fire time once, persists it, and fires idempotently.
  // A firing routine's action is handed to the Concierge as an update turn: the Concierge
  // drives the persistent browser itself (`beckett browser`), so the scheduler never blocks
  // on browser work and the run stays observable in the Concierge's own session.
  const routineStore = new RoutineStore(join(beckettDir, "routines.json"));
  const routineScheduler = startRoutineScheduler({
    store: routineStore,
    logger: logger.child("routine"),
    dispatcher: {
      async dispatch(plan) {
        // Resolve the origin channel/requester at fire time from env so no id is baked into a
        // routine definition (BECKETT_ROUTINE_CHANNEL_ID / DISCORD_OWNER_ID).
        const channelId = plan.channelId ?? process.env.BECKETT_ROUTINE_CHANNEL_ID?.trim() ?? null;
        const requesterId = plan.requesterId ?? process.env.DISCORD_OWNER_ID?.trim() ?? null;
        if (!channelId || !requesterId) {
          throw new Error(
            "routine dispatch needs an origin channel + requester " +
              "(set BECKETT_ROUTINE_CHANNEL_ID and DISCORD_OWNER_ID, or the routine's channelId/requesterId)",
          );
        }

        // The task string posted to the browser lane. For the `browser` lane it's the routine's
        // static task; for the `agent` lane the agent AUTHORS it live (issue #55/#72).
        let browserTask = plan.browserTask;
        if (plan.lane === "agent") {
          if (!plan.agentId) throw new Error("agent-lane routine is missing an agentId");
          // Resolve the agent LIVE from the registry, so editing its prompt (or the routine's target
          // agent) takes effect with no redeploy. A removed/unknown agent fails loudly here.
          const def = agentRegistry.get(plan.agentId);
          if (!def) throw new Error(`routine references unknown agent: ${plan.agentId}`);
          const outcome = await agentRunner.run(def, plan.agentInput ?? "", { channelId, requesterId });
          if (outcome.state !== "done" || !outcome.output.trim()) {
            throw new Error(`agent ${plan.agentId} did not author a post: ${outcome.error ?? outcome.state}`);
          }
          browserTask = outcome.output.trim();
        }
        if (!browserTask) throw new Error("routine dispatch produced no browser task");

        // Hand the fire to the Concierge as an update turn. The Concierge works the task with
        // its own `beckett browser` hands: credentials come from the jingle entry NAMED by
        // credsEntry (vault-injected, never printed), blocking questions are ordinary channel
        // messages, and the confirmation back to the origin channel is its normal reply flow.
        await concierge.notifyRoutineFire(browserTask, {
          channelId,
          requesterId,
          credsEntry: plan.credsEntry ?? null,
        });
      },
    },
  });
  // Serve `beckett routine fire … --force` from the control bus (a real, live dispatch). The
  // dry-run path is CLI-local (build the plan, no daemon) so it can prove wiring with no post.
  concierge.setRoutineOps({
    fire: (id, opts) => routineScheduler.fireNow(id, opts),
  });
  // Prime once shortly after boot so a routine whose window is live right now is caught up
  // without waiting a full tick. Best-effort; failures are logged inside the scheduler.
  setTimeout(() => void routineScheduler.tick().catch(() => {}), 5_000).unref?.();

  logger.info("beckett v4 online", { liveWorkers: dispatcher.live().length, boards: [...pollers.keys()] });

  return { config, logger, client, clients, poller, pollers, prPoller, activityPoller, mailPoller, dispatcher, concierge, quick, memoryMaintenance, routineScheduler };
}

/** Tear the system down in reverse boot order. Best-effort: one failure never blocks the rest. */
async function shutdown(sys: BootedSystem, signal: string): Promise<void> {
  sys.logger.info("shutting down beckett v3", { signal });
  sys.routineScheduler.stop();
  sys.memoryMaintenance.stop();
  sys.prPoller?.stop();
  sys.activityPoller?.stop();
  sys.mailPoller?.stop();
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
    await sys.quick.stopAll();
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
