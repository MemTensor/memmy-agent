/** World model sub page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GetMemoryOutput } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { loadWorldModelData, loadWorldModelDetail, WorldModelSubPageView, worldModelStatusTone } from "../world-model-sub-page.js";
import { createMemoryRuntimeClientStub, panelItemsOutput } from "./fixtures.js";

const worldItems = panelItemsOutput([
  {
    id: "memory-world-1",
    kind: "world_model" as const,
    memoryLayer: "L3" as const,
    status: "resolving" as const,
    title: "Memmy 是跨 Agent 记忆 sidecar",
    summary: "Environment",
    tags: ["Memmy"],
    createdAt: "2026-06-03T08:20:00.000Z",
    updatedAt: "2026-06-03T08:30:00.000Z",
    version: 2
  }
]);

const worldDetail: GetMemoryOutput = {
  item: {
    ...worldItems.items[0]!,
    body: "Memmy 是本地记忆 sidecar，不负责调度外部 Agent 任务队列。",
    createdAt: "2026-06-03T07:30:00.000Z",
    sourceMemoryIds: ["memory-trace-1"],
    metadata: {
      source: "mock-codex",
      properties: {
        internal_info: {
          world_model: {
            policyIds: ["memory-policy-1"],
            structure: {
              environment: [
                {
                  label: "本地记忆底座",
                  description: "记忆服务通过 panel items 暴露 L1/L2/L3/Skill 数据。",
                  evidenceIds: ["memory-trace-1"]
                }
              ],
              inference: [
                {
                  label: "页面按层查询",
                  description: "场域认知页面固定读取 L3。"
                }
              ],
              constraints: [
                {
                  label: "不走外部 agent runtime recall",
                  description: "管理页只读本地记忆运行时。"
                }
              ]
            }
          }
        }
      }
    }
  },
  version: 2,
  etag: "world-detail"
};

describe("WorldModelSubPage", () => {
  it("从 panel items/detail 读取场域认知数据", async () => {
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => worldItems),
      getMemory: vi.fn(async () => worldDetail)
    });

    await expect(loadWorldModelData(client, "Memmy")).resolves.toEqual(worldItems);
    await expect(loadWorldModelDetail(client, "memory-world-1")).resolves.toEqual(worldDetail);

    expect(client.listPanelItems).toHaveBeenCalledWith({ layer: "L3", q: "Memmy", page: 1 });
    expect(client.getMemory).toHaveBeenCalledWith("memory-world-1");
  });

  it("渲染 loading/error/empty/ready 状态", () => {
    expect(renderWorldModel({ status: "loading" })).toContain("正在加载场域认知");
    expect(renderWorldModel({ status: "error", message: "world failed" })).toContain("world failed");
    const emptyHtml = renderWorldModel({ status: "ready", data: panelItemsOutput([]) });
    expect(emptyHtml).toContain("暂无场域认知");
    expect(emptyHtml).toContain("memory-state-box");
    expect(emptyHtml).not.toContain("rounded-card p-5 text-sm");

    const html = renderWorldModel({ status: "ready", data: worldItems });
    expect(html).toContain("Memmy 是跨 Agent 记忆 sidecar");
    expect(html).toContain("候选");
    expect(html).toContain("memory-pill--world-model-candidate");
    expect(html).not.toContain("Environment</div>");
    expect(html).toContain('data-icon="search"');
    expect(html).toContain("搜索场域认知");
    expect(html).toContain("记忆分页");
    expect(html).toContain("/ 1 页");
    expect(html).not.toContain("memory-card__summary");
    expect(html).not.toContain(">v2<");
    expect(html).not.toContain("查询");
  });

  it("不把内部 world key 当成场域认知标题", () => {
    const html = renderWorldModel({
      status: "ready",
      data: panelItemsOutput([
        {
          id: "world_7d90403f352485599017",
          kind: "world_model" as const,
          memoryLayer: "L3" as const,
          status: "activated" as const,
          title: "world:17dbbffb4ceda711",
          summary: "Environment",
          tags: ["python"],
          createdAt: "2026-06-05T08:20:00.000Z",
          updatedAt: "2026-06-05T08:30:00.000Z",
          version: 1
        }
      ])
    });

    expect(html).not.toContain("world:17dbbffb4ceda711");
    expect(html).not.toContain("Environment</div>");
    expect(html).toContain("world_7d90403f352485599017");
    expect(html).toContain("已启用");
    expect(html).toContain("memory-pill--world-model-active");
    expect(html).not.toContain(">activated<");
  });

  it("场域认知状态归一到经验和技能一致的展示状态", () => {
    expect(worldModelStatusTone("activated")).toBe("active");
    expect(worldModelStatusTone("active")).toBe("active");
    expect(worldModelStatusTone("resolving")).toBe("candidate");
    expect(worldModelStatusTone("candidate")).toBe("candidate");
    expect(worldModelStatusTone("archived")).toBe("archived");
    expect(worldModelStatusTone("deleted")).toBe("deleted");
  });

  it("渲染右侧详情抽屉和结构化认知", () => {
    const html = renderWorldModel(
      { status: "ready", data: worldItems },
      { status: "ready", data: worldDetail }
    );

    expect(html).toContain("memory-drawer");
    expect(html).toContain('memory-drawer__eyebrow">memory-world-1');
    expect(html).toContain("memory-delete-button");
    expect(html).toContain('data-icon="trash-2"');
    expect(html).toContain("候选");
    expect(html).toContain("结构化认知");
    expect(html).toContain("环境拓扑");
    expect(html).toContain("本地记忆底座");
    expect(html).toContain("memory-policy-1");
  });
});

function renderWorldModel(
  state: Parameters<typeof WorldModelSubPageView>[0]["state"],
  detail: Parameters<typeof WorldModelSubPageView>[0]["detail"] = null
): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <WorldModelSubPageView
        state={state}
        detail={detail}
        selectedWorldModelId="memory-world-1"
        query="Memmy"
        onQueryChange={vi.fn()}
        onSearch={vi.fn()}
        onPageChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenWorldModel={vi.fn()}
        onDeleteWorldModel={vi.fn(async () => undefined)}
        onCloseWorldModel={vi.fn()}
      />
    </I18nProvider>
  );
}
