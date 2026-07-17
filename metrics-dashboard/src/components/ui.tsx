import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
    <As
      className={cn(
        "border-2 border-border bg-card shadow-brutal-sm",
        className
      )}
    >
      {children}
    </As>
  );
}

/** Headline stat: big tabular number over a small raw-caps label. */
export function Stat({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Panel className="flex flex-col justify-between gap-3 p-4 sm:p-5">
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="flex items-end gap-2">
        <span
          className={cn(
            "font-mono text-3xl font-extrabold leading-none tabular-nums tracking-tight sm:text-4xl",
            accent ? "text-primary" : "text-foreground"
          )}
        >
          {value}
        </span>
        {sub ? (
          <span className="mb-0.5 font-mono text-[11px] font-medium text-muted-foreground">
            {sub}
          </span>
        ) : null}
      </div>
    </Panel>
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
    <Panel
      as="section"
      className={cn("flex flex-col shadow-brutal", className)}
    >
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
