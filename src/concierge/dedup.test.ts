/**
 * Regression for the duplicate-Discord-message bug. On a direct @mention the Concierge has two
 * ways to reach the human: (a) the turn's return text, which `onMessage` auto-posts as a native
 * reply, and (b) running `beckett discord reply` from its Bash tool, which routes through
 * `onBusRequest`. The bug was both firing for ONE turn → the person got the same answer twice.
 * These pin the dedup: when the Concierge answers a live @mention via the CLI, that becomes THE
 * reply (native, once) and the auto-post is suppressed; when it doesn't, the auto-post is the reply.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, redactBrowserSecrets, type ConciergeSession } from "./index.ts";
import { callBus, ControlBusTimeoutError, serveBus } from "../shell/control-bus.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { QuickRun, QuickRunner } from "../quick/index.ts";

const CHAN = "1097283746520174592";
const MSG = "msg-42";
const USER = "111111111111111111";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
  files?: string[];
  singleMessage?: boolean;
  browserQuestion?: boolean;
}

/**
 * Build a Concierge whose session, when it runs a turn, optionally simulates the Concierge
 * answering via `beckett discord reply` (the bus path) before returning its turn text.
 */
function harness(opts: {
  replyViaCli: boolean;
  turnText: string;
  cliText?: string;
  dir?: string;
  ownerId?: string;
  currentMeta?: {
    channelId: string;
    messageId: string;
    userId: string;
    isOwner: boolean;
    repliedViaCli: boolean;
    ackMessageId: string | null;
  };
  failPosts?: boolean | { remaining: number };
  failFilePosts?: { remaining: number };
  failDeletes?: boolean;
  postDelayMs?: number;
  quickOnAsk?: boolean;
}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  if (!tmpDirs.includes(dir)) tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = opts.ownerId ?? USER;
  const posts: Post[] = [];
  const deletedMessages: { channelId: string; messageId: string }[] = [];
  let postAttempts = 0;
  let chilledPosts = 0;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: {
      replyToMessageId?: string;
      files?: string[];
      chill?: boolean;
      singleMessage?: boolean;
      browserQuestion?: boolean;
    }) {
      postAttempts++;
      if (o?.chill) chilledPosts++;
      if (opts.postDelayMs) await Bun.sleep(opts.postDelayMs);
      if (o?.files?.length && opts.failFilePosts && opts.failFilePosts.remaining > 0) {
        opts.failFilePosts.remaining--;
        throw new Error("discord attachment rejected");
      }
      if (opts.failPosts === true) throw new Error("discord offline");
      if (typeof opts.failPosts === "object" && opts.failPosts.remaining > 0) {
        opts.failPosts.remaining--;
        throw new Error("discord offline");
      }
      posts.push({
        channelId,
        text,
        replyTo: o?.replyToMessageId,
        files: o?.files,
        ...(o?.singleMessage !== undefined ? { singleMessage: o.singleMessage } : {}),
        ...(o?.browserQuestion !== undefined ? { browserQuestion: o.browserQuestion } : {}),
      });
      return `mid-${posts.length}`;
    },
    async deleteMessage(channelId: string, messageId: string) {
      if (opts.failDeletes) throw new Error("missing Manage Messages");
      deletedMessages.push({ channelId, messageId });
    },
  } as unknown as DiscordGateway;

  // Late-bound so the fake session can call back into the Concierge's bus handler mid-turn.
  let concierge!: Concierge;
  const session = {
    async start() {},
    async stop() {},
    ...(opts.currentMeta ? { getCurrentMeta: () => opts.currentMeta } : {}),
    ask: async (_m: string) => {
      if (opts.quickOnAsk) {
        await concierge.onBusRequest({
          cmd: "quick.run",
          args: { agent: "computer-use", task: "open inbox", channelId: CHAN },
        });
      }
      if (opts.replyViaCli) {
        await concierge.onBusRequest({
          cmd: "discord.reply",
          args: { channelId: CHAN, text: opts.cliText ?? "via cli" },
        });
      }
      return opts.turnText;
    },
  } as unknown as ConciergeSession;

  concierge = new Concierge({ config, session, gateway });
  return { concierge, posts, deletedMessages, dir, postAttempts: () => postAttempts, chilledPosts: () => chilledPosts };
}

