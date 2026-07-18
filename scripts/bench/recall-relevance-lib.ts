/** Pure relevance metrics for the recall golden-set runner. */

export interface QueryMetrics {
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAt10: number;
  firstRelevantRank: number | null;
}

/**
 * Score a ranked list against binary relevance labels. Results beyond the returned list are
 * non-relevant: this makes a missing result visible in all three metrics.
 */
export function scoreRanking(
  rankedNames: readonly string[],
  relevantNames: readonly string[],
  precisionK = 3,
): QueryMetrics {
  if (!Number.isInteger(precisionK) || precisionK < 1) {
    throw new Error("precisionK must be a positive integer");
  }

  const relevant = new Set(relevantNames);
  const firstIndex = rankedNames.findIndex((name) => relevant.has(name));
  const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
  const retrievedRelevant = rankedNames.slice(0, precisionK).filter((name) => relevant.has(name)).length;
  const dcg = rankedNames.slice(0, 10).reduce(
    (sum, name, index) => sum + (relevant.has(name) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(relevant.size, 10);
  const idealDcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, gain) => sum + gain, 0);

  return {
    precisionAtK: retrievedRelevant / precisionK,
    reciprocalRank: firstRelevantRank ? 1 / firstRelevantRank : 0,
    ndcgAt10: idealDcg === 0 ? 0 : dcg / idealDcg,
    firstRelevantRank,
  };
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
