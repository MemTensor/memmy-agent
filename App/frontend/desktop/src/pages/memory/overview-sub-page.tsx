import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PanelOverviewOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { Tooltip } from "../../components/tooltip.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { BarChart3, BrainCircuit, Globe2, Layers, Sparkles, Wand2 } from "./memory-prototype-icons.js";
import {
  memoryPanelCacheKey,
  readMemoryPanelCache,
  writeMemoryPanelCache
} from "./memory-panel-cache.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

interface OverviewCountCard {
  id: "memories" | "skills" | "experiences" | "worldModels";
  labelKey: MessageKey;
  value: number;
  hintKey: MessageKey;
  icon: ReactNode;
}

interface DailyActivityCell {
  date: string;
  count: number;
  inRange: boolean;
}

interface DailyActivityWeek {
  key: string;
  cells: DailyActivityCell[];
}

interface ActivityMonthLabel {
  key: string;
  label: string;
}

const ACTIVITY_CELL_SIZE = 10;
const ACTIVITY_MAX_CELL_SIZE = 16;
const ACTIVITY_MIN_CELL_SIZE = 5;
const ACTIVITY_CELL_GAP = 3;
const ACTIVITY_MAX_CELL_GAP = 5;
const ACTIVITY_MIN_CELL_GAP = 2;
const ACTIVITY_LABEL_WIDTH = 34;
const ACTIVITY_CELL_RADIUS = 2;
const ACTIVITY_MONTH_GAP = 9;

interface ActivityGridLayout {
  cellSize: number;
  cellGap: number;
  cellRadius: number;
  gridWidth: number;
}

export interface OverviewSubPageProps {
  client: MemoryRuntimeClient | null;
}

export function loadOverviewData(client: MemoryRuntimeClient): Promise<PanelOverviewOutput> {
  return client.getPanelOverview();
}

