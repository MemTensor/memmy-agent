import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE } from "../../theme/window-controls-overlay.js";
import { AttachmentActionError, emailAddressFromMailtoHref, estimateDeferredMarkdownHeight, isLikelyExpensiveAgentMarkdown, isMailtoHref, localArtifactPathFromHref, runAttachmentAction } from "../agent-message-content.js";
import { AgentThreadMessages, buildAgentDisplayUnits, CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS, CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS, copyImageToClipboard, resolveAgentMessageDisplayContent, saveImageToFile } from "../agent-thread-messages.js";

const agentThreadMessagesSourceUrl = new URL("../agent-thread-messages.tsx", import.meta.url);
const agentMessageContentSourceUrl = new URL("../agent-message-content.tsx", import.meta.url);
const stylesSourceUrl = new URL("../../styles.css", import.meta.url);
const WINDOWS_COMMAND_ERROR = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";

describe("AgentThreadMessages", () => {
  it("keeps memo boundaries around chat history rendering", () => {
    const threadSource = readFileSync(agentThreadMessagesSourceUrl, "utf8");
    const contentSource = readFileSync(agentMessageContentSourceUrl, "utf8");

    expect(threadSource).toContain("import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type SVGProps } from \"react\";");
    expect(threadSource).toContain("export const AgentThreadMessages = memo(function AgentThreadMessages(props: AgentThreadMessagesProps) {");
    expect(threadSource).toContain("}, areAgentThreadMessagesPropsEqual);");
    expect(threadSource).toContain("function areAgentThreadMessagesPropsEqual(previous: AgentThreadMessagesProps, next: AgentThreadMessagesProps): boolean");
    expect(threadSource).toContain("previous.messages === next.messages");
    expect(threadSource).toContain("previous.artifactClient === next.artifactClient");
    expect(threadSource).toContain("previous.chatScopeKey === next.chatScopeKey");
    expect(threadSource).toContain("previous.historyVersion === next.historyVersion");
    expect(threadSource).toContain("previous.isSending === next.isSending");
    expect(threadSource).toContain("const SingleMessage = memo(function SingleMessage(props: SingleMessageProps) {");
    expect(threadSource).toContain("}, areSingleMessagePropsEqual);");
    expect(threadSource).toMatch(
      /function areSingleMessagePropsEqual\(previous: SingleMessageProps, next: SingleMessageProps\): boolean \{[\s\S]*previous\.message === next\.message[\s\S]*previous\.artifactClient === next\.artifactClient[\s\S]*previous\.chatScopeKey === next\.chatScopeKey[\s\S]*previous\.unitIndex === next\.unitIndex/u,
    );

    expect(contentSource).toContain("import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from \"react\";");
    expect(contentSource).toContain("import { Prism as SyntaxHighlighter, type SyntaxHighlighterProps } from \"react-syntax-highlighter\";");
    expect(contentSource).toContain("export const AgentMessageContent = memo(function AgentMessageContent(props: AgentMessageContentProps) {");
    expect(contentSource).toContain("}, areAgentMessageContentPropsEqual);");
    expect(contentSource).toContain("function areAgentMessageContentPropsEqual(previous: AgentMessageContentProps, next: AgentMessageContentProps): boolean");
    expect(contentSource).toContain("previous.content === next.content");
    expect(contentSource).toContain("previous.isStreaming === next.isStreaming");
    expect(contentSource).toContain("previous.artifactClient === next.artifactClient");
    expect(contentSource).toContain("previous.deferRender === next.deferRender");
    expect(contentSource).toContain("scheduleDeferredMarkdownReveal(reveal, revealDelayMs)");
    expect(contentSource).toContain("compensateDeferredRevealScroll(snapshot, containerRef.current)");
    expect(contentSource).toContain("return <MailtoLink href={href?.trim() ?? \"\"}>{children}</MailtoLink>;");
    expect(contentSource).toContain("target=\"_blank\"");
  });

  it("keeps the streaming cursor attached to the last markdown paragraph", () => {
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");
    const cursorParagraphRule = stylesSource.match(/\.agent-message-content--streaming > \.agent-message-content__p:has\(\+ \.agent-streaming-cursor\)\s*\{[^}]*\}/)?.[0] ?? "";

    expect(cursorParagraphRule).toContain("display: inline;");
    expect(cursorParagraphRule).toContain("margin-bottom: 0;");
  });

  it("recognizes table-heavy markdown as expensive and estimates deferred height", () => {
    const table = [
      "| A | B | C |",
      "| --- | --- | --- |",
      "| 1 | 2 | 3 |",
      "| 4 | 5 | 6 |",
      "| 7 | 8 | 9 |",
      "| 10 | 11 | 12 |"
    ].join("\n");

    expect(isLikelyExpensiveAgentMarkdown(table)).toBe(true);
    expect(isLikelyExpensiveAgentMarkdown("短回答")).toBe(false);
    expect(estimateDeferredMarkdownHeight(table)).toBeGreaterThan(120);
  });

  it("derives chat-scoped activity UI keys and running state from activity messages", () => {
    const units = buildAgentDisplayUnits([
      { id: "old-trace", role: "tool", kind: "trace", content: "old_tool()", traces: ["old_tool()"], activitySegmentId: "old-activity" },
      { id: "answer", role: "assistant", content: "上一轮完成" },
      { id: "new-reasoning", role: "assistant", content: "", reasoning: "分析中", reasoningStreaming: true, activitySegmentId: "new-activity" }
    ], { chatScopeKey: "chat-scope" });

    expect(units[0]).toMatchObject({
      type: "activity",
      segmentId: "old-activity",
      activityKey: "chat-scope::activity::0::old-activity",
      bodyId: "agent-activity-chat-scope-activity-0-old-activity-body",
      isRunning: false
    });
    expect(units[2]).toMatchObject({
      type: "activity",
      segmentId: "new-activity",
      activityKey: "chat-scope::activity::2::new-activity",
      bodyId: "agent-activity-chat-scope-activity-2-new-activity-body",
      isRunning: true
    });
  });

  it("keeps a grouped activity running while any message in the segment is still running", () => {
    const units = buildAgentDisplayUnits([
      {
        id: "file-edit",
        role: "tool",
        kind: "trace",
        content: "",
        traces: [],
        fileEdits: [{ call_id: "call-edit", tool: "edit_file", path: "/tmp/a.txt", status: "done" }],
        activitySegmentId: "activity-edit",
        isStreaming: false
      },
      {
        id: "tool-trace",
        role: "tool",
        kind: "trace",
        content: 'edit_file({"path": "/tmp/a.txt"})',
        traces: ['edit_file({"path": "/tmp/a.txt"})'],
        toolEvents: [{ phase: "start", call_id: "call-edit", name: "edit_file", arguments: { path: "/tmp/a.txt" } }],
        activitySegmentId: "activity-edit",
        isStreaming: true
      }
    ], { chatScopeKey: "chat-grouped-activity" });

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      type: "activity",
      segmentId: "activity-edit",
      isRunning: true
    });
  });

  it("uses friendly fallback for platform API technical errors without changing BYOK display", () => {
    const message = { id: "error", role: "assistant" as const, content: "Error: API returned empty choices." };
    const fallback = "抱歉，刚刚没有拿到有效回复，请稍后再试一次。";

    expect(resolveAgentMessageDisplayContent(message, { sanitizePlatformApiErrors: true, fallback })).toBe(fallback);
    expect(resolveAgentMessageDisplayContent(message, { sanitizePlatformApiErrors: false, fallback })).toBe("Error: API returned empty choices.");

    const platformHtml = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages chatScopeKey="chat-platform-error" messages={[message]} sanitizePlatformApiErrors />
      </I18nProvider>
    );
    const byokHtml = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages chatScopeKey="chat-byok-error" messages={[message]} />
      </I18nProvider>
    );

    expect(platformHtml).toContain(fallback);
    expect(platformHtml).not.toContain("API returned empty choices");
    expect(byokHtml).toContain("Error: API returned empty choices.");
  });

  it("shows login-expired copy for auth errors in account mode and keeps API-key copy for BYOK", () => {
    const message = { id: "error", role: "assistant" as const, content: "Error calling LLM: 401 Unauthorized" };

    const accountHtml = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages chatScopeKey="chat-account-auth-error" messages={[message]} accountMode />
      </I18nProvider>
    );
    const byokHtml = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages chatScopeKey="chat-byok-auth-error" messages={[message]} />
      </I18nProvider>
    );

    expect(accountHtml).toContain("登录已过期，请重新登录");
    expect(accountHtml).not.toContain("API 密钥无效或已过期");
    expect(byokHtml).toContain("API 密钥无效或已过期，请检查后重试");
  });

  it("renders context compaction messages as standalone dividers outside activity clusters", () => {
    const messages = [
      {
        id: "context-compaction",
        role: "tool" as const,
        kind: "context_compaction" as const,
        content: "会话压缩中",
        compactionId: "context-compaction:turn-1",
        compactionStatus: "running" as const,
        isStreaming: true
      }
    ];
    const units = buildAgentDisplayUnits(messages, { chatScopeKey: "chat-context-compaction" });

    expect(units).toEqual([{ type: "single", message: messages[0] }]);

    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-context-compaction"
          messages={messages}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-context-compaction-divider--running");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("会话压缩中");
    expect(html).not.toContain("data-activity-key=");
    expect(html).not.toContain("正在执行");
  });

  it("hides the thinking placeholder while the current turn context compaction is running", () => {
    const messages = [
      { id: "question", role: "user" as const, content: "继续" },
      {
        id: "context-compaction",
        role: "tool" as const,
        kind: "context_compaction" as const,
        content: "会话压缩中",
        compactionId: "context-compaction:turn-1",
        compactionStatus: "running" as const,
        isStreaming: true
      }
    ];

    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-context-compaction-running"
          isSending
          messages={messages}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-context-compaction-divider--running");
    expect(html).toContain("会话压缩中");
    expect(html).not.toContain("思考中");
    expect(html).not.toContain("data-activity-key=");
  });

  it("keeps the thinking placeholder available when running context compaction belongs to an older turn", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-context-compaction-old-turn"
          isSending
          messages={[
            {
              id: "old-context-compaction",
              role: "tool",
              kind: "context_compaction",
              content: "会话压缩中",
              compactionId: "context-compaction:turn-old",
              compactionStatus: "running",
              isStreaming: true
            },
            { id: "question", role: "user", content: "新问题" }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("会话压缩中");
    expect(html).toContain("思考中");
    // The waiting placeholder carries the mascot at a legible size.
    expect(html).toContain('alt="Memmy"');
    expect(html).not.toContain("agent-chat-bubble--assistant");
  });

  it.each(["done", "error"] as const)("shows the thinking placeholder after current turn context compaction is %s", (compactionStatus) => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey={`chat-context-compaction-${compactionStatus}`}
          isSending
          messages={[
            { id: "question", role: "user", content: "继续" },
            {
              id: `context-compaction-${compactionStatus}`,
              role: "tool",
              kind: "context_compaction",
              content: compactionStatus === "done" ? "压缩已完成" : "压缩失败",
              compactionId: "context-compaction:turn-1",
              compactionStatus,
              isStreaming: false
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain(compactionStatus === "done" ? "压缩已完成" : "压缩失败");
    expect(html).toContain("思考中");
  });

  it("keeps repeated activitySegmentId values as separate UI identities", () => {
    const messages = [
      { id: "trace-1", role: "tool" as const, kind: "trace" as const, content: "A", traces: ["A"], activitySegmentId: "activity-1", isStreaming: true },
      { id: "answer-1", role: "assistant" as const, content: "done" },
      { id: "trace-2", role: "tool" as const, kind: "trace" as const, content: "B", traces: ["B"], activitySegmentId: "activity-1", isStreaming: true }
    ];
    const units = buildAgentDisplayUnits(messages, { chatScopeKey: "chat-duplicate" });
    const activityUnits = units.flatMap((unit) => unit.type === "activity" ? [unit] : []);

    expect(activityUnits).toHaveLength(2);
    expect(new Set(activityUnits.map((unit) => unit.activityKey)).size).toBe(2);
    expect(new Set(activityUnits.map((unit) => unit.bodyId)).size).toBe(2);

    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages chatScopeKey="chat-duplicate" messages={messages} />
      </I18nProvider>
    );
    const bodyIds = Array.from(html.matchAll(/id="(agent-activity-[^"]+)"/g)).map((match) => match[1]);
    const controlIds = Array.from(html.matchAll(/aria-controls="(agent-activity-[^"]+)"/g)).map((match) => match[1]);

    expect(bodyIds).toHaveLength(2);
    expect(new Set(bodyIds).size).toBe(2);
    expect(controlIds).toEqual(bodyIds);
  });

  it("merges contiguous completed and running activity into one open cluster", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-render"
          messages={[
            {
              id: "done",
              role: "tool",
              kind: "trace",
              content: "old_tool()",
              traces: ["old_tool()"],
              toolEvents: [{ phase: "end", call_id: "call-old", name: "old_tool" }],
              activitySegmentId: "done-activity"
            },
            {
              id: "running",
              role: "tool",
              kind: "trace",
              content: "new_tool()",
              traces: ["new_tool()"],
              toolEvents: [{ phase: "start", call_id: "call-new", name: "new_tool" }],
              activitySegmentId: "running-activity",
              isStreaming: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-icon="chevron-down"');
    // A running cluster that contains tool activity reads "Working";
    // "Thinking" is reserved for pure-reasoning runs.
    expect(html).toContain("工作中");
    // Cursor-style: each tool row keeps its own category icon + humanized "Verb detail"
    // summary. Both messages flow inside ONE merged cluster body (not split by category).
    // The raw `<name>()` fallback is only used when the tool name is missing entirely;
    // when a name is present we always render `Called <Humanized Name>` instead.
    expect(html).toContain("Old tool");
    expect(html).toContain("New tool");
    expect(html.match(/data-activity-key=/g) ?? []).toHaveLength(1);
    expect(html).toContain("agent-activity-tool-group-details");
    expect(html).toContain("agent-activity-tool-group-details__summary");
    // Follow-along: while the cluster is running, its latest tool group is
    // auto-expanded so tool rows stream into view; it folds once superseded.
    expect(html).toMatch(/agent-activity-tool-group-details" open/);
    expect(html).toContain("agent-activity-tool-details");
    expect(html).toContain('data-detail="trace"');
    expect(html).toContain("old_tool()");
    expect(html).toContain("new_tool()");
    expect(html).not.toContain("Completed old_tool");
    expect(html).not.toContain("Started new_tool");
    expect(html).not.toContain("rounded-card-lg");
    expect(html).not.toContain("bg-background-paper/90");
    expect(html).not.toContain("border-t border-border-stone/25");
    expect(html).not.toContain("rounded-lg bg-canvas-oat/45");
    expect(html).not.toContain("rounded-lg bg-canvas-oat/60");
  });

  it("keeps current-turn activity open while the chat is still sending", () => {
    const messages = [
      { id: "question", role: "user" as const, content: "查一下" },
      {
        id: "trace",
        role: "tool" as const,
        kind: "trace" as const,
        content: "web_search()",
        traces: ["web_search()"],
        toolEvents: [{ phase: "end" as const, call_id: "call-search", name: "web_search" }],
        activitySegmentId: "activity-current",
        isStreaming: false
      }
    ];
    const units = buildAgentDisplayUnits(messages, { chatScopeKey: "chat-current-activity" });

    expect(units[1]).toMatchObject({
      type: "activity",
      isRunning: false,
      isCurrentTurnActivity: true
    });

    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-current-activity"
          isSending
          messages={messages}
        />
      </I18nProvider>
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-icon="chevron-down"');
    expect(html).toContain("工作中");
    expect(html).toContain("agent-activity-cluster flex min-w-0 justify-start");
    expect(html).toContain("data-activity-key=");
    // The tool row now uses the humanized "Searched web for" verb + web-search
    // category icon instead of the raw `web_search()` placeholder.
    expect(html).toContain("Searched web for");
    expect(html).toContain("agent-activity-timeline-item--search");
    expect(html).toContain("agent-activity-tool-details");
    expect(html).toContain("web_search()");
    expect(html).not.toContain("Completed web_search");
    expect(html.indexOf("工作中")).toBeLessThan(html.indexOf("Searched web for"));
    expect(html).not.toContain("rounded-card-lg");
    expect(html).not.toContain("bg-background-paper/90");
  });

  it("treats current-turn assistant text as continuation while tools are still running", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-mid-turn-answer"
          isSending
          messages={[
            { id: "previous-answer", role: "assistant", content: "上一轮完成", createdAt: new Date(2026, 5, 23, 9, 7).getTime() },
            { id: "question", role: "user", content: "继续", createdAt: new Date(2026, 5, 23, 10, 0).getTime() },
            { id: "mid-answer", role: "assistant", content: "Round 1 — 数据采集", createdAt: new Date(2026, 5, 23, 10, 1).getTime() },
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              toolEvents: [{ phase: "start", call_id: "call-read", name: "ReadFile", arguments: { path: "README.md" } }],
              activitySegmentId: "activity-mid-turn",
              isStreaming: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("上一轮完成");
    expect(html).toContain("Round 1 — 数据采集");
    expect(html).toContain("Read");
    expect(html).toContain("README.md");
    expect(html.match(/agent-message-copy-cluster--left/g) ?? []).toHaveLength(1);
    expect(html.match(/agent-message-copy-button--left/g) ?? []).toHaveLength(1);
    expect(html).not.toContain("10:01");
  });

  it("renders short narration drafts inside the run cluster in answer style without chrome", () => {
    const draft = "好的！我来帮你规划国庆出行方案。先查一下几个热门目的地的天气情况，再搜索一些出行信息。";
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-narration"
          isSending
          messages={[
            { id: "question", role: "user", content: "开始任务" },
            {
              id: "reasoning",
              role: "assistant",
              content: "",
              reasoning: "先规划三轮循环。",
              activitySegmentId: "activity-narration"
            },
            {
              id: "draft",
              role: "assistant",
              kind: "narration",
              content: draft,
              activitySegmentId: "activity-narration"
            },
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              toolEvents: [{ phase: "start", call_id: "call-read", name: "read_file", arguments: { path: "skills/cron/SKILL.md" } }],
              activitySegmentId: "activity-narration",
              isStreaming: true
            }
          ]}
        />
      </I18nProvider>
    );

    // Drafts belong to the SAME per-run cluster as thoughts and tools (one
    // "Worked for" header for the whole process), rendered verbatim in answer
    // typography: no dimming, no collapsing for short text, and no answer
    // chrome (bubble / copy button). The superseded thought above it folds to
    // its one-line label while the draft stays fully readable.
    expect(html.match(/data-activity-key=/g) ?? []).toHaveLength(1);
    expect(html).toContain("agent-activity-segment--narration");
    expect(html).toContain(draft);
    expect(html).not.toContain("agent-narration-block__preview");
    expect(html).toContain("简短思考");
    expect(html).not.toContain("先规划三轮循环。");
    expect(html).not.toContain("agent-chat-bubble--assistant");
    expect(html).not.toContain("agent-message-copy-button--left");
    expect(html.indexOf("简短思考")).toBeLessThan(html.indexOf("我来帮你规划国庆出行方案"));
  });

  it("counts every row in the group label — web search plus grep reads 浏览了 2 处", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-group-count"
          messages={[
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              toolEvents: [
                { phase: "end", call_id: "call-search", name: "web_search", arguments: { query: "onboarding" } },
                { phase: "end", call_id: "call-grep", name: "grep", arguments: { pattern: "scan" } }
              ],
              stoppedByUser: true
            }
          ]}
        />
      </I18nProvider>
    );

    // Both rows are exploration, so the category label must use the true row count.
    expect(html).toContain("浏览了 2 处");
    expect(html).not.toContain("浏览了 1 处");
  });

  it("folds the whole finished run — thoughts, tools, drafts — behind one worked-for header", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-run-folded"
          messages={[
            { id: "question", role: "user", content: "开始任务" },
            {
              id: "reasoning",
              role: "assistant",
              content: "",
              reasoning: "先查天气。",
              createdAt: 1_720_000_000_000
            },
            {
              id: "draft",
              role: "assistant",
              kind: "narration",
              content: "好的！先查一下几个城市的天气。",
              createdAt: 1_720_000_002_000
            },
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              toolEvents: [
                { phase: "start", call_id: "call-weather", name: "web_search", arguments: { query: "天气" } },
                { phase: "end", call_id: "call-weather", name: "web_search", result: "ok" }
              ],
              createdAt: 1_720_000_009_000
            },
            { id: "answer", role: "assistant", content: "最终方案如下。", createdAt: 1_720_000_010_000 }
          ]}
        />
      </I18nProvider>
    );

    // One cluster header covers the entire process run; a run containing
    // drafts reads as work, never as thought-only. Collapsed by
    // default once the turn is over, so the draft text is out of sight while
    // the final answer stays visible.
    expect(html.match(/data-activity-key=/g) ?? []).toHaveLength(1);
    expect(html).toContain("工作了 9s");
    expect(html).not.toContain("好的！先查一下几个城市的天气。");
    expect(html).toContain("最终方案如下。");
  });

  it("collapses only long cumulative narration drafts to an in-place preview row", () => {
    const longDraft = [
      "好的！这次我给自己设计的任务是：**「Memmy 技能图鉴」**",
      "",
      "## 第 1 轮 — 全量扫描",
      "",
      `已读取全部技能，${"数据详情。".repeat(60)}`,
      "",
      "## 第 2 轮 — 设计",
      "",
      "开始生成图片。"
    ].join("\n");
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-narration-long"
          isSending
          messages={[
            { id: "question", role: "user", content: "开始任务" },
            { id: "draft", role: "assistant", kind: "narration", content: longDraft },
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              toolEvents: [{ phase: "start", call_id: "call-img", name: "generate_image", arguments: { prompt: "atlas" } }],
              isStreaming: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-activity-segment--narration");
    // The fold row is nothing but the draft's own first line — no badges, no
    // meta commentary about drafts or supersession.
    expect(html).toContain('agent-narration-block__preview">好的！这次我给自己设计的任务是：「Memmy 技能图鉴」');
    expect(html).not.toContain("agent-narration-block__tag");
    expect(html).not.toContain("中途草稿");
    expect(html).toContain('aria-expanded="false"');
    // Collapsed body is not rendered until expanded.
    expect(html).not.toContain("开始生成图片。");
  });

  it("keeps a long draft fully readable while it is the live step", () => {
    const longDraft = `第一轮报告\n\n${"很长的进展描述。".repeat(80)}\n\n收尾。`;
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-live-long-draft"
          isSending
          messages={[
            { id: "question", role: "user", content: "开始" },
            { id: "draft", role: "assistant", kind: "narration", content: longDraft }
          ]}
        />
      </I18nProvider>
    );

    // The draft is the turn's latest (live) step: it stays expanded with no
    // fold row, because collapsing text mid-read is worse than length. It
    // folds only after tools/thoughts supersede it.
    expect(html).toContain("收尾。");
    expect(html).not.toContain("agent-narration-block__toggle");
  });

  it("strips leaked internal ant tags from rendered assistant markdown", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-ant-leak"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "现在生成第一张图——**早晨到上午**：\n</antThthinking>"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("现在生成第一张图");
    expect(html).not.toContain("antThthinking");
    expect(html).not.toContain("antThinking");
  });

  it("inserts retry wait status after the current user message without changing activity order", () => {
    const messages = [
      { id: "question", role: "user" as const, content: "查一下" },
      {
        id: "trace",
        role: "tool" as const,
        kind: "trace" as const,
        content: "web_search()",
        traces: ["web_search()"],
        activitySegmentId: "activity-current",
        isStreaming: true
      },
      { id: "answer", role: "assistant" as const, content: "完成" }
    ];
    const units = buildAgentDisplayUnits(messages, {
      chatScopeKey: "chat-retry-order",
      retryWaitStatus: {
        id: "retry-wait-1",
        chatId: "chat-1",
        turnId: "turn-1",
        anchorMessageId: "question",
        text: "Model request failed, retrying attempt 2 in 2s...",
        isRunning: true,
        createdAt: 1,
        updatedAt: 2
      }
    });

    expect(units.map((unit) => unit.type)).toEqual(["single", "retry_wait", "activity", "single"]);
    expect(units[1]).toMatchObject({
      type: "retry_wait",
      status: { text: "Model request failed, retrying attempt 2 in 2s..." }
    });
  });

  it("renders retry wait as gray status text instead of an assistant bubble or activity", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-retry-status"
          messages={[{ id: "question", role: "user", content: "继续" }]}
          retryWaitStatus={{
            id: "retry-wait-1",
            chatId: "chat-1",
            turnId: "turn-1",
            anchorMessageId: "question",
            text: "Model request failed, retrying attempt 1 in 1s...",
            isRunning: true,
            createdAt: 1,
            updatedAt: 2
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-retry-wait-line");
    expect(html).toContain("agent-retry-wait-line__label");
    expect(html).toContain("agent-retry-wait-line--running");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("模型请求失败，1 秒后重试（第 1 次）");
    expect(html).not.toContain("data-activity-key=");
    expect(html).not.toContain("agent-chat-bubble--assistant");
    expect(html).not.toContain("agent-message-copy-button--left");
    expect(html).not.toContain('alt="Memmy"');
    expect(html).not.toContain("模型请求重试中");
  });

  it("removes retry wait running affordance after the status stops", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-retry-stopped"
          messages={[{ id: "question", role: "user", content: "继续" }]}
          retryWaitStatus={{
            id: "retry-wait-1",
            chatId: "chat-1",
            anchorMessageId: "question",
            text: "Model request failed, retrying attempt 1 in 1s...",
            isRunning: false,
            createdAt: 1,
            updatedAt: 2
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-retry-wait-line");
    expect(html).not.toContain("agent-retry-wait-line--running");
    expect(html).not.toContain('aria-busy="true"');
  });

  it("keeps activity and thinking placeholder after retry wait when no final answer exists", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-retry-activity"
          isSending
          messages={[
            { id: "question", role: "user", content: "查一下" },
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "web_search()",
              traces: ["web_search()"],
              activitySegmentId: "activity-current",
              isStreaming: true
            }
          ]}
          retryWaitStatus={{
            id: "retry-wait-1",
            chatId: "chat-1",
            anchorMessageId: "question",
            text: "Model request failed, retrying attempt 1 in 1s...",
            isRunning: false,
            createdAt: 1,
            updatedAt: 2
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-retry-wait-line");
    expect(html).toContain("模型请求失败，1 秒后重试（第 1 次）");
    expect(html).toContain("data-activity-key=");
    expect(html).toContain("Searched web for");
    expect(html).toContain("工作中");
  });

  it("hides thinking placeholder after retry wait once final answer text exists", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-retry-answer"
          isSending
          messages={[
            { id: "question", role: "user", content: "继续" },
            { id: "answer", role: "assistant", content: "最终回答", isStreaming: true }
          ]}
          retryWaitStatus={{
            id: "retry-wait-1",
            chatId: "chat-1",
            anchorMessageId: "question",
            text: "Model request failed, retrying attempt 1 in 1s...",
            isRunning: false,
            createdAt: 1,
            updatedAt: 2
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-retry-wait-line");
    expect(html).toContain("agent-chat-bubble--assistant");
    expect(html).toContain("最终回答");
    expect(html).not.toContain("思考中");
  });

  it("renders model errors as a notice instead of an assistant bubble", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-model-error"
          messages={[
            { id: "question", role: "user", content: "介绍下你自己" },
            {
              id: "error",
              role: "assistant",
              content: "Error: 503 upstream connect error or disconnect/reset before headers. reset reason: remote connection failure"
            }
          ]}
          retryWaitStatus={{
            id: "retry-wait-1",
            chatId: "chat-1",
            anchorMessageId: "question",
            text: "Model request failed after 4 retries, giving up.",
            isRunning: false,
            createdAt: 1,
            updatedAt: 2
          }}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-model-error-notice");
    expect(html).toContain("无法连接到模型服务");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("agent-chat-bubble--assistant");
    expect(html).not.toContain("agent-retry-wait-line");
    expect(html).not.toContain("upstream connect error");
  });

  it("renders activity reasoning and plain content as context rather than steps", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-activity-context"
          isSending
          messages={[
            { id: "question", role: "user", content: "继续" },
            {
              id: "reasoning",
              role: "assistant",
              content: "",
              reasoning: "先判断要不要查资料。",
              activitySegmentId: "activity-context"
            },
            {
              id: "plain-content",
              role: "tool",
              kind: "trace",
              content: "准备读取本地说明。",
              traces: ["准备读取本地说明。"],
              activitySegmentId: "activity-context"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("工作中");
    // The thought was superseded by the tool step, so it folds to its
    // one-line label; the prose re-appears on demand, not by default.
    expect(html).toContain("简短思考");
    expect(html).not.toContain("先判断要不要查资料。");
    expect(html).toContain("准备读取本地说明。");
    expect(html).not.toContain("正在执行 2 个步骤");
    expect(html).not.toContain("执行了 2 个步骤");
    expect(html).not.toContain("text-status-success");
  });

  it("renders reasoning as muted prose while preserving real markdown blocks", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-reasoning-markdown"
          isSending
          messages={[
            { id: "question", role: "user", content: "介绍下你自己" },
            {
              id: "reasoning",
              role: "assistant",
              content: "",
              reasoning: [
                "The user wants a detailed introduction",
                "with a markdown-aware reasoning summary.",
                "",
                "1. Keep markdown lists compact.",
                "2. Keep ordinary prose soft-wrapped.",
                "",
                "**Decision**: answer in Simplified Chinese."
              ].join("\n"),
              activitySegmentId: "activity-reasoning-markdown"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-message-content--reasoning");
    expect(html).toContain("The user wants a detailed introduction with a markdown-aware reasoning summary.");
    expect(html).toContain("agent-message-content__list--ordered");
    expect(html).toContain("Keep markdown lists compact.");
    expect(html).toContain("<strong>Decision</strong>");
    expect(html).not.toContain("The user wants a detailed introduction<br");
    expect(html).not.toContain("简短思考</span>");
  });

  it("renders the complete decoded Windows error in tool details", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-windows-error"
          messages={[
            {
              id: "trace-windows-error",
              role: "tool",
              kind: "trace",
              content: "exec()",
              traces: ["exec()"],
              toolEvents: [{
                phase: "error",
                call_id: "call-windows",
                name: "exec",
                arguments: { command: "node" },
                error: WINDOWS_COMMAND_ERROR
              }],
              activitySegmentId: "activity-windows-error",
              stoppedByUser: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html.replaceAll("&#x27;", "'")).toContain(WINDOWS_COMMAND_ERROR);
    expect(html).toContain("agent-activity-timeline-item__error");
    expect(html).not.toContain("����");
  });

  it("matches compact persisted trace JSON to structured tool events without duplicating rows", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-compact-trace-match"
          messages={[
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: 'read_file({"path":"README.md"})',
              traces: ['read_file({"path":"README.md"})'],
              toolEvents: [{ phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }],
              activitySegmentId: "activity-compact",
              isStreaming: true,
              // Keep the cluster expanded so the test can inspect body content
              // for de-duplication between traces[] and structured toolEvents.
              stoppedByUser: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("已停止，保留活动");
    // A single tool step renders as just its row without a redundant group header.
    expect(html).not.toContain("浏览了 1 处");
    // The humanized "Read README.md" verb replaces the raw
    // `read_file({...})` payload, and it appears exactly once (i.e. we don't
    // duplicate it because both `traces` and `toolEvents` refer to the call).
    expect(html).toContain("Read");
    expect(html).toContain("README.md");
    expect(html).toContain("agent-activity-timeline-item--read");
    expect(html).toContain("agent-activity-tool-details");
    // Expanded payload renders as one quiet code card: raw input/output only,
    // no ALL-CAPS form labels and no summary row duplicating the row text.
    expect(html).toContain("agent-activity-tool-card");
    expect(html).toContain('data-detail="arguments"');
    expect(html).not.toContain(">Summary<");
    expect(html).not.toContain(">Arguments<");
    expect(html).not.toContain("Completed read_file");
  });

  it("renders same-call file edit and tool trace in one activity cluster without duplicate summary", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-file-edit"
          messages={[
            {
              id: "file-edit",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              fileEdits: [
                {
                  call_id: "call-write",
                  tool: "write_file",
                  path: "/tmp/a.txt",
                  phase: "end",
                  status: "done",
                  added: 1,
                  deleted: 0
                }
              ],
              activitySegmentId: "activity-file-edit",
              isStreaming: true,
              // Keep the cluster expanded so we can verify no duplicate rows appear.
              stoppedByUser: true
            },
            {
              id: "tool-trace",
              role: "tool",
              kind: "trace",
              content: 'write_file({"path": "/tmp/a.txt"})',
              traces: ['write_file({"path": "/tmp/a.txt"})'],
              toolEvents: [
                { phase: "end", call_id: "call-write", name: "write_file", arguments: { path: "/tmp/a.txt" } }
              ],
              activitySegmentId: "activity-file-edit",
              isStreaming: true,
              stoppedByUser: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html.match(/data-activity-key=/g) ?? []).toHaveLength(1);
    // One merged stopped-state cluster keeps contiguous tool and file activity
    // folded into a single default-collapsed group. The group holds a file-edit
    // row and a tool row, so the label reports the true total;
    // category labels only apply when every row is that category.
    expect(html).toContain("已停止，保留活动");
    expect(html).toContain("执行了 2 步");
    expect(html).toContain("agent-activity-tool-group-details");
    expect(html).toContain("Edited /tmp/a.txt");
    expect(html).toContain("Wrote");
    expect(html).toContain("a.txt");
    expect(html).toContain("agent-activity-timeline-item--write");
    expect(html).toContain("agent-activity-tool-details");
    expect(html).toContain('data-detail="trace"');
    expect(html).toContain("write_file({");
    expect(html).not.toContain("Completed write_file");
    expect(html).toMatch(/done(?:<!-- -->)? · (?:<!-- -->)?\+1 \/ -0/u);
    expect(html.indexOf("+1 / -0")).toBeLessThan(html.indexOf("Wrote"));
    expect(html).not.toContain("write_file(/tmp/a.txt)");
  });

  it("keeps same-segment file edit and tool trace visible after both complete", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-file-edit-done"
          messages={[
            {
              id: "file-edit",
              role: "tool",
              kind: "trace",
              content: "",
              traces: [],
              fileEdits: [
                {
                  call_id: "call-write",
                  tool: "write_file",
                  path: "/tmp/a.txt",
                  phase: "end",
                  status: "done",
                  added: 1,
                  deleted: 0
                }
              ],
              activitySegmentId: "activity-file-edit",
              isStreaming: false
            },
            {
              id: "tool-trace",
              role: "tool",
              kind: "trace",
              content: 'write_file({"path": "/tmp/a.txt"})',
              traces: ['write_file({"path": "/tmp/a.txt"})'],
              toolEvents: [
                { phase: "end", call_id: "call-write", name: "write_file", arguments: { path: "/tmp/a.txt" } }
              ],
              activitySegmentId: "activity-file-edit",
              isStreaming: false
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html.match(/data-activity-key=/g) ?? []).toHaveLength(1);
    // Cursor-style: completed activity collapses by default; header shows a
    // duration-based summary ("Worked briefly" — no timestamps means <1s elapsed).
    expect(html).toContain("工作了一会儿");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-icon="chevron-right"');
    expect(html).not.toContain("Completed write_file");
    expect(html).not.toContain("Edited /tmp/a.txt");
  });

  it.each(["write_file", "edit_file", "apply_patch"] as const)("does not render %s file edit content fallback", (toolName) => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey={`chat-${toolName}`}
          messages={[
            {
              id: `${toolName}-file-edit`,
              role: "tool",
              kind: "trace",
              content: `${toolName}(/tmp/a.txt)`,
              traces: [],
              fileEdits: [
                {
                  call_id: `call-${toolName}`,
                  tool: toolName,
                  path: "/tmp/a.txt",
                  phase: "end",
                  status: "done",
                  added: 1,
                  deleted: 0
                }
              ],
              activitySegmentId: `activity-${toolName}`,
              isStreaming: true,
              stoppedByUser: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("/tmp/a.txt");
    expect(html).toMatch(/done(?:<!-- -->)? · (?:<!-- -->)?\+1 \/ -0/u);
    expect(html).not.toContain(`${toolName}(/tmp/a.txt)`);
  });

  it("keeps user-stopped loaded activity open after pausing before an answer", () => {
    const messages = [
      { id: "question", role: "user" as const, content: "整理一下" },
      {
        id: "trace",
        role: "tool" as const,
        kind: "trace" as const,
        content: "loaded_tool()",
        traces: ["loaded_tool()"],
        activitySegmentId: "paused-activity",
        isStreaming: false,
        stoppedByUser: true
      }
    ];
    const units = buildAgentDisplayUnits(messages, { chatScopeKey: "chat-paused" });

    expect(units[1]).toMatchObject({
      type: "activity",
      isRunning: false,
      stoppedByUser: true
    });

    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-paused"
          isSending={false}
          messages={messages}
        />
      </I18nProvider>
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-icon="chevron-down"');
    expect(html).toContain("已停止，保留活动");
    expect(html).toContain("loaded_tool()");
    expect(html).not.toContain("思考中");
  });

  it("shows a thinking placeholder while a sent turn is waiting for assistant content", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-thinking"
          isSending
          messages={[
            { id: "previous-answer", role: "assistant", content: "上一轮完成" },
            { id: "question", role: "user", content: "继续" }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("思考中");
    expect(html).toContain('aria-live="polite"');
  });

  it("hides the thinking placeholder once assistant content is streaming", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-answering"
          isSending
          messages={[
            { id: "question", role: "user", content: "继续" },
            { id: "answer", role: "assistant", content: "正在回答", isStreaming: true }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("正在回答");
    expect(html).not.toContain("思考中");
  });

  it("renders final-answer reasoning as activity while answer streams", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-final-reasoning-live"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "正在回答",
              reasoning: "先检查文件内容。",
              isStreaming: true,
              reasoningStreaming: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("data-reasoning-key=");
    expect(html).toContain("先检查文件内容。");
    expect(html).toContain("正在回答");
  });

  it("keeps completed final-answer reasoning in collapsed activity instead of the answer bubble", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-final-reasoning-done"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "最终回答",
              reasoning: "这是一段很长的内部思考。"
            }
          ]}
        />
      </I18nProvider>
    );

    // Cursor-style: completed reasoning activity is a collapsed "Thought briefly"
    // header, separate from the always-visible final answer bubble below it.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-icon="chevron-right"');
    expect(html).toContain("简短思考");
    expect(html).not.toContain("data-reasoning-key=");
    expect(html).toContain("最终回答");
    // Reasoning body is only rendered when the user expands the collapsed cluster.
    expect(html).not.toContain("这是一段很长的内部思考。");
  });

  it("shows single-thought content directly when its activity is expanded", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-single-thought-expanded"
          messages={[
            {
              id: "reasoning",
              role: "assistant",
              content: "",
              reasoning: "先检查文件内容。",
              stoppedByUser: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("agent-narration-block__toggle");
    expect(html).toContain("先检查文件内容。");
  });

  it("keeps ended reasoning in collapsed activity while answer text streams", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-final-reasoning-text-streaming"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "正在回答",
              reasoning: "这段思考已经结束。",
              isStreaming: true,
              reasoningStreaming: false
            }
          ]}
        />
      </I18nProvider>
    );

    // Reasoning finished but answer is still streaming → cluster collapses (reasoning not running).
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-icon="chevron-right"');
    expect(html).toContain("简短思考");
    expect(html).not.toContain("data-reasoning-key=");
    expect(html).toContain("正在回答");
    // Reasoning body is only rendered when the user expands the collapsed cluster.
    expect(html).not.toContain("这段思考已经结束。");
  });

  it("keeps reasoning-only assistant messages in the activity cluster", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-reasoning-only"
          messages={[
            {
              id: "reasoning",
              role: "assistant",
              content: "",
              reasoning: "只是在思考。",
              reasoningStreaming: false
            },
            {
              id: "answer",
              role: "assistant",
              content: "完成。"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("简短思考");
    expect(html).toContain("data-activity-key=");
    expect(html).toContain("完成。");
    expect(html).not.toContain("data-reasoning-key=");
  });

  it("renders copy affordances on completed assistant answer and user text bubble without assistant chrome", () => {
    const assistantMarkdown = [
      "助手原始文本",
      "",
      "[链接](https://example.com)",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "`code`"
    ].join("\n");
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-copy-affordance"
          messages={[
            { id: "question", role: "user", content: "用户原始文本" },
            { id: "answer", role: "assistant", content: assistantMarkdown }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-chat-bubble-frame--user");
    expect(html).toContain("agent-chat-bubble--user");
    expect(html).toContain("agent-message-copy-button--right");
    expect(html).toContain("agent-chat-bubble-frame--assistant");
    expect(html).toContain("agent-chat-bubble--assistant");
    expect(html).toContain("agent-message-copy-button--left");
    expect(html).toContain("agent-message-content");
    expect(html).toContain("agent-message-content__link");
    expect(html).toContain("agent-message-content__table");
    expect(html).toContain("agent-message-content__inline-code");
    expect(html).toContain('aria-label="复制消息"');
    expect(html).not.toContain('alt="Memmy"');
    expect(html).not.toContain("bg-background-paper border border-border-stone/30 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm");
  });

  it("renders message timestamps beside the hover copy affordance", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 23, 18, 30));
    try {
      const html = renderToString(
        <I18nProvider language="zh-CN">
          <AgentThreadMessages
            chatScopeKey="chat-copy-time"
            messages={[
              { id: "today", role: "user", content: "今天", createdAt: new Date(2026, 5, 23, 9, 7).getTime() },
              { id: "assistant-today", role: "assistant", content: "今天回复", createdAt: new Date(2026, 5, 23, 15, 16).getTime() },
              { id: "this-week", role: "user", content: "一周内", createdAt: new Date(2026, 5, 20, 8, 9).getTime() },
              { id: "this-year", role: "user", content: "今年稍早", createdAt: new Date(2026, 4, 2, 10, 11).getTime() },
              { id: "last-year", role: "user", content: "超过一年", createdAt: new Date(2025, 4, 1, 12, 13).getTime() }
            ]}
          />
        </I18nProvider>
      );

      expect(html.match(/agent-message-time-label/g) ?? []).toHaveLength(5);
      expect(html).toContain("09:07");
      expect(html).toContain("15:16");
      expect(html).toContain("agent-message-copy-cluster--left");
      expect(html).toContain("星期六 08:09");
      expect(html).toContain("5月2日 10:11");
      expect(html).toContain("2025年5月1日 12:13");
      expect(html).not.toContain("6月20日 08:09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("localizes user message timestamp date parts in English", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 23, 18, 30));
    try {
      const html = renderToString(
        <I18nProvider language="en-US">
          <AgentThreadMessages
            chatScopeKey="chat-copy-time-en"
            messages={[
              { id: "today", role: "user", content: "today", createdAt: new Date(2026, 5, 23, 9, 7).getTime() },
              { id: "this-week", role: "user", content: "within week", createdAt: new Date(2026, 5, 20, 8, 9).getTime() },
              { id: "this-year", role: "user", content: "older", createdAt: new Date(2026, 4, 2, 10, 11).getTime() },
              { id: "last-year", role: "user", content: "last year", createdAt: new Date(2025, 4, 1, 12, 13).getTime() }
            ]}
          />
        </I18nProvider>
      );

      expect(html).toContain("09:07");
      expect(html).toContain("Saturday 08:09");
      expect(html).toContain("5/2, 10:11");
      expect(html).toContain("5/1/2025, 12:13");
      expect(html).not.toContain("星期六");
      expect(html).not.toContain("月");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides assistant copy affordance while text is streaming", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-copy-streaming"
          messages={[
            { id: "answer", role: "assistant", content: "正在回答", isStreaming: true }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-chat-bubble-frame--assistant");
    expect(html).toContain("agent-chat-bubble--assistant");
    expect(html).not.toContain("agent-message-copy-button--left");
  });

  it("renders assistant copy affordance for user-stopped partial text", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-copy-stopped"
          messages={[
            { id: "answer", role: "assistant", content: "已经流出的部分回答", isStreaming: false, stoppedByUser: true }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("已经流出的部分回答");
    expect(html).toContain("agent-message-copy-button--left");
    expect(html).toContain('aria-label="复制消息"');
  });

  it("renders assistant markdown links, media images, fenced code, and file chips", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-markdown"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: [
                "# 结果汇总",
                "## 验证情况",
                "结果见 [报告](https://example.com/report)。",
                "![图](/api/media/image-token)",
                "",
                "- 路径：/Users/yuan/result.md",
                "- 已验证：共 `5` 页",
                "",
                "1. 已生成",
                "2. 可打开",
                "",
                "> 这是引用说明",
                "",
                "---",
                "",
                "| 项目 | 状态 |",
                "| --- | --- |",
                "| PPT | 完成 |",
                "",
                "PPT 在 [deck.pptx](/Users/yuan/deck.pptx)。",
                "```ts",
                "const ok: boolean = true;",
                "```",
                "本地文件 /Users/yuan/result.md"
              ].join("\n")
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("<h1>结果汇总</h1>");
    expect(html).toContain("<h2>验证情况</h2>");
    expect(html).toContain('href="https://example.com/report"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("agent-message-content__link");
    expect(html).toContain("agent-message-content__image");
    expect(html).toContain("agent-message-content__list--unordered");
    expect(html).toContain("agent-message-content__list--ordered");
    expect(html).toContain("agent-message-content__quote");
    expect(html).toContain("agent-message-content__separator");
    expect(html).toContain("agent-message-content__table-scroll");
    expect(html).toContain("agent-message-content__table");
    expect(html).toContain("agent-message-content__th");
    expect(html).toContain("agent-message-content__td");
    expect(html).toContain("agent-message-content__inline-code");
    expect(html).toContain("agent-message-content__code-block");
    expect(html).toContain("agent-message-content__code-header");
    expect(html).toContain("agent-message-content__code-scroll");
    expect(html).toContain("agent-message-content__file-chip");
    expect(html).toContain('title="/Users/yuan/deck.pptx"');
    expect(html).toContain(">deck.pptx</span>");
    expect(html).not.toContain('href="/Users/yuan/deck.pptx"');
    expect(html).not.toContain('href="file:///Users/yuan/deck.pptx"');
    expect(html).toContain('src="/api/media/image-token"');
    expect(html).toContain("<hr");
    expect(html).toContain("<table");
    expect(html).toContain("<blockquote");
    expect(html).toContain("ts");
    expect(html).toContain("const");
    expect(html).toContain("ok");
    expect(html).toContain("/Users/yuan/result.md");
    expect(html).not.toContain('title="/Users/yuan/result.md"');
    expect(html).not.toContain('href="file:///Users/yuan/result.md"');
  });

  it("renders assistant bare email addresses as controlled mailto links", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-mailto"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "请联系 825735067@qq.com"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain('href="mailto:825735067@qq.com"');
    expect(html).toContain("agent-message-content__link");
    expect(html).not.toContain('target="_blank"');
  });

  it("keeps assistant markdown CSS scoped to the message content container", () => {
    const contentSource = readFileSync(agentMessageContentSourceUrl, "utf8");
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");

    expect(stylesSource).toContain(".agent-message-content {");
    expect(stylesSource).toContain(".agent-message-content :where(h1, h2, h3, h4, h5, h6)");
    expect(stylesSource).toContain(".agent-message-content__list--unordered");
    expect(stylesSource).toContain("list-style: disc;");
    expect(stylesSource).toContain(".agent-message-content__list--ordered");
    expect(stylesSource).toContain("list-style: decimal;");
    expect(stylesSource).toContain(".agent-message-content__inline-code");
    expect(stylesSource).toContain(".agent-message-content--deferred");
    expect(stylesSource).toContain(".agent-message-content__table-scroll");
    expect(stylesSource).toContain(".agent-message-content__code-block");
    expect(stylesSource).toContain(".agent-message-content__file-chip");
    expect(stylesSource).toContain(".agent-message-content--reasoning");
    expect(stylesSource).toContain(".agent-message-content--reasoning .agent-message-content__list p");
    expect(stylesSource).toContain(".agent-message-content--reasoning :where(strong, b)");
    expect(stylesSource).toContain(".agent-message-content--reasoning :where(h1, h2, h3, h4, h5, h6)");
    expect(stylesSource).toContain("color: inherit;");
    expect(stylesSource).toContain("font-weight: 500;");
    expect(stylesSource).toContain(".agent-activity-tool-details");
    expect(stylesSource).toContain(".agent-activity-tool-details__summary");
    expect(stylesSource).toContain(".agent-activity-tool-details[open] .agent-activity-tool-details__chevron");
    expect(stylesSource).toContain(".agent-activity-tool-group-details");
    expect(stylesSource).toContain(".agent-activity-tool-group-details__body");
    expect(stylesSource).toContain(".agent-activity-timeline-item__line");
    expect(stylesSource).toContain("white-space: nowrap;");
    expect(stylesSource).toContain("text-overflow: ellipsis;");
    expect(stylesSource).toContain("--agent-conversation-muted-separator: color-mix(in srgb, var(--color-border-stone) 44%, transparent);");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-activity-cluster");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-activity-cluster__separator");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__separator");
    expect(stylesSource).toContain("background: var(--agent-conversation-muted-separator);");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__code-block");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__code-header");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__pre");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__table-scroll");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__table");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__th");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__td");
    expect(stylesSource).toContain(".agent-conversation-panel .agent-message-content__table tbody tr:nth-child(even)");
    expect(stylesSource).toContain("border-radius: 8px;");
    expect(stylesSource).toContain("var(--color-background-paper)");
    expect(stylesSource).toContain("var(--color-canvas-oat)");
    expect(stylesSource).toContain("var(--color-border-stone)");
    expect(stylesSource).not.toMatch(/^ul\s*\{/mu);
    expect(stylesSource).not.toMatch(/^ol\s*\{/mu);
    expect(stylesSource).not.toMatch(/^table\s*\{/mu);
    expect(stylesSource).not.toMatch(/^pre\s*\{/mu);
    expect(stylesSource).not.toMatch(/^hr\s*\{/mu);
    expect(stylesSource).not.toMatch(/^\.agent-message-content__separator\s*\{/mu);
    expect(stylesSource).not.toContain(".agent-conversation-panel .agent-activity-cluster::after");
    expect(contentSource).toContain("const PRISM_CODE_SELECTOR = 'code[class*=\"language-\"]' as const;");
    expect(contentSource).toContain("const PRISM_PRE_SELECTOR = 'pre[class*=\"language-\"]' as const;");
    expect(contentSource).toContain("const AGENT_CODE_BACKGROUND = \"transparent\";");
    expect(contentSource).toContain("const AGENT_CODE_THEME = {");
    expect(contentSource).toContain("background: AGENT_CODE_BACKGROUND");
    expect(contentSource).toContain("satisfies NonNullable<SyntaxHighlighterProps[\"style\"]>;");
    expect(contentSource).toContain("style={AGENT_CODE_THEME}");
    expect(contentSource).toContain("minWidth: \"max-content\"");
    expect(contentSource).not.toContain("style={oneLight}");
  });

  it("keeps context compaction divider styling separate from activity UI", () => {
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");

    expect(stylesSource).toContain(".agent-context-compaction-divider {");
    expect(stylesSource).toContain(".agent-context-compaction-divider__line");
    expect(stylesSource).toContain(".agent-context-compaction-divider--running .agent-context-compaction-divider__label");
    expect(stylesSource).toContain("@keyframes agent-context-compaction-shimmer");
    expect(stylesSource).toContain("color-mix(in srgb, var(--color-text-ink)");
    expect(stylesSource).toContain("color-mix(in srgb, var(--color-border-stone)");
    expect(stylesSource).toContain(".agent-retry-wait-line {");
    expect(stylesSource).toContain(".agent-retry-wait-line__label");
    expect(stylesSource).toContain(".agent-retry-wait-line--running .agent-retry-wait-line__label");
    expect(stylesSource).toContain(".agent-model-error-notice {");
    expect(stylesSource).toContain(".agent-model-error-notice__title");
    expect(stylesSource).toContain("animation: agent-context-compaction-shimmer");
  });

  it("detects local artifact paths from markdown link hrefs", () => {
    expect(localArtifactPathFromHref("/Users/yuan/deck.pptx")).toBe("/Users/yuan/deck.pptx");
    expect(localArtifactPathFromHref("file:///Users/yuan/deck.pptx")).toBe("/Users/yuan/deck.pptx");
    expect(localArtifactPathFromHref("/api/media/sig/payload")).toBeNull();
    expect(localArtifactPathFromHref("https://example.com/deck.pptx")).toBeNull();
  });

  it("detects mailto links without changing local artifact detection", () => {
    expect(isMailtoHref("mailto:825735067@qq.com")).toBe(true);
    expect(isMailtoHref("https://example.com")).toBe(false);
    expect(isMailtoHref("/Users/yuan/file.txt")).toBe(false);
    expect(emailAddressFromMailtoHref("mailto:825735067@qq.com?subject=test")).toBe("825735067@qq.com");
    expect(localArtifactPathFromHref("mailto:825735067@qq.com")).toBeNull();
  });

  it("keeps markdown local links rendered as file chips", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-markdown-local-link"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "文件在 [deck.pptx](/Users/yuan/deck.pptx)。"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-message-content__file-chip");
    expect(html).toContain('title="/Users/yuan/deck.pptx"');
    expect(html).toContain(">deck.pptx</span>");
    expect(html).not.toContain('href="file:///Users/yuan/deck.pptx"');
  });

  it("renders inline code local paths as normal markdown code", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-inline-local-path"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "`/Users/yuan/deck.pptx`"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-message-content__inline-code");
    expect(html).toContain("/Users/yuan/deck.pptx");
    expect(html).not.toContain("agent-message-content__file-chip");
    expect(html).not.toContain('href="file:///Users/yuan/deck.pptx"');
  });

  it("renders bare local file and directory paths as plain text", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-bare-local-path"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "文件 /Users/yuan/deck.pptx\n目录 /Users/yuan/.memmy/workspace\n普通文本 foo/bar"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("/Users/yuan/deck.pptx");
    expect(html).toContain("/Users/yuan/.memmy/workspace");
    expect(html).toContain("foo/bar");
    expect(html).not.toContain('href="file:///Users/yuan/deck.pptx"');
    expect(html).not.toContain('href="file:///Users/yuan/.memmy/workspace"');
    expect(html).not.toContain('href="file://foo/bar"');
    expect(html).not.toContain('href="file:///bar"');
    expect(html).not.toContain("agent-message-content__file-chip");
  });

  it("renders structured file media as attachment chips instead of images", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-media"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "附件好了",
              media: [
                { kind: "file", url: "/api/media/sig/deck", name: "deck.pptx" },
                { kind: "image", url: "/api/media/sig/image", name: "result.png" },
                { kind: "video", url: "/api/media/sig/clip", name: "clip.mp4" }
              ]
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("<button");
    expect(html).toContain("deck.pptx");
    expect(html).not.toContain('href="/api/media/sig/deck"');
    expect(html).not.toContain('img src="/api/media/sig/deck"');
    expect(html).toContain('img src="/api/media/sig/image"');
    expect(html).toContain('video src="/api/media/sig/clip"');
  });

  it("renders user media as compact thumbnails above the text bubble", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-user-media"
          messages={[
            {
              id: "question",
              role: "user",
              content: "描述这张图",
              media: [
                { kind: "image", url: "data:image/png;base64,AAAA", name: "shot.png" },
                { kind: "video", url: "data:video/mp4;base64,BBBB", name: "clip.mp4" },
                { kind: "file", url: "/api/media/sig/report", name: "report.pdf" }
              ]
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain('img src="data:image/png;base64,AAAA"');
    expect(html).toContain('video src="data:video/mp4;base64,BBBB"');
    expect(html).toContain('data-testid="agent-attachment-card-image"');
    expect(html).toContain('data-testid="agent-attachment-card-file"');
    expect(html).toContain("agent-attachment-card");
    expect(html).toContain("agent-attachment-card__preview");
    expect(html).toContain("agent-attachment-card__file-tile--pdf");
    expect(html).toContain('style="max-width:min(100%, 32rem)"');
    expect(html).toContain('style="width:100%;max-height:26rem"');
    expect(html).toContain('data-testid="user-file-attachment"');
    expect(html).toContain('data-testid="agent-file-icon-pdf"');
    expect(html).toContain(">shot<");
    expect(html).toContain(">report<");
    expect(html).toContain('title="report.pdf"');
    expect(html).toContain(">PNG<");
    expect(html).toContain(">PDF<");
    expect(html).not.toContain('img src="/api/media/sig/report"');
    expect(html).not.toContain('video src="/api/media/sig/report"');
    expect(html).not.toContain("text-white/90");
    expect(html).not.toContain("bg-white/10");
    expect(html).not.toContain("border-white/25");
    expect(html).not.toContain("rounded-2xl bg-action-sky px-2 pb-2");
    expect(html).not.toContain("mt-3 max-w-full rounded-card");
    expect(html.indexOf('src="data:image/png;base64,AAAA"')).toBeLessThan(html.indexOf("描述这张图"));
  });

  it("keeps the image lightbox close button fixed at the top right of the overlay", () => {
    const threadSource = readFileSync(agentThreadMessagesSourceUrl, "utf8");

    expect(CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS).toContain("absolute right-4 z-10");
    expect(CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS).not.toContain("top-4");
    expect(WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE.top).toBe("calc(1rem + env(titlebar-area-height, 0px))");
    expect(threadSource).toContain("style={WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE}");
    expect(CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS).not.toContain("-right-3");
    expect(CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS).not.toContain("-top-3");
  });

  it("anchors the lightbox prev/next buttons to the overlay edges so they do not overlap the image", () => {
    const threadSource = readFileSync(agentThreadMessagesSourceUrl, "utf8");

    expect(CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS).toContain("absolute top-1/2 z-10");
    expect(CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS).toContain("-translate-y-1/2");

    expect(threadSource).toContain("CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS + \" left-4\"");
    expect(threadSource).toContain("CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS + \" right-4\"");
    expect(threadSource).not.toContain("absolute left-3 top-1/2");
    expect(threadSource).not.toContain("absolute right-3 top-1/2");
  });

  it("keeps user file attachments and message columns inside shrink boundaries", () => {
    const longName = "very-long-local-report-name-that-should-stay-inside-the-user-file-chip-and-not-grow-the-chat-column.pdf";
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-user-file-width"
          messages={[
            {
              id: "question",
              role: "user",
              content: "请看附件",
              media: [{ kind: "file", path: `/Users/yuan/${longName}`, name: longName }]
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("flex min-w-0 justify-end");
    expect(html).toContain("flex min-w-0 max-w-[75%] flex-col");
    expect(html).toContain("flex min-w-0 max-w-full flex-wrap");
    expect(html).toContain("inline-flex max-w-full min-w-0 flex-col items-end");
    expect(html).toContain("agent-attachment-card");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("agent-attachment-card__name");
    expect(html).toContain("agent-attachment-card__meta");
    expect(html).toContain(">PDF<");
    expect(html).toContain(longName);
  });

  it("keeps assistant markdown tables and code blocks scrollable inside the answer content", () => {
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-markdown-width"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: [
                "| Column with a very long heading | Value |",
                "| --- | --- |",
                "| long | value |",
                "",
                "```ts",
                "const longValue = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';",
                "```",
                "",
                "```",
                "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
                "second line",
                "```"
              ].join("\n")
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("flex min-w-0 justify-start");
    expect(html).toContain("min-w-0 w-full space-y-2");
    expect(html).toContain("agent-chat-bubble agent-chat-bubble--assistant w-full max-w-full min-w-0 overflow-hidden");
    expect(html).not.toContain('alt="Memmy"');
    expect(html).not.toContain("bg-background-paper border border-border-stone/30 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm");
    expect(html).not.toContain("max-w-full min-w-0 overflow-hidden bg-background-paper");
    expect(html).toContain("agent-message-content min-w-0 max-w-full overflow-hidden");
    // Spacing/scroll behavior is CSS-owned (single rhythm source): renderers
    // emit only the structural classes.
    expect(html).toContain("agent-message-content__table-scroll");
    expect(html).toContain("agent-message-content__code-block");
    expect(html).toContain("agent-message-content__pre");
    expect(html).toContain("max-w-full overflow-x-auto");
    expect(html).toContain("min-width:max-content");
    expect(stylesSource).toMatch(/\.agent-message-content__table-scroll\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(stylesSource).toMatch(/\.agent-message-content__code-scroll,\s*\.agent-message-content__pre\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(stylesSource).toMatch(/\.agent-message-content__table-scroll,\s*\.agent-message-content__code-scroll,\s*\.agent-message-content__pre\s*\{(?=[^}]*scrollbar-width:\s*thin;)(?=[^}]*scrollbar-color:\s*var\(--codex-scrollbar-thumb\)\s+transparent;)[^}]*\}/s);
    expect(stylesSource).toMatch(/\.agent-message-content__table-scroll::-webkit-scrollbar,\s*\.agent-message-content__code-scroll::-webkit-scrollbar,\s*\.agent-message-content__pre::-webkit-scrollbar\s*\{(?=[^}]*display:\s*block;)(?=[^}]*height:\s*var\(--codex-scrollbar-size\);)[^}]*\}/s);
    expect(stylesSource).toMatch(/\.agent-message-content__table-scroll::-webkit-scrollbar-thumb,\s*\.agent-message-content__code-scroll::-webkit-scrollbar-thumb,\s*\.agent-message-content__pre::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--codex-scrollbar-thumb\);/s);
  });

  it("wraps long file paths inside user message bubbles", () => {
    const longPath = "/Users/zongy/Documents/MemTensor/Playground/src/main/resources/db/agent_quota_usage_record_add_usage_columns_20260713.sql";
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-user-long-path"
          messages={[
            { id: "question", role: "user", content: longPath }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-chat-bubble--user");
    expect(html).toContain("break-words [overflow-wrap:anywhere]");
    expect(html).toContain(longPath);
  });

  it("wraps long Windows PowerShell commands inside the assistant answer content", () => {
    const command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Desktop\\force-uninstall-memmy.ps1"';
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-windows-long-text"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: [
                "### test.txt 内容",
                "",
                `\`${command}\``,
                "",
                "这是一条执行 Memmy 卸载脚本的命令。"
              ].join("\n")
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("agent-message-content min-w-0 max-w-full overflow-hidden");
    expect(html).toContain("break-words [overflow-wrap:anywhere]");
    expect(html).toContain("whitespace-pre-wrap break-all [overflow-wrap:anywhere]");
    expect(html).toContain("$env:USERPROFILE\\Desktop\\force-uninstall-memmy.ps1");
  });

  it("keeps activity clusters inside shrink boundaries for long trace content", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-activity-width"
          messages={[
            {
              id: "trace",
              role: "tool",
              kind: "trace",
              content: "tool output",
              traces: ["{\"path\":\"/Users/yuan/very/long/path/that/should/not/stretch/the/activity/cluster/report.json\"}"],
              activitySegmentId: "activity-long",
              isStreaming: true
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("flex min-w-0 justify-start");
    expect(html).toContain("min-w-0 w-full");
    // No inner scroll box: the expanded body flows inline with the page and
    // relies on the single outer conversation scrollbar, matching Cursor.
    expect(html).toContain("agent-activity-cluster__body min-w-0\"");
    expect(html).toContain("mb-0.5 min-w-0 break-words px-0 py-0.5");
    expect(html).not.toContain("min-w-0 max-w-[82%]");
    expect(html).not.toContain("break-words rounded-lg bg-canvas-oat/60");
  });

  it("does not render an empty user text bubble for media-only messages", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-media-only"
          messages={[
            {
              id: "question",
              role: "user",
              content: "",
              media: [{ kind: "image", url: "/api/media/sig/user-image", name: "shot.png" }]
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain('img src="/api/media/sig/user-image"');
    expect(html).toContain('data-testid="agent-attachment-card-image"');
    expect(html).toContain("agent-attachment-card");
    expect(html).not.toContain("agent-chat-bubble-frame--user");
    expect(html).not.toContain("agent-message-copy-button--right");
    expect(html).not.toContain("bg-action-sky text-white px-4 py-2.5");
  });

  it("keeps generated images ready for right-click actions, system save, and keyboard image copy", async () => {
    const threadSource = readFileSync(agentThreadMessagesSourceUrl, "utf8");
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");
    const write = vi.fn(async (_items: ClipboardItem[]) => undefined);
    const fetcher = vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }));
    class MockClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }

    await expect(copyImageToClipboard({
      url: "/api/media/sig/result",
      name: "result.png",
      fetcher,
      clipboard: { write },
      clipboardItemCtor: MockClipboardItem as unknown as typeof ClipboardItem
    })).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledWith("/api/media/sig/result", { credentials: "include" });
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0];
    expect(call).toBeDefined();
    const [items] = call!;
    expect(items[0]).toBeInstanceOf(MockClipboardItem);
    expect((items[0] as unknown as MockClipboardItem).items["image/png"]).toBeInstanceOf(Blob);
    expect(threadSource).toContain("onContextMenu={(event) => props.onContextMenu(event, image)}");
    expect(threadSource).toContain("onKeyDown={(event) => handleImageCopyShortcut(event, image)}");
    expect(threadSource).toContain("const result = await saveImageToFile(props.menu.image)");
    expect(threadSource).toContain("const desktopSaveImage = !input.startDownload");
    expect(threadSource).toContain("const bytes = await fetchDesktopImageBytes(input.url)");
    expect(threadSource).toContain("data: bytes.data, mime: bytes.mime");
    expect(threadSource).toContain("window.memmy?.copyImageToClipboard");
    expect(threadSource).toContain("void copyImageToClipboard(current)");
    expect(threadSource).toContain("border-0 bg-canvas-oat/35 p-0");
    expect(threadSource).toContain('className="agent-image-context-menu"');
    expect(stylesSource).toContain(".agent-image-context-menu {");
    expect(stylesSource).toContain("border: 1px solid color-mix(in srgb, var(--color-border-stone) 40%, transparent);");
    expect(stylesSource).toContain(".agent-image-context-menu__item");
  });

  it("falls back to browser download only outside the desktop image save bridge", async () => {
    const startDownload = vi.fn(() => true);

    await expect(saveImageToFile({
      url: "/api/media/sig/result",
      name: "result.png",
      startDownload
    })).resolves.toBe("saved");

    expect(startDownload).toHaveBeenCalledWith("/api/media/sig/result", "result.png");
  });

  it("keeps message copy behavior scoped to raw message text and bubble styles", () => {
    const threadSource = readFileSync(agentThreadMessagesSourceUrl, "utf8");
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");

    expect(threadSource).toContain("AlertCircle,");
    expect(threadSource).toContain("ChevronDown,");
    expect(threadSource).toContain("ChevronLeft,");
    expect(threadSource).toContain("ChevronRight,");
    expect(threadSource).toContain("X,");
    expect(threadSource).toContain("Terminal,");
    expect(threadSource).toContain("Search,");
    expect(threadSource).toContain("Pencil,");
    expect(threadSource).toContain("} from \"lucide-react\";");
    expect(threadSource).toContain("import { Tooltip } from \"../components/tooltip.js\";");
    expect(threadSource).toContain("writeClipboardText(props.text)");
    expect(threadSource).toContain("function isAssistantMessageCopyReady(message: AgentChatMessage): boolean");
    expect(threadSource).toContain("&& !message.isStreaming");
    expect(threadSource).toContain("&& !message.reasoningStreaming");
    expect(threadSource).not.toContain("&& !message.stoppedByUser");
    expect(threadSource).toContain("function CodexCopyIcon");
    expect(threadSource).toContain("function CodexCheckIcon");
    expect(threadSource).toContain('width="16"');
    expect(threadSource).toContain('height="16"');
    expect(stylesSource).toContain(".agent-chat-bubble--user::selection");
    expect(stylesSource).toContain(".agent-chat-bubble-frame--assistant");
    expect(stylesSource).toContain(".agent-chat-bubble-frame--user");
    expect(stylesSource).toContain(".agent-message-time-label");
    expect(stylesSource).toContain("border: 0;");
    expect(stylesSource).toContain("background: transparent;");
    expect(stylesSource).toContain(".agent-chat-bubble-frame:hover .agent-message-copy-cluster");
  });

  it("keeps collapse chevrons hidden until their row is hovered or focused", () => {
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");

    // Every expand/collapse chevron in the conversation defaults to invisible
    // (opacity 0) and fades in on hover/focus of its own row. Visibility only:
    // toggle logic, hit area, and aria-expanded stay untouched.
    expect(stylesSource).toContain(".agent-activity-cluster__toggle svg,");
    expect(stylesSource).toContain(".agent-reasoning-panel__toggle svg,");
    expect(stylesSource).toContain(".agent-activity-cluster__toggle:hover svg,");
    expect(stylesSource).toContain(".agent-activity-cluster__toggle:focus-visible svg,");
    expect(stylesSource).toContain(".agent-activity-tool-group-details__summary:hover .agent-activity-tool-group-details__chevron,");
    expect(stylesSource).toContain(".agent-activity-tool-details__summary:hover .agent-activity-tool-details__chevron,");
    expect(stylesSource).toContain(".agent-narration-block__toggle:hover .agent-narration-block__chevron,");
  });

  it("renders structured file media with resolved paths as action buttons", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-file-path"
          artifactClient={{
            resolveArtifact: async () => ({ ok: true, path: "/Users/yuan/deck.pptx", name: "deck.pptx", kind: "file" }),
            revealArtifact: async () => undefined,
            openArtifact: async () => undefined
          }}
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "附件好了",
              media: [{ kind: "file", path: "/Users/yuan/deck.pptx", name: "deck.pptx" }]
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("<button");
    expect(html).toContain('title="/Users/yuan/deck.pptx"');
    expect(html).toContain(">deck<");
    expect(html).toContain(">PPTX<");
    expect(html).toContain('data-testid="agent-file-icon-pptx"');
    expect(html).toContain('data-testid="agent-attachment-card-file"');
    expect(html).toContain("agent-attachment-card");
    expect(html).toContain("agent-attachment-card__file-tile--pptx");
    expect(html).not.toContain("rounded-tag");
    expect(html).not.toContain('href="/Users/yuan/deck.pptx"');
    expect(html).not.toContain('img src="/Users/yuan/deck.pptx"');
  });

  it("runs file attachment actions as open, reveal, download, then final failure", async () => {
    const events: string[] = [];
    const openOutcomes = [true, false, false, false];
    const revealOutcomes = [true, false, false];
    const downloadOutcomes = [true, false];
    const resolveArtifact = vi.fn(async (path: string) => {
      events.push(`resolve:${path}`);
      return fileArtifact("/Users/yuan/fresh-deck.pptx", "fresh-deck.pptx", "http://127.0.0.1:18980/api/media/fresh");
    });
    const openArtifact = vi.fn(async (path: string) => {
      events.push(`open:${path}`);
      if (!openOutcomes.shift()) throw new Error("open failed");
    });
    const revealArtifact = vi.fn(async (path: string) => {
      events.push(`reveal:${path}`);
      if (!revealOutcomes.shift()) throw new Error("reveal failed");
    });
    const startDownload = vi.fn((url: string, name: string) => {
      events.push(`download:${url}:${name}`);
      return downloadOutcomes.shift() ?? false;
    });
    const artifactClient = { resolveArtifact, openArtifact, revealArtifact };

    await expect(runAttachmentAction({
      path: "/Users/yuan/deck.pptx",
      url: "http://127.0.0.1:18980/api/media/old",
      label: "deck.pptx",
      artifactClient,
      startDownload
    })).resolves.toBe("opened");
    expect(openArtifact).toHaveBeenLastCalledWith("/Users/yuan/fresh-deck.pptx");
    expect(revealArtifact).not.toHaveBeenCalled();
    expect(startDownload).not.toHaveBeenCalled();

    await expect(runAttachmentAction({
      path: "/Users/yuan/deck.pptx",
      url: "http://127.0.0.1:18980/api/media/old",
      label: "deck.pptx",
      artifactClient,
      startDownload
    })).resolves.toBe("revealed");
    expect(revealArtifact).toHaveBeenLastCalledWith("/Users/yuan/fresh-deck.pptx");

    await expect(runAttachmentAction({
      path: "/Users/yuan/deck.pptx",
      url: "http://127.0.0.1:18980/api/media/old",
      name: "old-deck.pptx",
      label: "deck.pptx",
      artifactClient,
      startDownload
    })).resolves.toBe("downloaded");
    expect(startDownload).toHaveBeenLastCalledWith("http://127.0.0.1:18980/api/media/fresh", "fresh-deck.pptx");

    await expect(runAttachmentAction({
      path: "/Users/yuan/deck.pptx",
      url: "http://127.0.0.1:18980/api/media/old",
      label: "deck.pptx",
      artifactClient,
      startDownload
    })).resolves.toBe("failed");
    expect(resolveArtifact).toHaveBeenCalledTimes(4);
    expect(openArtifact).toHaveBeenCalledTimes(4);
    expect(revealArtifact).toHaveBeenCalledTimes(3);
    expect(startDownload).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "resolve:/Users/yuan/deck.pptx",
      "open:/Users/yuan/fresh-deck.pptx",
      "resolve:/Users/yuan/deck.pptx",
      "open:/Users/yuan/fresh-deck.pptx",
      "reveal:/Users/yuan/fresh-deck.pptx",
      "resolve:/Users/yuan/deck.pptx",
      "open:/Users/yuan/fresh-deck.pptx",
      "reveal:/Users/yuan/fresh-deck.pptx",
      "download:http://127.0.0.1:18980/api/media/fresh:fresh-deck.pptx",
      "resolve:/Users/yuan/deck.pptx",
      "open:/Users/yuan/fresh-deck.pptx",
      "reveal:/Users/yuan/fresh-deck.pptx",
      "download:http://127.0.0.1:18980/api/media/fresh:fresh-deck.pptx"
    ]);
  });

  it("keeps old fallback order when fresh resolve fails", async () => {
    const events: string[] = [];
    const resolveArtifact = vi.fn(async (path: string) => {
      events.push(`resolve:${path}`);
      throw new Error("resolve failed");
    });
    const openArtifact = vi.fn(async (path: string) => {
      events.push(`open:${path}`);
      throw new Error("open failed");
    });
    const revealArtifact = vi.fn(async (path: string) => {
      events.push(`reveal:${path}`);
      throw new Error("reveal failed");
    });
    const startDownload = vi.fn((url: string, name: string) => {
      events.push(`download:${url}:${name}`);
      return true;
    });

    await expect(runAttachmentAction({
      path: "/Users/yuan/deck.pptx",
      url: "http://127.0.0.1:18980/api/media/old",
      name: "old-deck.pptx",
      label: "deck.pptx",
      artifactClient: { resolveArtifact, openArtifact, revealArtifact },
      startDownload
    })).resolves.toBe("downloaded");

    expect(events).toEqual([
      "resolve:/Users/yuan/deck.pptx",
      "open:/Users/yuan/deck.pptx",
      "reveal:/Users/yuan/deck.pptx",
      "download:http://127.0.0.1:18980/api/media/old:old-deck.pptx"
    ]);
  });

  it("does not resolve URL-only attachments", async () => {
    const resolveArtifact = vi.fn(async () => fileArtifact("/Users/yuan/deck.pptx"));
    const openArtifact = vi.fn(async () => undefined);
    const revealArtifact = vi.fn(async () => undefined);
    const startDownload = vi.fn(() => true);

    await expect(runAttachmentAction({
      url: "http://127.0.0.1:18980/api/media/only-url",
      name: "deck.pptx",
      label: "deck.pptx",
      artifactClient: { resolveArtifact, openArtifact, revealArtifact },
      startDownload
    })).resolves.toBe("downloaded");

    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(openArtifact).not.toHaveBeenCalled();
    expect(revealArtifact).not.toHaveBeenCalled();
    expect(startDownload).toHaveBeenCalledWith("http://127.0.0.1:18980/api/media/only-url", "deck.pptx");
  });

  it("uses fresh artifact name for download filename", async () => {
    const resolveArtifact = vi.fn(async () => fileArtifact(
      "/Users/yuan/fresh-deck.pptx",
      "fresh.pptx",
      "http://127.0.0.1:18980/api/media/fresh"
    ));
    const openArtifact = vi.fn(async () => {
      throw new Error("open failed");
    });
    const revealArtifact = vi.fn(async () => {
      throw new Error("reveal failed");
    });
    const startDownload = vi.fn(() => true);

    await expect(runAttachmentAction({
      path: "/Users/yuan/deck.pptx",
      url: "http://127.0.0.1:18980/api/media/old",
      name: "old.pptx",
      label: "deck.pptx",
      artifactClient: { resolveArtifact, openArtifact, revealArtifact },
      startDownload
    })).resolves.toBe("downloaded");

    expect(startDownload).toHaveBeenCalledWith("http://127.0.0.1:18980/api/media/fresh", "fresh.pptx");
  });

  it("renders final attachment failure actions with copy affordances", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AttachmentActionError
          path="/Users/yuan/deck.pptx"
          url="/api/media/deck"
          copiedTarget="path"
          onCopy={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain("无法打开或下载该附件");
    expect(html).toContain("复制路径");
    expect(html).toContain("复制链接");
    expect(html).toContain("已复制路径");
  });

  it("unwraps a whole-message markdown fence only for table or image result content", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <AgentThreadMessages
          chatScopeKey="chat-table"
          messages={[
            {
              id: "answer",
              role: "assistant",
              content: "```markdown\n| 文件 | 状态 |\n| --- | --- |\n| report.md | done |\n```"
            }
          ]}
        />
      </I18nProvider>
    );

    expect(html).toContain("<table");
    expect(html).toContain("report.md");
  });
});

function fileArtifact(path: string, name = "deck.pptx", mediaUrl?: string) {
  return {
    ok: true as const,
    path,
    name,
    kind: "file" as const,
    ...(mediaUrl ? { media_url: mediaUrl } : {})
  };
}
