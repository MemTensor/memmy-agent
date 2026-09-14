/** Analytics view aligned with Memmy's memory analysis page. */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { RefreshButton } from "../components/RefreshButton";
import { t } from "../stores/i18n";

interface DailyPoint {
  date: string;
  count: number;
}

interface ToolLatencyItem {
  name: string;
  calls: number;
  avgMs: number;
  p95Ms: number;
}

interface ToolLatencySeries {
  name: string;
  points: Array<{ date: string; avgMs: number }>;
}

interface AnalyticsPayload {
  metrics: {
    avgRecallScore: number;
    recallEvents: number;
    activeSkills: number;
    recentlyUsedSkills: number;
    avgToolLatencyMs: number;
    p95ToolLatencyMs: number;
  };
  dailyMemoryWrites: DailyPoint[];
  dailySkillEvolutions: DailyPoint[];
  toolLatency: {
    tools: ToolLatencyItem[];
    series: ToolLatencySeries[];
  };
}

interface ChartSeries {
  name: string;
  color: string;
  values: Array<{ label: string; value: number }>;
}

export function AnalyticsView() {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      setData(await api.get<AnalyticsPayload>("/api/v1/analytics"));
    } catch (cause) {
      setError(true);
      throw cause;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  const metrics = data?.metrics;

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("analytics.title")}</h1>
        </div>
        <div class="view-header__actions">
          <RefreshButton onRefresh={load} />
        </div>
      </div>

      {error && !data ? (
        <div class="card muted">{t("analytics.loadError")}</div>
      ) : (
        <>
          <section class="metric-grid">
            <Metric
              label={t("analytics.averageRecallScore")}
              value={loading ? undefined : (metrics?.avgRecallScore ?? 0).toFixed(2)}
              hint={t("analytics.recallEvents", { count: metrics?.recallEvents ?? 0 })}
            />
            <Metric
              label={t("analytics.activeSkillCount")}
              value={loading ? undefined : metrics?.activeSkills ?? 0}
              hint={t("analytics.recentlyUsedSkills", { count: metrics?.recentlyUsedSkills ?? 0 })}
            />
            <Metric
              label={t("analytics.toolAverageLatency")}
              value={loading ? undefined : `${metrics?.avgToolLatencyMs ?? 0}ms`}
              hint={t("analytics.toolAverageLatencyHint")}
            />
            <Metric
              label={t("analytics.toolP95Latency")}
              value={loading ? undefined : `${metrics?.p95ToolLatencyMs ?? 0}ms`}
              hint={t("analytics.slowCallWatch")}
            />
          </section>

          <section class="analytics-chart-grid">
            <DailyBarChart
              title={t("analytics.sevenDayWrites")}
              data={data?.dailyMemoryWrites ?? []}
              loading={loading}
              color="var(--accent)"
            />
            <DailyBarChart
              title={t("analytics.sevenDaySkillEvolutions")}
              data={data?.dailySkillEvolutions ?? []}
              loading={loading}
              color="var(--green)"
            />
          </section>

          <ToolLatencyCard
            tools={data?.toolLatency.tools ?? []}
            series={data?.toolLatency.series ?? []}
            loading={loading}
          />
        </>
      )}
    </>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string | undefined;
  hint: string;
}) {
  return (
    <article class="metric">
      <div class="metric__label">{label}</div>
      <div class="metric__value">
        {value === undefined ? <span class="skeleton analytics-kpi-skeleton" /> : value}
      </div>
      <div class="metric__delta">{hint}</div>
    </article>
  );
}