export function OverviewSubPage(props: OverviewSubPageProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<RemoteData<PanelOverviewOutput>>({ status: "loading" });

  useEffect(() => {
    if (!props.client) {
      setState({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    let active = true;
    const cacheKey = memoryPanelCacheKey("overview");
    const cached = readMemoryPanelCache<PanelOverviewOutput>(cacheKey);
    setState((current) => cached ? { status: "ready", data: cached } : current.status === "ready" ? current : { status: "loading" });
    void loadOverviewData(props.client)
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

  return <OverviewSubPageView state={state} />;
}

export function OverviewSubPageView(props: { state: RemoteData<PanelOverviewOutput> }) {
  const { t } = useTranslation();

  return (
    <section className="memory-page-section">
      <header className="mb-5">
        <h3 className="memory-page-content-title text-base text-text-ink gap-2">
          <Layers size={18} className="text-text-ink/60" />
          {t("memory.overview.title")}
        </h3>
      </header>

      {props.state.status === "loading" && <StateBox message={t("memory.overview.loading")} />}
      {props.state.status === "error" && <StateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && <OverviewContent data={props.state.data} />}
    </section>
  );
}

function OverviewContent(props: { data: PanelOverviewOutput }) {
  const countCards = buildCountCards(props.data);

  return (
    <>
      <div className="grid gap-4 mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
        {countCards.map((item) => (
          <CountCard key={item.id} item={item} />
        ))}
      </div>

      <DailyActivityCard values={props.data.dailyActivity} />
      <SourceDistributionCard values={props.data.sourceDistribution} />
    </>
  );
}

function buildCountCards(data: PanelOverviewOutput): OverviewCountCard[] {
  return [
    { id: "memories", labelKey: "memory.overview.memories", value: data.counts.memories, hintKey: "memory.overview.memoriesHint", icon: <BrainCircuit size={18} /> },
    { id: "experiences", labelKey: "memory.overview.policies", value: data.counts.experiences, hintKey: "memory.overview.policiesHint", icon: <Sparkles size={18} /> },
    { id: "worldModels", labelKey: "memory.overview.worldModels", value: data.counts.worldModels, hintKey: "memory.overview.worldModelsHint", icon: <Globe2 size={18} /> },
    { id: "skills", labelKey: "memory.overview.skills", value: data.counts.skills, hintKey: "memory.overview.skillsHint", icon: <Wand2 size={18} /> }
  ];
}

function CountCard(props: { item: OverviewCountCard }) {
  const { t } = useTranslation();

  return (
    <article className="bg-background-paper border-content-panel rounded-card p-4 flex flex-col justify-between" style={{ minHeight: 132 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-text-ink/60">{t(props.item.labelKey)}</div>
        <span className="w-8 h-8 rounded-card bg-action-sky/10 text-action-sky flex items-center justify-center shrink-0">
          {props.item.icon}
        </span>
      </div>
      <div>
        <div className="text-2xl font-extrabold text-text-ink tabular-nums">{formatInteger(props.item.value)}</div>
        <div className="mt-1 text-[11px] leading-snug text-text-ink/45">{t(props.item.hintKey)}</div>
      </div>
    </article>
  );
}

function DailyActivityCard(props: { values: PanelOverviewOutput["dailyActivity"] }) {
  const { t, language } = useTranslation();
  const [chartRef, chartWidth] = useElementWidth<HTMLDivElement>();
  const weeks = buildDailyActivityWeeks(props.values);
  const maxCount = Math.max(0, ...props.values.map((item) => item.count));
  const monthLabels = buildActivityMonthLabels(props.values, language);
  const weekdayLabels = buildWeekdayLabels(language);
  const activityLayout = activityGridLayoutForWeeks(weeks.length, chartWidth);

  return (
    <article className="relative bg-background-paper border-content-panel rounded-card p-5 mb-5" data-daily-activity-card="true">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm text-text-ink flex items-center gap-2">
            <BarChart3 size={16} className="text-action-sky" />
            {t("memory.overview.dailyActivity")}
          </h4>
          <p className="mt-1 text-xs text-text-ink/50">{t("memory.overview.dailyActivityHint")}</p>
        </div>
        <span className="text-xs text-text-ink/55 tabular-nums whitespace-nowrap">
          {t("memory.overview.sourceCount", { count: formatInteger(props.values.reduce((sum, item) => sum + item.count, 0)) })}
        </span>
      </div>

      {weeks.length === 0 && <div className="text-sm text-text-ink/55">{t("memory.overview.empty")}</div>}
      {weeks.length > 0 && (
        <div ref={chartRef} className="overflow-x-auto pb-1">
          <div>
            <div
              className="grid mb-1 text-[10px] leading-none text-text-ink/45"
              style={{
                gridTemplateColumns: `${ACTIVITY_LABEL_WIDTH}px ${activityLayout.gridWidth}px`,
                columnGap: activityLayout.cellGap,
                marginBottom: ACTIVITY_MONTH_GAP
              }}
            >
              <span aria-hidden="true" />
              <div
                className="grid h-3"
                style={{
                  gridTemplateColumns: `repeat(${monthLabels.length}, minmax(0, 1fr))`,
                  justifyItems: "stretch",
                  width: activityLayout.gridWidth
                }}
              >
                {monthLabels.map((item) => (
                  <span
                    key={item.key}
                    data-activity-month-key={item.key}
                    data-activity-month-label={item.label}
                    className="overflow-visible whitespace-nowrap"
                    style={{ minWidth: 0, textAlign: "center" }}
                  >
                    {item.label}
                  </span>
                ))}
              </div>
            </div>

            <div
              className="grid items-start"
              style={{ gridTemplateColumns: `${ACTIVITY_LABEL_WIDTH}px ${activityLayout.gridWidth}px`, columnGap: activityLayout.cellGap }}
            >
              <div
                className="grid text-[10px] text-text-ink/45"
                style={{
                  gridTemplateRows: `repeat(7, ${activityLayout.cellSize}px)`,
                  rowGap: activityLayout.cellGap,
                  lineHeight: `${activityLayout.cellSize}px`
                }}
              >
                {weekdayLabels.map((label, index) => (
                  <span key={`${label}-${index}`} style={{ height: activityLayout.cellSize }}>
                    {index === 1 || index === 3 || index === 5 ? label : ""}
                  </span>
                ))}
              </div>
              <div
                style={{
                  display: "grid",
                  gridAutoFlow: "column",
                  gridTemplateRows: `repeat(7, ${activityLayout.cellSize}px)`,
                  gridAutoColumns: `${activityLayout.cellSize}px`,
                  gap: activityLayout.cellGap
                }}
                role="img"
                aria-label={t("memory.overview.dailyActivity")}
              >
                {weeks.flatMap((week) => week.cells.map((cell) => {
                  const tooltipText = formatActivityTooltip(cell, language, t);
                  return (
                    <Tooltip key={cell.date} content={tooltipText}>
                      <span
                        data-activity-cell={cell.date}
                        data-activity-level={activityLevel(cell.count, maxCount)}
                        data-activity-tooltip-text={tooltipText}
                        className="memory-daily-activity-cell"
                        style={{
                          display: "block",
                          width: activityLayout.cellSize,
                          height: activityLayout.cellSize,
                          borderRadius: activityLayout.cellRadius,
                          backgroundColor: activityCellColor(cell, maxCount),
                          boxSizing: "border-box"
                        }}
                      />
                    </Tooltip>
                  );
                }))}
              </div>
            </div>
            <DailyActivityLegend maxCount={maxCount} layout={activityLayout} />
          </div>
        </div>
      )}
    </article>
  );
}

function DailyActivityLegend(props: { maxCount: number; layout: ActivityGridLayout }) {
  const { t } = useTranslation();
  const levels = [0, 1, 2, 3, 4];

  return (
    <div className="mt-4 flex items-center justify-end gap-1 text-[11px] text-text-ink/50">
      <span>{t("memory.overview.dailyActivityLess")}</span>
      {levels.map((level) => (
        <span
          key={level}
          style={{
            display: "block",
            width: props.layout.cellSize,
            height: props.layout.cellSize,
            borderRadius: props.layout.cellRadius,
            backgroundColor: activityColorForLevel(level, props.maxCount),
            boxSizing: "border-box"
          }}
        />
      ))}
      <span>{t("memory.overview.dailyActivityMore")}</span>
    </div>
  );
}

function SourceDistributionCard(props: { values: PanelOverviewOutput["sourceDistribution"] }) {
  const { t } = useTranslation();

  return (
    <article className="bg-background-paper border-content-panel rounded-card p-5">
      <div className="mb-4">
        <div>
          <h4 className="text-sm text-text-ink">{t("memory.overview.sourceDistribution")}</h4>
          <p className="mt-1 text-xs text-text-ink/50">{t("memory.overview.sourceDistributionHint")}</p>
        </div>
      </div>
      <div>
        {props.values.length === 0 && <div className="text-sm text-text-ink/55">{t("memory.overview.empty")}</div>}
        {props.values.length > 0 && (
          <div className="space-y-3.5">
            {props.values.map((item, index) => (
              <div
                key={item.source}
                data-source-distribution-row={item.source}
                className="grid items-center gap-x-3"
                style={{ gridTemplateColumns: "96px minmax(0, 1fr) 96px" }}
              >
                <span className="min-w-0 text-xs text-text-ink/70 truncate">{item.source}</span>
                <div className="h-3 rounded-pill bg-canvas-oat overflow-hidden">
                  <div className="h-full rounded-pill" style={{ width: `${item.percentage}%`, backgroundColor: sourceBarColor(index) }} />
                </div>
                <span className="text-right text-xs text-text-ink/55 tabular-nums whitespace-nowrap">
                  {t("memory.overview.sourceCount", { count: formatInteger(item.count) })} · {item.percentage}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function StateBox(props: { message: string; tone?: "error" }) {
  return <div className={`bg-background-paper rounded-card p-5 text-sm ${props.tone === "error" ? "border border-status-error/25 text-status-error" : "border-content-panel text-text-ink/60"}`}>{props.message}</div>;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function activityGridWidthForWeeks(weeks: number): number {
  return weeks * ACTIVITY_CELL_SIZE + Math.max(0, weeks - 1) * ACTIVITY_CELL_GAP;
}

export function activityGridLayoutForWeeks(weeks: number, availableWidth: number): ActivityGridLayout {
  const fallback: ActivityGridLayout = {
    cellSize: ACTIVITY_CELL_SIZE,
    cellGap: ACTIVITY_CELL_GAP,
    cellRadius: ACTIVITY_CELL_RADIUS,
    gridWidth: activityGridWidthForWeeks(weeks)
  };
  if (weeks <= 0 || availableWidth <= 0) return fallback;

  const defaultGridWidth = activityGridWidthForWeeksWithLayout(weeks, ACTIVITY_CELL_SIZE, ACTIVITY_CELL_GAP);
  // The rendered row is [label] [column gap] [grid], and the grid has (weeks - 1)
  // internal gaps. Counting the label->grid gap there are `weeks` gaps total, so
  // reserve one extra gap in the fit math; otherwise the content is one gap wider
  // than the container and shows a horizontal scrollbar.
  const idealTotalWidth = ACTIVITY_LABEL_WIDTH + ACTIVITY_CELL_GAP + defaultGridWidth;
  if (availableWidth > idealTotalWidth) {
    const maxTotalWidth =
      ACTIVITY_LABEL_WIDTH +
      ACTIVITY_MAX_CELL_GAP +
      activityGridWidthForWeeksWithLayout(weeks, ACTIVITY_MAX_CELL_SIZE, ACTIVITY_MAX_CELL_GAP);
    const boundedWidth = Math.min(availableWidth, maxTotalWidth);
    // Budget per column = one cell + one gap. Keeping cellSize + cellGap <= perColumn
    // (via floor) guarantees label + weeks*(cell + gap) <= container width.
    const perColumn = (boundedWidth - ACTIVITY_LABEL_WIDTH) / weeks;
    const cellGap = roundCssPx(
      Math.min(
        ACTIVITY_MAX_CELL_GAP,
        Math.max(ACTIVITY_CELL_GAP, perColumn * (ACTIVITY_CELL_GAP / (ACTIVITY_CELL_SIZE + ACTIVITY_CELL_GAP)))
      )
    );
    const cellSize = floorCssPx(Math.min(ACTIVITY_MAX_CELL_SIZE, perColumn - cellGap));

    return {
      cellSize,
      cellGap,
      cellRadius: roundCssPx(Math.min(ACTIVITY_CELL_RADIUS * (cellSize / ACTIVITY_CELL_SIZE), cellSize / 4)),
      gridWidth: activityGridWidthForWeeksWithLayout(weeks, cellSize, cellGap)
    };
  }

  const maxCellGap = (availableWidth - ACTIVITY_LABEL_WIDTH - weeks * ACTIVITY_CELL_SIZE) / weeks;
  if (maxCellGap >= ACTIVITY_MIN_CELL_GAP) {
    const cellGap = floorCssPx(Math.min(ACTIVITY_CELL_GAP, maxCellGap));
    return {
      cellSize: ACTIVITY_CELL_SIZE,
      cellGap,
      cellRadius: ACTIVITY_CELL_RADIUS,
      gridWidth: activityGridWidthForWeeksWithLayout(weeks, ACTIVITY_CELL_SIZE, cellGap)
    };
  }

  const cellSize = floorCssPx(Math.max(
    ACTIVITY_MIN_CELL_SIZE,
    Math.min(ACTIVITY_CELL_SIZE, (availableWidth - ACTIVITY_LABEL_WIDTH - weeks * ACTIVITY_MIN_CELL_GAP) / weeks)
  ));
  return {
    cellSize,
    cellGap: ACTIVITY_MIN_CELL_GAP,
    cellRadius: roundCssPx(Math.min(ACTIVITY_CELL_RADIUS, cellSize / 4)),
    gridWidth: activityGridWidthForWeeksWithLayout(weeks, cellSize, ACTIVITY_MIN_CELL_GAP)
  };
}

function activityGridWidthForWeeksWithLayout(weeks: number, cellSize: number, cellGap: number): number {
  return roundCssPx(weeks * cellSize + Math.max(0, weeks - 1) * cellGap);
}

function roundCssPx(value: number): number {
  return Math.round(value * 10) / 10;
}

function floorCssPx(value: number): number {
  return Math.floor(value * 10) / 10;
}

function useElementWidth<T extends HTMLElement>(): readonly [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateWidth = (value: number) => {
      setWidth((current) => (Math.abs(current - value) < 0.5 ? current : value));
    };
    updateWidth(element.clientWidth);

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

function buildDailyActivityWeeks(values: PanelOverviewOutput["dailyActivity"]): DailyActivityWeek[] {
  const sorted = values
    .filter((item) => dateKeyToUtcDate(item.date))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];

  const counts = new Map(sorted.map((item) => [item.date, item.count]));
  const first = dateKeyToUtcDate(sorted[0]!.date)!;
  const last = dateKeyToUtcDate(sorted[sorted.length - 1]!.date)!;
  const start = startOfUtcWeek(first);
  const weeks: DailyActivityWeek[] = [];

  for (let weekStart = start; weekStart <= last; weekStart = addUtcDays(weekStart, 7)) {
    const cells = Array.from({ length: 7 }, (_item, index) => {
      const date = utcDateKey(addUtcDays(weekStart, index));
      return {
        date,
        count: counts.get(date) ?? 0,
        inRange: counts.has(date)
      };
    });
    weeks.push({ key: utcDateKey(weekStart), cells });
  }

  return weeks;
}

function buildActivityMonthLabels(values: PanelOverviewOutput["dailyActivity"], language: string): ActivityMonthLabel[] {
  const sortedDates = values
    .map((item) => dateKeyToUtcDate(item.date))
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime());
  if (sortedDates.length === 0) return [];

  const cursor = new Date(Date.UTC(sortedDates[0]!.getUTCFullYear(), sortedDates[0]!.getUTCMonth(), 1));
  const end = new Date(Date.UTC(sortedDates[sortedDates.length - 1]!.getUTCFullYear(), sortedDates[sortedDates.length - 1]!.getUTCMonth(), 1));
  const labels: ActivityMonthLabel[] = [];
  while (cursor <= end) {
    labels.push({
      key: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`,
      label: new Intl.DateTimeFormat(language, { month: "short", timeZone: "UTC" }).format(cursor)
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return labels;
}

function buildWeekdayLabels(language: string): string[] {
  const sunday = new Date(Date.UTC(2026, 0, 4));
  return Array.from({ length: 7 }, (_item, index) => (
    new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(addUtcDays(sunday, index))
  ));
}

function activityLevel(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / maxCount) * 4)));
}

function activityCellColor(cell: DailyActivityCell, maxCount: number): string {
  return activityColorForLevel(activityLevel(cell.count, maxCount), maxCount);
}

function formatActivityTooltip(cell: DailyActivityCell, language: string, t: (key: MessageKey, values?: Record<string, string | number>) => string): string {
  return t("memory.overview.dailyActivityCount", {
    date: formatActivityDate(cell.date, language),
    count: formatInteger(cell.count)
  });
}

function formatActivityDate(value: string, language: string): string {
  const date = dateKeyToUtcDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function activityColorForLevel(level: number, maxCount: number): string {
  if (level === 0 || maxCount <= 0) {
    return "color-mix(in srgb, var(--color-canvas-oat) 70%, var(--color-background-paper))";
  }

  const colors = [
    "color-mix(in srgb, var(--color-status-success) 22%, var(--color-background-paper))",
    "color-mix(in srgb, var(--color-status-success) 42%, var(--color-background-paper))",
    "color-mix(in srgb, var(--color-status-success) 70%, var(--color-background-paper))",
    "color-mix(in srgb, var(--color-status-success) 88%, var(--color-text-ink))"
  ];
  return colors[level - 1]!;
}

function dateKeyToUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day));
}

function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay();
  return addUtcDays(date, -day);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sourceBarColor(index: number): string {
  const colors = [
    "var(--color-action-sky)",
    "var(--color-status-success)",
    "var(--color-role-assistant)",
    "var(--color-icon-ember)",
    "color-mix(in srgb, var(--color-text-ink) 45%, transparent)"
  ];
  return colors[index % colors.length]!;
}
