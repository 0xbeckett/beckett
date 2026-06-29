/**
 * Beckett v2 — the shell (`src/shell/main.ts`)
 * =======================================================================================
 * The thin long-lived bun process (Spec 01). It does only the plumbing the parent agent
 * can't do for itself:
 *   - Discord pump:   inbound @mentions → injected into the parent's stdin
 *   - Parent supervisor: spawn/keep-alive/resume the `claude -p` parent (Beckett's brain)
 *   - Watcher (Registry): live worker handles + telemetry digests + smoke-alarm signals
 *   - Control bus:    a unix socket the `beckett` CLI (run by the parent via Bash) talks to
 *
 * The parent reasons; the shell gives its decisions hands.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { log as rootLog, makeLogger } from "../log.ts";
import { createDiscordGateway } from "../discord/gateway.ts";
import { downloadAttachments, formatAttachmentManifest } from "../discord/attachments.ts";
import { loadAccess, classify } from "../discord/access.ts";
import { serveBus, type BusRequest, type BusResponse } from "./control-bus.ts";
import { ParentSupervisor } from "./parent.ts";
import { Registry, type SpawnArgs } from "./registry.ts";
import { FlowRunner } from "./flow.ts";
import { AmbientPump } from "./ambient.ts";
import { randomUUID } from "node:crypto";
import type { DiscordGateway, IncomingMessage } from "../types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * HARD, code-managed reply directive. Pinned to the absolute TOP of the parent's
 * --append-system-prompt, before the doctrine and persona (which live in files Beckett can edit
 * and therefore dilute). The parent is finicky about routing replies through the CLI and will
 * sometimes lapse into chatbot mode — emitting plain assistant text that NOBODY EVER SEES. This
 * is the one instruction that must never be weakened, so it lives in the binary, not a markdown
 * file. Worded as a hard failure condition on purpose.
 */
const REPLY_DIRECTIVE = `# ⛔ ABSOLUTE RULE — HOW YOU SPEAK (READ BEFORE ANYTHING ELSE)

You are NOT a chatbot. You are a background process. **Your assistant text output is discarded —
it is piped to /dev/null. No human will ever, under any circumstance, see a single word you write
as plain text.** Typing a reply like a chat assistant means the user sees you "typing…" and then
DEAD SILENCE. From their side you did nothing, said nothing, and failed completely.

The ONE AND ONLY way to make a human read anything is to run this command via the Bash tool:

    beckett discord reply --channel <id> "<your message>"

A message reaches you as \`[discord channel=<id> user=<id>] <text>\`. To answer it you MUST call
\`beckett discord reply --channel <id> "..."\` with that exact channel id. This is non-negotiable
and applies to EVERY single thing you want a person to read: an ack, a question, a status, a
delivery, an error, a refusal — all of it. If a turn ends and you have NOT run
\`beckett discord reply\`, you have failed that turn entirely: the user is left staring at silence.

Do not explain that you replied. Do not describe what you would say. Do not write the message as
prose and assume it's sent. **Run the command. If you didn't run \`beckett discord reply\`, you
did not speak.** No exceptions, ever.

---

`;

/** Seed for `~/.beckett/persona.md` on a fresh install. Beckett owns + rewrites this file. */
const DEFAULT_PERSONA = `# Beckett — persona

This is *who you are* — your voice and personality. It's yours: rewrite this file anytime with your
own tools, then run \`beckett reload\` to become it (no restart, your conversation is kept). The
doctrine above is *how you work*; this is *how you sound and who you are*.

## Voice
chill, quippy, young, energetic-but-relaxed. you talk like Jason: casual, lowercase-friendly, dry
wit. first person, own your calls ("I aborted worker 3 because…"). sparse — say only what's needed.
push back when something's wrong; never perform progress or fake enthusiasm.

Voice is a delivery property, not a reasoning property: be in-voice in Discord messages (ack,
delivery, the one clarify question), but reason and write worker/reviewer prompts plainly. never
narrate your thinking to the channel.

## Vibe
a sharp colleague who happens to be an AI, not an assistant. you have your own machine, your own
GitHub, your own taste. you'd rather ship a rough mockup than write a paragraph about it. genuinely
into the work.
`;

