/**
 * Beckett v6 — the routines extension (`src/capability/modules/routines.ts`)
 * =======================================================================================
 * Phase 3b of the v6 migration (docs/v6-architecture.md §6): the routines organ — named
 * recurring tasks with HUMANIZED fire times (issue #62) — on the extension contract,
 * following the Phase 2 browser.ts shape. This is the first organ whose `lifecycle.start`
 * runs a BACKGROUND LOOP under registry orchestration, and the first `startPhase: "late"`
 * organ: a firing routine dispatches INTO the live system (agent registry/runner + the
 * background browser lane), so its cron loop must arm only after the whole system is up —
 * the sanctioned late `startAll` position in `shell/main.ts`.
 *
 *   - `init` builds the durable {@link RoutineStore} and the scheduler's deps INERT — no
 *     interval is armed, nothing ticks. The CLI process registers this extension too (for
 *     the verb projection) but never runs any lifecycle hook.
 *   - `start` (late sweep) arms the cron loop via `startRoutineScheduler` — whose internals
 *     are untouched by this migration; only its call site moved here — plus the 5s post-boot
 *     prime tick, verbatim from the old boot wiring. Re-entry is a no-op (no double interval).
 *   - `stop` is idempotent: clears the prime, stops the loop, and allows a clean re-start.
 *     It rides the registry teardown sweep in `shell/main.ts` — AFTER the pollers stop, a
 *     sanctioned beat later than the old hand-wired first-line stop (a cron clearInterval
 *     there is accepted; per-period idempotency protects against any straggler tick).
 *   - `health` reports loop liveness, the routine census, and the next concrete fire.
 *
 * The dispatcher closure moved here from `shell/main.ts` byte-identically; its dependencies
 * (browser agent, agent registry/runner, the env-resolved fallback origin) are injected as
 * LAZY accessors resolved at FIRE time — the daemon constructs some of them after the
 * extension registers, and the late start guarantees they exist before the first fire.
 *
 * The CLI `routine` verb IS carried here (like quick's — its body binds no concierge state)
 * and projects into its existing `cli/beckett.ts` spine slot via `asCapability`, so the
 * pinned help token and every usage/failure string stay byte-identical. The concierge's
 * `routine.fire` bus command body stays in the concierge (it binds `routineOps`); only its
 * backing `fire()` is re-sourced from this extension's scheduler accessor.
 */

import { join } from "node:path";
import { z } from "zod";
import { ActionClass, type Extension, type ExtensionContext } from "../../ext/contract.ts";
import { RoutineStore } from "../../routine/store.ts";
import {
  startRoutineScheduler,
  type RoutineScheduler,
  type RoutineSchedulerDeps,
} from "../../routine/scheduler.ts";
import { buildDispatchPlan, type RoutineDispatchPlan } from "../../routine/plan.ts";
import { nextFireAt, isValidTimeZone } from "../../routine/schedule.ts";
import type { Routine } from "../../routine/types.ts";
import type { AgentDefinition, AgentRunner } from "../../agent/index.ts";
import type { BrowserAgent } from "../../browser/agent.ts";
import { callBus } from "../../shell/control-bus.ts";
import { fail, out, parse } from "../../cli/io.ts";

/**
 * What the daemon injects beyond {@link ExtensionContext}: the dispatch closure's
 * dependencies, as LAZY accessors resolved at fire time (the same DI spirit as browser.ts's
 * keychain/onQuestion/onOutcome, made lazy because the daemon constructs the agent
 * registry/runner AFTER the extension registers — the late start keeps fires behind them).
 * All optional: the CLI registers with `{}` (its process never starts the scheduler; a real
 * fire routes through the bus), and an unwired dispatch fails loudly at fire time.
 */
