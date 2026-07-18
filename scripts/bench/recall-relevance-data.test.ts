import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dataPath = new URL("./recall-relevance-golden.json", import.meta.url);
const data = JSON.parse(readFileSync(dataPath, "utf8")) as {
  version: number;
  categories: string[];
  pairs: {
    id: string;
    category: string;
    question: string;
    expectedNoteIds: string[];
    sourceFiles: string[];
    hardNegativeNoteIds?: string[];
  }[];
};

test("versioned recall corpus remains substantial, stratified, and provenance-labelled", () => {
  expect(data.version).toBe(2);
  expect(data.pairs.length).toBeGreaterThanOrEqual(80);
  expect(data.pairs.length).toBeLessThanOrEqual(150);
  expect(new Set(data.categories)).toEqual(new Set([
    "feedback", "people-profile", "project-status", "environment-setup", "adversarial",
  ]));

  const ids = new Set<string>();
  for (const pair of data.pairs) {
    expect(ids.has(pair.id)).toBe(false);
    ids.add(pair.id);
    expect(pair.question.trim().length).toBeGreaterThan(0);
    expect(pair.expectedNoteIds.length).toBeGreaterThan(0);
    expect(pair.sourceFiles.length).toBeGreaterThan(0);
    expect(pair.hardNegativeNoteIds?.some((id) => pair.expectedNoteIds.includes(id)) ?? false).toBe(false);
  }
  for (const category of data.categories) {
    expect(data.pairs.filter((pair) => pair.category === category).length).toBeGreaterThanOrEqual(10);
  }
});

test("Zoom/Fable regression retains its canonical result and known wrong results", () => {
  const pair = data.pairs.find((candidate) => candidate.id === "adversarial-zoom-fable");
  expect(pair?.question).toBe("can zoom use fable");
  expect(pair?.expectedNoteIds).toEqual(["zoom-can-use-fable"]);
  expect(pair?.hardNegativeNoteIds).toEqual(["website-deploy-apex-blocked", "how-to-use-memory"]);
});
