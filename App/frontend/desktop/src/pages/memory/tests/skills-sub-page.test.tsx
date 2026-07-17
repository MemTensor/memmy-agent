/** Skills sub page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { loadSkillDetail, loadSkillsData, loadSkillTimeline, SkillsSubPageView, skillStatusTone } from "../skills-sub-page.js";
import { demoSkillDetail, demoSkillPanelItems, demoSkillTimeline, isSkillsDemoEnabled } from "../skill-demo-data.js";
import { createMemoryRuntimeClientStub, panelItemsOutput, skillPanelDetailFixture, skillPanelItemsFixture } from "./fixtures.js";

describe("SkillsSubPage", () => {
  it("从 panel items/detail 读取技能数据", async () => {
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => skillPanelItemsFixture),
      getMemory: vi.fn(async () => skillPanelDetailFixture),
      listMemoryLogs: vi.fn(async () => skillTimelineLogsOutput())
    });

    await expect(loadSkillsData(client, "中文")).resolves.toEqual(skillPanelItemsFixture);
    await expect(loadSkillDetail(client, "skill-memory-1")).resolves.toEqual(skillPanelDetailFixture);
    await expect(loadSkillTimeline(client, "skill-memory-1")).resolves.toMatchObject([
      { kind: "skill.crystallized", summary: "中文注释技能", success: true }
    ]);

    expect(client.listPanelItems).toHaveBeenCalledWith({ layer: "Skill", q: "中文", page: 1 });
    expect(client.getMemory).toHaveBeenCalledWith("skill-memory-1");
    expect(client.listMemoryLogs).toHaveBeenCalledWith({ tools: ["skill_generate", "skill_evolve"], limit: 500, offset: 0 });
  });

  it("渲染 loading/error/empty/ready 和详情内容", () => {
    expect(renderSkills({ status: "loading" })).toContain("正在加载技能");
    expect(renderSkills({ status: "error", message: "skills failed" })).toContain("skills failed");
    const emptyHtml = renderSkills({ status: "ready", data: panelItemsOutput([]), detail: null });
    expect(emptyHtml).toContain("暂无技能");
    expect(emptyHtml).toContain("memory-state-box");
    expect(emptyHtml).not.toContain("rounded-card p-5 text-sm");

    const html = renderSkills({
      status: "ready",
      data: skillPanelItemsFixture,
      detail: { status: "ready", data: { detail: skillPanelDetailFixture, timeline: skillTimelineEntries() } }
    });
    expect(html).toContain("根据仓库真实代码补齐中文文件级、函数级和字段含义注释。");
    expect(html).toContain("先读文件");
    expect(html).toContain("已启用");
    expect(html).toContain("价值评分");
    expect(html).toContain("memory-pill--skill-active");
    expect(html).toContain("memory-drawer");
    expect(html).toContain('memory-drawer__eyebrow">skill-memory-1');
    expect(html).toContain("memory-delete-button");
    expect(html).toContain('data-icon="trash-2"');
    expect(html).not.toContain(">v4<");
    expect(html).toContain("调用指南");
    expect(html).toContain("来源经验");
    expect(html).toContain("memory-policy-1");
    expect(html).toContain("进化时间线");
    expect(html).toContain("结晶完成");
    expect(html).toContain("价值评分更新");
    expect(html).toContain("中文注释技能");
    expect(html).toContain('data-icon="search"');
    expect(html).toContain("搜索技能");
    expect(html).toContain("记忆分页");
    expect(html).toContain("/ 1 页");
    expect(html).not.toContain("memory-card__summary");
    expect(html).not.toContain(">activated<");
  });

  it("技能卡片从长摘要中提取短标题", () => {
    const html = renderSkills({
      status: "ready",
      data: panelItemsOutput([
        {
          id: "skill_0f56cfb9815a96aa67d8",
          kind: "skill" as const,
          memoryLayer: "Skill" as const,
          status: "resolving" as const,
          title: "skill_0f56cfb9815a96aa67d",
          summary: "Brief Greeting for Salutations Use this skill when the user's latest message is only a greeting or salutation with no task.",
          tags: ["skill", "greeting"],
          createdAt: "2026-06-05T16:30:12.000Z",
          updatedAt: "2026-06-05T16:40:12.000Z",
          version: 1
        }
      ]),
      detail: null
    });

    expect(html).toContain("Brief Greeting for Salutations");
    expect(html).toContain("候选");
    expect(html).toContain("memory-pill--skill-candidate");
    expect(html).not.toContain("Use this skill when");
    expect(html).not.toContain("skill_0f56cfb9815a96aa67d");
    expect(html).not.toContain(">resolving<");
  });

  it("技能列表生命周期和详情技能状态使用同一套展示状态", () => {
    expect(skillStatusTone("resolving")).toBe("candidate");
    expect(skillStatusTone("candidate")).toBe("candidate");
    expect(skillStatusTone("activated")).toBe("active");
    expect(skillStatusTone("active")).toBe("active");

    const html = renderSkills({
      status: "ready",
      data: panelItemsOutput([{ ...skillPanelItemsFixture.items[0]!, status: "resolving" as const }]),
      detail: {
        status: "ready",
        data: {
          detail: {
            ...skillPanelDetailFixture,
            item: {
              ...skillPanelDetailFixture.item,
              status: "resolving" as const,
              metadata: {
                ...skillPanelDetailFixture.item.metadata,
                properties: {
                  internal_info: {
                    skill: {
                      status: "candidate"
                    }
                  }
                }
              }
            }
          },
          timeline: []
        }
      }
    });

    expect(html).toContain("候选");
    expect(html).toContain("memory-pill--skill-candidate");
    expect(html).not.toContain(">candidate<");
    expect(html).not.toContain(">resolving<");
  });

  it("提供可截图的多版本 skill demo 数据", () => {
    const items = demoSkillPanelItems("", 1);
    const firstSkill = items.items[0]!;
    const detail = demoSkillDetail(firstSkill.id)!;
    const timeline = demoSkillTimeline(firstSkill.id);
    const html = renderSkills({
      status: "ready",
      data: items,
      detail: { status: "ready", data: { detail, timeline } }
    });

    expect(isSkillsDemoEnabled("?memoryPage=skills&demoSkills=1")).toBe(true);
    expect(isSkillsDemoEnabled("?memoryPage=skills")).toBe(false);
    expect(items.items).toHaveLength(4);
    expect(timeline.map((entry) => entry.summary).join("\n")).toContain("v6:");
    expect(timeline.map((entry) => entry.summary).join("\n")).toContain("v1:");
    expect(html).toContain("发布前回归风险扫描");
    expect(html).toContain("v6: 根据 Electron 打包失败样本");
    expect(html).toContain("v3: 尝试加入全量 e2e 阻塞策略");
    expect(html).toContain("memory-skill-timeline__dot--failed");
  });
});

/** Renders render skills. */
function renderSkills(state: Parameters<typeof SkillsSubPageView>[0]["state"]): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <SkillsSubPageView
        state={state}
        query="中文"
        onQueryChange={vi.fn()}
        onSearch={vi.fn()}
        onPageChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenSkill={vi.fn()}
        onDeleteSkill={vi.fn(async () => undefined)}
        onCloseSkill={vi.fn()}
      />
    </I18nProvider>
  );
}

function skillTimelineLogsOutput() {
  return {
    logs: [
      {
        id: 10,
        toolName: "skill_generate" as const,
        inputJson: JSON.stringify({ phase: "done" }),
        outputJson: JSON.stringify({ skillId: "skill-memory-1", kind: "skill.crystallized", name: "中文注释技能" }),
        durationMs: 42,
        success: true,
        calledAt: "2026-06-03T10:30:00.000Z"
      }
    ],
    total: 1,
    limit: 500,
    offset: 0,
    serverTime: "2026-06-03T10:31:00.000Z"
  };
}

function skillTimelineEntries() {
  return [
    {
      ts: "2026-06-03T10:35:00.000Z",
      kind: "skill.eta.updated",
      durationMs: 8,
      success: true,
      summary: "反馈后提升"
    },
    {
      ts: "2026-06-03T10:30:00.000Z",
      kind: "skill.crystallized",
      durationMs: 42,
      success: true,
      summary: "中文注释技能"
    }
  ];
}
