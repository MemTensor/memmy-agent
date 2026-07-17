/** Overview sub page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { activityGridLayoutForWeeks, loadOverviewData, OverviewSubPageView } from "../overview-sub-page.js";
import { createMemoryRuntimeClientStub, panelOverviewFixture } from "./fixtures.js";

describe("OverviewSubPage", () => {
  it("通过 panel overview 接口读取概览数据", async () => {
    const getPanelOverview = vi.fn(async () => panelOverviewFixture);
    const client = createMemoryRuntimeClientStub({ getPanelOverview });

    const data = await loadOverviewData(client);

    expect(data).toEqual(panelOverviewFixture);
    expect(data.dailyActivity.length).toBeGreaterThan(0);
    expect(data.sourceDistribution.length).toBeGreaterThan(0);
    expect(getPanelOverview).toHaveBeenCalledTimes(1);
  });

  it("渲染概览数量卡和来源分布", () => {
    const html = renderOverview();

    expect(html).toContain('data-icon="layers"');
    expect(html).toContain("记忆数量");
    expect(html).toContain("技能数量");
    expect(html).toContain("经验数量");
    expect(html).toContain("场域认知数量");
    expect(html.indexOf("记忆数量")).toBeLessThan(html.indexOf("经验数量"));
    expect(html.indexOf("经验数量")).toBeLessThan(html.indexOf("场域认知数量"));
    expect(html.indexOf("场域认知数量")).toBeLessThan(html.indexOf("技能数量"));
    expect(html).toContain("每日统计");
    expect(html).toContain("按创建日期统计最近一年的新增记忆。");
    expect(html).toContain('data-daily-activity-card="true"');
    expect(html.indexOf("每日统计")).toBeLessThan(html.indexOf("来源分布"));
    expect(html.match(/data-activity-cell=/g)?.length ?? 0).toBeGreaterThanOrEqual(panelOverviewFixture.dailyActivity.length);
    expect(html).toContain("grid-auto-flow:column");
    expect(html).toContain("grid-auto-columns:10px");
    expect(html).toContain("border-radius:2px");
    expect(html).toContain("data-activity-month-label");
    expect(html).toContain("grid-template-columns:repeat(2, minmax(0, 1fr))");
    expect(html).toContain("5月");
    expect(html).toContain("6月");
    expect(html).toContain("data-activity-tooltip-text");
    expect(html).toContain('aria-describedby="app-tooltip-singleton"');
    expect(html).not.toContain('title="5月4日，新增 0 条记忆"');
    expect(html).toContain("5月4日，新增 0 条记忆");
    expect(html).toContain("margin-bottom:9px");
    expect(html).not.toContain("1px solid transparent");
    expect(html).not.toContain("border:1px solid color-mix(in srgb, var(--color-border-stone) 44%, transparent)");
    expect(html).toContain("来源分布");
    expect(html).toContain("Cursor");
    expect(html).toContain("Codex");
    expect(html).toContain("grid-template-columns:96px minmax(0, 1fr) 96px");
    expect(html.match(/data-source-distribution-row=/g)).toHaveLength(panelOverviewFixture.sourceDistribution.length);
    expect(html).not.toContain('class="contents"');
    expect(html).toContain("whitespace-nowrap");
    expect(html).not.toContain("全量");
    expect(html).not.toContain("任务数量");
    expect(html).not.toContain("主要来源");
    expect(html).not.toContain("已向量化");
    expect(html).not.toContain("今日新增");
  });

  it("跨年同月的活动月份标签使用唯一 key", () => {
    const html = renderOverview({
      ...panelOverviewFixture,
      dailyActivity: [
        { date: "2025-06-01", count: 1 },
        { date: "2026-06-01", count: 2 }
      ]
    });

    expect(html.match(/data-activity-month-label="6月"/g)).toHaveLength(2);
    expect(html).toContain('data-activity-month-key="2025-06"');
    expect(html).toContain('data-activity-month-key="2026-06"');
  });

  it("每日统计热力图在宽容器里充分拉长，在窄容器里收缩", () => {
    const defaultLayout = activityGridLayoutForWeeks(53, 0);
    const wideLayout = activityGridLayoutForWeeks(53, 1200);
    const narrowLayout = activityGridLayoutForWeeks(53, 420);

    expect(defaultLayout).toMatchObject({ cellSize: 10, cellGap: 3, gridWidth: 686 });
    expect(wideLayout.gridWidth).toBeGreaterThan(defaultLayout.gridWidth);
    expect(wideLayout.gridWidth).toBeGreaterThanOrEqual(1050);
    expect(wideLayout.gridWidth).toBeLessThanOrEqual(1200 - 34);
    expect(wideLayout.cellSize).toBeGreaterThan(defaultLayout.cellSize);
    expect(wideLayout.cellSize).toBeLessThanOrEqual(16);
    expect(wideLayout.cellGap).toBeLessThanOrEqual(5);
    expect(narrowLayout.gridWidth).toBeLessThan(defaultLayout.gridWidth);
    expect(narrowLayout.cellSize).toBeLessThan(defaultLayout.cellSize);
  });

  it("热力图整行宽度不超过容器宽度，避免出现横向滚动条", () => {
    // Rendered row = label column (34px) + label->grid column gap + grid width.
    const ACTIVITY_LABEL_WIDTH = 34;
    for (let availableWidth = 620; availableWidth <= 1400; availableWidth += 7) {
      const layout = activityGridLayoutForWeeks(53, availableWidth);
      const totalWidth = ACTIVITY_LABEL_WIDTH + layout.cellGap + layout.gridWidth;
      expect(totalWidth).toBeLessThanOrEqual(availableWidth);
    }
  });
});

function renderOverview(data = panelOverviewFixture): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <OverviewSubPageView state={{ status: "ready", data }} />
    </I18nProvider>
  );
}