export interface RoutinesExtensionDeps {
  /** The background browser lane a fire posts through (issue #50/#58). */
  browserAgent?: () => Pick<BrowserAgent, "run">;
  /** The live agent registry — agent-lane routines resolve their author agent at fire time. */
  agentRegistry?: () => { get(id: string): AgentDefinition | null };
  /** The generic invoke-lane runner that runs the resolved agent (issue #55/#72). */
  agentRunner?: () => Pick<AgentRunner, "run">;
  /**
   * Fire-time fallback origin for a routine that names no channel/requester. The daemon binds
   * this to env (BECKETT_ROUTINE_CHANNEL_ID / DISCORD_OWNER_ID) so no id is baked into a
   * routine definition and the extension itself stays env-free.
   */
  defaultOrigin?: () => { channelId: string | null; requesterId: string | null };
  /** Test seams — the scheduler's injectable clock/RNG/cadence (see {@link RoutineSchedulerDeps}). */
  now?: () => Date;
  rng?: () => number;
  intervalMs?: number;
  createStore?: (ctx: ExtensionContext) => RoutineStore;
  createScheduler?: (deps: RoutineSchedulerDeps) => RoutineScheduler;
}

/** The built extension plus the accessors `shell/main.ts` wires into the concierge's v5 setters. */
export interface RoutinesExtension extends Extension {
  /** The daemon-owned durable routine store. Throws before `lifecycle.init` has run. */
  store(): RoutineStore;
  /** The live cron scheduler. Throws before `lifecycle.start` (the late sweep) has run. */
  scheduler(): RoutineScheduler;
}

// ── shared display helpers (moved verbatim from cli/beckett.ts) ─────────────────────────────

/** "12:34 America/Los_Angeles on 2026-07-20" — a routine's next concrete fire, humanized. */
function describeNextFire(routine: Routine): string {
  const at = nextFireAt(routine.schedule, routine.state, new Date(), Math.random);
  const tz = routine.schedule.window.tz;
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(at);
  const rolled = routine.state.periodKey && routine.state.chosenFireAt ? "" : " (window; exact time not rolled yet)";
  return `${local} ${tz}${rolled}`;
}

function summarizeRoutine(routine: Routine): Record<string, unknown> {
  const w = routine.schedule.window;
  return {
    id: routine.id,
    name: routine.name,
    builtin: routine.builtin,
    enabled: routine.enabled,
    action: routine.action.kind,
    cadence: routine.schedule.cadence.kind,
    window: `${w.start}-${w.end} ${w.tz}`,
    nextFire: describeNextFire(routine),
    lastFiredAt: routine.state.lastFiredAt ?? null,
  };
}

// ── v6 invocation schemas ──────────────────────────────────────────────────────────────────

const InspectArgs = z.object({
  id: z.string().trim().min(1, "routines.inspect needs a routine id"),
});

const AddArgs = z.object({
  id: z.string().trim().min(1, "a routine needs an id"),
  /** 24h HH:MM-HH:MM — the daily window the fuzzed fire time is rolled inside. */
  window: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "window must look like 12:00-13:00 (24h HH:MM-HH:MM)"),
  tz: z.string().refine(isValidTimeZone, "tz must be a valid IANA timezone, e.g. America/Los_Angeles"),
  task: z.string().trim().min(1, "a routine needs a self-contained browser task"),
  name: z.string().optional(),
  /** jingle keychain entry NAME the browser lane injects at fire time — never a secret value. */
  credsEntry: z.string().optional(),
  /** Where fires report. May only restate the origin's channel, never redirect it. */
  channelId: z.string().optional(),
});

const RemoveArgs = z.object({
  id: z.string().trim().min(1, "routines.remove needs a routine id"),
});

const FireArgs = z.object({
  id: z.string().trim().min(1, "routines.fire needs a routine id"),
  /** Bypass per-period idempotency (a real re-fire). */
  force: z.boolean().optional(),
  /** Build and return the dispatch plan WITHOUT running the agent or posting. */
  dryRun: z.boolean().optional(),
});

