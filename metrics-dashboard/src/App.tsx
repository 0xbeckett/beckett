import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { BarViz, AreaViz } from "@/components/charts";
import { ChartCard, Panel, Stat } from "@/components/ui";
import { cn } from "@/lib/utils";
import { metrics, usd, usdPrecise, hrs, shortDate } from "@/metrics";
import { RecallView } from "@/RecallView";

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("bkt-theme");
    if (saved) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("bkt-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

const h = metrics.headline;

type TabId = "telemetry" | "recall";
const TABS: { id: TabId; label: string }[] = [
  { id: "telemetry", label: "Telemetry" },
  { id: "recall", label: "Recall Eval" },
];

// Per-tab masthead copy — the title and blurb change with the active view, the
// frame stays put.
const MAST: Record<TabId, { kicker: string; title: string; blurb: string }> = {
  telemetry: {
    kicker: "Beckett // Telemetry",
    title: "Model\nMetrics",
    blurb:
      "What Beckett's own agent runs actually cost — real spend, wall-clock and review bounces across every model it drives. Harvested, not estimated by hand.",
  },
  recall: {
    kicker: "Beckett // Recall Eval",
    title: "Recall\nScores",
    blurb:
      "How the memory-recall agent ranks against the golden set — P@1, P@5 and MRR per category, luna (pi) vs haiku (claude -p), on the real #34.2 benchmark output.",
  },
};

// Which models are priced from an estimated (non-published) SKU — flagged so the
// cost figures stay honest. Text-only: the bars are one colour, so coloured chips
// here would imply a model→colour encoding the charts don't use.
function EstimateKey() {
  const estimated = metrics.models.filter((m) => m.estimate).map((m) => m.label);
  if (estimated.length === 0) return null;
  return (
    <>
      <span className="text-foreground">·est</span> = estimated SKU (
      {estimated.join(", ")}).
    </>
  );
}

function TelemetryView() {
  const costData = metrics.models.map((m) => ({ label: m.label, value: m.cost }));
  const wallData = metrics.models.map((m) => ({ label: m.label, value: m.wallHours }));
  const cycleData = metrics.reviewCycles.map((c) => ({
    label: c.label,
    value: c.count,
  }));
  const runsData = metrics.runsOverTime.map((d) => ({
    date: d.date,
    value: d.runs,
  }));

  const window =
    h.firstRun && h.lastRun
      ? `${shortDate(h.firstRun)} – ${shortDate(h.lastRun)}`
      : "—";

  return (
    <div className="flex flex-col gap-8">
      {/* ── Headline strip ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Stat label="Runs" value={h.totalRuns.toLocaleString()} />
        <Stat label="Total Spend" value={usd(h.totalSpend)} accent />
        <Stat label="Wall-Clock" value={hrs(h.totalWallHours)} />
        <Stat label="Models" value={String(h.modelsUsed)} />
        <Stat
          label="Tasks"
          value={h.tasksTracked != null ? String(h.tasksTracked) : "—"}
          sub="tracked"
        />
      </div>

      {/* ── Charts ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard
          title="API Cost / Model"
          kicker="USD · current rates"
          footnote={
            <>
              Opus does the heavy lifting and the heavy spending. Rates from the
              harvester's dated table
              {metrics.rate_table_effective_date
                ? ` (${metrics.rate_table_effective_date})`
                : ""}
              . <EstimateKey />
            </>
          }
        >
          <BarViz
            data={costData}
            color="red"
            seriesLabel="Cost"
            variant="hatched"
            valueFormatter={usdPrecise}
            yFormatter={usd}
          />
        </ChartCard>

        <ChartCard
          title="Wall-Clock / Model"
          kicker="hours · first→last log"
          footnote="Summed session duration per model — first to last logged timestamp of each run."
        >
          <BarViz
            data={wallData}
            color="blue"
            seriesLabel="Hours"
            variant="hatched"
            valueFormatter={(v) => `${v.toFixed(1)}h`}
            yFormatter={(v) => `${Math.round(v)}h`}
          />
        </ChartCard>

        <ChartCard
          title="Review Cycles"
          kicker="implement → review bounces"
          footnote="How many times each run's task bounced from implementation back to review. Most land first try."
        >
          <BarViz
            data={cycleData}
            color="green"
            seriesLabel="Runs"
            variant="solid"
            maxTicks={12}
            valueFormatter={(v) => `${v.toLocaleString()} runs`}
            yFormatter={(v) => v.toLocaleString()}
          />
        </ChartCard>

        <ChartCard
          title="Runs Over Time"
          kicker={window}
          footnote="Daily count of harvested agent runs across all harnesses."
        >
          <AreaViz
            data={runsData}
            color="orange"
            seriesLabel="Runs"
            xFormatter={(v) => shortDate(String(v))}
            yFormatter={(v) => v.toLocaleString()}
            valueFormatter={(v) => `${v.toLocaleString()} runs`}
          />
        </ChartCard>
      </div>

      {/* ── Colophon ─────────────────────────────────────────────── */}
      <Panel className="flex flex-col gap-3 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-bold uppercase tracking-wide text-foreground">
            Sources
          </span>
          {metrics.harnesses.map((hn) => (
            <span key={hn.harness} className="whitespace-nowrap">
              {hn.harness}
              <span className="text-foreground"> {hn.count.toLocaleString()}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            harvested{" "}
            <span className="text-foreground">
              {metrics.source_generated_at
                ? metrics.source_generated_at.slice(0, 10)
                : "—"}
            </span>
          </span>
          <span>
            charts{" "}
            <a
              href="https://www.tripwire.sh/dither-kit"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-primary decoration-2 underline-offset-2 hover:text-primary"
            >
              dither-kit
            </a>
          </span>
        </div>
      </Panel>
    </div>
  );
}

export function App() {
  const [dark, toggle] = useTheme();
  const [tab, setTab] = useState<TabId>(() => {
    const saved = localStorage.getItem("bkt-tab");
    return saved === "recall" ? "recall" : "telemetry";
  });
  useEffect(() => {
    localStorage.setItem("bkt-tab", tab);
  }, [tab]);

  const mast = MAST[tab];

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        {/* ── Masthead ─────────────────────────────────────────────── */}
        <header className="mb-8 flex flex-col gap-6 sm:mb-10">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <div className="inline-flex w-fit items-center gap-2 border-2 border-border bg-primary px-2.5 py-1 shadow-brutal-sm">
                <span className="font-mono text-[11px] font-extrabold uppercase tracking-[0.2em] text-primary-foreground">
                  {mast.kicker}
                </span>
              </div>
              <h1 className="whitespace-pre-line font-mono text-3xl font-extrabold uppercase leading-[0.95] tracking-tight text-foreground sm:text-5xl">
                {mast.title}
              </h1>
              <p className="max-w-prose font-sans text-sm leading-relaxed text-muted-foreground sm:text-base">
                {mast.blurb}
              </p>
            </div>
            <button
              type="button"
              onClick={toggle}
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              className="shrink-0 border-2 border-border bg-card p-2.5 shadow-brutal-sm transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-x-0 active:translate-y-0"
            >
              {dark ? (
                <Sun className="size-5" strokeWidth={2.5} />
              ) : (
                <Moon className="size-5" strokeWidth={2.5} />
              )}
            </button>
          </div>

          {/* ── Tab nav ───────────────────────────────────────────── */}
          <nav
            className="flex w-fit gap-0 border-2 border-border bg-card p-1 shadow-brutal-sm"
            aria-label="Dashboard views"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={cn(
                  "px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4 sm:text-xs",
                  tab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>

        {/* ── Active view ──────────────────────────────────────────── */}
        <main>{tab === "telemetry" ? <TelemetryView /> : <RecallView />}</main>
      </div>
    </div>
  );
}