function mention(): IncomingMessage {
  return {
    messageId: MSG,
    userId: USER,
    channelId: CHAN,
    roleIds: [],
    content: "@beckett where my site at",
    mentionsBot: true,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("answers via CLI → exactly one post, native reply, no auto-post duplicate", async () => {
  const { concierge, posts } = harness({ replyViaCli: true, turnText: "the turn text", cliText: "the cli answer" });
  await concierge.onMessage(mention());
  // Only the CLI reply lands — once — and it's a NATIVE reply to the @mention (not a bare post).
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "the cli answer", replyTo: MSG, files: undefined });
});

test("answers normally (no CLI) → the turn text is auto-posted once as a native reply", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "just the turn text" });
  await concierge.onMessage(mention());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "just the turn text", replyTo: MSG, files: undefined });
});

test("a CLI reply OUTSIDE any live @mention turn posts plainly (proactive update path)", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  // No @mention in flight (this models notify()'s update turn) → plain post, no reply-bar.
  await concierge.onBusRequest({ cmd: "discord.reply", args: { channelId: CHAN, text: "shipped it" } });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "shipped it", replyTo: undefined, files: undefined });
});

test("discord.reply forwards files and permits image-only posts", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN, text: "", files: ["/tmp/logo.png"] },
  });
  expect(posts).toEqual([{ channelId: CHAN, text: "", replyTo: undefined, files: ["/tmp/logo.png"] }]);
});

test("computer-use cannot borrow the profile outside an authenticated request", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  let runs = 0;
  concierge.setQuickRunner({
    agents: () => [],
    run: async () => { runs++; return { detached: true, runId: "bad" }; },
    resume: async () => {},
    stats: () => ({ running: 0, waiting: 0, runs: [] }),
    stopAll: async () => {},
  } as QuickRunner);
  const result = await concierge.onBusRequest({
    cmd: "quick.run",
    args: { agent: "computer-use", task: "open inbox", channelId: CHAN },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("authenticated authorized request");
  expect(runs).toBe(0);
});

test("an access-list user can start computer-use from a role-free Discord mention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  writeFileSync(join(dir, "access.txt"), `${USER}\n`, "utf8");
  const { concierge } = harness({
    replyViaCli: false,
    turnText: "",
    quickOnAsk: true,
    dir,
    ownerId: "999999999999999999",
  });
  const runs: { channelId: string | null | undefined; requesterId: string | null | undefined }[] = [];
  concierge.setQuickRunner({
    agents: () => [],
    run: async (_agent, _task, channelId, requesterId) => {
      runs.push({ channelId, requesterId });
      return { detached: true, runId: "authorized-run" };
    },
    resume: async () => {},
    stats: () => ({ running: 0, waiting: 0, runs: [] }),
    stopAll: async () => {},
  });
  await concierge.onMessage(mention());
  expect(runs).toEqual([{ channelId: CHAN, requesterId: USER }]);
});

test("an authenticated request can start computer-use and is stamped as requester", async () => {
  const { concierge } = harness({
    replyViaCli: false,
    turnText: "",
    currentMeta: {
      channelId: CHAN,
      messageId: MSG,
      userId: USER,
      isOwner: false,
      repliedViaCli: false,
      ackMessageId: null,
    },
  });
  let requesterId: string | null | undefined;
  let originChannel: string | null | undefined;
  concierge.setQuickRunner({
    agents: () => [],
    run: async (_agent, _task, channel, requester) => {
      requesterId = requester;
      originChannel = channel;
      return { detached: true, runId: "ok" };
    },
    resume: async () => {},
    stats: () => ({ running: 0, waiting: 0, runs: [] }),
    stopAll: async () => {},
  });
  const result = await concierge.onBusRequest({
    cmd: "quick.run",
    args: { agent: "computer-use", task: "open inbox", channelId: CHAN },
  });
  expect(result.ok).toBe(true);
  expect(requesterId).toBe(USER);
  expect(originChannel).toBe(CHAN);

  const mismatched = await concierge.onBusRequest({
    cmd: "quick.run",
    args: { agent: "computer-use", task: "open inbox", channelId: "999999999999999999" },
  });
  expect(mismatched.ok).toBe(false);
  expect(mismatched.error).toContain("where the authorized request began");
});

function browserRun(overrides: Partial<QuickRun> = {}): QuickRun {
  return {
    runId: "browser-1",
    agent: "computer-use",
    task: "finish signup",
    channelId: CHAN,
    requesterId: USER,
    startedAt: Date.now(),
    finishedAt: null,
    state: "waiting",
    result: null,
    detached: true,
    sessionId: "session-1",
    proofFiles: [],
    question: "Which plan?",
    questionMessageId: null,
    ...overrides,
  };
}

