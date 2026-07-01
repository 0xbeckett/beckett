import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChatWindow,
  extractCliReply,
  HANDOFF,
  SILENT,
  type HaikuOutput,
  type HaikuRun,
} from "./chatWindow.ts";

const quietLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child() {
    return quietLogger;
  },
} as never;

function makeDeps(run: HaikuRun, maxTurns?: number) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-chat-"));
  return {
    dir,
    deps: { bin: "claude", model: "claude-haiku-4-5", dir, persona: "dry, lowercase, sparse", logger: quietLogger, maxTurns, run },
  };
}

/** A run that "delivers" via the CLI (returns cliReply). */
const cli = (reply: string): HaikuRun => async () => ({ finalText: "", cliReply: reply });
/** A run that emits a plain final text (sentinel, empty, or safety-net message — no CLI call). */
const text = (finalText: string): HaikuRun => async () => ({ finalText } as HaikuOutput);

function fileExists(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("extractCliReply", () => {
  test("pulls the message out of a beckett discord reply command", () => {
    expect(extractCliReply('beckett discord reply --channel 99 "hey there"')).toBe("hey there");
  });
  test("handles single quotes", () => {
    expect(extractCliReply("beckett discord reply --channel 99 'yo'")).toBe("yo");
  });
  test("a quoted channel id does not swallow the message (the live-test bug)", () => {
    expect(extractCliReply('beckett discord reply --channel "1" "4"')).toBe("4");
  });
  test("a message with inner quotes survives", () => {
    expect(extractCliReply('beckett discord reply --channel 1 "she said \\"hi\\""')).toBe('she said "hi"');
  });
  test("an unquoted single-word message works", () => {
    expect(extractCliReply("beckett discord reply --channel 1 ok")).toBe("ok");
  });
  test("returns undefined for non-reply commands", () => {
    expect(extractCliReply('echo "hello"')).toBeUndefined();
    expect(extractCliReply("ls -la")).toBeUndefined();
  });
});

describe("Haiku chat window", () => {
  test("a CLI-delivered reply is recorded and marked delivered (shell won't re-post)", async () => {
    const { dir, deps } = makeDeps(cli("hey, what's up"));
    const cw = createChatWindow(deps);
    const res = await cw.chatTurn("chan1", "yo", "mention");

    expect(res).toEqual({ kind: "reply", reply: "hey, what's up", delivered: true });
    expect(readFileSync(join(dir, "chan1.log"), "utf8")).toBe("User: yo\nBeckett: hey, what's up\n");
  });

  test("first turn has no window context; second turn feeds the prior exchange back in", async () => {
    const prompts: string[] = [];
    const run: HaikuRun = async (p) => {
      prompts.push(p);
      return { finalText: "", cliReply: "still here" };
    };
    const { deps } = makeDeps(run);
    const cw = createChatWindow(deps);
    await cw.chatTurn("c", "first", "mention");
    await cw.chatTurn("c", "second", "mention");

    expect(prompts[0]).not.toContain("Recent conversation");
    expect(prompts[1]).toContain("Recent conversation");
    expect(prompts[1]).toContain("User: first");
    expect(prompts[1]).toContain("Beckett: still here");
    expect(prompts[1]).toContain("User: second");
  });

  test("HANDOFF sentinel → kind:handoff and nothing recorded", async () => {
    const { dir, deps } = makeDeps(text(HANDOFF));
    const cw = createChatWindow(deps);
    const res = await cw.chatTurn("c2", "deploy the site to prod", "mention");
    expect(res.kind).toBe("handoff");
    expect(fileExists(join(dir, "c2.log"))).toBe(false);
  });

  test("text starting with the handoff sentinel still hands off", async () => {
    const { deps } = makeDeps(text(`${HANDOFF} (needs the parent)`));
    const cw = createChatWindow(deps);
    expect((await cw.chatTurn("c3", "rewrite my auth module", "mention")).kind).toBe("handoff");
  });

  test("SILENT is honored in ambient mode but becomes handoff on a direct mention", async () => {
    const { deps } = makeDeps(text(SILENT));
    const cw = createChatWindow(deps);
    expect((await cw.chatTurn("a1", "random chatter", "ambient")).kind).toBe("silent");
    expect((await cw.chatTurn("a1", "yo @beckett", "mention")).kind).toBe("handoff");
  });

  test("an empty result never goes out: silent in ambient, handoff on mention", async () => {
    const { deps } = makeDeps(text("   "));
    const cw = createChatWindow(deps);
    expect((await cw.chatTurn("e1", "x", "ambient")).kind).toBe("silent");
    expect((await cw.chatTurn("e1", "x", "mention")).kind).toBe("handoff");
  });

  test("safety net: a message with no CLI call comes back kind:reply, delivered:false", async () => {
    const { dir, deps } = makeDeps(text("oops i forgot the command"));
    const cw = createChatWindow(deps);
    const res = await cw.chatTurn("sn", "hey", "mention");
    expect(res).toEqual({ kind: "reply", reply: "oops i forgot the command", delivered: false });
    // still recorded to the window
    expect(readFileSync(join(dir, "sn.log"), "utf8")).toContain("Beckett: oops i forgot the command");
  });

  test("a silent ambient turn records nothing to the window", async () => {
    const { dir, deps } = makeDeps(text(SILENT));
    const cw = createChatWindow(deps);
    await cw.chatTurn("s1", "not about beckett", "ambient");
    expect(fileExists(join(dir, "s1.log"))).toBe(false);
  });

  test("ambient and mention use different system prompts", async () => {
    const systems: string[] = [];
    const run: HaikuRun = async (_p, s) => {
      systems.push(s);
      return { finalText: SILENT };
    };
    const { deps } = makeDeps(run);
    const cw = createChatWindow(deps);
    await cw.chatTurn("m", "hi", "ambient");
    await cw.chatTurn("m", "hi", "mention");
    expect(systems[0]).toContain("OVERHEARING");
    expect(systems[0]).toContain("DEFAULT TO SILENCE");
    expect(systems[1]).toContain("directly addressed");
    expect(systems[1]).not.toContain("DEFAULT TO SILENCE");
  });

  test("system prompt mandates the beckett reply CLI; the prompt carries the channel id", async () => {
    let seenSystem = "";
    let seenPrompt = "";
    const run: HaikuRun = async (p, s) => {
      seenPrompt = p;
      seenSystem = s;
      return { finalText: "", cliReply: "hi" };
    };
    const { deps } = makeDeps(run);
    const cw = createChatWindow(deps);
    await cw.chatTurn("1234567890", "yo", "mention");
    expect(seenSystem).toContain("beckett discord reply --channel");
    expect(seenSystem).toContain("plain text output is discarded");
    expect(seenPrompt).toContain("beckett discord reply --channel 1234567890");
  });

  test("window trims to the last maxTurns exchanges", async () => {
    let n = 0;
    const run: HaikuRun = async () => ({ finalText: "", cliReply: `reply-${n++}` });
    const { dir, deps } = makeDeps(run, 3);
    const cw = createChatWindow(deps);
    for (let i = 0; i < 6; i++) await cw.chatTurn("ch", `msg-${i}`, "mention");
    const lines = readFileSync(join(dir, "ch.log"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(6); // 3 exchanges * 2 lines
    expect(lines[0]).toBe("User: msg-3");
    expect(lines.at(-1)).toBe("Beckett: reply-5");
  });

  test("multiline user text and replies are flattened to one line each", async () => {
    const { dir, deps } = makeDeps(cli("line one\nline two"));
    const cw = createChatWindow(deps);
    await cw.chatTurn("ml", "a\nb\nc", "mention");
    expect(readFileSync(join(dir, "ml.log"), "utf8")).toBe("User: a b c\nBeckett: line one line two\n");
  });

  test("separate channels keep separate windows", async () => {
    const run: HaikuRun = async (p) => ({ finalText: "", cliReply: p.includes("alpha") ? "A" : "B" });
    const { dir, deps } = makeDeps(run);
    const cw = createChatWindow(deps);
    await cw.chatTurn("chanA", "alpha", "mention");
    await cw.chatTurn("chanB", "beta", "mention");
    expect(readFileSync(join(dir, "chanA.log"), "utf8")).toContain("alpha");
    expect(readFileSync(join(dir, "chanB.log"), "utf8")).toContain("beta");
    expect(readFileSync(join(dir, "chanA.log"), "utf8")).not.toContain("beta");
  });
});