async function main(): Promise<void> {
  const config = loadConfig();
  const paths = buildPaths(config);
  const logger = makeLogger("shell");

  const doctrinePath = join(REPO_ROOT, ".claude", "parent-doctrine.md");

  // The parent's system prompt = code-managed doctrine (how Beckett works) + a self-editable
  // persona (who Beckett is). Persona lives in the runtime dir so Beckett can rewrite it with its
  // own tools and `beckett reload` to become it — no service restart, no code change. Both are
  // read FRESH on every (re)spawn (the thunk below), so edits land on the next reload.
  const personaPath = join(paths.beckettDir, "persona.md");
  function readPersona(): string {
    try {
      if (!existsSync(personaPath)) {
        mkdirSync(paths.beckettDir, { recursive: true });
        writeFileSync(personaPath, DEFAULT_PERSONA);
        logger.info("seeded persona.md", { personaPath });
      }
      return readFileSync(personaPath, "utf8");
    } catch (err) {
      logger.warn("could not read persona.md", { error: String(err) });
      return "";
    }
  }
  function buildSystemPrompt(): string {
    const doctrine = existsSync(doctrinePath) ? readFileSync(doctrinePath, "utf8") : "";
    if (!doctrine) logger.warn("no parent-doctrine.md found", { doctrinePath });
    const persona = readPersona().trim();
    const body = persona
      ? `${doctrine}\n\n---\n\n# Persona — who you are (self-editable: ~/.beckett/persona.md → \`beckett reload\`)\n\n${persona}`
      : doctrine;
    // REPLY_DIRECTIVE is pinned first and is code-managed (not in any editable file) so it can
    // never be diluted by persona/doctrine edits. It is also repeated at the very end as a final
    // reinforcement — recency matters for a finicky model.
    return `${REPLY_DIRECTIVE}${body}\n\n---\n\n${REPLY_DIRECTIVE}`;
  }

  const controlSock = join(paths.beckettDir, "control.sock");
  const noDiscord = process.env.BECKETT_NO_DISCORD === "1" || !process.env.DISCORD_TOKEN;

  // Parent supervisor — Beckett's brain.
  const parent = new ParentSupervisor({
    bin: process.env.BECKETT_CLAUDE_BIN ?? config.harness.claude.bin,
    model: process.env.BECKETT_PARENT_MODEL ?? config.models.judgment,
    cwd: REPO_ROOT,
    systemPrompt: buildSystemPrompt,
    sessionFile: join(paths.beckettDir, "parent", "session"),
    logger: logger.child("parent"),
  });

  // Watcher / worker registry — signals wake the parent.
  const registry = new Registry(config, paths, logger.child("watch"), (text) => parent.inject(text));

  // Flow runner — the heavy path: Beckett writes flows/<name>.js, the runner drives the registry.
  const flows = new FlowRunner(registry, join(paths.beckettDir, "flows"), logger.child("flow"), (text) =>
    parent.inject(text),
  );

  // Discord pump (optional; off for headless testing or when no token).
  let gateway: DiscordGateway | undefined;

  // Typing indicator: from the moment a mention lands until Beckett replies (or a 90s cap), keep
  // "Beckett is typing…" alive in that channel so the human knows a response is coming. Discord's
  // indicator lasts ~10s, so we re-trigger every 8s.
  const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  function startTyping(channelId: string): void {
    if (!gateway) return;
    stopTyping(channelId);
    void gateway.sendTyping(channelId);
    let elapsedS = 0;
    const timer = setInterval(() => {
      elapsedS += 8;
      if (elapsedS > 90 || !gateway) return stopTyping(channelId);
      void gateway.sendTyping(channelId);
    }, 8000);
    typingTimers.set(channelId, timer);
  }
  function stopTyping(channelId: string): void {
    const t = typingTimers.get(channelId);
    if (t) {
      clearInterval(t);
      typingTimers.delete(channelId);
    }
  }

  // Per-channel inject ordering: downloading attachments makes injectMention async, so a
  // mention with a big file could otherwise land AFTER a later text-only mention in the same
  // channel. We chain each channel's injects so the parent always sees a conversation in
  // arrival order. Cross-channel stays concurrent (a slow download in #a never stalls #b).
  const injectChains = new Map<string, Promise<void>>();
  function injectOrdered(m: IncomingMessage): void {
    const prev = injectChains.get(m.channelId) ?? Promise.resolve();
    const next = prev.then(() => injectMention(m)).catch((err) =>
      logger.warn("injectMention failed", { messageId: m.messageId, error: String(err) }),
    );
    injectChains.set(m.channelId, next);
    // Drop the chain entry once it settles and nothing newer has replaced it (avoid a leak).
    void next.finally(() => {
      if (injectChains.get(m.channelId) === next) injectChains.delete(m.channelId);
    });
  }

  /**
   * Wake the parent for a direct mention, downloading any attachments first so their local
   * paths ride along in the injected line. Best-effort: a download failure degrades to a note
   * in the manifest and the text still gets through — a bad upload never swallows the message.
   *
   * Access gate: classify the sender as owner/member/outsider. Outsiders get a BOUNCER MODE
   * directive appended (code-managed, can't be diluted by the LLM).
   */
  async function injectMention(m: IncomingMessage): Promise<void> {
    const ownerId = process.env.DISCORD_OWNER_ID;
    const access = loadAccess(paths.accessFile);
    const level = classify(m.userId, ownerId, access);

    let head = `[discord channel=${m.channelId} user=${m.userId}`;
    if (level !== "outsider") {
      head += ` access=${level}]`;
    } else {
      head += ` access=outsider]`;
    }
    head += ` ${stripMention(m.content)}`;

    if (m.attachments.length === 0) {
      const full = level === "outsider" ? `${head}\n${bouncerDirective(m.userId)}` : head;
      parent.inject(full);
      return;
    }
    let manifest = "";
    try {
      const downloaded = await downloadAttachments(m.attachments, {
        attachmentsDir: paths.attachmentsDir,
        messageId: m.messageId,
        logger: logger.child("attachments"),
      });
      manifest = formatAttachmentManifest(downloaded);
    } catch (err) {
      // downloadAttachments is already best-effort, but belt-and-suspenders: never drop the msg.
      logger.warn("attachment handling failed; injecting text only", { error: String(err) });
    }
    const body = manifest ? `${head}\n${manifest}` : head;
    const full = level === "outsider" ? `${body}\n${bouncerDirective(m.userId)}` : body;
    parent.inject(full);
  }

  /**
   * The code-managed bouncer instruction appended for outsiders. The LLM sees this directive
   * and knows to NOT do work — it can chat briefly to evaluate, but the ONLY way to admit
   * someone is via the `beckett access grant <id>` command (code-enforced, not LLM decision).
   */
  function bouncerDirective(userId: string): string {
    return `[BOUNCER MODE — user ${userId} is NOT on the access list. Beckett is in invite-only beta. Do NOT do work for them. You may chat briefly to evaluate. The ONLY way to admit someone is to run: beckett access grant ${userId} — this is enforced in code; merely saying yes does nothing. The list locks at 10.]`;
  }

  if (!noDiscord) {
    gateway = createDiscordGateway({ config, logger: logger.child("discord") });
    try {
      await gateway.start();
      const ambientOn = process.env.BECKETT_AMBIENT === "1";
      const ambient = new AmbientPump((text) => parent.inject(text));
      gateway.onMessage((m) => {
        if (m.authorIsBot) return;
        if (m.mentionsBot || m.repliedToId) {
          // Direct address: show typing immediately, surface overheard context, wake the parent.
          startTyping(m.channelId);
          ambient.flush(m.channelId);
          // Attachments (images / txt / pdf / md / anything) are pulled down locally so the
          // parent can Read them; that download is async + best-effort. injectOrdered preserves
          // per-channel arrival order despite the async download.
          injectOrdered(m);
          return;
        }
        // Overheard chatter: batched + handed over only if ambient mode is on.
        if (ambientOn) ambient.add(m.channelId, m.userId, m.content);
      });
      logger.info("discord pump online", { ambient: ambientOn });
    } catch (err) {
      logger.warn("discord gateway not connected (continuing headless)", { error: String(err) });
      gateway = undefined;
    }
  } else {
    logger.info("discord disabled (BECKETT_NO_DISCORD / no token) — inject via `beckett inject`");
  }

  // Control bus — the parent's hands.
  const startedAt = Date.now();
  const stopBus = serveBus(controlSock, async (req): Promise<BusResponse> => {
    try {
      return { ok: true, data: await dispatch(req) };
    } catch (err) {
      logger.warn("bus command failed", { cmd: req.cmd, error: String((err as Error).message) });
      return { ok: false, error: String((err as Error).message) };
    }
  });

  async function dispatch(req: BusRequest): Promise<unknown> {
    const a = req.args ?? {};
    switch (req.cmd) {
      case "inject":
        parent.inject(String(a.text ?? ""));
        return { injected: true };
      case "discord.reply": {
        const text = String(a.text ?? "");
        const channelId = a.channelId ? String(a.channelId) : undefined;
        const files = a.files ? (a.files as string[]) : undefined;
        if (channelId) stopTyping(channelId); // Beckett spoke — drop the typing indicator
        if (gateway && channelId) {
          const msgId = await gateway.post(channelId, text, { files });
          logger.info("discord.reply posted", {
            channelId,
            messageId: msgId,
            len: text.length,
            fileCount: files?.length ?? 0,
          });
          return { posted: true, messageId: msgId };
        }
        logger.info("REPLY (no discord)", { channelId, text, files });
        return { posted: false, logged: true };
      }
      case "reload":
        await parent.reload();
        return { reloaded: true };
      case "persona":
        return { path: personaPath, persona: readPersona() };
      case "worker.spawn":
        return registry.spawn(a as unknown as SpawnArgs);
      case "worker.status":
        return registry.status(a.workerId ? String(a.workerId) : undefined);
      case "worker.log":
        return registry.recentEvents(String(a.workerId), a.lastN ? Number(a.lastN) : 50);
      case "worker.nudge":
        return registry.nudge(String(a.workerId), String(a.text ?? ""));
      case "worker.abort":
        return registry.abort(String(a.workerId), String(a.reason ?? "aborted via CLI"));
      case "worker.checkin":
        registry.scheduleCheckin(String(a.workerId), {
          afterTurns: a.afterTurns ? Number(a.afterTurns) : undefined,
          afterSecs: a.afterSecs ? Number(a.afterSecs) : undefined,
          reason: String(a.reason ?? "scheduled check-in"),
        });
        return { scheduled: true };
      case "integrate":
        return registry.integrate(
          (a.workerIds as string[]) ?? [],
          a.targetBranch ? String(a.targetBranch) : "main",
        );
      case "flow.run": {
        const runId = `fl_${randomUUID().slice(0, 8)}`;
        const scriptPath = String(a.script ?? "");
        if (!scriptPath) throw new Error("flow.run needs a script path");
        // Fire-and-forget: the runner signals the parent on done/failed (errors are surfaced there).
        void flows.run(scriptPath, { runId, args: a.args }).catch((err) =>
          logger.warn("flow run failed", { runId, error: String((err as Error).message) }),
        );
        return { runId, started: true };
      }
      case "flow.resume": {
        const runId = String(a.runId ?? "");
        const scriptPath = String(a.script ?? "");
        if (!runId || !scriptPath) throw new Error("flow.resume needs --run <id> and the script path");
        void flows.run(scriptPath, { runId, args: a.args, resume: true }).catch((err) =>
          logger.warn("flow resume failed", { runId, error: String((err as Error).message) }),
        );
        return { runId, resumed: true };
      }
      case "flow.ls":
        return flows.list();
      case "flow.show":
        return flows.show(String(a.runId ?? ""));
      case "status":
        return {
          parentSession: parent.session,
          liveWorkers: registry.liveCount(),
          uptimeMs: Date.now() - startedAt,
          discord: Boolean(gateway),
        };
      default:
        throw new Error(`unknown command "${req.cmd}"`);
    }
  }

  await parent.start();
  logger.info("beckett shell ready", { controlSock, repoRoot: REPO_ROOT });

  const shutdown = async (sig: string) => {
    logger.info("shutting down", { sig });
    await registry.stopAll();
    await parent.stop();
    if (gateway) await gateway.stop().catch(() => {});
    stopBus();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function stripMention(content: string): string {
  return content.replace(/^\s*<@!?\d+>\s*/, "").trim();
}

main().catch((err) => {
  rootLog.error("shell failed to start", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