test("browser question attaches its screenshot and a native reply resumes without entering chat context", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not run" });
  const resumed: { runId: string; answer: string }[] = [];
  concierge.setQuickRunner({
    agents: () => [],
    run: async () => ({ detached: true, runId: "unused" }),
    resume: async (runId, answer) => {
      resumed.push({ runId, answer });
    },
    stats: () => ({ running: 0, waiting: 1, runs: [] }),
    stopAll: async () => {},
  } as QuickRunner);
  const questionId = await concierge.notifyQuickQuestion(
    browserRun(),
    { text: "Which plan should I select?", screenshot: "/tmp/question.png" },
  );
  expect(posts[0]).toEqual({
    channelId: CHAN,
    text: "Which plan should I select?\nReply directly to this message and I'll continue from the same page.",
    replyTo: undefined,
    files: ["/tmp/question.png"],
    singleMessage: true,
    browserQuestion: true,
  });

  await concierge.onMessage({
    ...mention(),
    messageId: "answer-1",
    content: "Pro",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumed).toEqual([{ runId: "browser-1", answer: "Pro" }]);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "answer-1" });
  expect(posts[1]).toMatchObject({ replyTo: undefined, text: "I have what I need. Continuing from that page now." });
});

test("a browser answer is not used when Discord cannot confirm its deletion", async () => {
  const { concierge, posts } = harness({
    replyViaCli: false,
    turnText: "must not run",
    failDeletes: true,
  });
  let resumes = 0;
  concierge.setQuickRunner({
    agents: () => [],
    run: async () => ({ detached: true, runId: "unused" }),
    resume: async () => { resumes++; },
    stats: () => ({ running: 0, waiting: 1, runs: [] }),
    stopAll: async () => {},
  } as QuickRunner);
  const questionId = await concierge.notifyQuickQuestion(
    browserRun(),
    { text: "What is the password?", screenshot: "/tmp/question.png" },
  );
  await concierge.onMessage({
    ...mention(),
    messageId: "undeletable-answer",
    content: "Sup3rSecret!",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumes).toBe(0);
  expect(posts.at(-1)?.text).toContain("Manage Messages");
  expect(JSON.stringify(posts)).not.toContain("Sup3rSecret");
});

test("a browser question is deleted when its privacy ledger cannot be persisted", async () => {
  const { concierge, deletedMessages, dir } = harness({ replyViaCli: false, turnText: "" });
  mkdirSync(join(dir, "browser-questions.json"));
  await expect(concierge.notifyQuickQuestion(
    browserRun(),
    { text: "What is the password?", screenshot: join(dir, "question.png") },
  )).rejects.toThrow("was not made durable");
  expect(deletedMessages).toEqual([{ channelId: CHAN, messageId: "mid-1" }]);
  await concierge.stop();
});

test("browser question instructions stay in the one ledgered Discord message", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  await concierge.notifyQuickQuestion(
    browserRun(),
    {
      text: `Page context before the question.\n\nWhich password should I use? ${"context ".repeat(400)}`,
      screenshot: "/tmp/question.png",
    },
  );
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text.length).toBeLessThanOrEqual(2_000);
  expect(posts[0]!.text).not.toContain("\n\n");
  expect(posts[0]!.text).toStartWith("Page context before the question. Which password should I use?");
  expect(posts[0]!.text).toEndWith("Reply directly to this message and I'll continue from the same page.");
  expect(posts[0]!.files).toEqual(["/tmp/question.png"]);
  // Atomicity is the GATEWAY's guarantee, not the chunker's: `singleMessage: true` bypasses
  // chunkReply/chilltext entirely (and `browserQuestion` posts require it — gateway throws
  // otherwise), so the suffix can never be split away from the question. The old
  // `chunkReply(text) has length 1` assertion here only held because the pre-fix sentence
  // splitter silently DROPPED the long "context…" run; the lossless splitter would pack this
  // text into 2 chunks — correctly — on the (unused) non-atomic path.
  expect(posts[0]!.singleMessage).toBe(true);
  expect(posts[0]!.browserQuestion).toBe(true);
  await concierge.stop();
});

