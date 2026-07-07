/**
 * Channel profiler (server memory, v4.1) — the "what's going on in #media" builder.
 * =======================================================================================
 * Every `profile_update_messages` new entries in a guild channel, a one-shot small-model
 * call (same shape as the ambient triage classifier) turns the channel's bounded window
 * into `{summary, topics[]}`, persisted via the store's profiles sidecar. The Concierge
 * surfaces those profiles as the cross-channel awareness footer and `beckett channels list`.
 *
 * Standing rules:
 *   - Profiles NEVER touch DM channels — the store's meta gate is checked here in code,
 *     and content without recorded guild meta is treated as private by default.
 *   - Fail open, write nothing: a failed/garbled model call is logged and dropped; a stale
 *     profile or none at all beats a fabricated one.
 *   - One summarize at a time: appends can burst across channels; the queue serializes the
 *     child processes so a busy server never stampedes `claude -p` spawns.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../types.ts";
import { renderEntryLine, type ChannelContextStore } from "./channel-context.ts";
import { extractVerdictJson } from "./triage.ts";

export const ProfileVerdictSchema = z.object({
  summary: z.string().min(1).max(600),
  topics: z.array(z.string().min(1).max(60)).max(6),
});

export type ProfileVerdict = z.infer<typeof ProfileVerdictSchema>;

/** Test seam: given a rendered transcript + channel name, produce the profile JSON. */
export type SummarizeFn = (transcript: string, channelName: string | null) => Promise<ProfileVerdict>;

export interface CreateChannelProfilerOptions {
  store: ChannelContextStore;
  model: string;
  /** New entries in a channel before its profile is rebuilt. */
  updateEveryMessages: number;
  logger: Logger;
  claudeBin?: string;
  promptPath?: string;
  timeoutMs?: number;
  /** Injectable summarizer for tests; defaults to a one-shot `claude -p` spawn. */
  summarize?: SummarizeFn;
}

export interface ChannelProfiler {
  /** Called after every store append; decides (cheaply) whether a rebuild is due. */
  notifyAppend(channelId: string): void;
  /** Resolves when all queued/in-flight profile work is drained (tests + shutdown). */
  idle(): Promise<void>;
}

/** Pull the profile JSON out of `--output-format json` stdout (result may be fenced prose). */
export function parseProfile(stdout: string): ProfileVerdict {
  const parsed = JSON.parse(stdout.trim());
  const direct = ProfileVerdictSchema.safeParse(parsed);
  if (direct.success) return direct.data;
  if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
    const inner = JSON.parse(extractVerdictJson(parsed.result));
    return ProfileVerdictSchema.parse(inner);
  }
  return ProfileVerdictSchema.parse(parsed);
}

export function createChannelProfiler(opts: CreateChannelProfilerOptions): ChannelProfiler {
  const { store, logger } = opts;
  const bin = opts.claudeBin ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const promptPath = opts.promptPath ?? join(import.meta.dir, "channel-profile.md");
  const updateEvery = Math.max(1, opts.updateEveryMessages);

  const defaultSummarize: SummarizeFn = async (transcript, channelName) => {
    const staticPrompt = readFileSync(promptPath, "utf8");
    const prompt = `${staticPrompt.trim()}\n\n<context>\nChannel: ${channelName ? `#${channelName}` : "(unnamed)"}\nTranscript:\n${transcript}\n</context>\n`;
    const proc = Bun.spawn([bin, "-p", prompt, "--model", opts.model, "--output-format", "json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (timedOut) throw new Error(`channel profile timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (code !== 0) throw new Error(`channel profile exited ${code}: ${stderr.trim()}`);
      return parseProfile(stdout);
    } finally {
      clearTimeout(timer);
    }
  };
  const summarize = opts.summarize ?? defaultSummarize;

  // Channels queued or in flight — a second notify while one is pending is a no-op.
  const pending = new Set<string>();
  // The serializer: each due channel chains onto the tail; errors never break the chain.
  let queue: Promise<void> = Promise.resolve();

  /** Entries newer than the current profile's anchor (whole window when no/aged-out anchor). */
  function entriesSinceProfile(channelId: string): number {
    const window = store.recent(channelId);
    const profile = store.getProfile(channelId);
    if (!profile) return window.length;
    const idx = window.findIndex((e) => e.messageId === profile.lastMessageId);
    return idx === -1 ? window.length : window.length - 1 - idx;
  }

  async function rebuild(channelId: string): Promise<void> {
    try {
      // Re-read at run time — the queue may have sat behind another channel's rebuild.
      const window = store.recent(channelId);
      if (window.length === 0) return;
      const meta = store.getMeta(channelId);
      if (!meta || meta.guildId === null) return;
      const transcript = window.map((e) => renderEntryLine(e, { withDate: true })).join("\n");
      const verdict = await summarize(transcript, meta.name);
      const newest = window[window.length - 1]!;
      store.setProfile(channelId, {
        summary: verdict.summary,
        topics: verdict.topics,
        lastMessageId: newest.messageId,
        entryCount: window.length,
      });
      logger.info("channel profile updated", {
        channelId,
        name: meta.name,
        topics: verdict.topics,
        entries: window.length,
      });
    } catch (err) {
      // Fail open: keep the stale profile (or none). Never write a fabricated one.
      logger.warn("channel profile rebuild failed", { channelId, error: (err as Error).message });
    } finally {
      pending.delete(channelId);
    }
  }

  return {
    notifyAppend(channelId: string): void {
      if (pending.has(channelId)) return;
      // DM channels (and channels whose guild we haven't learned yet) are never profiled —
      // profile text feeds server-wide surfaces, so private-by-default wins.
      const meta = store.getMeta(channelId);
      if (!meta || meta.guildId === null) return;
      if (entriesSinceProfile(channelId) < updateEvery) return;
      pending.add(channelId);
      queue = queue.then(() => rebuild(channelId));
    },

    idle(): Promise<void> {
      return queue.then(() => undefined);
    },
  };
}