export const createRoutinesExtension =
  (deps: RoutinesExtensionDeps) =>
  (ctx: ExtensionContext): RoutinesExtension => {
    // Built by lifecycle.init; the scheduler is armed only by lifecycle.start (late sweep).
    let store: RoutineStore | null = null;
    let schedulerDeps: RoutineSchedulerDeps | null = null;
    let scheduler: RoutineScheduler | null = null;
    let primeTimer: ReturnType<typeof setTimeout> | null = null;

    function requireStore(): RoutineStore {
      if (!store) throw new Error("the routines extension is not initialized (lifecycle.init has not run)");
      return store;
    }
    function requireScheduler(): RoutineScheduler {
      if (!scheduler) throw new Error("the routine scheduler is not started (lifecycle.start has not run)");
      return scheduler;
    }

    /**
     * The dispatch executor, moved from `shell/main.ts` byte-identically (messages and check
     * order preserved). Runs OFF the scheduler's tick path — the scheduler never blocks on
     * browser work. Resolution of every dependency is deferred to HERE, fire time.
     */
    async function dispatchPlan(plan: RoutineDispatchPlan): Promise<void> {
      // Resolve the origin channel/requester at fire time (the daemon binds this to
      // BECKETT_ROUTINE_CHANNEL_ID / DISCORD_OWNER_ID) so no id is baked into a routine.
      const fallback = deps.defaultOrigin?.() ?? { channelId: null, requesterId: null };
      const channelId = plan.channelId ?? fallback.channelId;
      const requesterId = plan.requesterId ?? fallback.requesterId;
      if (!channelId || !requesterId) {
        throw new Error(
          "routine dispatch needs an origin channel + requester " +
            "(set BECKETT_ROUTINE_CHANNEL_ID and DISCORD_OWNER_ID, or the routine's channelId/requesterId)",
        );
      }
      if (!deps.browserAgent || !deps.agentRegistry || !deps.agentRunner) {
        // Only reachable in a process that armed the scheduler without the daemon's deps —
        // the CLI never starts it, and the daemon always injects all three.
        throw new Error("routine dispatch is not wired (the daemon injects the browser lane + agent registry/runner)");
      }

      // The task string posted to the browser lane. For the `browser` lane it's the routine's
      // static task; for the `agent` lane the agent AUTHORS it live (issue #55/#72).
      let browserTask = plan.browserTask;
      if (plan.lane === "agent") {
        if (!plan.agentId) throw new Error("agent-lane routine is missing an agentId");
        // Resolve the agent LIVE from the registry, so editing its prompt (or the routine's target
        // agent) takes effect with no redeploy. A removed/unknown agent fails loudly here.
        const def = deps.agentRegistry().get(plan.agentId);
        if (!def) throw new Error(`routine references unknown agent: ${plan.agentId}`);
        const outcome = await deps.agentRunner().run(def, plan.agentInput ?? "", { channelId, requesterId });
        if (outcome.state !== "done" || !outcome.output.trim()) {
          throw new Error(`agent ${plan.agentId} did not author a post: ${outcome.error ?? outcome.state}`);
        }
        browserTask = outcome.output.trim();
      }
      if (!browserTask) throw new Error("routine dispatch produced no browser task");

      // Post via the PRIVILEGED in-process browser lane — the routine holds the channel/requester
      // authorization, so a headless run can post without a Discord mention token. Credential
      // injection (from the jingle entry NAMED by credsEntry), the X verification pause/resume,
      // and the confirmation back to the origin channel are all the browser agent's job (issue #50).
      await deps.browserAgent().run(browserTask, {
        channelId,
        requesterId,
        credsEntry: plan.credsEntry,
      });
    }

    /**
     * The carried v5 CLI verb — `cli/beckett.ts::runRoutine` moved verbatim (the CLI
     * characterization suite pins the help token; every usage/`fail` string is preserved).
     * `out`/`fail` are CLI-surface only: this run function is dispatched by the CLI spine in a
     * `beckett` process, never by the daemon — daemon dispatch goes through `invoke` below.
     * It reads a FRESH store per call (CLI-process semantics, same as the task registry) and
     * routes a real fire through the bus, exactly as before.
     */
    function cliRoutineStore(): RoutineStore {
      return new RoutineStore(join(ctx.paths.beckettDir, "routines.json"));
    }

    async function runRoutine(argv: string[]): Promise<void> {
      const sock = join(ctx.paths.beckettDir, "control.sock");
      const [sub, ...rest] = argv;
      const store = cliRoutineStore();

      if (!sub || sub === "list") {
        const routines = await store.list();
        out(routines.map(summarizeRoutine));
      }

      if (sub === "inspect") {
        const id = rest[0];
        if (!id) fail("usage: beckett routine inspect <id>");
        const routine = await store.get(id!);
        if (!routine) fail(`no such routine: ${id}`);
        out({ ...summarizeRoutine(routine!), state: routine!.state, createdAt: routine!.createdAt });
      }

      if (sub === "add") {
        const { _, flags } = parse(rest);
        const id = _[0];
        if (!id) {
          fail('usage: beckett routine add <id> --window 12:00-13:00 --tz <IANA> --task "<browser task>" [--name <n>] [--creds <entry>] [--channel <id>]');
        }
        const windowRaw = String(flags.window ?? "");
        const m = windowRaw.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
        if (!m) fail("--window must look like 12:00-13:00 (24h HH:MM-HH:MM)");
        const tz = String(flags.tz ?? "");
        if (!tz || !isValidTimeZone(tz)) fail("--tz must be a valid IANA timezone, e.g. America/Los_Angeles");
        const task = flags.task ? String(flags.task) : "";
        if (!task.trim()) fail('a routine needs a --task "<self-contained browser task>"');
        try {
          const routine = await store.add({
            id: id!,
            name: flags.name ? String(flags.name) : id!,
            enabled: true,
            action: {
              kind: "browser",
              task,
              credsEntry: flags.creds ? String(flags.creds) : undefined,
              channelId: flags.channel ? String(flags.channel) : undefined,
            },
            schedule: {
              cadence: { kind: "daily" },
              window: { start: m[1]!, end: m[2]!, tz },
            },
          });
          out(summarizeRoutine(routine));
        } catch (err) {
          fail((err as Error).message);
        }
      }

      if (sub === "remove" || sub === "rm") {
        const id = rest[0];
        if (!id) fail("usage: beckett routine remove <id>");
        const removed = await store.remove(id!);
        if (!removed) fail(`no such routine: ${id}`);
        out(`removed routine ${id}`);
      }

      if (sub === "enable" || sub === "disable") {
        const id = rest[0];
        if (!id) fail(`usage: beckett routine ${sub} <id>`);
        try {
          const routine = await store.setEnabled(id!, sub === "enable");
          out(summarizeRoutine(routine));
        } catch (err) {
          fail((err as Error).message);
        }
      }

      if (sub === "fire") {
        const { _, flags } = parse(rest);
        const id = _[0];
        if (!id) fail("usage: beckett routine fire <id> [--dry-run | --force]");
        const dryRun = flags["dry-run"] === true || flags.dryrun === true;
        const force = flags.force === true;
        const routine = await store.get(id!);
        if (!routine) fail(`no such routine: ${id}`);
        if (dryRun) {
          // Build the exact dispatch plan WITHOUT running the agent or posting — proves the wiring,
          // no live post. For the agent lane the post text is authored at fire time, so it's not shown.
          const plan = buildDispatchPlan(routine!);
          out({
            dryRun: true,
            routine: id,
            lane: plan.lane,
            wouldDispatchTo:
              plan.lane === "agent"
                ? `invoke agent ${plan.agentId} → beckett browser (background lane)`
                : "beckett browser (background lane)",
            preview: plan.preview,
            agentId: plan.agentId,
            agentInput: plan.agentInput,
            credsEntry: plan.credsEntry,
            browserTask: plan.browserTask,
            note: "dry-run did NOT run the agent or post. To fire for real: beckett routine fire " + id + " --force",
          });
        }
        // A real fire routes through the daemon so it dispatches on the browser lane, off this process.
        try {
          const res = await callBus(sock, "routine.fire", { id, force }, 30_000);
          if (!res.ok) fail(res.error ?? "routine fire failed");
          out(res.data);
        } catch (err) {
          fail((err as Error).message);
        }
      }

      fail(
        "usage: beckett routine list | inspect <id> | add <id> ... | remove <id> | enable <id> | disable <id> | fire <id> [--dry-run|--force]",
      );
    }

    return {
      manifest: {
        id: "routines",
        version: "1.0.0",
        // The v5 spine literal's exact summary — asCapability projects it into the CLI slot.
        summary: "humanized recurring routines: add/list/remove/inspect + fire (dry-run or --force)",
        // Default FREE (matches the v5 spine slot the projection must reproduce); every
        // mutating capability overrides to a non-FREE posture below.
        actionClass: ActionClass.FREE,
        kind: "extension",
      },

      // --- v6 discovery + dispatch (router prose sourced from the routine module docs) ---
      capabilities: [
        {
          id: "routines.list",
          description:
            "List every named recurring routine — enabled state, its daily fuzz window, and " +
            "the next concrete fire time, humanized. Use when someone asks what is scheduled, " +
            "what runs daily, or when a routine fires next.",
          examples: ["what routines are scheduled?", "when does the daily post fire?"],
        },
        {
          id: "routines.inspect",
          description:
            "Inspect one routine by id: its definition plus the persisted per-period state " +
            "(the rolled fire time, the last-fired period). Use to debug why a routine did or " +
            "did not fire.",
          input: InspectArgs,
          examples: ["did the daily-x-shitpost routine fire today?"],
        },
        {
          id: "routines.add",
          description:
            "Schedule a NEW named recurring routine: a self-contained browser task that fires " +
            "once per day at a fuzzed time inside a 24h HH:MM-HH:MM window in a given IANA " +
            "timezone, dispatched through the background browser lane. Use when someone asks " +
            "for something to happen every day (\"post this daily around noon\").",
          actionClass: ActionClass.HANDSHAKE_GATED,
          input: AddArgs,
          examples: ["every day between 12:00 and 13:00 PT, check the status page and post a summary"],
        },
        {
          id: "routines.remove",
          description:
            "Remove a routine by id so it never fires again (a removed built-in stays removed). " +
            "Use for \"stop the daily post\" / \"cancel that routine\".",
          actionClass: ActionClass.HANDSHAKE_GATED,
          input: RemoveArgs,
          examples: ["stop the daily shitpost routine"],
        },
        {
          id: "routines.fire",
          description:
            "Fire a named routine NOW through the live scheduler instead of waiting for its " +
            "window — dryRun builds and returns the dispatch plan without running the agent or " +
            "posting; force bypasses the once-per-period guard. A real fire dispatches on the " +
            "background browser lane under the routine's stored authorization.",
          actionClass: ActionClass.ALWAYS_ASK,
          input: FireArgs,
          examples: ["run the daily post now instead of waiting for the window"],
        },
      ],

      // Routes to the SAME store/scheduler core the CLI verbs and the routine.fire bus command
      // use, and NEVER exits the process: every failure — including a pre-init/pre-start call —
      // comes back as an ok:false result the caller can surface.
      invoke: async (call) => {
        try {
          switch (call.capabilityId) {
            case "routines.list": {
              const routines = await requireStore().list();
              return { ok: true, data: { routines: routines.map(summarizeRoutine) } };
            }
            case "routines.inspect": {
              const a = call.args as z.infer<typeof InspectArgs>;
              const routine = await requireStore().get(a.id);
              if (!routine) return { ok: false, error: `no such routine: ${a.id}` };
              return {
                ok: true,
                data: { ...summarizeRoutine(routine), state: routine.state, createdAt: routine.createdAt },
              };
            }
            case "routines.add": {
              // Defense in depth, the same rule as browser.task: identity comes from the
              // token-derived origin (the ext.invoke gate already refuses unauthenticated
              // non-FREE calls; this backstops a future direct caller).
              if (!call.origin?.userId) {
                return { ok: false, error: "routine changes need an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof AddArgs>;
              // A report channel may only RESTATE the origin channel, never redirect a
              // routine's fires somewhere the authorized request was not made (quick's rule).
              const requestedChannelId = a.channelId?.trim();
              if (requestedChannelId && call.origin.channelId && requestedChannelId !== call.origin.channelId) {
                return { ok: false, error: "routines must report to the channel where the authorized request began" };
              }
              const m = a.window.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/)!;
              const routine = await requireStore().add({
                id: a.id,
                name: a.name?.trim() || a.id,
                enabled: true,
                action: {
                  kind: "browser",
                  task: a.task,
                  ...(a.credsEntry ? { credsEntry: a.credsEntry } : {}),
                  ...(requestedChannelId ? { channelId: requestedChannelId } : {}),
                },
                schedule: {
                  cadence: { kind: "daily" },
                  window: { start: m[1]!, end: m[2]!, tz: a.tz },
                },
              });
              return { ok: true, data: summarizeRoutine(routine) };
            }
            case "routines.remove": {
              if (!call.origin?.userId) {
                return { ok: false, error: "routine changes need an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof RemoveArgs>;
              const removed = await requireStore().remove(a.id);
              if (!removed) return { ok: false, error: `no such routine: ${a.id}` };
              return { ok: true, data: { removed: a.id } };
            }
            case "routines.fire": {
              if (!call.origin?.userId) {
                return { ok: false, error: "firing a routine needs an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof FireArgs>;
              // The LIVE scheduler (armed by the late start) — a dry run still builds the plan
              // through it so fireNow's semantics stay the single source of truth.
              const plan = await requireScheduler().fireNow(a.id, {
                ...(a.force !== undefined ? { force: a.force } : {}),
                ...(a.dryRun !== undefined ? { dryRun: a.dryRun } : {}),
              });
              return {
                ok: true,
                data: {
                  routineId: plan.routineId,
                  lane: plan.lane,
                  preview: plan.preview,
                  credsEntry: plan.credsEntry,
                  dryRun: a.dryRun === true,
                },
              };
            }
            default:
              return { ok: false, error: `routines: unknown capability "${call.capabilityId}"` };
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      lifecycle: {
        // A firing routine dispatches INTO the live system — the cron loop must arm at the
        // daemon's sanctioned LATE position (after pollers/mail/agents), never the early sweep.
        startPhase: "late",
        // Construction only — the store (durable routines.json) plus the scheduler's deps,
        // fully INERT: no interval armed, nothing ticks until start().
        init: () => {
          store =
            deps.createStore?.(ctx) ?? new RoutineStore(join(ctx.paths.beckettDir, "routines.json"));
          schedulerDeps = {
            store,
            logger: ctx.logger.child("routine"),
            dispatcher: { dispatch: (plan) => dispatchPlan(plan) },
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.rng ? { rng: deps.rng } : {}),
            ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
          };
        },
        // Arms the loop exactly as the old boot did: startRoutineScheduler (interval armed at
        // construction, internals untouched) + the 5s post-boot prime so a routine whose
        // window is live right now is caught up without waiting a full tick. Re-entry is a
        // no-op — a second sweep must never arm a second interval (redundant roll/persist
        // churn; per-period idempotency would still prevent a double FIRE).
        start: () => {
          if (scheduler) return;
          if (!schedulerDeps) {
            throw new Error("the routines extension is not initialized (lifecycle.init has not run)");
          }
          const started = deps.createScheduler?.(schedulerDeps) ?? startRoutineScheduler(schedulerDeps);
          scheduler = started;
          // Prime once shortly after boot. Best-effort; failures are logged inside the scheduler.
          primeTimer = setTimeout(() => void started.tick().catch(() => {}), 5_000);
          primeTimer.unref?.();
        },
        // Idempotent: clears the prime + interval; a later start() may re-arm cleanly.
        stop: () => {
          if (primeTimer) {
            clearTimeout(primeTimer);
            primeTimer = null;
          }
          scheduler?.stop();
          scheduler = null;
        },
        health: async () => {
          if (!store) return { ok: false, detail: "not initialized" };
          try {
            const routines = await store.list();
            const enabled = routines.filter((r) => r.enabled);
            const at = (deps.now ?? (() => new Date()))();
            const rng = deps.rng ?? Math.random;
            let next: Date | null = null;
            for (const routine of enabled) {
              const fire = nextFireAt(routine.schedule, routine.state, at, rng);
              if (!next || fire.getTime() < next.getTime()) next = fire;
            }
            return {
              ok: true,
              detail:
                `scheduler ${scheduler ? "running" : "idle"}; ` +
                `${enabled.length}/${routines.length} routines enabled` +
                (next ? `; next fire ${next.toISOString()}` : ""),
            };
          } catch (err) {
            return { ok: false, detail: (err as Error).message };
          }
        },
      },

      // --- carried v5 facets: the CLI verb + its pinned help token, projected into the same
      // cli/beckett.ts spine slot via asCapability. The routine.fire bus command stays
      // concierge-owned (its body binds this.routineOps — see the header).
      cliVerbs: [
        {
          name: "routine",
          summary: "named recurring tasks that fire at a fuzzed time inside a daily window",
          usage:
            'beckett routine list | inspect <id> | add <id> --window 12:00-13:00 --tz <IANA> --task "<task>" [--creds <entry>] | remove <id> | enable|disable <id> | fire <id> [--dry-run|--force]',
          run: runRoutine,
        },
      ],
      busCommands: [],
      cliHelp: "routine list|inspect|add|remove|fire",

      store: requireStore,
      scheduler: requireScheduler,
    };
  };
