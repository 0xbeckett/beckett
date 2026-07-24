/**
 * Beckett v6 — the memory extension (`src/capability/modules/memory.ts`)
 * =======================================================================================
 * Phase 6 — the LAST organ (docs/v6-architecture.md §6-§7): the markdown memory graph on the
 * full extension contract. A pure re-home of the working organ:
 *
 *   - `lifecycle.init` builds the ONE daemon-owned warm {@link MemoryStore} (the store
 *     `shell/main.ts` used to hand-wire): warm graph + Moss handle survive each short-lived
 *     `beckett recall` process. Exposed through the {@link MemoryExtension.store} accessor so
 *     every daemon consumer (the concierge's `memory.recall` bus body, routine maintenance)
 *     re-sources the SAME store — never a second warm graph.
 *   - `start` (startPhase "late") arms the nightly self-healing maintain loop exactly where
 *     the boot used to start it (after pollers/mail — its passes write, and writes must never
 *     race the boot burst); `stop` stills it and settles any write-behind remembers.
 *   - `health` reports store/loop state (NET-NEW — no memory doctor probe existed).
 *
 * The two §7 HARD constraints live HERE, in memory code, and nowhere upstream:
 *
 *   - **Visibility stays fail-closed and code-enforced inside memory.** The `memory.recall` /
 *     `memory.remember` capabilities take NO viewer/viewerRole/context args (the schemas are
 *     `.strict()` so a caller passing them is refused loudly): the {@link Audience} is derived
 *     in {@link audienceFromOrigin} from the TOKEN-DERIVED `call.origin` the `ext.invoke` gate
 *     stamped. Wave-4 cautionary tale, binding: a discarded draft let invoke callers
 *     self-claim `viewerRole:"owner"` and round-trip `--as-self` through argv — an audience
 *     escalation. Origin-bound means: viewerId is `origin.userId` or nothing; owner role only
 *     when that id IS the daemon-configured owner id; and because the origin carries no
 *     DM/guild signal today, `context` is pinned to `"guild"` — a dm-scoped fact can NEVER
 *     surface through `ext.invoke` (fail-closed beats clever). `SELF_AUDIENCE` is never
 *     granted here: `origin.surface` is caller-supplied provenance, not identity.
 *     Writes are gated the same way: on the invoke path scoping is CREATE-ONLY (a
 *     `visibility`/`dmWith` arg aimed at an already-existing node is refused for every
 *     caller — even the owner, so a prompt-injected FREE call riding the owner's turn can't
 *     flip a scoped node public), and an update to a node the origin-derived audience cannot
 *     `canView` is refused outright (no body tamper / provenance overwrite on a scoped fact).
 *   - **Recall never blocks a turn on writes.** `memory.remember` is write-behind: invoke
 *     validates, then hands the intent to the store (whose own writeChain serializes it and
 *     git-commits) and returns WITHOUT awaiting — reads keep `await registry.invoke(...)`,
 *     writes stay fire-and-forget inside the extension (§7). Failures log; `settled()` lets
 *     tests and the teardown sweep await the tail.
 *
 * The CLI facets — `beckett recall …` (OPS-121) and `beckett memory recall|remember|show|
 * maintain …` — are carried byte-identically from the thin Phase 4 module; the CLI process
 * registers this extension but never runs a lifecycle hook, so no warm store or timer ever
 * exists there (cold per-call stores, exactly the legacy behavior).
 */

import { z } from "zod";
import {
  ActionClass,
  type Extension,
  type ExtensionContext,
  type ExtensionInvocation,
} from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { createMemory, type MemoryStore } from "../../memory/index.ts";
import {
  type Audience,
  canView,
  provenanceOf,
  renderProvenanceFrom,
  IdSchema,
  VisibilitySchema,
} from "../../memory/search.ts";
import {
  parseRecallCliRequest,
  recallCliOutput,
  type RecallCliRequest,
} from "../../memory/recall-cli.ts";
import { startRoutineMaintenance } from "../../memory/maintain.ts";
import { fail, out, parse } from "../../cli/io.ts";
import type { MemoryNode, NodeType, RememberIntent } from "../../types.ts";

