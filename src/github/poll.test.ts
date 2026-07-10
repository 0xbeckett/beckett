import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubPrPoller } from "./poll.ts";
import { parsePrUrl, type PrSignals } from "./types.ts";

const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as const;

function signals(over: Partial<PrSignals> = {}): PrSignals {
  return {
    number: over.number ?? 96,
    url: over.url ?? "https://github.com/0xbeckett/foo/pull/96",
    title: over.title ?? "Add sense",
    state: over.state ?? "OPEN",
    isDraft: over.isDraft ?? false,
    headRefOid: over.headRefOid ?? "sha1",
    reviewDecision: over.reviewDecision ?? "",
    reviews: over.reviews ?? [],
    comments: over.comments ?? [],
    checkConclusion: over.checkConclusion ?? "NONE",
  };
}

/** A reader that returns a scripted queue of signals per `repo#number` (last value sticks). */
class FakeReader {
  queues = new Map<string, PrSignals[]>();
  calls: string[] = [];
  set(repo: string, n: number, seq: PrSignals[]) {
    this.queues.set(`${repo}#${n}`, seq);
  }
  async prSignals(repo: string, n: number): Promise<PrSignals> {
    this.calls.push(`${repo}#${n}`);
    const q = this.queues.get(`${repo}#${n}`);
    if (!q || q.length === 0) throw new Error("no signals scripted");
    return q.length === 1 ? q[0]! : q.shift()!;
  }
}

function poller(reader: FakeReader, over: { account?: string; statePath?: string } = {}): GitHubPrPoller {
  return new GitHubPrPoller({
    reader,
    account: over.account ?? "0xbeckett",
    logger: quiet as never,
    statePath: over.statePath,
    now: () => 1_000,
  });
}

const WATCH = {
  repo: "0xbeckett/foo",
  number: 96,
  url: "https://github.com/0xbeckett/foo/pull/96",
  title: "Add sense",
  ticket: "OPS-124",
  channel: "chan-1",
};

describe("parsePrUrl", () => {
  test("parses org/repo and number from a PR web URL", () => {
    expect(parsePrUrl("https://github.com/0xbeckett/foo/pull/96")).toEqual({ repo: "0xbeckett/foo", number: 96 });
  });
  test("rejects non-PR URLs (a direct push link)", () => {
    expect(parsePrUrl("https://github.com/0xbeckett/foo")).toBeNull();
    expect(parsePrUrl("https://x.0xbeckett.me")).toBeNull();
  });
});

