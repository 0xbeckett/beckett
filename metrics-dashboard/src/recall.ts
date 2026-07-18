import raw from "./generated/recall.json";
import type { DitherColor } from "./metrics";

/**
 * Recall-eval (#34.2) aggregates, projected by scripts/prepare-data.mjs from the
 * recall-agent benchmark's JSON. The benchmark stages moss retrieval → the
 * in-code visibility gate → a small LLM agent (luna via pi, haiku via claude -p)
 * and scores the agent's ranking against the #34.1 golden labels.
 */

export type RecallSeat = "luna" | "haiku";

export type RecallModel = {
  seat: RecallSeat;
  model: string;
  label: string;
  color: DitherColor;
  queries: number;
  precisionAt1: number;
  precisionAt5: number;
  mrr: number;
  passRate: number;
  fallbackRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export type RecallCategory = {
  category: string;
  label: string;
  queries: number;
  byModel: Record<
    string,
    { precisionAt1: number; precisionAt5: number; mrr: number; queries: number }
  >;
};

/** A grouped-bar row: an x-axis label plus one numeric column per seat key. */
export type GroupRow = { label: string; category?: string } & Record<string, string | number>;

export type Recall = {
  schema_version: number;
  generated_at: string | null;
  available: boolean;
  corpus: {
    parsedNodes: number;
    cliMemoryDir: string | null;
    legacyMemoryDir: string | null;
  };
  queries: number;
  models: RecallModel[];
  categories: RecallCategory[];
  aggregate: GroupRow[];
  perCategory: {
    precisionAt1: GroupRow[];
    precisionAt5: GroupRow[];
    mrr: GroupRow[];
  };
  latency: GroupRow[];
};

export const recall = raw as Recall;

/** Score (P@1/P@5/MRR/rate) in [0,1] → two-decimal string, e.g. 0.85. */
export function score(n: number): string {
  return n.toFixed(2);
}

/** Score as a whole-percent, e.g. 85%. */
export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Latency in ms → compact "1.2s" / "840ms". */
export function ms(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}