/**
 * Build the provenance/visibility metadata a `remember` write carries (multiplayer §7), THROWING
 * the historical message on a bad value. Only fields actually passed produce keys — an absent
 * field writes nothing, so the engine merge preserves existing scope on an update. Reached from
 * the CLI wrapper via {@link provenanceMetadataFromFlags}, which catches → `fail`, and from the
 * `memory.remember` invoke (which never passes `by`/`byName` — the writer is origin-stamped).
 */
function buildProvenanceMetadata(input: {
  visibility?: string;
  dmWith?: string;
  by?: string;
  byName?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  // Same id/visibility shapes the engine enforces (search.ts) — validate against them, don't
  // re-hand-roll the regex/enum here.
  const asId = (flag: string, raw: string): string => {
    const parsed = IdSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`--${flag} must be a Discord user id (1–20 digits)`);
    return parsed.data;
  };
  if (input.visibility !== undefined) {
    const vis = VisibilitySchema.safeParse(input.visibility);
    if (!vis.success) throw new Error("--visibility must be one of: public, owner, dm");
    if (vis.data === "dm" && input.dmWith === undefined) {
      throw new Error("--visibility dm requires --dm-with <discordUserId>");
    }
    meta.visibility = vis.data;
  }
  if (input.dmWith !== undefined) meta.dm_with = asId("dm-with", input.dmWith);
  if (input.by !== undefined) meta.source_user = asId("by", input.by);
  if (input.byName !== undefined) meta.source_name = input.byName;
  return meta;
}

/** The CLI adapter: read the flags, run the shared core, adapt a throw to the historical `fail`. */
function provenanceMetadataFromFlags(flags: Record<string, string | boolean>): Record<string, unknown> {
  try {
    return buildProvenanceMetadata({
      visibility: flags.visibility !== undefined ? String(flags.visibility) : undefined,
      dmWith: flags["dm-with"] !== undefined ? String(flags["dm-with"]) : undefined,
      by: flags.by !== undefined ? String(flags.by) : undefined,
      byName: flags["by-name"] !== undefined ? String(flags["by-name"]) : undefined,
    });
  } catch (err) {
    fail((err as Error).message);
  }
}

// ── v6 invocation schemas ──────────────────────────────────────────────────────────────────
// Both are `.strict()`: the schemas accept NO audience-shaped input (viewer, viewerRole,
// asSelf, context, by, …) — a caller trying to smuggle one is refused at the seam instead of
// silently stripped, so an attempted audience escalation is loud (the wave-4 lesson).

