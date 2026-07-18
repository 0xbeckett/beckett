import { GroupedBarViz, type Series } from "@/components/charts";
import { ChartCard, Panel, Stat } from "@/components/ui";
import { recall, score, pct, ms, type RecallModel } from "@/recall";

// luna vs haiku, in the fixed presentation order the projector emits.
const series: Series[] = recall.models.map((m) => ({
  key: m.seat,
  label: m.label,
  color: m.color,
}));

function seatBy(pick: (m: RecallModel) => number) {
  // The seat that scores highest on `pick` (ties → first, i.e. luna).
  return recall.models.reduce((best, m) => (pick(m) > pick(best) ? m : best));
}

function EmptyState() {
  return (
    <Panel className="p-6 sm:p-8">
      <h2 className="font-mono text-lg font-bold uppercase tracking-wide text-foreground">
        No recall eval data
      </h2>
      <p className="mt-2 max-w-prose font-sans text-sm leading-relaxed text-muted-foreground">
        Run the benchmark and refresh the build:
      </p>
      <pre className="mt-3 overflow-x-auto border-2 border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
        bun run recall:agent-bench -- --json &gt; data/recall-eval.json{"\n"}
        npm run build --prefix metrics-dashboard
      </pre>
    </Panel>
  );
}

export function RecallView() {
  if (!recall.available || recall.models.length === 0) return <EmptyState />;

  const mrrLeader = seatBy((m) => m.mrr);
  const p1Leader = seatBy((m) => m.precisionAt1);
  const evalDate = recall.generated_at ? recall.generated_at.slice(0, 10) : "—";

  return (
    <div className="flex flex-col gap-8">
      {/* ── Headline strip ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Stat label="Golden Queries" value={String(recall.queries)} />
        <Stat label="Categories" value={String(recall.categories.length)} />
        {recall.models.map((m) => (
          <Stat
            key={m.seat}
            label={`${m.label} · MRR`}
            value={score(m.mrr)}
            accent={m.seat === mrrLeader.seat}
            sub={m.seat === mrrLeader.seat ? "lead" : undefined}
          />
        ))}
        <Stat label="Winner" value={mrrLeader.label} sub="by MRR" accent />
      </div>

      {/* ── Charts ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard
          title="Aggregate — luna vs haiku"
          kicker="corpus-wide · higher is better"
          className="lg:col-span-2"
          footnote={
            <>
              The three headline recall scores side by side. <b>{p1Leader.label}</b>{" "}
              wins P@1 ({score(p1Leader.precisionAt1)}); <b>{mrrLeader.label}</b> wins
              MRR ({score(mrrLeader.mrr)}). All scores are 0–1 against the #34.1
              golden labels.
            </>
          }
        >
          <GroupedBarViz
            data={recall.aggregate}
            series={series}
            valueFormatter={score}
            yFormatter={score}
          />
        </ChartCard>

        <ChartCard
          title="P@1 by Category"
          kicker="top hit correct"
          footnote="Precision@1 per golden category — did the agent's first citation match a labelled note."
        >
          <GroupedBarViz
            data={recall.perCategory.precisionAt1}
            series={series}
            valueFormatter={pct}
            yFormatter={score}
          />
        </ChartCard>

        <ChartCard
          title="P@5 by Category"
          kicker="hit in top 5"
          footnote="Precision@5 per category — share of the top-5 ranked citations that are relevant."
        >
          <GroupedBarViz
            data={recall.perCategory.precisionAt5}
            series={series}
            valueFormatter={pct}
            yFormatter={score}
          />
        </ChartCard>

        <ChartCard
          title="MRR by Category"
          kicker="rank of first hit"
          footnote="Mean reciprocal rank per category — 1.0 means the first relevant note led every time; 0.5 means it sat second."
        >
          <GroupedBarViz
            data={recall.perCategory.mrr}
            series={series}
            valueFormatter={score}
            yFormatter={score}
          />
        </ChartCard>

        <ChartCard
          title="Latency — luna vs haiku"
          kicker="ms · lower is better"
          footnote="Per-turn agent latency across the run — p50 (typical) and p95 (tail). The recall path calls the model once per query via the CLI."
        >
          <GroupedBarViz
            data={recall.latency}
            series={series}
            valueFormatter={ms}
            yFormatter={ms}
          />
        </ChartCard>
      </div>

      {/* ── Colophon ─────────────────────────────────────────────── */}
      <Panel className="flex flex-col gap-3 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-bold uppercase tracking-wide text-foreground">Path</span>
          <span className="whitespace-nowrap">moss retrieve → visibility gate → LLM agent</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            corpus <span className="text-foreground">{recall.corpus.parsedNodes} nodes</span>
          </span>
          <span>
            eval <span className="text-foreground">{evalDate}</span>
          </span>
        </div>
      </Panel>
    </div>
  );
}
