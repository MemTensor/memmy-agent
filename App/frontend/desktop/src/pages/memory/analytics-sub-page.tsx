import { useEffect, useRef, useState } from "react";
import type { PanelAnalysisOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { BarChart3 } from "./memory-prototype-icons.js";
import { memoryPanelCacheKey, readMemoryPanelCache, writeMemoryPanelCache } from "./memory-panel-cache.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

interface DailyPoint {
  date: string;
  label: string;
  count: number;
}

interface ToolLatencyItem {
  toolName: string;
  calls: number;
  avgMs: number;
  p95Ms: number;
}

interface ToolLatencySeries {
  toolName: string;
  color: string;
  values: Array<{
    label: string;
    value: number;
  }>;
}

interface AnalyticsViewData {
  metrics: PanelAnalysisOutput["metrics"];
  dailyWrites: DailyPoint[];
  dailySkillEvolutions: DailyPoint[];
  toolLatency: ToolLatencyItem[];
  toolLatencySeries: ToolLatencySeries[];
}

export interface AnalyticsSubPageProps {
  client: MemoryRuntimeClient | null;
}

export function loadAnalyticsData(client: MemoryRuntimeClient): Promise<PanelAnalysisOutput> {
  return client.getPanelAnalysis();
}

export function AnalyticsSubPage(props: AnalyticsSubPageProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<RemoteData<PanelAnalysisOutput>>({ status: "loading" });

  useEffect(() => {
    if (!props.client) {
      setState({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    let active = true;
    const cacheKey = memoryPanelCacheKey("analytics");
    const cached = readMemoryPanelCache<PanelAnalysisOutput>(cacheKey);
    setState((current) => cached ? { status: "ready", data: cached } : current.status === "ready" ? current : { status: "loading" });
    void loadAnalyticsData(props.client)
      .then((data) => {
        writeMemoryPanelCache(cacheKey, data);
        if (active) setState({ status: "ready", data });
      })
      .catch((error) => {
        if (active) setState({ status: "error", message: toErrorMessage(error) });
      });

    return () => {
      active = false;
    };
  }, [props.client, t]);

  return <AnalyticsSubPageView state={state} />;
}

export function AnalyticsSubPageView(props: { state: RemoteData<PanelAnalysisOutput> }) {
  const { t } = useTranslation();

  return (
    <section className="memory-page-section">
      <header className="mb-5">
        <div>
          <h3 className="memory-page-content-title text-base text-text-ink gap-2">
            <BarChart3 size={18} className="text-text-ink/60" />
            {t("memory.analytics.title")}
          </h3>
        </div>
      </header>

      {props.state.status === "loading" && <StateBox message={t("memory.analytics.loading")} />}
      {props.state.status === "error" && <StateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && <AnalyticsContent data={toAnalyticsViewData(props.state.data, t("memory.overview.today"))} />}
    </section>
  );
}

function AnalyticsContent(props: { data: AnalyticsViewData }) {
  const { t } = useTranslation();
  const data = props.data;

  return (
    <>
      <div className="grid gap-4 mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 144px), 1fr))" }}>
        <KpiCard label={t("memory.analytics.averageRecallScore")} value={data.metrics.avgRecallScore.toFixed(2)} hint={t("memory.analytics.recallEvents", { count: data.metrics.recallEvents })} />
        <KpiCard label={t("memory.analytics.activeSkillCount")} value={data.metrics.activeSkills} hint={t("memory.analytics.recentlyUsedSkills", { count: data.metrics.recentlyUsedSkills })} />
        <KpiCard label={t("memory.analytics.toolAverageLatency")} value={`${data.metrics.avgToolLatencyMs}ms`} hint={t("memory.analytics.toolAverageLatencyHint")} />
        <KpiCard label={t("memory.analytics.toolP95Latency")} value={`${data.metrics.p95ToolLatencyMs}ms`} hint={t("memory.analytics.slowCallWatch")} />
      </div>

      <div className="grid gap-4 mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))" }}>
        <BarChartCard title={t("memory.analytics.sevenDayWrites")} data={data.dailyWrites} color="var(--color-action-sky)" />
        <BarChartCard title={t("memory.analytics.sevenDaySkillEvolutions")} data={data.dailySkillEvolutions} color="var(--color-role-assistant)" />
      </div>

      <ToolLatencyLineChart series={data.toolLatencySeries} rows={data.toolLatency} />
    </>
  );
}

function KpiCard(props: { label: string; value: number | string; hint: string }) {
  return (
    <article className="bg-background-paper border-content-panel rounded-card p-4">
      <div className="text-xs text-text-ink/60 mb-2">{props.label}</div>
      <div className="text-2xl font-extrabold text-text-ink tabular-nums">{props.value}</div>
      <div className="mt-1 text-[11px] leading-snug text-text-ink/45">{props.hint}</div>
    </article>
  );
}