function DailyBarChart({
  title,
  data,
  loading,
  color,
}: {
  title: string;
  data: DailyPoint[];
  loading: boolean;
  color: string;
}) {
  const max = Math.max(1, ...data.map((point) => point.count));

  return (
    <article class="card">
      <h3 class="card__title">{title}</h3>
      {loading ? (
        <div class="skeleton analytics-chart-skeleton" />
      ) : data.length === 0 ? (
        <div class="empty__hint analytics-chart-empty">{t("analytics.empty")}</div>
      ) : (
        <div class="analytics-bars">
          {data.map((point, index) => {
            const height = point.count > 0 ? Math.max(8, (point.count / max) * 100) : 0;
            return (
              <div class="analytics-bars__column" key={point.date}>
                <div class="analytics-bars__track">
                  <span class="analytics-bars__tooltip">{point.count}</span>
                  {point.count > 0 ? (
                    <span class="analytics-bars__bar" style={`height:${height}%;background:${color}`} />
                  ) : (
                    <span class="analytics-bars__zero" />
                  )}
                </div>
                <span class="analytics-bars__label">
                  {formatDateLabel(point.date, index === data.length - 1)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function ToolLatencyCard({
  tools,
  series,
  loading,
}: {
  tools: ToolLatencyItem[];
  series: ToolLatencySeries[];
  loading: boolean;
}) {
  const chartSeries = useMemo<ChartSeries[]>(
    () => series.map((item, index) => ({
      name: item.name,
      color: toolColor(item.name, index),
      values: item.points.map((point, pointIndex) => ({
        label: formatDateLabel(point.date, pointIndex === item.points.length - 1),
        value: point.avgMs,
      })),
    })),
    [series],
  );
  const colors = new Map(chartSeries.map((item) => [item.name, item.color]));

  return (
    <article class="card analytics-latency-card">
      <h3 class="card__title">{t("analytics.toolLatency")}</h3>
      <p class="card__subtitle">{t("analytics.toolLatencyHint")}</p>
      {loading ? (
        <div class="skeleton analytics-latency-skeleton" />
      ) : (
        <>
          <ToolLatencyChart series={chartSeries} />
          {tools.length === 0 && <div class="empty__hint analytics-chart-empty">{t("analytics.empty")}</div>}
          <div class="analytics-tool-list">
            {tools.map((tool, index) => (
              <div class="analytics-tool-row" key={tool.name}>
                <div class="analytics-tool-row__name" title={tool.name}>
                  <span style={`background:${colors.get(tool.name) ?? toolColor(tool.name, index)}`} />
                  <strong>{tool.name}</strong>
                </div>
                <ToolMetric label="Avg" value={`${tool.avgMs}ms`} />
                <ToolMetric label="P95" value={`${tool.p95Ms}ms`} />
                <ToolMetric label={t("analytics.calls")} value={String(tool.calls)} />
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

function ToolMetric({ label, value }: { label: string; value: string }) {
  return (
    <span class="analytics-tool-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function ToolLatencyChart({ series }: { series: ChartSeries[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(860);
  const height = 260;
  const pad = { top: 18, right: 24, bottom: 44, left: 64 };
  const labels = series[0]?.values.map((point) => point.label) ?? [];
  const max = Math.max(100, ...series.flatMap((item) => item.values.map((point) => point.value)));
  const axisMax = Math.ceil((max * 1.15) / 50) * 50;
  const chartWidth = Math.max(1, width - pad.left - pad.right);
  const chartHeight = height - pad.top - pad.bottom;
  const baseline = height - pad.bottom;
  const toX = (index: number) => pad.left + (chartWidth / Math.max(1, labels.length - 1)) * index;
  const toY = (value: number) => baseline - (Math.max(0, value) / axisMax) * chartHeight;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = Math.max(1, Math.floor(element.getBoundingClientRect().width));
      setWidth((current) => current === nextWidth ? current : nextWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [series.length]);

  if (series.length === 0) return null;

  return (
    <div ref={containerRef} class="analytics-latency-chart-wrap">
      <svg class="analytics-latency-chart" width="100%" height={height} role="img" aria-label={t("analytics.toolLatency")}>
        {Array.from({ length: 5 }, (_, index) => Math.round((axisMax / 4) * index)).map((value) => {
          const y = toY(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="var(--border)" stroke-width="0.7" />
              <text x={pad.left - 10} y={y + 4} text-anchor="end" fill="var(--fg-dim)" font-size="10">{value}ms</text>
            </g>
          );
        })}
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={baseline} stroke="var(--fg-dim)" stroke-width="0.8" />
        <line x1={pad.left} y1={baseline} x2={width - pad.right} y2={baseline} stroke="var(--fg-dim)" stroke-width="0.8" />
        {labels.map((label, index) => (
          <text key={`${label}-${index}`} x={toX(index)} y={height - 18} text-anchor="middle" fill="var(--fg-dim)" font-size="10">{label}</text>
        ))}
        {series.map((item) => {
          const line = item.values.map((point, index) => `${index === 0 ? "M" : "L"}${toX(index).toFixed(1)} ${toY(point.value).toFixed(1)}`).join(" ");
          const area = item.values.length > 0
            ? `${line} L${toX(item.values.length - 1).toFixed(1)} ${baseline} L${toX(0).toFixed(1)} ${baseline} Z`
            : "";
          return (
            <g key={item.name}>
              <path d={area} fill={item.color} opacity="0.08" />
              <path d={line} fill="none" stroke={item.color} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
              {item.values.map((point, index) => (
                <circle key={`${item.name}-${index}`} cx={toX(index)} cy={toY(point.value)} r="4" fill={item.color} stroke="var(--bg-card)" stroke-width="2" />
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatDateLabel(date: string, isLast: boolean): string {
  if (isLast) return t("analytics.today");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[2])}/${Number(match[3])}` : date;
}

function toolColor(name: string, index: number): string {
  if (name === "memory_add") return "var(--amber)";
  if (name === "memory_search") return "var(--green)";
  return ["#7c8cf5", "#8b5cf6", "#06b6d4", "#ec4899"][index % 4]!;
}