const RecallArgs = z
  .object({
    /** What to look up — same free-text query as `beckett recall "<query>"`. */
    query: z.string().trim().optional(),
    /** Comma-separated node types, the `--type person,project` narrowing. */
    types: z.string().trim().optional(),
    /** Comma-separated node names, the `--name <node>,...` narrowing. */
    names: z.string().trim().optional(),
    k: z.number().int().positive().optional(),
    hops: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((a) => Boolean(a.query) || Boolean(a.types) || Boolean(a.names), {
    message: "memory.recall needs a query (or a types/names filter)",
  });

const KEBAB_NAME = /^[a-z0-9-]+$/;

const RememberArgs = z
  .object({
    name: z.string().regex(KEBAB_NAME, "a memory node name is kebab-case (a-z0-9 and dashes)"),
    op: z.enum(["create", "update", "append", "link"]).optional(),
    type: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    body: z.string().optional(),
    links: z
      .array(
        z
          .object({
            to: z.string().regex(KEBAB_NAME, "a link target is a kebab-case node name"),
            field: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Node scope for the write. Absent ⇒ an update preserves the existing scope. */
    visibility: VisibilitySchema.optional(),
    /** The DM partner id — required with visibility "dm" (checked by the shared core). */
    dmWith: z.string().optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

/** The comma-separated list shape shared with the CLI's `--type`/`--name` flags. */
function csvList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** The engine's alias-comparison normalization (index.ts `slug`), mirrored for the gate below. */
function slugName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve the node an invoke-path remember would MERGE INTO, by IDENTITY: an exact non-phantom
 * name hit or an alias hit — the same identity arms as the engine's `findExisting`
 * (`memory/index.ts`). Identity matches are exactly the dangerous set for the write gates in
 * the `memory.remember` invoke: the engine's `mergeInto` is explicit-flag-wins over existing
 * metadata, so an identity hit is where a caller-supplied `visibility`/`dmWith` could rewrite
 * an existing node's scope. The other `findExisting` arms are safe by construction: a phantom
 * fill-in has no content or scope yet (it IS a create), and the similarity arm only matches a
 * node whose effective scope already equals the intended save's (it never crosses a visibility
 * boundary).
 */
function existingTarget(store: MemoryStore, name: string): MemoryNode | null {
  const g = store.buildGraph();
  const byName = g.nodes.get(name);
  if (byName && !byName.phantom) return byName;
  const target = slugName(name);
  for (const n of g.nodes.values()) {
    if (n.phantom) continue;
    const aliases = n.metadata.aliases;
    const list = aliases == null ? [] : Array.isArray(aliases) ? aliases : [aliases];
    if (list.map((x) => slugName(String(x))).includes(target)) return n;
  }
  return null;
}

/**
 * What the daemon injects beyond {@link ExtensionContext}. All optional: the CLI registers
 * with `{}` (its process never runs a lifecycle hook, so nothing here is ever resolved).
 */
export interface MemoryExtensionDeps {
  /**
   * The configured owner's Discord id, resolved LAZILY at invoke time (the daemon binds this
   * to env — DISCORD_OWNER_ID — so no id is baked in and the extension stays env-free).
   * Grants `viewerRole:"owner"` ONLY when the token-derived origin id equals it.
   */
  ownerId?: () => string | null;
  /** Test seam: the warm store `lifecycle.init` builds (a tmpdir `git:false` store in tests). */
  createStore?: (ctx: ExtensionContext) => MemoryStore;
  /** Test seams for the maintain loop cadence (see {@link startRoutineMaintenance}). */
  maintenanceIntervalMs?: number;
  maintenanceInitialDelayMs?: number;
}

/** The built extension plus the accessors `shell/main.ts` and tests read. */
export interface MemoryExtension extends Extension {
  /** The daemon-owned warm store. Throws before `lifecycle.init` has run. */
  store(): MemoryStore;
  /**
   * Settles once every accepted write-behind `memory.remember` has finished (success or
   * logged failure). Used by tests and the teardown sweep — never by the invoke path.
   */
  settled(): Promise<void>;
}

export const createMemoryExtension =
  (deps: MemoryExtensionDeps = {}) =>
  (ctx: ExtensionContext): MemoryExtension => {
    const { paths } = ctx;

    // Built by lifecycle.init; the maintain loop is armed only by lifecycle.start (late sweep).
    let store: MemoryStore | null = null;
    let maintenance: { stop(): void } | null = null;
    /** The write-behind tail: every accepted remember chains here (store-side writeChain
     *  serializes the actual writes; this only tracks settlement for stop()/tests). */
    let pendingWrites: Promise<void> = Promise.resolve();

    function requireStore(): MemoryStore {
      if (!store) throw new Error("the memory extension is not initialized (lifecycle.init has not run)");
      return store;
    }

    /**
     * The §7 visibility derivation — Audience is built HERE, in memory code, from the
     * token-derived origin. Never from caller args, never from argv, never from
     * `origin.surface` (caller-supplied provenance):
     *   - no authenticated origin id ⇒ `undefined` ⇒ recallOver/canView serve PUBLIC ONLY.
     *   - an origin id ⇒ that id is the viewer; role is "owner" iff it equals the
     *     daemon-configured owner id, else "member" (owner-scoped facts stay owner-only).
     *   - the origin carries no DM/guild signal, so context pins to "guild": the dm arm of
     *     canView can never match — a DM fact never leaks through ext.invoke. Fail-closed.
     * SELF_AUDIENCE is never granted on this path — an internal caller that needs it holds
     * the store itself (the concierge / maintain loop), not the invoke seam.
     */
    function audienceFromOrigin(origin: ExtensionInvocation["origin"]): Audience | undefined {
      const viewerId = origin?.userId?.trim();
      if (!viewerId) return undefined;
      const owner = deps.ownerId?.()?.trim() || null;
      return {
        viewerId,
        viewerRole: owner !== null && viewerId === owner ? "owner" : "member",
        context: "guild",
      };
    }

    /** Serve the exact same parser/renderer on the direct path when no daemon is listening. */
    async function runRecall(argv: string[]): Promise<never> {
      let request;
      try {
        // Validate before dialing the daemon: malformed input keeps the historical fast usage error.
        request = parseRecallCliRequest(argv);
      } catch (err) {
        fail((err as Error).message);
      }

      try {
        const { callBus } = await import("../../shell/control-bus.ts");
        const { join } = await import("node:path");
        // Agentic recall may spend up to 45s in its model seat; unlike channels, this bus request
        // needs to preserve that established command budget rather than declaring the daemon dead.
        const res = await callBus(join(paths.beckettDir, "control.sock"), "memory.recall", { argv }, 60_000);
        if (!res.ok) fail(res.error ?? "memory.recall failed");
        out(res.data);
      } catch (err) {
        if (!String((err as Error).message).startsWith("shell not running")) {
          fail(`daemon reachable but not answering (${(err as Error).message}) — retry, or stop the daemon and re-run`);
        }
        // No daemon is the one safe fallback: a fresh CLI process keeps the legacy cold behavior.
        const memory = createMemory({ memoryDir: paths.memoryDir, logger: undefined, git: false });
        out(await recallCliOutput(memory, request));
      }
    }

    async function runMemory(argv: string[]): Promise<void> {
      const [sub, ...rest] = argv;
      const memory = createMemory({
        memoryDir: paths.memoryDir,
        logger: undefined,
        git: sub === "remember" || sub === "maintain",
      });
      if (sub === "recall") await runRecall(rest);
      if (sub === "maintain") {
        // The routine staleness/dedup pass (OPS-121). The daemon runs this daily on its own;
        // the command is for on-demand runs and inspection. `--dry-run` plans without writing.
        const { flags } = parse(rest);
        const report = await memory.maintain({ dryRun: Boolean(flags["dry-run"]) });
        out(report);
      }
      if (sub === "show") {
        const { flags, _ } = parse(rest);
        const nodeName = (flags.name ? String(flags.name) : _[0] ?? "").trim();
        if (!nodeName) fail("usage: beckett memory show <name>");
        // No audience filter here — `show` is an owner-side inspection tool; it surfaces the
        // node's visibility + provenance so a caller can SEE the scope, not enforce it.
        const g = memory.buildGraph();
        const node = g.nodes.get(nodeName);
        if (!node || node.phantom) fail(`memory show: no node named '${nodeName}'`);
        const prov = provenanceOf(node!);
        out({
          name: node!.name,
          type: node!.type,
          path: node!.path,
          visibility: prov.visibility,
          dm_with: prov.dmWith ?? null,
          source_user: prov.sourceUser ?? null,
          source_name: prov.sourceName ?? null,
          provenance: renderProvenanceFrom(prov),
          description: node!.description,
          body: node!.body,
        });
      }
      if (sub === "remember") {
        const { flags } = parse(rest);
        const op = (flags.op as RememberIntent["op"]) ?? "create";
        const name = flags.name as string;
        if (!name) fail("usage: beckett memory remember --name <n> [--op create] [--type t] [--desc d] [--reason r] [--body <text>] [--link to:field,...] [--visibility public|owner|dm] [--dm-with <id>] [--by <userId>] [--by-name <name>]");
        let body = flags.body as string | undefined;
        if (flags["body-stdin"]) body = await Bun.stdin.text();
        const links = flags.link
          ? String(flags.link).split(",").map((s) => {
              const [to, field] = s.split(":");
              return { to: to!, field: field ?? "body" };
            })
          : undefined;
        // Provenance + visibility (multiplayer §7) ride in metadata. Absent flags write nothing,
        // so on an update the engine's `{ ...existing, ...intent }` merge preserves the prior
        // scope — never silently broadening it; an explicit flag is the only way to change it.
        const metadata = provenanceMetadataFromFlags(flags);
        const node = await memory.remember({
          op,
          name,
          type: flags.type ? (String(flags.type) as NodeType) : undefined,
          description: flags.desc ? String(flags.desc) : undefined,
          body,
          links,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          source: (flags.source as RememberIntent["source"]) ?? "conversation",
          reason: flags.reason ? String(flags.reason) : "remember via CLI",
        });
        out({ remembered: node.name, type: node.type, visibility: provenanceOf(node).visibility });
      }
      fail(`unknown: beckett memory ${sub ?? ""} (recall | remember | show | maintain)`);
    }

    return {
      manifest: {
        id: "memory",
        version: "1.1.0",
        summary: "the in-process markdown memory graph",
        actionClass: ActionClass.FREE,
        kind: "core",
      },

      // --- v6 discovery + dispatch ---
      capabilities: [
        {
          id: "memory.recall",
          description:
            "Ranked recall from the markdown memory knowledge graph: relevance-scored hits, " +
            "one-hop linked context, and the visible index — scoped fail-closed to what the " +
            "CALLING identity may see (public-only without one). Use before planning, " +
            "answering questions about people/projects/the environment, or staffing.",
          examples: ["what do you know about jason?", "recall the deploy setup for the site"],
          input: RecallArgs,
        },
        {
          id: "memory.remember",
          description:
            "Persist a durable cross-task fact into the memory knowledge graph — a person, a " +
            "project status change, an environment change. Write-behind: the write is accepted " +
            "and committed asynchronously; provenance (who taught it) is stamped from the " +
            "authenticated origin, never from arguments. Not for code facts or per-task ephemera.",
          examples: ["remember that the site deploy moved to cloudflare", "remember this preference"],
          input: RememberArgs,
        },
      ],

      // Both capabilities route to the SAME init-built warm store, and never exit the process:
      // every failure — including a pre-init call — comes back as an ok:false result.
      invoke: async (call) => {
        try {
          switch (call.capabilityId) {
            case "memory.recall": {
              const a = call.args as z.infer<typeof RecallArgs>;
              // §7: audience derived in code from the token-derived origin — see the fn doc.
              const audience = audienceFromOrigin(call.origin);
              const request: RecallCliRequest = {
                text: a.query ?? "",
                types: csvList(a.types),
                names: csvList(a.names),
                flags: {
                  json: true,
                  ...(a.k !== undefined ? { k: String(a.k) } : {}),
                  ...(a.hops !== undefined ? { hops: String(a.hops) } : {}),
                },
                // `audience: undefined` (no origin id) is recallOver's fail-closed public-only.
                audience: audience as Audience,
              };
              // Reads are awaited (§7): same renderer as the bus/CLI path, same engine gates.
              return { ok: true, data: await recallCliOutput(requireStore(), request) };
            }
            case "memory.remember": {
              const a = call.args as z.infer<typeof RememberArgs>;
              // Provenance is origin-bound: no authenticated identity ⇒ no write. The id is
              // stamped as source_user below — callers cannot supply `by` (strict schema).
              const writerId = call.origin?.userId?.trim();
              if (!writerId) {
                return { ok: false, error: "memory.remember needs an authenticated authorized request" };
              }
              const writer = IdSchema.safeParse(writerId);
              if (!writer.success) {
                return { ok: false, error: "memory.remember: the origin user id is not a Discord id" };
              }
              const memory = requireStore();
              // FAIL-CLOSED WRITE AUTHORITY. A remember that identity-matches an EXISTING
              // node is a merge, and the engine merge is explicit-flag-wins — so two gates
              // live HERE, in memory code (§7), before any intent is built:
              //   1. Scoping is CREATE-ONLY on this path: a `visibility`/`dmWith` arg aimed
              //      at an existing node is refused for EVERY caller. Owner-gating alone
              //      would not do — memory.remember is FREE (no confirmation), so a
              //      prompt-injected call riding the owner's own turn would carry the
              //      owner's origin id and could still flip a scoped node public.
              //   2. You cannot write what you cannot view: an update to a node the
              //      origin-derived audience can't see (canView — the exact gate recall
              //      uses) is refused, so a non-viewer can never tamper a scoped node's
              //      body or overwrite its provenance. Since this audience pins context
              //      to "guild", dm-scoped nodes accept NO invoke-path writes at all.
              const existing = existingTarget(memory, a.name);
              if (existing) {
                if (a.visibility !== undefined || a.dmWith !== undefined) {
                  return {
                    ok: false,
                    error:
                      `memory.remember: '${existing.name}' already exists — scope is set at create ` +
                      "and cannot be changed via ext.invoke (re-scoping is an owner-side CLI action)",
                  };
                }
                if (!canView(existing, audienceFromOrigin(call.origin))) {
                  return {
                    ok: false,
                    error: `memory.remember: '${existing.name}' is not visible to the calling identity — write refused`,
                  };
                }
              }
              const metadata = buildProvenanceMetadata({
                visibility: a.visibility,
                dmWith: a.dmWith,
              });
              metadata.source_user = writer.data;
              const intent: RememberIntent = {
                op: a.op ?? "create",
                name: a.name,
                type: a.type ? (a.type as NodeType) : undefined,
                description: a.description,
                body: a.body,
                links: a.links?.map((l) => ({ to: l.to, field: l.field ?? "body" })),
                metadata,
                source: "conversation",
                reason: a.reason ?? `remember via ext.invoke (${call.origin?.surface ?? "bus"})`,
              };
              // §7 write-behind: the store's own writeChain serializes and git-commits; invoke
              // returns NOW so no turn (and no concurrent recall) ever waits on the commit.
              // Failures are logged — settled() exposes the tail for tests and the stop sweep.
              const write = memory.remember(intent).then(
                () => undefined,
                (err) =>
                  ctx.logger.warn("memory.remember write-behind failed", {
                    node: a.name,
                    error: (err as Error).message ?? String(err),
                  }),
              );
              pendingWrites = pendingWrites.then(() => write);
              return { ok: true, data: { accepted: a.name, op: intent.op, writeBehind: true } };
            }
            default:
              return { ok: false, error: `memory: unknown capability "${call.capabilityId}"` };
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      lifecycle: {
        // The maintain loop's passes WRITE (archive/merge) and must not race the boot burst —
        // the same sanctioned LATE position the hand-wired startRoutineMaintenance held.
        startPhase: "late",
        // Construction only — the warm store (graph + Moss handle reused across bus recalls).
        // No timer is armed until start(); building the store does no I/O.
        init: () => {
          store =
            deps.createStore?.(ctx) ??
            createMemory({
              memoryDir: ctx.paths.memoryDir,
              logger: ctx.logger.child("memory"),
              git: true,
              warm: true,
            });
        },
        // Memory self-healing (OPS-121): one maintenance pass shortly after boot, then daily —
        // archives expired/superseded facts and merges near-duplicates so the knowledge graph
        // doesn't rot between deploys. Failures log and never affect the rest of the daemon.
        // Re-entry is a no-op — a second sweep must never arm a second timer.
        start: () => {
          if (maintenance) return;
          maintenance = startRoutineMaintenance({
            maintain: (opts) => requireStore().maintain(opts),
            logger: ctx.logger.child("memory.maintain"),
            ...(deps.maintenanceIntervalMs !== undefined ? { intervalMs: deps.maintenanceIntervalMs } : {}),
            ...(deps.maintenanceInitialDelayMs !== undefined
              ? { initialDelayMs: deps.maintenanceInitialDelayMs }
              : {}),
          });
        },
        // Idempotent: stills the maintain timer, then settles the write-behind tail so a
        // shutdown never abandons an accepted remember mid-commit (each write is short and
        // already serialized by the store's writeChain).
        stop: async () => {
          maintenance?.stop();
          maintenance = null;
          await pendingWrites;
        },
        health: () => {
          if (!store) return { ok: false, detail: "not initialized" };
          try {
            const g = store.buildGraph();
            let nodes = 0;
            for (const n of g.nodes.values()) if (!n.phantom) nodes++;
            return {
              ok: true,
              detail: `warm store over ${nodes} nodes; maintenance ${maintenance ? "scheduled" : "idle"}`,
            };
          } catch (err) {
            return { ok: false, detail: (err as Error).message ?? String(err) };
          }
        },
      },

      // --- v5 facets, carried through unchanged ---
      cliHelp:
        'recall "<query>" [--type t] [--name n] [--as-self | --viewer id] | memory recall|remember|show|maintain',
      cliVerbs: [
        {
          // first-class targeted memory retrieval — OPS-121
          name: "recall",
          summary: "ranked memory recall for a query, with audience scoping",
          usage:
            'beckett recall "<query>" [--type person,project,...] [--name <node>,...] [--k N] [--hops N] [--as-self | --viewer <userId>] [--viewer-role owner|maintainer|member] [--context guild|dm] [--json]',
          run: runRecall,
        },
        {
          name: "memory",
          summary: "recall | remember | show | maintain over the markdown graph",
          usage: "beckett memory recall|remember|show|maintain <...>",
          run: runMemory,
        },
      ],
      // The concierge keeps its v5-shaped `memory.recall` bus command body (like browser.*),
      // re-sourced onto this extension's store through the v4-main setter — declared empty here
      // so the bus namespace stays single-owner.
      busCommands: [],

      store: requireStore,
      settled: () => pendingWrites,
    };
  };

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createMemoryCapability(deps: CapabilityDeps): Capability {
  return asCapability(createMemoryExtension({})(deps));
}
