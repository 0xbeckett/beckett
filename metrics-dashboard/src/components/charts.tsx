import { BarChart } from "@/components/dither-kit/bar-chart";
import { Bar } from "@/components/dither-kit/bar";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { Area } from "@/components/dither-kit/area";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import { Grid } from "@/components/dither-kit/grid";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { Sparkline } from "@/components/dither-kit/sparkline";
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
  heightClass = "h-[240px] sm:h-[260px]",
}: {
  data: Datum[];
  color: DitherColor;
  seriesLabel: string;
  valueFormatter: (v: number) => string;
  yFormatter: (v: number) => string;
  variant?: "gradient" | "dotted" | "hatched" | "solid";
  maxTicks?: number;
  heightClass?: string;
}) {
  const config = { value: { label: seriesLabel, color } };
  return (
    <div className={`dk-plot w-full ${heightClass}`}>
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
        <Tooltip labelKey="label" valueFormatter={(v) => valueFormatter(v)} />
      </BarChart>
    </div>
  );
}

/**
 * Dithered area chart for a time series. Dates on X, count on Y; the dither fill
 * carries the neo-brutalist texture. `heightClass` lets the hero timeline run taller.
 */
export function AreaViz({
  data,
  color,
  seriesLabel,
  xFormatter,
  yFormatter,
  valueFormatter,
  maxTicks = 6,
  heightClass = "h-[240px] sm:h-[260px]",
}: {
  data: { date: string; value: number }[];
  color: DitherColor;
  seriesLabel: string;
  xFormatter: (v: unknown) => string;
  yFormatter: (v: number) => string;
  valueFormatter: (v: number) => string;
  maxTicks?: number;
  heightClass?: string;
}) {
  const config = { value: { label: seriesLabel, color } };
  return (
    <div className={`dk-plot w-full ${heightClass}`}>
      <AreaChart
        data={data}
        config={config}
        className="h-full w-full"
        margins={{ top: 12, right: 12, bottom: 26, left: 40 }}
        bloom="low"
      >
        <Grid />
        <YAxis tickFormatter={yFormatter} tickCount={4} />
        <XAxis dataKey="date" tickFormatter={(v) => xFormatter(v)} maxTicks={maxTicks} />
        <Area dataKey="value" variant="gradient" />
        <Tooltip labelKey="date" valueFormatter={(v) => valueFormatter(v)} />
      </AreaChart>
    </div>
  );
}

/** Tiny inline sparkline for hero stats — no axes, just the dithered trend. */
export function Spark({
  data,
  color,
}: {
  data: number[];
  color: DitherColor;
}) {
  return <Sparkline data={data} color={color} variant="gradient" className="h-full w-full" />;
}
