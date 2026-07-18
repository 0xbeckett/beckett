import { expect, test } from "bun:test";
import { scoreRanking } from "./recall-relevance-lib.ts";

test("relevance metrics score binary labels, rank, and missing targets", () => {
  const score = scoreRanking(["right-a", "noise", "right-b"], ["right-a", "right-b"], 1);
  expect(score.precisionAtK).toBe(1);
  expect(score.reciprocalRank).toBe(1);
  expect(score.firstRelevantRank).toBe(1);
  expect(score.ndcgAt10).toBeCloseTo((1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)));

  expect(scoreRanking(["noise"], ["missing"], 1)).toEqual({
    precisionAtK: 0,
    reciprocalRank: 0,
    ndcgAt10: 0,
    firstRelevantRank: null,
  });
});
