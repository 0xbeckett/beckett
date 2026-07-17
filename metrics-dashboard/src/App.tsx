import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { BarViz, AreaViz, Spark } from "@/components/charts";
import { ChartCard, HeroStat, StatChip } from "@/components/ui";
import { Reveal } from "@/motion";
import { metrics, usd, usdPrecise, shortDate } from "@/metrics";
import {
  authorSeries,
  beckettShare,
  commitsPerDay,
  costPerCommit,
  costSeries,
  cycleSeries,
  firstTryRate,
  int,
  linesPerDollar,
  pct,
  projectSeries,
  runsSeries,
  velocitySeries,
  wallSeries,
} from "@/derived";

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
const cs = metrics.codeStats;

// Daily series feeding the hero sparklines.
const dailyCommits = cs.velocity.map((v) => v.commits);
const dailyRuns = metrics.runsOverTime.map((d) => d.runs);
const dailyCost = metrics.runsOverTime.map((d) => d.cost);

const usdFull = (n: number) => `$${int(n)}`;

// Estimated-SKU footnote for the cost chart — keeps the dollar figures honest.
function estimateNote() {
  const est = metrics.models.filter((m) => m.estimate).map((m) => m.label);
  return est.length ? ` · est: ${est.join(", ")}` : "";
}

const runWindow =
  h.firstRun && h.lastRun ? `${shortDate(h.firstRun)} – ${shortDate(h.lastRun)}` : "—";

