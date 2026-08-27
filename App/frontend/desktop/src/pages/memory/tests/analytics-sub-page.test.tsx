/** Analytics sub page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AnalyticsSubPageView, loadAnalyticsData } from "../analytics-sub-page.js";
import { createMemoryRuntimeClientStub, panelAnalysisFixture } from "./fixtures.js";

describe("AnalyticsSubPage", () => {
  it("通过 panel analysis 接口读取分析数据", async () => {
    const getPanelAnalysis = vi.fn(async () => panelAnalysisFixture);
    const client = createMemoryRuntimeClientStub({ getPanelAnalysis });

    const data = await loadAnalyticsData(client);

    expect(data.dailyMemoryWrites).toHaveLength(7);
    expect(data.dailySkillEvolutions).toHaveLength(7);
    expect(data.toolLatency.tools.length).toBeGreaterThan(0);
    expect(data.toolLatency.series).toHaveLength(2);
    expect(getPanelAnalysis).toHaveBeenCalledTimes(1);
  });

  it("渲染分析 KPI、趋势和工具耗时折线图", () => {
    const html = renderAnalytics();

    expect(html).toContain('data-icon="bar-chart-3"');
    expect(html).toContain("平均召回得分");
    expect(html).toContain("活跃技能数量");
    expect(html).toContain("工具平均耗时");
    expect(html).toContain("工具 P95 耗时");
    expect(html).toContain("repeat(auto-fit, minmax(min(100%, 144px), 1fr))");
    expect(html).toContain("最近7天写入趋势");
    expect(html).toContain("最近7天技能进化趋势");
    expect(html).toContain("工具响应耗时");
    expect(html).toContain("按全部工具调用统计");
    expect(html).toContain("memory_search");
    expect(html).toContain("<svg");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("flex flex-col gap-2");
    expect(html).toContain(">34</span>");
    expect(html).not.toContain("memory_search / memory_add");
    expect(html).not.toContain("border-action-sky/20");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("来源分布");
    expect(html).not.toContain("最近30天 - 记忆写入 vs 调用");
  });

  it("工具耗时图按工具名使用稳定且明显区分的颜色", () => {
    const searchTool = panelAnalysisFixture.toolLatency.tools.find((tool) => tool.name === "memory_search")!;
    const addTool = panelAnalysisFixture.toolLatency.tools.find((tool) => tool.name === "memory_add")!;
    const searchSeries = panelAnalysisFixture.toolLatency.series.find((series) => series.name === "memory_search")!;
    const addSeries = panelAnalysisFixture.toolLatency.series.find((series) => series.name === "memory_add")!;
    const html = renderAnalytics({
      ...panelAnalysisFixture,
      toolLatency: {
        tools: [addTool, searchTool],
        series: [addSeries, searchSeries]
      }
    });

    const addBlock = extractToolSeriesBlock(html, "memory_add");
    const searchBlock = extractToolSeriesBlock(html, "memory_search");

    expect(addBlock).toContain('fill="var(--color-icon-ember)"');
    expect(addBlock).toContain('stroke="var(--color-icon-ember)"');
    expect(searchBlock).toContain('fill="var(--color-role-assistant)"');
    expect(searchBlock).toContain('stroke="var(--color-role-assistant)"');
    expect(html).toContain('background-color:var(--color-icon-ember)');
    expect(html).toContain('background-color:var(--color-role-assistant)');
  });

  it("0 值趋势柱只渲染为底部横线", () => {
    const html = renderAnalytics({
      ...panelAnalysisFixture,
      dailyMemoryWrites: panelAnalysisFixture.dailyMemoryWrites.map((point, index) =>
        index === 1 ? { ...point, count: 0 } : point
      ),
      dailySkillEvolutions: panelAnalysisFixture.dailySkillEvolutions.map((point, index) =>
        index === 2 ? { ...point, count: 0 } : point
      )
    });

    expect(html).toContain(">0</span>");
    expect(html).toContain("h-px w-full rounded-pill bg-text-ink/25");
    expect(html).not.toContain("min-height:8px");
  });
});

function renderAnalytics(data = panelAnalysisFixture): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <AnalyticsSubPageView state={{ status: "ready", data }} />
    </I18nProvider>
  );
}

function extractToolSeriesBlock(html: string, toolName: string): string {
  const match = new RegExp(`<g data-tool-name="${toolName}">[\\s\\S]*?</g>`).exec(html);
  expect(match).not.toBeNull();
  return match![0];
}