test("deleted browser question tombstones expire and remain bounded", async () => {
  const { concierge, deletedMessages, dir } = harness({ replyViaCli: false, turnText: "" });
  const now = Date.now();
  const records = Array.from({ length: 1_005 }, (_, index) => ({
    messageId: `question-${index}`,
    runId: `run-${index}`,
    channelId: CHAN,
    allowedUserId: USER,
    createdAt: now - index,
    stale: false,
  }));
  records.push({
    messageId: "expired-question",
    runId: "expired-run",
    channelId: CHAN,
    allowedUserId: USER,
    createdAt: now - 8 * 24 * 60 * 60_000,
    stale: false,
  });
  writeFileSync(join(dir, "browser-questions.json"), JSON.stringify(records));
  await concierge.start();
  try {
    let persisted: { stale: boolean; deletedAt?: number }[] = [];
    const deadline = Date.now() + 2_000;
    do {
      persisted = JSON.parse(readFileSync(join(dir, "browser-questions.json"), "utf8"));
      if (persisted.length === 1_000 && persisted.every((record) => record.deletedAt !== undefined)) break;
      if (Date.now() > deadline) throw new Error("stale browser questions were not deleted and compacted");
      await Bun.sleep(10);
    } while (true);
    expect(persisted).toHaveLength(1_000);
    expect(persisted.every((record) => record.stale && record.deletedAt !== undefined)).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain("expired-question");
    expect(deletedMessages).toHaveLength(1_006);
  } finally {
    await concierge.stop();
  }
});

test("only the browser-run owner can answer its screenshot-backed question", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not run" });
  let resumes = 0;
  concierge.setQuickRunner({
    agents: () => [],
    run: async () => ({ detached: true, runId: "unused" }),
    resume: async () => { resumes++; },
    stats: () => ({ running: 0, waiting: 1, runs: [] }),
    stopAll: async () => {},
  } as QuickRunner);
  const questionId = await concierge.notifyQuickQuestion(
    browserRun(),
    { text: "What is the one-time code?", screenshot: "/tmp/question.png" },
  );
  await concierge.onMessage({
    ...mention(),
    messageId: "answer-other",
    userId: "222222222222222222",
    content: "123456",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumes).toBe(0);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "answer-other" });
  expect(posts.at(-1)?.text).toContain("Only the person who started");
});

test("the initiating authorized user can answer a browser question without a Discord role", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not run" });
  let resumes = 0;
  concierge.setQuickRunner({
    agents: () => [],
    run: async () => ({ detached: true, runId: "unused" }),
    resume: async () => { resumes++; },
    stats: () => ({ running: 0, waiting: 1, runs: [] }),
    stopAll: async () => {},
  } as QuickRunner);
  const questionId = await concierge.notifyQuickQuestion(
    browserRun(),
    { text: "What is the one-time code?", screenshot: "/tmp/question.png" },
  );
  await concierge.onMessage({
    ...mention(),
    messageId: "answer-revoked",
    roleIds: [],
    content: "123456",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumes).toBe(1);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "answer-revoked" });
  expect(posts.at(-1)?.text).toContain("Continuing from that page");
});

test("a reply to a browser question from before restart is consumed as sensitive stale input", async () => {
  const first = harness({ replyViaCli: false, turnText: "must not run" });
  const questionId = await first.concierge.notifyQuickQuestion(
    browserRun(),
    { text: "What is the one-time code?", screenshot: "/tmp/question.png" },
  );
  const restarted = harness({ replyViaCli: false, turnText: "must not run", dir: first.dir });
  await restarted.concierge.start();
  try {
    await restarted.concierge.onMessage({
      ...mention(),
      messageId: "late-secret",
      content: "654321",
      mentionsBot: false,
      repliedToId: questionId,
      authorIsBot: false,
    });
    expect(restarted.deletedMessages).toContainEqual({ channelId: CHAN, messageId: "late-secret" });
    expect(restarted.posts.some((post) => post.text.includes("browser run is no longer active"))).toBe(true);
    expect(restarted.posts.some((post) => post.text.includes("must not run"))).toBe(false);
  } finally {
    await restarted.concierge.stop();
  }
});

