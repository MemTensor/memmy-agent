import { Icon } from "../../components/Icon";
import { locale, t } from "../../stores/i18n";
import { useRef, useState } from "preact/hooks";

export interface DailyActivityPoint {
  date: string;
  count: number;
}

interface ActivityCell extends DailyActivityPoint {
  inRange: boolean;
}

interface ActivityWeek {
  key: string;
  cells: ActivityCell[];
}

const ACTIVITY_CELL_SIZE = 12;
const ACTIVITY_GAP = 3;

export function DailyActivityCard({ values }: { values: DailyActivityPoint[] }) {
  const cardRef = useRef<HTMLElement>(null);
  const [tooltip, setTooltip] = useState<{ text: string; left: number; top: number } | null>(null);
  const weeks = buildWeeks(values);
  const maxCount = Math.max(0, ...values.map((item) => item.count));
  const gridWidth = weeks.length * ACTIVITY_CELL_SIZE + Math.max(0, weeks.length - 1) * ACTIVITY_GAP;
  const language = locale.value === "zh" ? "zh-CN" : "en";
  const monthLabels = buildMonthLabels(weeks, language);
  const total = values.reduce((sum, item) => sum + item.count, 0);

  return (
    <section ref={cardRef} class="card daily-activity-card" data-daily-activity-card="true">
      <div class="card__header" style="margin-bottom:var(--sp-2)">
        <div>
          <h3 class="card__title" style="display:flex;align-items:center;gap:var(--sp-2)">
            <Icon name="bar-chart-3" size={16} />
            {t("overview.daily.title")}
          </h3>
          <p class="card__subtitle">{t("overview.daily.subtitle")}</p>
        </div>
        <span class="muted" style="font-size:var(--fs-xs);white-space:nowrap">
          {t("overview.daily.total", { count: total })}
        </span>
      </div>

      {weeks.length === 0 ? (
        <div class="empty__hint">{t("common.empty")}</div>
      ) : (
        <div style="width:100%;overflow:hidden;padding-bottom:var(--sp-2)">
          <div style={`width:${gridWidth}px;max-width:100%;margin-inline:auto`}>
            <div
              role="img"
              aria-label={t("overview.daily.title")}
              style={`display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,${ACTIVITY_CELL_SIZE}px);grid-auto-columns:${ACTIVITY_CELL_SIZE}px;gap:${ACTIVITY_GAP}px`}
            >
              {weeks.flatMap((week) => week.cells.map((cell) => {
                const tooltip = t("overview.daily.count", {
                  date: formatDate(cell.date, language),
                  count: cell.count,
                });
                return (
                  <span
                    key={cell.date}
                    data-activity-cell={cell.date}
                    data-activity-count={cell.count}
                    aria-label={tooltip}
                    tabIndex={0}
                    onMouseEnter={(event) => showTooltip(event.currentTarget, tooltip)}
                    onMouseLeave={() => setTooltip(null)}
                    onFocus={(event) => showTooltip(event.currentTarget, tooltip)}
                    onBlur={() => setTooltip(null)}
                    style={`display:block;width:${ACTIVITY_CELL_SIZE}px;height:${ACTIVITY_CELL_SIZE}px;border-radius:3px;background:${activityColor(cell, maxCount)};opacity:${cell.inRange ? 1 : 0.35}`}
                  />
                );
              }))}
            </div>

            <div
              style={`display:grid;grid-template-columns:repeat(${weeks.length},${ACTIVITY_CELL_SIZE}px);column-gap:${ACTIVITY_GAP}px;height:12px;margin-top:10px;color:var(--fg-dim);font-size:var(--fs-2xs);line-height:1`}
            >
              {monthLabels.map((item) => (
                <span
                  key={item.key}
                  data-activity-month-label={item.label}
                  style={`grid-column:${item.weekIndex + 1};white-space:nowrap`}
                >
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {tooltip && (
        <span
          class="daily-activity-tooltip"
          role="tooltip"
          style={`left:${tooltip.left}px;top:${tooltip.top}px`}
        >
          {tooltip.text}
        </span>
      )}
    </section>
  );

  function showTooltip(cell: HTMLElement, text: string) {
    const card = cardRef.current;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    setTooltip({
      text,
      left: cellRect.left - cardRect.left + cellRect.width / 2,
      top: cellRect.top - cardRect.top - 8,
    });
  }
}

function buildWeeks(values: DailyActivityPoint[]): ActivityWeek[] {
  const sorted = values
    .filter((item) => parseDate(item.date))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];
  const counts = new Map(sorted.map((item) => [item.date, item.count]));
  const first = parseDate(sorted[0]!.date)!;
  const last = parseDate(sorted.at(-1)!.date)!;
  const start = addDays(first, -first.getUTCDay());
  const weeks: ActivityWeek[] = [];
  for (let weekStart = start; weekStart <= last; weekStart = addDays(weekStart, 7)) {
    const cells = Array.from({ length: 7 }, (_, day) => {
      const date = dateKey(addDays(weekStart, day));
      return { date, count: counts.get(date) ?? 0, inRange: counts.has(date) };
    });
    weeks.push({ key: dateKey(weekStart), cells });
  }
  return weeks;
}

function buildMonthLabels(weeks: ActivityWeek[], language: string): Array<{ key: string; label: string; weekIndex: number }> {
  const labels: Array<{ key: string; label: string; weekIndex: number }> = [];
  let previous = "";
  weeks.forEach((week, weekIndex) => {
    const visibleCell = week.cells.find((cell) => cell.inRange);
    if (!visibleCell) return;
    const month = visibleCell.date.slice(0, 7);
    if (month === previous) return;
    previous = month;
    const date = parseDate(`${month}-01`)!;
    labels.push({
      key: month,
      label: new Intl.DateTimeFormat(language, { month: "short", timeZone: "UTC" }).format(date),
      weekIndex,
    });
  });
  return labels;
}

function activityColor(cell: ActivityCell, maxCount: number): string {
  if (!cell.inRange || cell.count <= 0 || maxCount <= 0) return colorForLevel(0);
  return colorForLevel(Math.max(1, Math.min(4, Math.ceil((cell.count / maxCount) * 4))));
}

function colorForLevel(level: number): string {
  return [
    "color-mix(in srgb, var(--bg-hover) 70%, var(--bg-card))",
    "color-mix(in srgb, var(--accent) 20%, var(--bg-card))",
    "color-mix(in srgb, var(--accent) 40%, var(--bg-card))",
    "color-mix(in srgb, var(--accent) 65%, var(--bg-card))",
    "var(--accent)",
  ][level] ?? "var(--accent)";
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string, language: string): string {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(date)
    : value;
}