describe("GitHubPrPoller", () => {
  test("the baseline read emits nothing (seeds without replaying history)", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] })]);
    const p = poller(r);
    p.watch(WATCH);
    expect(await p.poll()).toEqual([]);
  });

  test("a new requested-changes review after seeding fires once, routed to the origin channel", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(), // seed
      signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }),
      signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }), // unchanged → deduped
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const first = await p.poll();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("review");
    expect(first[0]!.pr.channel).toBe("chan-1");
    expect(first[0]!.pr.ticket).toBe("OPS-124");
    expect(await p.poll()).toEqual([]); // dedup
  });

  test("approval and plain review comments are material; PENDING/DISMISSED are not", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(),
      signals({ reviews: [rev("a", "ro", "APPROVED"), rev("b", "ro", "COMMENTED"), rev("c", "ro", "PENDING")] }),
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const kinds = (await p.poll()).map((e) => (e.kind === "review" ? e.review.state : e.kind));
    expect(kinds).toEqual(["APPROVED", "COMMENTED"]);
  });

  test("Beckett's own reviews and comments are skipped", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(),
      signals({
        reviews: [rev("r1", "0xbeckett", "APPROVED")],
        comments: [com("c1", "0xbeckett", "ping")],
      }),
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect(await p.poll()).toEqual([]);
  });

  test("a new conversation comment from someone else fires", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ comments: [com("c1", "ro", "looks good?")] })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const ev = await p.poll();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("comment");
  });

  test("CI: failure fires once per head sha, and re-arms on a new push", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals({ checkConclusion: "PENDING" }), // seed while running
      signals({ checkConclusion: "FAILURE" }), // fail → fire
      signals({ checkConclusion: "FAILURE" }), // same sha → deduped
      signals({ headRefOid: "sha2", checkConclusion: "FAILURE" }), // new push → re-armed → fire again
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect((await p.poll()).map((e) => e.kind)).toEqual(["ci"]);
    expect(await p.poll()).toEqual([]);
    const rearmed = await p.poll();
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]).toMatchObject({ kind: "ci", conclusion: "FAILURE" });
  });

  test("a head-sha move alone (Beckett's own push) emits nothing", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ headRefOid: "sha2" })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect(await p.poll()).toEqual([]);
  });

  test("draft churn is suppressed but not replayed once it leaves draft", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [
      signals(),
      signals({ isDraft: true, reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }), // draft → suppressed
      signals({ isDraft: false, reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] }), // same review → still no replay
    ]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect(await p.poll()).toEqual([]);
    expect(await p.poll()).toEqual([]);
  });

  test("merged fires once, then the entry is pruned and never re-polled", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ state: "MERGED" }), signals({ state: "MERGED" })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    const merged = await p.poll();
    expect(merged.map((e) => e.kind)).toEqual(["merged"]);
    r.calls = [];
    expect(await p.poll()).toEqual([]); // terminal pruned
    expect(r.calls).toEqual([]); // no further reads for the dead PR
  });

  test("closed-without-merge fires once", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ state: "CLOSED" })]);
    const p = poller(r);
    p.watch(WATCH);
    await p.poll();
    expect((await p.poll()).map((e) => e.kind)).toEqual(["closed"]);
  });

  test("PRs outside our org are never watched (v1 scope)", async () => {
    const r = new FakeReader();
    const p = poller(r);
    p.watch({ ...WATCH, repo: "someoneelse/foo", url: "https://github.com/someoneelse/foo/pull/1", number: 1 });
    expect(await p.poll()).toEqual([]);
    expect(p.stats().watching).toBe(0);
  });

  test("persisted state means a restart never re-fires an already-surfaced review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-poll-"));
    const statePath = join(dir, "github-prs.json");
    try {
      const r1 = new FakeReader();
      r1.set("0xbeckett/foo", 96, [signals(), signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] })]);
      const p1 = poller(r1, { statePath });
      p1.watch(WATCH);
      await p1.poll(); // seed
      expect(await p1.poll()).toHaveLength(1); // fires once
      expect(existsSync(statePath)).toBe(true);

      // Restart: a fresh poller loads the persisted snapshot; the SAME review must not re-fire.
      const r2 = new FakeReader();
      r2.set("0xbeckett/foo", 96, [signals({ reviews: [rev("r1", "ro", "CHANGES_REQUESTED")] })]);
      const p2 = poller(r2, { statePath });
      expect(p2.stats().watching).toBe(1);
      expect(await p2.poll()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a read failure for one PR is swallowed and retried next tick", async () => {
    const r = new FakeReader();
    // first call throws (empty queue), second returns fine
    r.queues.set("0xbeckett/foo#96", []);
    const p = poller(r);
    p.watch(WATCH);
    expect(await p.poll()).toEqual([]); // did not throw
    r.set("0xbeckett/foo", 96, [signals()]);
    expect(await p.poll()).toEqual([]); // seeds cleanly on retry
  });

  test("re-watch refreshes a previously-unknown channel without replaying history", async () => {
    const r = new FakeReader();
    r.set("0xbeckett/foo", 96, [signals(), signals({ reviews: [rev("r1", "ro", "APPROVED")] })]);
    const p = poller(r);
    p.watch({ ...WATCH, channel: undefined }); // opened before we knew the channel
    await p.poll(); // seed
    p.watch({ ...WATCH, channel: "chan-late" }); // channel learned later
    const ev = await p.poll();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.pr.channel).toBe("chan-late");
  });
});

function rev(id: string, author: string, state: string): PrSignals["reviews"][number] {
  return { id, author, state: state as never, submittedAt: `2026-01-01T00:00:0${id.length}.000Z`, body: "note" };
}
function com(id: string, author: string, body: string): PrSignals["comments"][number] {
  return { id, author, createdAt: `2026-01-01T00:01:0${id.length}.000Z`, body };
}