test("an orphan browser-question reply is consumed even if the daemon crashed before ledger persistence", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not enter chat" });
  await concierge.onMessage({
    ...mention(),
    messageId: "orphan-secret",
    content: "739184",
    mentionsBot: true,
    repliedToId: "accepted-before-crash",
    repliedToBrowserQuestion: true,
    authorIsBot: false,
  });
  expect(posts.some((post) => post.text.includes("browser run is no longer active"))).toBe(true);
  expect(posts.some((post) => post.text.includes("must not enter chat"))).toBe(false);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "orphan-secret" });
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "accepted-before-crash" });
});

test("an unverified bot-reference reply fails closed instead of entering chat context", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not enter chat" });
  await concierge.onMessage({
    ...mention(),
    messageId: "unverified-secret",
    content: "739184",
    mentionsBot: true,
    repliedToId: "uninspectable-bot-message",
    repliedToBotUnverified: true,
    authorIsBot: false,
  });
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "unverified-secret" });
  expect(posts.some((post) => post.text.includes("didn't retain your reply"))).toBe(true);
  expect(posts.some((post) => post.text.includes("must not enter chat"))).toBe(false);
});

test("browser completion posts the trusted proof directly without another Concierge turn", async () => {
  const { concierge, posts, chilledPosts } = harness({ replyViaCli: false, turnText: "must not run" });
  await concierge.notifyQuickResult(browserRun({
    state: "done",
    result: "The account is ready at https://example.test/account.",
    proofFiles: ["/tmp/proof.png"],
    finishedAt: Date.now(),
  }));
  expect(posts).toEqual([{
    channelId: CHAN,
    text: "The account is ready at https://example.test/account.",
    replyTo: undefined,
    files: ["/tmp/proof.png"],
  }]);
  expect(chilledPosts()).toBe(0);
});

test("browser terminal results survive an offline shutdown and retry after restart", async () => {
  const first = harness({ replyViaCli: false, turnText: "", failPosts: true });
  const proof = join(first.dir, "proof.png");
  writeFileSync(proof, "png fixture");
  const run = browserRun({
    state: "done",
    result: "Recovered browser result.",
    proofFiles: [proof],
    finishedAt: Date.now(),
  });
  await expect(first.concierge.notifyQuickResult(run)).rejects.toThrow("discord offline");
  expect(existsSync(proof)).toBe(true);
  const persisted = JSON.parse(readFileSync(join(first.dir, "browser-results.json"), "utf8"));
  expect(persisted).toEqual([{
    runId: run.runId,
    channelId: CHAN,
    state: "done",
    result: "Recovered browser result.",
    proofFiles: [proof],
  }]);
  expect(JSON.stringify(persisted)).not.toContain(run.task);
  expect(JSON.stringify(persisted)).not.toContain(run.requesterId!);
  await first.concierge.stop();

  const restarted = harness({ replyViaCli: false, turnText: "", dir: first.dir });
  await restarted.concierge.start();
  try {
    const deadline = Date.now() + 2_000;
    while (!restarted.posts.some((post) => post.text.includes("Recovered browser result"))) {
      if (Date.now() > deadline) throw new Error("browser outbox did not retry");
      await Bun.sleep(10);
    }
    expect(existsSync(proof)).toBe(false);
    expect(JSON.parse(readFileSync(join(first.dir, "browser-results.json"), "utf8"))).toEqual([]);
  } finally {
    await restarted.concierge.stop();
  }
});

test("browser result outbox retries a transient Discord failure without a restart", async () => {
  const failures = { remaining: 1 };
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "", failPosts: failures });
  await expect(concierge.notifyQuickResult(browserRun({
    state: "done",
    result: "Delivered on retry.",
    finishedAt: Date.now(),
  }))).rejects.toThrow("discord offline");
  const deadline = Date.now() + 2_500;
  while (!posts.some((post) => post.text.includes("Delivered on retry"))) {
    if (Date.now() > deadline) throw new Error("live browser outbox retry did not fire");
    await Bun.sleep(20);
  }
  await concierge.stop();
});

