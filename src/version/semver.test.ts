/**
 * Coverage for the pure semver core + the deploy-time MINOR/PATCH classifier (OPS-188). The
 * classifier is the load-bearing "smart bump" heuristic, so its rules (feature → minor, everything
 * else → patch, NEVER major) and its explainability are pinned here.
 */

import { test, expect, describe } from "bun:test";
import { parseSemver, formatSemver, applyBump, classifyBump } from "./semver.ts";

describe("parseSemver / formatSemver", () => {
  test("round-trips a clean triple", () => {
    expect(formatSemver(parseSemver("4.2.0"))).toBe("4.2.0");
  });
  test("tolerates a leading v", () => {
    expect(parseSemver("v10.0.3")).toEqual({ major: 10, minor: 0, patch: 3 });
  });
  test("rejects garbage", () => {
    expect(() => parseSemver("4.2")).toThrow();
    expect(() => parseSemver("nope")).toThrow();
    expect(() => parseSemver("1.2.3-rc1")).toThrow();
  });
});

describe("applyBump (semver carry)", () => {
  test("patch increments the last part only", () => {
    expect(applyBump("4.1.2", "patch")).toBe("4.1.3");
  });
  test("minor increments minor and zeros patch", () => {
    expect(applyBump("4.1.2", "minor")).toBe("4.2.0");
  });
  test("major increments major and zeros minor+patch", () => {
    expect(applyBump("4.1.2", "major")).toBe("5.0.0");
  });
});

describe("classifyBump", () => {
  test("a feature commit makes it a MINOR and names the driver", () => {
    const r = classifyBump(["fix: null guard", "feat: add federation peers command"]);
    expect(r.level).toBe("minor");
    expect(r.minorCommits).toEqual(["feat: add federation peers command"]);
    expect(r.reasons.join("\n")).toContain("add federation peers command");
    expect(r.reasons.join(" ").toLowerCase()).toContain("minor");
  });

  test('"implement" reads as a new capability (minor)', () => {
    const r = classifyBump(["beckett: OPS-186 implement (wk_88b40d1d)"]);
    expect(r.level).toBe("minor");
  });

  test("a pure refactor is a PATCH (V5 refactor is minor-at-most → we call it patch)", () => {
    const r = classifyBump([
      "V5 Daemon: extensibility refactor (all 7 phases) (#114)",
      "chore: tidy imports",
      "docs: update readme",
    ]);
    expect(r.level).toBe("patch");
    expect(r.reasons.join(" ").toLowerCase()).toContain("patch");
  });

  test("NEVER returns major even when a commit screams breaking", () => {
    const r = classifyBump(["feat!: breaking rewrite of the whole daemon API major bump"]);
    expect(r.level).not.toBe("major");
    expect(["minor", "patch"]).toContain(r.level);
  });

  test("word-boundary matching: 'address' does not trip 'add'", () => {
    const r = classifyBump(["fix: correct the peer address parsing"]);
    expect(r.level).toBe("patch");
  });

  test("no commits → PATCH with an explaining reason (no crash)", () => {
    const r = classifyBump([]);
    expect(r.level).toBe("patch");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  test("caps the driver list in the reasons but reports the true count", () => {
    const many = Array.from({ length: 8 }, (_, i) => `feat: add capability number ${i}`);
    const r = classifyBump(many);
    expect(r.level).toBe("minor");
    expect(r.minorCommits.length).toBe(8);
    expect(r.reasons.join("\n")).toContain("and 3 more");
  });
});
