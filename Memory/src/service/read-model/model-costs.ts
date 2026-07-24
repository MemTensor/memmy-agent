import type { ApiLogRecord } from "../../storage/repositories.js";
import { isRecord } from "../../utils/json.js";

export function panelToolLatency(logs: ApiLogRecord[], dates: string[]): {
  tools: Array<{ name: string; calls: number; avgMs: number; p95Ms: number }>;
  series: Array<{ name: string; points: Array<{ date: string; avgMs: number }> }>;
} {
  const byTool = new Map<ApiLogRecord["toolName"], ApiLogRecord[]>();
  for (const log of logs) {
    const current = byTool.get(log.toolName) ?? [];
    current.push(log);
    byTool.set(log.toolName, current);
  }

  const tools = Array.from(byTool.entries())
    .map(([name, rows]) => {
      const durations = rows.map((row) => Math.max(0, Math.round(row.durationMs)));
      return {
        name,
        calls: rows.length,
        avgMs: panelRoundInt(panelAverage(durations)),
        p95Ms: panelPercentile95(durations)
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    tools,
    series: tools.map((tool) => {
      const rows = byTool.get(tool.name as ApiLogRecord["toolName"]) ?? [];
      return {
        name: tool.name,
        points: dates.map((date) => {
          const durations = rows
            .filter((row) => panelDateKey(row.calledAt) === date)
            .map((row) => Math.max(0, Math.round(row.durationMs)));
          return { date, avgMs: panelRoundInt(panelAverage(durations)) };
        })
      };
    })
  };
}

export function panelRecallScore(outputJson: string): number | undefined {
  const output = panelJsonObject(outputJson);
  const stats = isRecord(output.stats) ? output.stats : {};
  const score = stats.topRelevance;
  return typeof score === "number" && Number.isFinite(score) ? Math.max(0, score) : undefined;
}

export function panelLastSevenDateKeys(now: string): string[] {
  return panelDateKeys(now, 7);
}

export function panelDateKeys(now: string, days: number): string[] {
  const parsed = Date.parse(now);
  const end = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return Array.from({ length: days }, (_item, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (days - 1 - index));
    return day.toISOString().slice(0, 10);
  });
}

export function panelDateKey(value: string | undefined): string {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

export function panelAverage(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function panelPercentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return panelRoundInt(sorted[index] ?? 0);
}

export function panelRoundInt(value: number): number {
  return Math.max(0, Math.round(value));
}

export function panelRoundDecimal(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function panelJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
