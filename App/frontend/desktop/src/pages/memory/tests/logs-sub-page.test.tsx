/** Logs sub page tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import type { MemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import {
  loadLogsData,
  logsPageInfo,
  LogsSubPageView,
  MemoryAddDetail,
  MemorySearchDetail,
  memorySearchCandidateLayerLabel,
  OTHER_LOG_SOURCE_AGENT
} from "../logs-sub-page.js";
import { MEMORY_SOURCE_AGENT_EXCLUSIONS } from "../memory-agent-filter.js";

const stylesPath = fileURLToPath(new URL("../../../styles.css", import.meta.url));

describe("LogsSubPage", () => {
  it("treats missing logs route as an empty log list", async () => {
    const client = {
      listMemoryLogs: vi.fn(async () => {
        throw new ApiRequestError("memory not found: logs", 404, "not_found", "req-1");
      })
    } as unknown as MemoryRuntimeClient;

    await expect(loadLogsData(client)).resolves.toMatchObject({
      logs: [],
      total: 0,
      limit: 20,
      offset: 0
    });
  });

  it("treats structurally equivalent missing logs errors as an empty log list", async () => {
    const client = {
      listMemoryLogs: vi.fn(async () => {
        throw { message: "memory not found: logs", status: 404, code: "not_found" };
      })
    } as unknown as MemoryRuntimeClient;

    await expect(loadLogsData(client)).resolves.toMatchObject({
      logs: [],
      total: 0,
      limit: 20,
      offset: 0
    });
  });

  it("sends exact and other source Agent filters to the logs API", async () => {
    const listMemoryLogs = vi.fn(async () => ({
      logs: [],
      total: 0,
      limit: 20,
      offset: 0,
      serverTime: "2026-06-03T10:00:00.000Z"
    }));
    const client = { listMemoryLogs } as unknown as MemoryRuntimeClient;

    await loadLogsData(client, 2, "memory_add", "openclaw");
    await loadLogsData(client, 1, "", OTHER_LOG_SOURCE_AGENT);
    await loadLogsData(client, 3, "memory_search", "claude_code");

    expect(listMemoryLogs).toHaveBeenNthCalledWith(1, {
      tools: ["memory_add"],
      sourceAgent: "openclaw",
      limit: 20,
      offset: 20
    });
    expect(listMemoryLogs).toHaveBeenNthCalledWith(2, {
      tools: ["memory_add", "memory_search"],
      excludedSourceAgents: MEMORY_SOURCE_AGENT_EXCLUSIONS,
      limit: 20,
      offset: 0
    });
    expect(listMemoryLogs).toHaveBeenNthCalledWith(3, {
      tools: ["memory_search"],
      sourceAgent: "claude_code",
      limit: 20,
      offset: 40
    });
  });

  it("renders readable filter button states", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [],
              total: 0,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("memory-log-filter memory-log-filter--active");
    expect(html).toContain("memory-panel__header memory-panel__header--single-line");
    expect(html).toContain("memory-panel__title");
    expect(html).toContain("memory-panel__header-actions");
    expect(html).toContain("memory-search");
    expect(html).toContain("memory-search__input");
    expect(html).toContain("memory-source-search-control");
    expect(html).toContain("memory-source-filter");
    expect(html).toContain("select-control__selection");
    expect(html).toContain("select-control__option-icon");
    expect(html).toContain("memory-source-filter__all-icon");
    expect(html.match(/memory-source-filter__all-avatar/g)).toHaveLength(3);
    expect(html).toContain("memmy-rice.png");
    expect(html).not.toContain("lucide-bot");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("按来源 Agent 筛选");
    expect(html).toContain("全部 Agent");
    expect(html).toContain('data-icon="search"');
    expect(html).toContain('class="memory-log-filter">memory_add');
    expect(html).not.toContain("min-w-[220px] flex-1 rounded-card");
    expect(html).not.toContain("bg-text-ink text-white");
  });

  it("memory_add 日志没有摘要时显示 trace id 而不是 empty", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_add",
                inputJson: "{}",
                outputJson: JSON.stringify({
                  stored: 1,
                  details: [{ role: "trace", action: "stored", traceId: "trace_abc123" }]
                }),
                durationMs: 12,
                success: true,
                calledAt: "2026-06-03T10:00:00.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("trace_abc123");
    expect(html).not.toContain("trace (empty)");
    expect(html).not.toContain("stored 1 ·");
  });

  it("memory_add 标题优先显示有效 summary，没有 summary 时显示 query", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_add",
                inputJson: JSON.stringify({ query: "你之前推荐的科幻电影是什么" }),
                outputJson: JSON.stringify({
                  stored: 1,
                  details: [{
                    summary: "摘要排队中",
                    query: "你之前推荐的科幻电影是什么",
                    traceId: "trace_abc123"
                  }]
                }),
                durationMs: 12,
                success: true,
                calledAt: "2026-06-03T10:00:00.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("你之前推荐的科幻电影是什么");
    expect(html).not.toContain("摘要排队中");
  });

  it("通过顶部下拉框筛选来源 Agent，不再在日志行内展示标签", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_add",
                inputJson: JSON.stringify({ sourceAgent: "cursor" }),
                outputJson: JSON.stringify({
                  stored: 1,
                  details: [{ sourceAgent: "memmy-agent", summary: "记住用户偏好的编辑器" }]
                }),
                durationMs: 12,
                success: true,
                calledAt: "2026-06-03T10:00:00.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent="memmy-agent"
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain('id="memory-log-agent-filter"');
    expect(html).toContain(">Memmy</span>");
    expect(html).toContain("memory-source-filter__logo--memmy");
    expect(html).toContain("memmy-rice.png");
    expect(html).not.toContain("memory-log-card__identity");
    expect(html).not.toContain("memory-agent-source-tag");
  });

  it("来源 Agent 下拉框提供其他来源筛选", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [],
              total: 0,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent={OTHER_LOG_SOURCE_AGENT}
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("其他");
    expect(html).toContain("memory-source-filter__icon--other");
  });

  it("memory_add 详情按 trace 写入字段展示", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <MemoryAddDetail
          input={{ sourceAgent: "openclaw" }}
          output={{
            stored: 1,
            details: [{
              summary: "你之前推荐的科幻电影是什么",
              sourceAgent: "openclaw",
              traceId: "trace_xxx",
              episodeId: "episode_xxx",
              query: "你之前推荐的科幻电影是什么",
              agent: "你之前推荐的是《银翼杀手2049》。"
            }]
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("memory-log-detail");
    expect(html).toContain("memory-log-meta-list");
    expect(html).toContain("memory-log-meta--agent");
    expect(html).toContain("memory-agent-source-tag");
    expect(html).toContain("memory-log-text--query");
    expect(html).toContain("memory-log-text--agent");
    expect(html).toContain("来源 Agent");
    expect(html).toContain('aria-label="来源 Agent: OpenClaw"');
    expect(html).toContain(">OpenClaw</span>");
    expect(html).not.toContain(">openclaw</span>");
    expect(html).toContain("trace_xxx");
    expect(html).toContain("episode_xxx");
    expect(html).toContain("User");
    expect(html).toContain("Assistant");
    expect(html).toContain("你之前推荐的科幻电影是什么");
    expect(html).toContain("你之前推荐的是《银翼杀手2049》。");
    expect(html).not.toContain("stored 1");
  });

  it("memory_add 详情只使用结构化 source agent", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <MemoryAddDetail
          input={{ source: "turn.complete", sessionId: "openclaw::web" }}
          output={{
            stored: 1,
            details: [{
              sourceAgent: "openclaw",
              traceId: "trace_xxx",
              episodeId: "episode_xxx",
              query: "我喜欢吃什么水果",
              agent: "苹果。"
            }]
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain(">OpenClaw</span>");
    expect(html).not.toContain("turn.complete");
    expect(html).not.toContain("openclaw::web");
  });

  it("memory_add 详情优先使用日志的 source Agent 字段", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <MemoryAddDetail
          sourceAgent="test_agent"
          input={{}}
          output={{ stored: 1, details: [{ summary: "custom source" }] }}
        />
      </I18nProvider>
    );

    expect(html).toContain('aria-label="来源 Agent: test_agent"');
    expect(html).toContain(">test_agent</span>");
  });

  it("默认 unknown 来源显示为本地化的未知标签", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <MemorySearchDetail sourceAgent="unknown" input={{ query: "anonymous" }} output={{}} />
      </I18nProvider>
    );

    expect(html).toContain('aria-label="来源 Agent: 未知"');
    expect(html).toContain("memory-agent-source-tag--unknown");
    expect(html).toContain("lucide-circle-question-mark");
    expect(html).toContain(">未知</span>");
    expect(html).not.toContain(">unknown</span>");
  });

  it("memory_search 详情和 memory_add 使用统一日志详情样式", () => {
    const keptCandidate = {
      refKind: "trace",
      refId: "trace_search_1",
      score: 0.82,
      tier: "L1",
      content: "User: hi\nAgent: Hi!"
    };
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <MemorySearchDetail
          sourceAgent="codex"
          input={{ query: "hi" }}
          output={{
            candidates: [
              keptCandidate,
              {
                refKind: "trace",
                refId: "trace_search_2",
                score: 0.6,
                tier: "L1",
                content: "User: bye"
              }
            ],
            filtered: [keptCandidate]
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("memory-log-detail");
    expect(html).toContain("memory-log-meta--agent");
    expect(html).toContain("memory-agent-source-tag");
    expect(html).toContain("来源 Agent");
    expect(html).toContain('aria-label="来源 Agent: Codex"');
    expect(html).toContain(">Codex</span>");
    expect(html).not.toContain(">codex</span>");
    expect(html).toContain("memory-log-text--query");
    expect(html).toContain("memory-log-section");
    expect(html).toContain("memory-log-count");
    expect(html).toContain("memory-log-candidate");
    expect(html).toContain("memory-log-candidate__tags");
    expect(html).toContain("memory-log-layer");
    expect(html).toContain("memory-log-candidate--dropped");
    expect(html).toContain("memory-log-candidate-groups");
    expect(html).toContain("memory-log-candidate-group--muted");
    expect(html).toContain("保留");
    expect(html).toContain("LLM 过滤");
    expect(html).toContain("User: hi");
    expect(html).toContain("User: bye");
    expect(html.match(/User: hi/g)?.length).toBe(1);
    expect(html.match(/User: bye/g)?.length).toBe(1);
    expect(html).not.toContain("保留 1");
    expect(html).not.toContain("memory-log-llm-state");
    expect(html).not.toContain("memory-log-candidate-group-label");
    expect(html).not.toContain("LLM kept");
    expect(html).not.toContain("No relevant results");
  });

  it("memory_search 全部保留时过滤列显示空态", () => {
    const candidate = {
      refKind: "episode",
      refId: "episode_1",
      score: 0.409,
      tier: "L1",
      content: "summary: 用户要写 Python 冒泡排序"
    };
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <MemorySearchDetail
          input={{ query: "用户 喜欢 吃 什么 食物 饮食 偏好" }}
          output={{
            candidates: [candidate],
            filtered: [candidate]
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("保留");
    expect(html).toContain("LLM 过滤");
    expect(html).toContain("无过滤记忆");
    expect(html).toContain("summary: 用户要写 Python 冒泡排序");
    expect(html).toContain("memory-log-candidate__tags");
    expect(html).not.toContain("memory-log-llm-state");
    expect(html).not.toContain("memory-log-candidate-group-label");
    expect(html).not.toContain("保留 1");
  });

  it("renders tool tags with distinct colors and no leading status dot", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [
                {
                  id: 1,
                  toolName: "memory_add",
                  inputJson: "{}",
                  outputJson: JSON.stringify({ stored: 1 }),
                  durationMs: 12,
                  success: true,
                  calledAt: "2026-06-03T10:00:00.000Z"
                },
                {
                  id: 2,
                  toolName: "memory_search",
                  inputJson: JSON.stringify({ query: "hermes" }),
                  outputJson: JSON.stringify({ candidates: [], filtered: [] }),
                  durationMs: 20,
                  success: true,
                  calledAt: "2026-06-03T10:01:00.000Z"
                }
              ],
              total: 2,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("memory-log-tool memory-log-tool--add");
    expect(html).toContain("memory-log-tool memory-log-tool--search");
    expect(html).toContain("memory-log-card");
    expect(html).not.toContain("rounded-card text-text-ink");
    expect(html).toContain("hermes");
    expect(html).toContain("memory-log-card__summary-tail");
    expect(html).toContain("· 保留 0/0");
    expect(html).not.toContain("候选 0，保留 0");
    expect(html).not.toContain("query &quot;hermes&quot;");
    expect(html).not.toContain("h-2.5 w-2.5 rounded-full");
  });

  it("caps long log summaries before fixed search counts, duration, and date columns", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const summaryRule = cssRule(styles, ".memory-log-card__summary");
    const summaryWithTailRule = cssRule(styles, ".memory-log-card__summary--with-tail");
    const summaryTailRule = cssRule(styles, ".memory-log-card__summary-tail");
    const metaRule = cssRule(styles, ".memory-log-card__meta,\n.memory-log-card__action");

    expect(summaryRule).toContain("max-width: clamp(280px, 46vw, 760px);");
    expect(summaryRule).toContain("margin-right: auto;");
    expect(summaryWithTailRule).toContain("margin-right: 0;");
    expect(summaryTailRule).toContain("flex: 0 0 auto;");
    expect(summaryTailRule).toContain("margin-right: auto;");
    expect(summaryTailRule).toContain("white-space: nowrap;");
    expect(metaRule).toContain("text-align: right;");
    expect(styles).toContain(".memory-log-card__meta + .memory-log-card__meta {\n  min-width: 112px;\n}");
    expect(styles).toContain(".memory-log-card__action {\n  min-width: 34px;");
  });

  it("keeps memory_search counts outside the ellipsized summary", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_search",
                inputJson: JSON.stringify({
                  query: "bug: 双击 session 修改会话时遮罩太深看不清后面内容；弹窗标题改为重命名任务，英文也要同步"
                }),
                outputJson: JSON.stringify({
                  candidates: Array.from({ length: 10 }, (_, index) => ({ refId: `trace_${index}` })),
                  filtered: Array.from({ length: 6 }, (_, index) => ({ refId: `trace_${index}` }))
                }),
                durationMs: 12900,
                success: true,
                calledAt: "2026-07-07T15:13:44.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-07-07T15:13:44.000Z"
            }
          }}
          tool="memory_search"
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("memory-log-card__summary--with-tail");
    expect(html).toContain("memory-log-card__summary-tail");
    expect(html).toContain("bug: 双击 session 修改会话时遮罩太深");
    expect(html).toContain("· 保留 6/10");
  });

  it("combines search and Agent selection inside one bordered control", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const controlRule = cssRule(styles, ".memory-source-search-control");
    const inputRule = cssRule(styles, ".memory-source-search-control .memory-search__input");
    const agentRule = cssRule(styles, ".memory-source-filter");
    const buttonRule = cssRule(styles, ".memory-source-search-control .memory-source-filter__button");

    expect(controlRule).toContain("grid-template-columns: minmax(0, 1fr) max-content;");
    expect(controlRule).toContain("border: 1px solid var(--border-content-panel);");
    expect(inputRule).toContain("border: 0;");
    expect(agentRule).not.toContain("border-left:");
    expect(agentRule).toContain("width: max-content;");
    expect(agentRule).toContain("max-width: 144px;");
    expect(buttonRule).toContain("border: 0;");
    expect(buttonRule).toContain("padding: 0 32px 0 8px;");
    expect(styles).not.toContain(".memory-log-search-row");
  });

  it("来源 Agent 标题不强制转换为全大写", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const labelRule = cssRule(styles, ".memory-log-meta__label");

    expect(labelRule).not.toContain("text-transform: uppercase;");
  });

  it("renders localized memory_search summary counts in English", () => {
    const html = renderToString(
      <I18nProvider language="en-US">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_search",
                inputJson: JSON.stringify({ query: "hermes" }),
                outputJson: JSON.stringify({
                  candidates: Array.from({ length: 7 }, (_, index) => ({ refId: `trace_${index}` })),
                  filtered: Array.from({ length: 6 }, (_, index) => ({ refId: `trace_${index}` }))
                }),
                durationMs: 20,
                success: true,
                calledAt: "2026-06-03T10:01:00.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("hermes");
    expect(html).toContain("memory-log-card__summary-tail");
    expect(html).toContain("· kept 6/7");
    expect(html).not.toContain("candidates 7, kept 6");
  });

  it("keeps stats-only memory_search counts visible after long summaries", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_search",
                inputJson: JSON.stringify({
                  query: "用户希望参考腾讯团队实践图，为公司 AI Native 落地方案增加 Harness 端到端开发流程图、AI 端到端开发全景架构图、质量门禁和持续交付说明"
                }),
                outputJson: JSON.stringify({
                  candidates: [],
                  filtered: [],
                  stats: {
                    raw: 10,
                    ranked: 4,
                    finalReturned: 2,
                    llmFilter: { kept: 2, dropped: 2, outcome: "filtered" }
                  }
                }),
                durationMs: 20,
                success: true,
                calledAt: "2026-06-03T10:01:00.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("用户希望参考腾讯团队实践图");
    expect(html).toContain("memory-log-card__summary-tail");
    expect(html).toContain("· 保留 2/10");
    expect(html).not.toContain("· 保留 0/0");
  });

  it("memory_search candidate rows use memory layer labels", () => {
    expect(memorySearchCandidateLayerLabel({ tier: "L1", refKind: "trace" })).toBe("L1");
    expect(memorySearchCandidateLayerLabel({ memoryLayer: "L2", refKind: "policy" })).toBe("L2");
    expect(memorySearchCandidateLayerLabel({ refKind: "world_model" })).toBe("L3");
    expect(memorySearchCandidateLayerLabel({ tier: "Skill", refKind: "skill" })).toBe("Skill");
  });

  it("does not render the memory_search retrieval funnel card", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_search",
                inputJson: JSON.stringify({ query: "hermes" }),
                outputJson: JSON.stringify({
                  candidates: [],
                  filtered: [],
                  stats: {
                    raw: 10,
                    ranked: 4,
                    finalReturned: 2,
                    llmFilter: { kept: 2, dropped: 2, outcome: "filtered" }
                  }
                }),
                durationMs: 20,
                success: true,
                calledAt: "2026-06-03T10:01:00.000Z"
              }],
              total: 1,
              limit: 20,
              offset: 0,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).not.toContain("retrieval funnel");
    expect(html).not.toContain("raw 10");
    expect(html).not.toContain("ranked 4");
    expect(html).not.toContain("final 2");
  });

  it("renders paginated log controls", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <LogsSubPageView
          state={{
            status: "ready",
            data: {
              logs: [{
                id: 1,
                toolName: "memory_search",
                inputJson: "{}",
                outputJson: "{}",
                durationMs: 12,
                success: true,
                calledAt: "2026-06-03T10:00:00.000Z"
              }],
              total: 45,
              limit: 20,
              offset: 20,
              nextOffset: 40,
              serverTime: "2026-06-03T10:00:00.000Z"
            }
          }}
          tool=""
          sourceAgent=""
          onToolChange={vi.fn()}
          onSourceAgentChange={vi.fn()}
          onPageChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>
    );

    expect(html).toContain("记忆分页");
    expect(html).toContain('data-icon="refresh-cw"');
    expect(html).toContain('aria-label="刷新本页"');
    expect(html).toContain('value="2"');
    expect(html).toContain("/ 3 页");
    expect(html).not.toContain("共 45 条");
  });

  it("本地搜索过滤后按可见日志数量计算分页", () => {
    expect(logsPageInfo({
      logs: [{
        id: 1,
        toolName: "memory_search",
        inputJson: "{}",
        outputJson: "{}",
        durationMs: 12,
        success: true,
        calledAt: "2026-06-03T10:00:00.000Z"
      }],
      total: 4500,
      limit: 20,
      offset: 0,
      nextOffset: 20,
      serverTime: "2026-06-03T10:00:00.000Z"
    }, 1)).toEqual({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      hasPrev: false,
      hasNext: false
    });
  });
});

function cssRule(styles: string, selector: string): string {
  const start = styles.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end + 1);
}