function toAnalyticsViewData(data: PanelAnalysisOutput, todayLabel: string): AnalyticsViewData {
  return {
    metrics: data.metrics,
    dailyWrites: data.dailyMemoryWrites.map((point, index, values) => toDailyPoint(point, index === values.length - 1, todayLabel)),
    dailySkillEvolutions: data.dailySkillEvolutions.map((point, index, values) => toDailyPoint(point, index === values.length - 1, todayLabel)),
    toolLatency: data.toolLatency.tools.map((tool) => ({
      toolName: tool.name,
      calls: tool.calls,
      avgMs: tool.avgMs,
      p95Ms: tool.p95Ms
    })),
    toolLatencySeries: data.toolLatency.series.map((series, index) => ({
      toolName: series.name,
      color: toolLatencyColor(series.name, index),
      values: series.points.map((point, pointIndex, points) => ({
        label: formatDateLabel(point.date, pointIndex === points.length - 1, todayLabel),
        value: point.avgMs
      }))
    }))
  };
}

function toDailyPoint(point: PanelAnalysisOutput["dailyMemoryWrites"][number], isLast: boolean, todayLabel: string): DailyPoint {
  return {
    date: point.date,
    label: formatDateLabel(point.date, isLast, todayLabel),
    count: point.count
  };
}

