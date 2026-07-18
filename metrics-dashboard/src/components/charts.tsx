import { BarChart } from "@/components/dither-kit/bar-chart";
import { Bar } from "@/components/dither-kit/bar";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { Area } from "@/components/dither-kit/area";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import { Grid } from "@/components/dither-kit/grid";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { BlockLegend } from "@/components/dither-kit/block-legend";
import type { DitherColor } from "@/metrics";

type Datum = { label: string; value: number };

/**
 * Single-series dithered bar chart: one category per bar, labelled on the axis,
 * so every bar is readable at a glance without a legend. Each card owns one
 * palette colour to stay monochromatic and uncluttered.
 */
export function BarViz({
  data,
  color,
  seriesLabel,
  valueFormatter,
  yFormatter,
  variant = "hatched",
  maxTicks = 8,
}: {
  data: Datum[];
  color: DitherColor;
  seriesLabel: string;
  valueFormatter: (v: number) => string;
  yFormatter: (v: number) => string;
  variant?: "gradient" | "dotted" | "hatched" | "solid";
  maxTicks?: number;
}) {
  const config = { value: { label: seriesLabel, color } };
  return (
    <div className="dk-plot h-[240px] w-full sm:h-[260px]">
      <BarChart
        data={data}
        config={config}
        className="h-full w-full"
        margins={{ top: 12, right: 10, bottom: 26, left: 40 }}
        bloom="low"
      >
        <Grid />
        <YAxis tickFormatter={yFormatter} tickCount={4} />
        <XAxis dataKey="label" maxTicks={maxTicks} />
        <Bar dataKey="value" variant={variant} />
        <Tooltip
          labelKey="label"
          valueFormatter={(v) => valueFormatter(v)}
        />
      </BarChart>
    </div>
  );
}

export type Series = { key: string; label: string; color: DitherColor };

/**
 * Grouped dithered bar chart: one category per axis tick, a side-by-side bar per
 * series. Built for the recall head-to-head — luna vs haiku on the same scale so
 * the gap between them is the story. An in-flow {@link BlockLegend} names the
 * seats below the plot (never overlapping the bars, at any width).
 */
export function GroupedBarViz({
  data,
  series,
  xKey = "label",
  valueFormatter,
  yFormatter,
  variant = "hatched",
  maxTicks = 8,
}: {
  data: Record<string, string | number>[];
  series: Series[];
  xKey?: string;
  valueFormatter: (v: number) => string;
  yFormatter: (v: number) => string;
  variant?: "gradient" | "dotted" | "hatched" | "solid";
  maxTicks?: number;
}) {
  const config = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }])
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="dk-plot h-[240px] w-full sm:h-[260px]">
        <BarChart
          data={data}
          config={config}
          className="h-full w-full"
          margins={{ top: 12, right: 10, bottom: 26, left: 40 }}
          bloom="low"
        >
          <Grid />
          <YAxis tickFormatter={yFormatter} tickCount={4} />
          <XAxis dataKey={xKey} maxTicks={maxTicks} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} variant={variant} />
          ))}
          <Tooltip labelKey={xKey} valueFormatter={(v) => valueFormatter(v)} />
        </BarChart>
      </div>
      <BlockLegend config={config} align="start" />
    </div>
  );
}

/**
 * Dithered area chart for the run timeline. Dates on X, run count on Y; the
 * dither fill carries the neo-brutalist texture.
 */
export function AreaViz({
  data,
  color,
  seriesLabel,
  xFormatter,
  yFormatter,
  valueFormatter,
}: {
  data: { date: string; value: number }[];
  color: DitherColor;
  seriesLabel: string;
  xFormatter: (v: unknown) => string;
  yFormatter: (v: number) => string;
  valueFormatter: (v: number) => string;
}) {
  const config = { value: { label: seriesLabel, color } };
  return (
    <div className="dk-plot h-[240px] w-full sm:h-[260px]">
      <AreaChart
        data={data}
        config={config}
        className="h-full w-full"
        margins={{ top: 12, right: 12, bottom: 26, left: 40 }}
        bloom="low"
      >
        <Grid />
        <YAxis tickFormatter={yFormatter} tickCount={4} />
        <XAxis dataKey="date" tickFormatter={(v) => xFormatter(v)} maxTicks={6} />
        <Area dataKey="value" variant="gradient" />
        <Tooltip labelKey="date" valueFormatter={(v) => valueFormatter(v)} />
      </AreaChart>
    </div>
  );
}
