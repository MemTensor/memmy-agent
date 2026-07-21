/** Memories sub page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { agentSourceDisplayName, MEMORY_AGENT_SOURCE_VALUES } from "../../agent-source-logos.js";
import {
  buildPanelItemsInput,
  loadMemoryDetail,
  loadMemoriesData,
  MemoriesSubPageView,
  processingRetryErrorMessage
} from "../memories-sub-page.js";
import { ApiRequestError } from "../../../api/http.js";
import {
  createMemoryRuntimeClientStub,
  memoryDetailFixture,
  memoryListItemFixture,
  panelItemsFixture,
  panelItemsOutput
} from "./fixtures.js";
import { createMockMemoryRuntimeClient } from "./memory-runtime-fixtures.js";
import { displayMemoryTitle, memoryDisplaySource } from "../memory-display.js";
import {
  MEMORY_SOURCE_AGENT_EXCLUSIONS,
  OTHER_MEMORY_SOURCE_AGENT
} from "../memory-agent-filter.js";

describe("MemoriesSubPage", () => {
  it("把搜索转换为只读取原始记忆的 PanelItemsInput", () => {
    expect(buildPanelItemsInput({ query: "偏好" })).toEqual({
      q: "偏好",
      layer: "L1",
      page: 1
    });
    expect(buildPanelItemsInput({ query: "偏好", page: 3 })).toEqual({
      q: "偏好",
      layer: "L1",
      page: 3
    });
    expect(buildPanelItemsInput({ sourceAgent: "cursor" })).toEqual({
      layer: "L1",
      sourceAgent: "cursor",
      page: 1
    });
    expect(buildPanelItemsInput({ sourceAgent: OTHER_MEMORY_SOURCE_AGENT })).toEqual({
      layer: "L1",
      excludedSourceAgents: MEMORY_SOURCE_AGENT_EXCLUSIONS,
      page: 1
    });
  });

  it("在 L1 搜索框内展示带图标的 Agent 筛选", () => {
    const html = renderMemories({ status: "ready", data: panelItemsOutput([]), detail: null });

    expect(html).toContain("memory-source-search-control");
    expect(html).toContain('id="memory-l1-agent-filter"');
    expect(html).toContain("memory-source-filter__all-icon");
    expect(html.match(/memory-source-filter__all-avatar/g)).toHaveLength(3);
    expect(html).toContain("memmy-rice.png");
    expect(html).not.toContain("lucide-bot");
    expect(html).toContain("全部 Agent");
    expect(html).toContain("按来源 Agent 筛选");
  });

  it("筛选器和详情共用统一的 Agent 名称格式", () => {
    expect(MEMORY_AGENT_SOURCE_VALUES.map(agentSourceDisplayName)).toEqual([
      "Memmy",
      "Cursor",
      "Claude Code",
      "Codex",
      "OpenCode",
      "OpenClaw",
      "Hermes",
      "WorkBuddy"
    ]);
    expect(agentSourceDisplayName("MEMMY_AGENT")).toBe("Memmy");
    expect(agentSourceDisplayName("claude-code")).toBe("Claude Code");
    expect(agentSourceDisplayName("OPENCLAW")).toBe("OpenClaw");
  });

  it("从导入 trace 的 tags 中识别来源 agent", () => {
    expect(memoryDisplaySource({ tags: ["trace", "cursor", "agent-source", "摘要排队中"] })).toBe("cursor");
  });

  it("优先使用列表项 metadata.source 展示来源 agent", () => {
    expect(memoryDisplaySource({ tags: ["database", "http"], metadata: { source: "codex" } })).toBe("codex");
  });

  it("展示自定义来源 agent 的原始名称", () => {
    expect(memoryDisplaySource({ tags: ["trace"], metadata: { source: "test_agent" } })).toBe("test_agent");
  });

  it("没有来源信息时归为未知，而不是 Memmy", () => {
    expect(memoryDisplaySource({ tags: ["trace"] })).toBe("unknown");
  });

  it("记忆列表使用与日志页一致的来源 Agent 标签", () => {
    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([{
        ...memoryListItemFixture,
        metadata: { source: "CODEX" }
      }]),
      detail: null
    });

    expect(html).toContain("memory-agent-source-tag");
    expect(html).toContain("memory-agent-source-tag__logo");
    expect(html).toContain('src="data:image/svg+xml');
    expect(html).toContain('aria-label="来源: Codex"');
    expect(html).toContain(">Codex</span>");
    expect(html).not.toContain("来源: codex");
    expect(html).not.toContain("memory-pill--source");
  });

  it("摘要未完成时用导入 trace 的用户 query 作为记忆标题", () => {
    expect(displayMemoryTitle({
      id: "memory-trace-import",
      title: "codex turn 2026-06-10 #10",
      summary: "## user",
      memoryLayer: "L1",
      body: "## user\n\n修复自动扫描卡顿和标题占位\n\n## assistant\n\n已开始排查。"
    })).toBe("修复自动扫描卡顿和标题占位");
  });

  it("搜索列表和点击详情都调用 memoryRuntime client", async () => {
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => panelItemsFixture),
      getMemory: vi.fn(async () => memoryDetailFixture)
    });

    await expect(loadMemoriesData(client, buildPanelItemsInput({ query: "偏好" }))).resolves.toEqual(panelItemsFixture);
    await expect(loadMemoryDetail(client, memoryListItemFixture)).resolves.toEqual(memoryDetailFixture);

    expect(client.listPanelItems).toHaveBeenCalledWith({ q: "偏好", layer: "L1", page: 1 });
    expect(client.getMemory).toHaveBeenCalledWith("memory-trace-1");
  });

  it("mock runtime 列表搜索索引包含记忆 id", async () => {
    const client = createMockMemoryRuntimeClient();

    const list = await client.listPanelItems({ layer: "L1", q: "memory-trace-1", page: 1 });

    expect(list.items.map((item) => item.id)).toEqual(["memory-trace-1"]);
  });

  it("多页记忆列表渲染分页控件", () => {
    const html = renderMemories({
      status: "ready",
      data: {
        ...panelItemsOutput([memoryListItemFixture]),
        total: 43,
        totalPages: 3,
        hasNext: true
      },
      detail: null
    });

    expect(html).toContain("记忆分页");
    expect(html).toContain('value="1"');
    expect(html).toContain("/ 3 页");
    expect(html).toContain('data-icon="chevron-left"');
    expect(html).toContain('data-icon="chevron-right"');
    expect(html).not.toContain("共 43 条");
  });

  it("把结构化处理状态渲染成用户可理解的提示", () => {
    const base = {
      ...memoryListItemFixture,
      metrics: undefined,
      tags: ["agent-source", "cursor"]
    };

    const summaryHtml = renderMemories({
      status: "ready",
      data: panelItemsOutput([{
        ...base,
        id: "memory-summary",
        processing: processingRecord("memory-summary", "summary_pending", "summary")
      }]),
      detail: null
    });
    expect(summaryHtml).toContain("摘要总结中");

    const indexHtml = renderMemories({
      status: "ready",
      data: panelItemsOutput([{
        ...base,
        id: "memory-index",
        processing: processingRecord("memory-index", "embedding_pending", "embedding")
      }]),
      detail: null
    });
    expect(indexHtml).toContain("索引建立中");

    const readyHtml = renderMemories({
      status: "ready",
      data: panelItemsOutput([{
        ...base,
        id: "memory-ready",
        summary: "已完成的真实摘要",
        processing: processingRecord("memory-ready", "ready", null)
      }]),
      detail: null
    });
    expect(readyHtml).not.toContain("摘要总结中");
    expect(readyHtml).not.toContain("索引建立中");

    const doneHtml = renderMemories({
      status: "ready",
      data: panelItemsOutput([
        {
          ...base,
          id: "memory-reflection-done",
          processing: processingRecord("memory-reflection-done", "ready", null),
          metrics: { value: 0.8, alpha: 0.6, reflectionDone: true }
        }
      ]),
      detail: null
    });
    expect(doneHtml).toContain('data-icon="sparkles"');
    expect(doneHtml).toContain("反思");
    expect(doneHtml).not.toContain("反思生成中");
  });

  it("展示结构化失败原因，并提供设置与立即重试操作", () => {
    const processing = {
      memoryId: memoryListItemFixture.id,
      state: "failed" as const,
      stage: "summary" as const,
      activeJobId: null,
      attemptCount: 3,
      manualRetryCount: 0,
      retryAction: "open_settings" as const,
      errorCode: "model_configuration",
      errorMessage: "摘要模型未配置",
      failedAt: "2026-06-03T09:30:00.000Z",
      updatedAt: "2026-06-03T09:30:00.000Z"
    };
    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([{ ...memoryListItemFixture, processing }]),
      detail: {
        status: "ready",
        data: {
          ...memoryDetailFixture,
          item: { ...memoryDetailFixture.item, processing }
        }
      }
    }, "zh-CN", {
      onRetryProcessing: vi.fn(),
      onOpenSettings: vi.fn()
    });

    expect(html).toContain("处理失败");
    expect(html).toContain("摘要总结");
    expect(html).toContain("摘要模型未配置");
    expect(html).toContain("重试");
    expect(html).toContain("检查模型设置");
    expect(html).toContain("memory-pill--failed");
  });

  it("重试接口失败时保留原始处理原因，并单独展示本次重试错误", () => {
    const processing = {
      memoryId: memoryListItemFixture.id,
      state: "failed" as const,
      stage: "summary" as const,
      activeJobId: null,
      attemptCount: 3,
      manualRetryCount: 0,
      retryAction: "open_settings" as const,
      errorCode: "model_configuration",
      errorMessage: "openai_compatible HTTP 200: expected JSON but received HTML instead of a model API response",
      failedAt: "2026-06-03T09:30:00.000Z",
      updatedAt: "2026-06-03T09:30:00.000Z"
    };
    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([{ ...memoryListItemFixture, processing }]),
      detail: {
        status: "ready",
        data: {
          ...memoryDetailFixture,
          item: { ...memoryDetailFixture.item, processing }
        }
      }
    }, "zh-CN", {
      onRetryProcessing: vi.fn(),
      retryFeedback: {
        memoryId: memoryListItemFixture.id,
        status: "error",
        message: "本地记忆服务尚未加载重试功能，请完全退出并重新打开 Memmy 后再试"
      }
    });

    expect(html).toContain(processing.errorMessage);
    expect(html).toContain("本次重试未成功：本地记忆服务尚未加载重试功能");
    expect(html).toContain("memory-processing-failure__retry-error");
  });

  it("只把没有结构化错误体的 404 识别为旧的本地重试接口", () => {
    const restartMessage = "请重启 Memmy";

    expect(processingRetryErrorMessage(
      new ApiRequestError("Request failed", 404),
      restartMessage
    )).toBe(restartMessage);
    expect(processingRetryErrorMessage(
      new ApiRequestError("memory not found", 404, "not_found"),
      restartMessage
    )).toBe("memory not found");
  });

  it("英文模式下详情里的导入摘要占位文案使用英文", () => {
    const traceDetail = memoryDetailFixture.item.metadata.traceDetail as Record<string, unknown>;
    const pendingDetail = {
      ...memoryDetailFixture,
      item: {
        ...memoryDetailFixture.item,
        summary: "摘要排队中",
        tags: [...memoryDetailFixture.item.tags, "摘要排队中"],
        metadata: {
          ...memoryDetailFixture.item.metadata,
          traceDetail: {
            ...traceDetail,
            summary: "摘要排队中"
          }
        }
      }
    };
    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([{ ...memoryListItemFixture, summary: "摘要排队中", tags: [...memoryListItemFixture.tags, "摘要排队中"] }]),
      detail: { status: "ready", data: pendingDetail }
    }, "en-US");

    expect(html).toContain("Memory summary");
    expect(html).toContain("Preparing summary");
    expect(html).not.toContain("摘要排队中");
  });

  it("渲染 L1 trace 里的思考", () => {
    const thinkingDetail = {
      ...memoryDetailFixture,
      item: {
        ...memoryDetailFixture.item,
        metadata: {
          ...memoryDetailFixture.item.metadata,
          traceDetail: {
            ...(memoryDetailFixture.item.metadata.traceDetail as Record<string, unknown>),
            agentThinking: "先检查后端是否把 reasoningSummary 暴露到 refs.rawTurn，再补前端气泡。"
          }
        }
      }
    };
    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([memoryListItemFixture]),
      detail: { status: "ready", data: thinkingDetail }
    });

    expect(html).toContain("思考");
    expect(html).toContain("memory-turn-block--thinking");
    expect(html).toContain("先检查后端是否把 reasoningSummary 暴露到 refs.rawTurn");
  });

  it("按收到顺序渲染 L1 trace 的思考和工具调用", () => {
    const orderedDetail = {
      ...memoryDetailFixture,
      item: {
        ...memoryDetailFixture.item,
        metadata: {
          ...memoryDetailFixture.item.metadata,
          traceDetail: {
            ...(memoryDetailFixture.item.metadata.traceDetail as Record<string, unknown>),
            agentThinking: "先调用系统命令检查内存。\n\n工具返回 16 GB 后确认答案。",
            finalResponse: "这台电脑的内存是 16 GB。",
            toolCalls: [{
              id: "tool-memory-check",
              name: "exec",
              input: { cmd: "sysctl -n hw.memsize" },
              output: "16 GB",
              success: true,
              thinkingBefore: "先调用系统命令检查内存。"
            }]
          }
        }
      }
    };

    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([memoryListItemFixture]),
      detail: { status: "ready", data: orderedDetail }
    });

    const firstThinkingIndex = html.indexOf("先调用系统命令检查内存。");
    const toolIndex = html.indexOf("工具调用 · exec");
    const secondThinkingIndex = html.indexOf("工具返回 16 GB 后确认答案。");
    const assistantIndex = html.indexOf("这台电脑的内存是 16 GB。");
    expect(firstThinkingIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(firstThinkingIndex);
    expect(secondThinkingIndex).toBeGreaterThan(toolIndex);
    expect(assistantIndex).toBeGreaterThan(secondThinkingIndex);
    expect(html).not.toContain("工具前思考");
  });

  it("渲染 loading/error/empty/ready 和右侧详情抽屉内容", () => {
    expect(renderMemories({ status: "loading" })).toContain("正在加载记忆列表");
    expect(renderMemories({ status: "error", message: "list failed" })).toContain("list failed");
    const emptyHtml = renderMemories({ status: "ready", data: panelItemsOutput([]), detail: null });
    expect(emptyHtml).toContain("暂无记忆");
    expect(emptyHtml).toContain("memory-state-box");
    expect(emptyHtml).not.toContain("rounded-card p-5 text-sm");
    const detailWithInternalStatus = {
      ...memoryDetailFixture,
      item: {
        ...memoryDetailFixture.item,
        title: "trace:memmy-agent::cli:memory-e2e:cb643e2f-b21c-4750-b162-b5f4f90135cd:0",
        summary: "Summary: Memmy 记忆管理模块执行规范",
        tags: ["hermes", ...memoryDetailFixture.item.tags],
        metadata: {
          ...memoryDetailFixture.item.metadata,
          source: "hermes",
          status: "succeeded",
          nested: {
            status: "nested-status-value",
            keep: "visible metadata"
          },
          raw: {
            sourceId: "sqlite-source",
            dbPath: "/tmp/memory.sqlite"
          }
        }
      }
    };

    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([
        {
          ...memoryListItemFixture,
          title: "trace:memmy-agent::cli:memory-e2e:cb643e2f-b21c-4750-b162-b5f4f90135cd:0",
          summary: "Summary: Memmy 记忆管理模块执行规范",
          tags: ["hermes", ...memoryListItemFixture.tags, "debug-tag-hidden"],
          version: 7
        }
      ]),
      detail: { status: "ready", data: detailWithInternalStatus }
    });
    expect(html).toContain('data-icon="brain-circuit"');
    expect(html).toContain('data-icon="search"');
    expect(html).toContain('data-icon="chevron-right"');
    expect(html).toContain('data-icon="x"');
    expect(html).toContain('aria-label="关闭"');
    expect(html).not.toContain("全部类型");
    expect(html).not.toContain("策略");
    expect(html).not.toContain("场域认知");
    expect(html).not.toContain("技能");
    expect(html).not.toContain('aria-label="来源"');
    expect(html).not.toContain("<select");
    expect(html).toContain("Memmy 记忆管理模块执行规范");
    expect(html.match(/aria-label="来源: Hermes"/g)?.length).toBe(2);
    expect(html).toContain(">Hermes</span>");
    expect(html).toContain("V 0.74");
    expect(html).toContain("α 0.50");
    expect(html).toContain("memory-pill--reflection-done");
    expect(html).toContain('data-icon="sparkles"');
    expect(html).toContain("反思");
    expect(html).not.toContain("待反思");
    expect(html).not.toContain("debug-tag-hidden");
    expect(html).not.toContain("Summary:");
    expect(html).not.toContain("trace:memmy-agent::cli");
    expect(html).not.toContain("版本 7");
    expect(html).not.toContain("原始记忆");
    expect(html).not.toContain("可召回");
    expect(html).not.toContain("共 1 条");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("memory-card");
    expect(html).toContain("memory-drawer-backdrop");
    expect(html).toContain("memory-drawer");
    expect(html).toContain('memory-drawer__eyebrow">memory-trace-1');
    expect(html).toContain("memory-delete-button");
    expect(html).toContain('data-icon="trash-2"');
    expect(html).toContain("memory-detail-card");
    expect(html).toContain("元数据");
    expect(html).toContain("时间");
    expect(html).toContain("价值");
    expect(html).toContain("反思权重 α");
    expect(html).toContain("优先级");
    expect(html).toContain("0.735");
    expect(html).toContain("0.500");
    expect(html).toContain("记忆摘要");
    expect(html).not.toContain("用于检索");
    expect(html).toContain("本轮步骤");
    expect(html).toContain("用户");
    expect(html).not.toContain("用户 Query");
    expect(html).toContain("<strong>记忆管理</strong>");
    expect(html).toContain("工具调用 · read_file");
    expect(html).toContain("read_file");
    expect(html).toContain("输入");
    expect(html).toContain("输出");
    expect(html).toContain("读取 MemoryPage 页面结构。");
    expect(html).toContain("助手");
    expect(html).not.toContain("Agent 最终回复");
    expect(html).toContain("<code");
    expect(html).toContain("listPanelItems");
    expect(html).not.toContain("原始记忆 ·");
    expect(html).not.toContain("<dt>类型</dt>");
    expect(html).not.toContain("<dt>层级</dt>");
    expect(html).not.toContain("<dt>状态</dt>");
    expect(html).not.toContain("正文");
    expect(html).not.toContain("visible metadata");
    expect(html).not.toContain("sourceId");
    expect(html).not.toContain("dbPath");
    expect(html).not.toContain("succeeded");
    expect(html).not.toContain("nested-status-value");
    expect(html).not.toContain("flex-row");
    expect(html).not.toContain("w-80");
    expect(html).not.toContain("完整正文");
  });

  it("历史 trace 详情中的 Markdown 链接只保留文字不生成跳转", () => {
    const linkedDetail = {
      ...memoryDetailFixture,
      item: {
        ...memoryDetailFixture.item,
        metadata: {
          ...memoryDetailFixture.item.metadata,
          traceDetail: {
            ...(memoryDetailFixture.item.metadata.traceDetail as Record<string, unknown>),
            finalResponse: "改动在 [onboarding-insight-service.ts](http://127.0.0.1:19000/Users/jiang/MyProject/mindock-agent/App/backend/src/services/onboarding-insight-service.ts)"
          }
        }
      }
    };
    const html = renderMemories({
      status: "ready",
      data: panelItemsOutput([memoryListItemFixture]),
      detail: { status: "ready", data: linkedDetail }
    });

    expect(html).toContain("onboarding-insight-service.ts");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("127.0.0.1:19000");
  });
});

/** Renders render memories. */
function renderMemories(
  state: Parameters<typeof MemoriesSubPageView>[0]["state"],
  language = "zh-CN",
  actions: {
    onRetryProcessing?: (id: string) => void;
    onOpenSettings?: () => void;
    retryFeedback?: NonNullable<Parameters<typeof MemoriesSubPageView>[0]["retryFeedback"]>;
  } = {}
): string {
  return renderToString(
    <I18nProvider language={language}>
      <MemoriesSubPageView
        state={state}
        query=""
        sourceAgent=""
        onQueryChange={vi.fn()}
        onSourceAgentChange={vi.fn()}
        onSearch={vi.fn()}
        onPageChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenDetail={vi.fn()}
        onDeleteDetail={vi.fn(async () => undefined)}
        onRetryProcessing={actions.onRetryProcessing}
        onOpenSettings={actions.onOpenSettings}
        retryFeedback={actions.retryFeedback}
        onCloseDetail={vi.fn()}
      />
    </I18nProvider>
  );
}

function processingRecord(
  memoryId: string,
  state: "summary_pending" | "embedding_pending" | "ready",
  stage: "summary" | "embedding" | null
) {
  return {
    memoryId,
    state,
    stage,
    activeJobId: null,
    attemptCount: 0,
    manualRetryCount: 0,
    retryAction: "none" as const,
    errorCode: null,
    errorMessage: null,
    failedAt: null,
    updatedAt: "2026-06-03T09:30:00.000Z"
  };
}