function BarChartCard(props: { title: string; data: DailyPoint[]; color: string }) {
  const max = Math.max(1, ...props.data.map((item) => item.count));

  return (
    <article className="bg-background-paper border-content-panel rounded-card p-5">
      <h4 className="text-sm text-text-ink mb-4">{props.title}</h4>
      <div className="flex items-end gap-2" style={{ height: 200 }}>
        {props.data.map((item) => {
          const hasValue = item.count > 0;
          const barHeight = hasValue ? Math.max(8, (item.count / max) * 100) : 0;
          const tooltipBottom = hasValue ? Math.min(82, barHeight) : 0;

          return (
            <div key={item.date} className="flex-1 flex flex-col items-center gap-2" style={{ height: "100%" }}>
              <div className="group relative flex w-full flex-1 items-end">
                <span
                  className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-tag bg-text-ink px-2 py-1 text-[10px] text-background-paper opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                  style={{ bottom: `calc(${tooltipBottom}% + 8px)` }}
                >
                  {item.count}
                </span>
                {hasValue ? (
                  <div className="w-full rounded-t-lg transition-all group-hover:brightness-95" style={{ height: `${barHeight}%`, backgroundColor: props.color }} />
                ) : (
                  <div className="h-px w-full rounded-pill bg-text-ink/25 transition-all group-hover:bg-text-ink/45" />
                )}
              </div>
              <span className="text-[10px] text-text-ink/45">{item.label}</span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ToolLatencyLineChart(props: { series: ToolLatencySeries[]; rows: ToolLatencyItem[] }) {
  const { t } = useTranslation();
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(860);
  const chart = buildLatencyChart(props.series, chartWidth);
  const colorByToolName = new Map(props.series.map((item) => [item.toolName, item.color]));

  useEffect(() => {
    const element = chartContainerRef.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = Math.max(1, Math.floor(element.getBoundingClientRect().width));
      setChartWidth((current) => current === nextWidth ? current : nextWidth);
    };

    updateWidth();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <article className="bg-background-paper border-content-panel rounded-card p-5 overflow-hidden">
      <div className="mb-4">
        <div>
          <h4 className="text-sm text-text-ink">{t("memory.analytics.toolLatency")}</h4>
          <p className="mt-1 text-xs text-text-ink/50">{t("memory.analytics.toolLatencyHint")}</p>
        </div>
      </div>
      <div ref={chartContainerRef}>
        <svg width="100%" height={chart.height} role="img" aria-label={t("memory.analytics.toolLatency")} className="block">
          {chart.gridValues.map((value) => {
            const y = chart.toY(value);
            return (
              <g key={`grid-${value}`}>
                <line x1={chart.pad.left} y1={y} x2={chart.width - chart.pad.right} y2={y} stroke="var(--color-border-stone)" strokeOpacity="0.35" />
                <text x={chart.pad.left - 10} y={y + 4} textAnchor="end" fill="currentColor" className="text-text-ink/40" fontSize={10}>{value}ms</text>
              </g>
            );
          })}
          <line x1={chart.pad.left} y1={chart.pad.top} x2={chart.pad.left} y2={chart.height - chart.pad.bottom} stroke="var(--color-text-ink)" strokeOpacity="0.22" />
          <line x1={chart.pad.left} y1={chart.height - chart.pad.bottom} x2={chart.width - chart.pad.right} y2={chart.height - chart.pad.bottom} stroke="var(--color-text-ink)" strokeOpacity="0.22" />
          {chart.labels.map((label, index) => (
            <text key={label} x={chart.toX(index)} y={chart.height - 18} textAnchor="middle" fill="currentColor" className="text-text-ink/45" fontSize={10}>{label}</text>
          ))}
          {props.series.map((item) => {
            const linePath = buildLinePath(item.values, chart.toX, chart.toY);
            const areaPath = buildAreaPath(linePath, item.values, chart.toX, chart.baselineY);
            return (
              <g key={item.toolName} data-tool-name={item.toolName}>
                <path d={areaPath} fill={item.color} fillOpacity="0.08" />
                <path d={linePath} fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                {item.values.map((point, index) => (
                  <circle key={`${item.toolName}-${point.label}`} cx={chart.toX(index)} cy={chart.toY(point.value)} r="4" fill={item.color} stroke="var(--color-background-paper)" strokeWidth="2" />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {props.rows.length === 0 && <div className="mt-4 text-sm text-text-ink/55">{t("memory.analytics.empty")}</div>}
      <div className="mt-4 flex flex-col gap-2">
        {props.rows.map((row, index) => {
          const color = colorByToolName.get(row.toolName) ?? toolLatencyColor(row.toolName, index);
          return (
            <div key={row.toolName} className="rounded-card bg-canvas-oat/35 px-3 py-2" data-tool-name={row.toolName}>
              <div
                className="grid min-w-max items-center text-[11px] text-text-ink/55"
                style={{ gridTemplateColumns: "150px 84px 84px 56px", columnGap: 16 }}
              >
                <div className="flex min-w-0 max-w-full shrink-0 items-center">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-pill" style={{ backgroundColor: color }} />
                  <span className="truncate text-xs text-text-ink" style={{ marginLeft: 8 }} title={row.toolName}>{row.toolName}</span>
                </div>
                <ToolLatencyMetric label="Avg" value={`${row.avgMs}ms`} />
                <ToolLatencyMetric label="P95" value={`${row.p95Ms}ms`} />
                <ToolLatencyMetric label={t("memory.analytics.calls")} value={row.calls.toString()} />
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ToolLatencyMetric(props: { label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline tabular-nums">
      <span className="text-text-ink/45" style={{ marginRight: 5 }}>{props.label}</span>
      <span className="text-text-ink/65">{props.value}</span>
    </span>
  );
}

function buildLatencyChart(series: ToolLatencySeries[], width = 860) {
  const height = 260;
  const pad = { top: 18, right: 24, bottom: 44, left: 64 };
  const labels = series[0]?.values.map((point) => point.label) ?? [];
  const maxValue = Math.max(100, ...series.flatMap((item) => item.values.map((point) => point.value)));
  const axisMax = Math.ceil((maxValue * 1.15) / 50) * 50;
  const chartWidth = Math.max(1, width - pad.left - pad.right);
  const chartHeight = height - pad.top - pad.bottom;
  const baselineY = height - pad.bottom;
  const toX = (index: number) => pad.left + (chartWidth / Math.max(1, labels.length - 1)) * index;
  const toY = (value: number) => baselineY - (Math.max(0, value) / axisMax) * chartHeight;
  const gridValues = Array.from({ length: 5 }, (_, index) => Math.round((axisMax / 4) * index));

  return { width, height, pad, labels, baselineY, toX, toY, gridValues };
}

function buildLinePath(values: ToolLatencySeries["values"], toX: (index: number) => number, toY: (value: number) => number): string {
  return values.map((point, index) => `${index === 0 ? "M" : "L"}${toX(index).toFixed(1)} ${toY(point.value).toFixed(1)}`).join(" ");
}

function buildAreaPath(linePath: string, values: ToolLatencySeries["values"], toX: (index: number) => number, baselineY: number): string {
  if (values.length === 0) {
    return "";
  }

  return `${linePath} L${toX(values.length - 1).toFixed(1)} ${baselineY.toFixed(1)} L${toX(0).toFixed(1)} ${baselineY.toFixed(1)} Z`;
}

function StateBox(props: { message: string; tone?: "error" }) {
  return <div className={`bg-background-paper rounded-card p-5 text-sm ${props.tone === "error" ? "border border-status-error/25 text-status-error" : "border-content-panel text-text-ink/60"}`}>{props.message}</div>;
}

function formatDateLabel(date: string, isLast: boolean, todayLabel: string): string {
  if (isLast) {
    return todayLabel;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return date;
  }

  return `${Number(match[2])}/${Number(match[3])}`;
}

const TOOL_LATENCY_COLORS: Record<string, string> = {
  memory_add: "var(--color-icon-ember)",
  memory_search: "var(--color-role-assistant)"
};

function toolLatencyColor(toolName: string, fallbackIndex: number): string {
  return TOOL_LATENCY_COLORS[toolName] ?? chartColor(fallbackIndex);
}

function chartColor(index: number): string {
  const colors = [
    "var(--color-action-sky)",
    "var(--color-status-success)",
    "var(--color-role-assistant)",
    "var(--color-icon-ember)"
  ];
  return colors[index % colors.length]!;
}
