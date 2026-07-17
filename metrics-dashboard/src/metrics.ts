import raw from "./generated/metrics.json";

// dither-kit's fixed palette identifiers.
export type DitherColor =
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "red"
  | "grey";

export type ModelRow = {
  model: string;
  label: string;
  color: DitherColor;
  runs: number;
  cost: number;
  wallHours: number;
  estimate: boolean;
};

export type Metrics = {
  schema_version: number;
  source_generated_at: string | null;
  rate_table_effective_date: string | null;
  headline: {
    totalRuns: number;
    totalSpend: number;
    totalWallHours: number;
    modelsUsed: number;
    firstRun: string | null;
    lastRun: string | null;
    tasksTracked: number | null;
  };
  models: ModelRow[];
  reviewCycles: { cycles: number; label: string; count: number }[];
  runsOverTime: { date: string; runs: number; cost: number }[];
  harnesses: { harness: string; count: number }[];
  notes: { skippedRows: number; anyEstimated: boolean };
};

export const metrics = raw as Metrics;

// Compact USD formatting that stays legible at a glance across 3 orders of magnitude.
export function usd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function usdPrecise(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 1 ? 2 : 0,
  });
}

export function hrs(n: number): string {
  if (n >= 100) return `${Math.round(n)}h`;
  if (n >= 10) return `${n.toFixed(0)}h`;
  return `${n.toFixed(1)}h`;
}

export function shortDate(iso: string): string {
  // "2026-07-16" -> "Jul 16"
  const [, m, d] = iso.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}
