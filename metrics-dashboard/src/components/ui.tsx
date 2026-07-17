import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CountUp } from "@/motion";

/** A single hard-framed panel — the brutalist building block. */
export function Panel({
  className,
  children,
  as: As = "div",
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "section" | "header";
}) {
  return (
    <As className={cn("border-2 border-border bg-card", className)}>{children}</As>
  );
}

/**
 * Hero figure: an oversized count-up number over a raw-caps label, with an optional
 * sub-figure and a decorative sparkline. This is the marketing punch — one accent stat
 * leads, the rest stay in ink.
 */
export function HeroStat({
  label,
  value,
  format,
  sub,
  accent = false,
  spark,
  className,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  sub?: string;
  accent?: boolean;
  spark?: ReactNode;
  className?: string;
}) {
  return (
    <Panel
      className={cn(
        "flex flex-col justify-between gap-3 p-4 shadow-brutal-sm transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 sm:gap-4 sm:p-5",
        className,
      )}
    >
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground sm:text-[11px]">
        {label}
      </div>
      <div className="flex flex-col gap-1">
        <CountUp
          value={value}
          format={format}
          className={cn(
            "font-mono text-[2rem] font-extrabold leading-[0.85] tabular-nums tracking-tight sm:text-5xl lg:text-6xl",
            accent ? "text-primary" : "text-foreground",
          )}
        />
        {sub ? (
          <div className="font-mono text-[11px] font-medium tabular-nums text-muted-foreground">
            {sub}
          </div>
        ) : null}
      </div>
      {spark ? <div className="h-9 w-full sm:h-11">{spark}</div> : null}
    </Panel>
  );
}

/** One figure in the derived-ratio ticker: big number, tiny caps label, inline. */
export function StatChip({
  value,
  label,
  format,
  accent = false,
}: {
  value: number;
  label: string;
  format: (n: number) => string;
  accent?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-baseline gap-2 whitespace-nowrap px-4 py-3 sm:px-5">
      <CountUp
        value={value}
        format={format}
        className={cn(
          "font-mono text-xl font-extrabold tabular-nums tracking-tight sm:text-2xl",
          accent ? "text-primary" : "text-foreground",
        )}
      />
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** A titled chart panel: heavy header bar + roomy plot area + optional footnote. */
export function ChartCard({
  title,
  kicker,
  footnote,
  children,
  className,
}: {
  title: string;
  kicker: string;
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Panel as="section" className={cn("flex flex-col shadow-brutal", className)}>
      <div className="flex items-baseline justify-between gap-3 border-b-2 border-border px-4 py-3 sm:px-5">
        <h2 className="font-mono text-sm font-bold uppercase tracking-wide text-foreground">
          {title}
        </h2>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {kicker}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">{children}</div>
      {footnote ? (
        <div className="border-t-2 border-dashed border-border px-4 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground sm:px-5">
          {footnote}
        </div>
      ) : null}
    </Panel>
  );
}