test("browser proof upload failure retains the screenshot and retries the verified result intact", async () => {
  const failures = { remaining: 1 };
  const fixture = harness({
    replyViaCli: false,
    turnText: "",
    failFilePosts: failures,
  });
  const proof = join(fixture.dir, "proof-retry.png");
  writeFileSync(proof, "png fixture");
  await expect(fixture.concierge.notifyQuickResult(browserRun({
    state: "done",
    result: "Verified after retry.",
    proofFiles: [proof],
    finishedAt: Date.now(),
  }))).rejects.toThrow("discord attachment rejected");
  expect(existsSync(proof)).toBe(true);
  expect(JSON.parse(readFileSync(join(fixture.dir, "browser-results.json"), "utf8"))[0].proofFiles).toEqual([proof]);
  const deadline = Date.now() + 2_500;
  while (!fixture.posts.some((post) => post.text === "Verified after retry.")) {
    if (Date.now() > deadline) throw new Error("browser proof retry did not fire");
    await Bun.sleep(20);
  }
  expect(fixture.posts).toEqual([{
    channelId: CHAN,
    text: "Verified after retry.",
    replyTo: undefined,
    files: [proof],
  }]);
  expect(existsSync(proof)).toBe(false);
  await fixture.concierge.stop();
});

test("browser result delivery fails closed when its durable outbox cannot be written", async () => {
  const { concierge, posts, dir } = harness({ replyViaCli: false, turnText: "" });
  const outbox = join(dir, "browser-results.json");
  mkdirSync(outbox);
  await expect(concierge.notifyQuickResult(browserRun({
    state: "done",
    result: "Must not post before persistence.",
    finishedAt: Date.now(),
  }))).rejects.toThrow();
  expect(posts).toEqual([]);
  await concierge.stop();
});

test("browser result failures cannot re-arm retry delivery after shutdown", async () => {
  const { concierge, postAttempts } = harness({
    replyViaCli: false,
    turnText: "",
    failPosts: true,
    postDelayMs: 50,
  });
  const delivery = concierge.notifyQuickResult(browserRun({
    state: "done",
    result: "Do not retry after stop.",
    finishedAt: Date.now(),
  }));
  while (postAttempts() === 0) await Bun.sleep(5);
  await concierge.stop();
  await expect(delivery).rejects.toThrow("discord offline");
  await Bun.sleep(1_100);
  expect(postAttempts()).toBe(1);
});

test("browser summaries redact labelled credentials before Discord delivery", () => {
  const cases = [
    "Created it. Password: Sup3rSecret! token=abc123",
    "generated password `correct horse battery staple`",
    '{"password":"abc123","status":"done"}',
    "token: abc123\nNext line is safe",
    "Open https://user:pass@example.test/path?token=abc123",
    "Password:\nSup3rSecret!\nSetup complete",
    "**Password:**\nSup3rSecret!\nSetup complete",
    "- Password:\nSup3rSecret!\nSetup complete",
    "### Password:\nSup3rSecret!\nSetup complete",
    "> Password:\nSup3rSecret!\nSetup complete",
    "Credentials created: alice / Sup3rSecret!",
  ];
  for (const value of cases) {
    const redacted = redactBrowserSecrets(value);
    expect(redacted).toContain("[redacted]");
    for (const secret of ["Sup3rSecret", "abc123", "correct horse", "user:pass"]) {
      expect(redacted).not.toContain(secret);
    }
  }
  expect(redactBrowserSecrets(cases[3]!)).toContain("Next line is safe");
  expect(redactBrowserSecrets(cases[5]!)).toContain("Setup complete");
  expect(redactBrowserSecrets("What is the password? Which password should I use?")).toBe(
    "What is the password? Which password should I use?",
  );
});

test("a send that succeeds before its bus ack times out is not posted again on retry", async () => {
  const { concierge, posts, dir } = harness({ replyViaCli: false, turnText: "" });
  const socket = join(dir, "control.sock");
  let first = true;
  let releaseFirstAck!: () => void;
  let ackIsWaiting!: () => void;
  const waitingForAck = new Promise<void>((resolve) => { ackIsWaiting = resolve; });
  const stop = serveBus(socket, async (req) => {
    const response = await concierge.onBusRequest(req);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        releaseFirstAck = resolve;
        ackIsWaiting();
      });
    }
    return response;
  });

  try {
    // The fake Discord gateway resolves immediately (the post exists), while the control-bus
    // response is deliberately held past the caller's deadline.
    const firstAttempt = callBus(socket, "discord.reply", { channelId: CHAN, text: "sent once" }, 10);
    await waitingForAck;
    await expect(firstAttempt).rejects.toBeInstanceOf(ControlBusTimeoutError);
    expect(posts).toHaveLength(1);

    releaseFirstAck();
    const retry = await callBus(socket, "discord.reply", { channelId: CHAN, text: "sent once" }, 100);
    expect(retry.ok).toBeTrue();
    expect(posts).toHaveLength(1);
  } finally {
    stop();
  }
});
