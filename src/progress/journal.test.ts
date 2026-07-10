/**
 * Coverage for the private ticket journal: the ProgressSink that replaced user-facing Discord
 * progress threads. Worker events append to a ticket-keyed file; the Concierge/CLI reads the
 * tail back on demand. Plus the pure formatEvent contract (what surfaces vs what is noise).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketJournal, formatEvent, readJournal, type ProgressContext } from "./journal.ts";
import type { WorkerEvent, Logger } from "../types.ts";

const IMPL: ProgressContext = { stage: "implement", workerId: "w-1" };

const quietLog = (() => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l } as unknown as Logger;
  return l;
})();

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function journalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-journal-"));
  tmpDirs.push(dir);
  return dir;
}

function toolCall(tool: string, input: unknown): WorkerEvent {
  return { kind: "tool_call", tool, input, toolId: `t-${tool}`, ts: 0 };
}

function finished(status: "success" | "error", summary: string): WorkerEvent {
  return {
    kind: "finished",
    status,
    subtype: "",
    structuredOutput: summary ? { summary } : null,
    usage: {} as never,
    ts: 0,
  };
}

// ── formatEvent (pure) ──────────────────────────────────────────────────────────────────────

test("formatEvent surfaces the play-by-play and drops noise", () => {
  const f = (e: WorkerEvent) => formatEvent(e, IMPL, new Map());
  expect(f({ kind: "session_started", sessionId: "s", model: "sonnet", ts: 0 })).toContain("implement worker started");
  expect(f(toolCall("Bash", { command: "curl -s https://target" }))).toContain("curl -s https://target");
  expect(f({ kind: "file_change", paths: [{ path: "src/a.ts", kind: "update" }], ts: 0 })).toContain("src/a.ts");
  expect(f({ kind: "hook_decision", decision: "deny", reason: "outside scope", ts: 0 })).toContain("deny");
  expect(f(finished("success", "all four criteria met"))).toContain("all four criteria met");
  // Noise: streaming text, per-turn ticks, echoes, successful tool results → dropped.
  expect(f({ kind: "assistant_text", text: "thinking", partial: true, ts: 0 })).toBeNull();
  expect(f({ kind: "turn_completed", usage: {} as never, ts: 0 })).toBeNull();
  expect(f({ kind: "tool_result", toolId: "t-Bash", isError: false, ts: 0 })).toBeNull();
});

test("formatEvent names the tool that errored via the toolNames map", () => {
  const names = new Map<string, string>();
  formatEvent(toolCall("Bash", { command: "false" }), IMPL, names); // records t-Bash → Bash
  const line = formatEvent({ kind: "tool_result", toolId: "t-Bash", isError: true, ts: 0 }, IMPL, names);
  expect(line).toContain("Bash errored");
});

// ── the journal itself ──────────────────────────────────────────────────────────────────────

test("worker events append timestamped lines to a ticket-keyed file; noise never lands", () => {
  const dir = journalDir();
  const journal = new TicketJournal({ dir, logger: quietLog, now: () => 0 });

  journal.event("OPS-1", { kind: "session_started", sessionId: "s", model: "sonnet", ts: 0 }, IMPL);
  journal.event("OPS-1", toolCall("Bash", { command: "bun test" }), IMPL);
  journal.event("OPS-1", { kind: "assistant_text", text: "thinking…", partial: true, ts: 0 }, IMPL);
  journal.event("OPS-1", finished("success", "done"), IMPL);

  const body = readFileSync(join(dir, "OPS-1.log"), "utf8");
  const lines = body.trimEnd().split("\n");
  expect(lines).toHaveLength(3); // the assistant_text noise was dropped
  expect(lines[0]).toContain("1970-01-01T00:00:00.000Z"); // timestamped
  expect(lines[0]).toContain("implement worker started");
  expect(lines[1]).toContain("bun test");
  expect(lines[2]).toContain("✓ implement success: done");
});

test("a tool_result error is attributed per ticket (tool-name maps don't leak across tickets)", () => {
  const dir = journalDir();
  const journal = new TicketJournal({ dir, logger: quietLog, now: () => 0 });

  journal.event("OPS-1", toolCall("Bash", { command: "false" }), IMPL);
  journal.event("OPS-2", { kind: "tool_result", toolId: "t-Bash", isError: true, ts: 0 }, IMPL);

  // OPS-2 never saw the tool_call, so its error line can't name Bash.
  expect(readFileSync(join(dir, "OPS-2.log"), "utf8")).toContain("! tool errored");
});

test("read returns the tail with an elision marker; readJournal serves the CLI path", () => {
  const dir = journalDir();
  const journal = new TicketJournal({ dir, logger: quietLog, now: () => 0 });
  for (let i = 0; i < 10; i++) journal.event("OPS-3", toolCall("Read", { file_path: `/f/${i}` }), IMPL);

  const tail = journal.read("OPS-3", 4)!;
  expect(tail).toContain("… 6 earlier lines elided");
  expect(tail).toContain("/f/9");
  expect(tail).not.toContain("/f/5");
  // The standalone reader (used by `beckett journal`) sees the same content.
  expect(readJournal(dir, "OPS-3", 4)).toBe(tail);
  // An unknown ticket is null — "no journal", not an empty string.
  expect(journal.read("OPS-404")).toBeNull();
});

test("a hostile ticket identifier cannot escape the journal dir", () => {
  const dir = journalDir();
  const journal = new TicketJournal({ dir, logger: quietLog, now: () => 0 });
  journal.event("../../evil", finished("success", "x"), IMPL);
  expect(existsSync(join(dir, ".._.._evil.log"))).toBe(true);
});

test("a journal with no dir is disabled: events drop, reads are null, nothing throws", () => {
  const journal = new TicketJournal({ logger: quietLog });
  journal.event("OPS-1", finished("success", "x"), IMPL);
  expect(journal.read("OPS-1")).toBeNull();
});