export function App() {
  const [dark, toggle] = useTheme();

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        {/* ── Masthead ─────────────────────────────────────────────── */}
        <header className="mb-8 flex items-start justify-between gap-4 sm:mb-10">
          <div className="flex flex-col gap-3">
            <div className="inline-flex w-fit items-center gap-2 border-2 border-border bg-primary px-2.5 py-1 shadow-brutal-sm">
              <span className="font-mono text-[11px] font-extrabold uppercase tracking-[0.2em] text-primary-foreground">
                Beckett // Autonomous Agent
              </span>
            </div>
            <h1 className="font-mono text-4xl font-extrabold uppercase leading-[0.9] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
              Proof
              <br />
              of Work
            </h1>
            <p className="max-w-md font-sans text-sm leading-relaxed text-muted-foreground">
              Every figure below is harvested from real git history and session logs. No
              estimates by hand.
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
        </header>

        {/* ── Hero counters ────────────────────────────────────────── */}
        <section className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          <HeroStat
            label="Lines Shipped"
            value={cs.headline.additions}
            format={int}
            sub={`+${int(cs.headline.net)} net`}
            accent
          />
          <HeroStat
            label="Commits"
            value={cs.headline.commits}
            format={int}
            spark={<Spark data={dailyCommits} color="red" />}
          />
          <HeroStat label="Projects" value={cs.headline.projects} format={int} sub="repositories" />
          <HeroStat
            label="Spent"
            value={h.totalSpend}
            format={usdFull}
            spark={<Spark data={dailyCost} color="orange" />}
          />
          <HeroStat
            label="Sessions"
            value={h.totalRuns}
            format={int}
            spark={<Spark data={dailyRuns} color="blue" />}
          />
          <HeroStat
            label="Compute"
            value={h.totalWallHours}
            format={(n) => `${int(n)}h`}
            sub={`${h.modelsUsed} models`}
          />
        </section>

        {/* ── Hero timeline: commit velocity is the show ───────────── */}
        <Reveal className="mb-6">
          <ChartCard title="Commit Velocity" kicker={`daily · ${runWindow}`}>
            <AreaViz
              data={velocitySeries}
              color="red"
              seriesLabel="Commits"
              heightClass="h-[280px] sm:h-[340px]"
              maxTicks={7}
              xFormatter={(v) => shortDate(String(v))}
              yFormatter={(v) => int(v)}
              valueFormatter={(v) => `${int(v)} commits`}
            />
          </ChartCard>
        </Reveal>

        {/* ── Derived ratios ticker ────────────────────────────────── */}
        <section className="mb-8 border-2 border-border bg-card shadow-brutal-sm sm:mb-10">
          <div className="flex flex-wrap divide-border max-sm:divide-y-2 sm:divide-x-2">
            <StatChip value={firstTryRate} label="First Try" format={pct} accent />
            <StatChip value={beckettShare} label="By Beckett" format={pct} />
            <StatChip value={costPerCommit} label="/ Commit" format={(n) => `$${n.toFixed(2)}`} />
            <StatChip value={linesPerDollar} label="Lines / $" format={(n) => int(n)} />
            <StatChip value={commitsPerDay} label="Commits / Day" format={(n) => n.toFixed(1)} />
            <StatChip value={h.tasksTracked ?? 0} label="Tasks" format={int} />
          </div>
        </section>

        {/* ── Chart grid ───────────────────────────────────────────── */}
        <main className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Reveal>
            <ChartCard title="Lines / Project" kicker="added · top 8">
              <BarViz
                data={projectSeries}
                color="purple"
                seriesLabel="Lines"
                variant="hatched"
                valueFormatter={(v) => `${int(v)} lines`}
                yFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : int(v))}
              />
            </ChartCard>
          </Reveal>

          <Reveal delay={0.05}>
            <ChartCard title="Authorship" kicker="commits · top 7">
              <BarViz
                data={authorSeries}
                color="pink"
                seriesLabel="Commits"
                variant="solid"
                valueFormatter={(v) => `${int(v)} commits`}
                yFormatter={(v) => int(v)}
              />
            </ChartCard>
          </Reveal>

          <Reveal>
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
                  {estimateNote()}.
                </>
              }
            >
              <BarViz
                data={costSeries}
                color="red"
                seriesLabel="Cost"
                variant="hatched"
                valueFormatter={usdPrecise}
                yFormatter={usd}
              />
            </ChartCard>
          </Reveal>

          <Reveal delay={0.05}>
            <ChartCard title="Runs / Day" kicker={`sessions · ${runWindow}`}>
              <AreaViz
                data={runsSeries}
                color="orange"
                seriesLabel="Runs"
                xFormatter={(v) => shortDate(String(v))}
                yFormatter={(v) => int(v)}
                valueFormatter={(v) => `${int(v)} runs`}
              />
            </ChartCard>
          </Reveal>

          <Reveal>
            <ChartCard title="Wall-Clock / Model" kicker="hours">
              <BarViz
                data={wallSeries}
                color="blue"
                seriesLabel="Hours"
                variant="hatched"
                valueFormatter={(v) => `${v.toFixed(1)}h`}
                yFormatter={(v) => `${Math.round(v)}h`}
              />
            </ChartCard>
          </Reveal>

          <Reveal delay={0.05}>
            <ChartCard title="Review Cycles" kicker="impl → review bounces">
              <BarViz
                data={cycleSeries}
                color="green"
                seriesLabel="Runs"
                variant="solid"
                maxTicks={12}
                valueFormatter={(v) => `${int(v)} runs`}
                yFormatter={(v) => int(v)}
              />
            </ChartCard>
          </Reveal>
        </main>

        {/* ── Colophon ─────────────────────────────────────────────── */}
        <footer className="mt-8 sm:mt-10">
          <div className="flex flex-col gap-3 border-2 border-border bg-card p-4 font-mono text-[11px] leading-relaxed text-muted-foreground shadow-brutal-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-bold uppercase tracking-wide text-foreground">Sources</span>
              {metrics.harnesses.map((hn) => (
                <span key={hn.harness} className="whitespace-nowrap">
                  {hn.harness}
                  <span className="text-foreground"> {hn.count.toLocaleString()}</span>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                git{" "}
                <span className="text-foreground">
                  {cs.source_generated_at ? cs.source_generated_at.slice(0, 10) : "—"}
                </span>
              </span>
              <span>
                telemetry{" "}
                <span className="text-foreground">
                  {metrics.source_generated_at ? metrics.source_generated_at.slice(0, 10) : "—"}
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
          </div>
        </footer>
      </div>
    </div>
  );
}
