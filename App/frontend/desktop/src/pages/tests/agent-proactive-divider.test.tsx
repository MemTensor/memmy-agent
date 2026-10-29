import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { configureUserTimeZone } from "../../lib/user-time-zone.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";

function render(messages: AgentChatMessage[], language: "zh-CN" | "en-US" = "zh-CN") {
  return renderToString(
    <I18nProvider language={language}>
      <AgentThreadMessages chatScopeKey="scheduled-divider" messages={messages} />
    </I18nProvider>,
  );
}

afterEach(() => {
  configureUserTimeZone();
  vi.useRealTimers();
});

describe("scheduled message dividers", () => {
  it("labels each independent result with its task name and delivery time, without adding an unread banner", () => {
    configureUserTimeZone("Asia/Shanghai");
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-12T12:30:00Z");
    const html = render([
      { id: "ordinary", role: "assistant", content: "定时任务建好了。" },
      { id: "cron:first", role: "assistant", proactiveDelivery: "cron", proactiveTaskName: "微信新消息监测", content: "暂无微信新消息。", createdAt: Date.parse("2026-10-12T12:11:00Z") },
      { id: "cron:second", role: "assistant", proactiveDelivery: "cron", proactiveTaskName: "微信新消息监测", content: "暂无微信新消息。", createdAt: Date.parse("2026-10-12T12:13:00Z") },
    ]);
    expect(html.match(/class="agent-proactive-message-divider"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="微信新消息监测 · 2026/10/12 20:11"');
    expect(html).toContain('dateTime="2026-10-12T12:11:00.000Z">20:11</time>');
    expect(html).toContain('dateTime="2026-10-12T12:13:00.000Z">20:13</time>');
    expect(html).not.toContain("以下为新消息");
    expect(render([{ id: "normal", role: "assistant", content: "普通回答。" }])).not.toContain("agent-proactive-message-divider");
  });

  it("reuses the entire ordinary answer renderer for Markdown, tables, code, images and files", () => {
    const message: AgentChatMessage = {
      id: "mixed-answer", role: "assistant",
      content: "## 本周汇总\n\n**已完成**，见下表。\n\n| 城市 | 数量 |\n| --- | --- |\n| 上海 | 12 |\n\n```json\n{\"ready\": true}\n```",
      media: [
        { kind: "image", name: "统计图.png", url: "http://localhost/api/media/chart.png" },
        { kind: "file", name: "业务数据.xlsx", url: "http://localhost/api/media/report.xlsx" },
      ],
    };
    const ordinary = render([message]);
    const proactive = render([{ ...message, proactiveDelivery: "cron", proactiveTaskName: "每周数据汇总" }]);
    expect(ordinary).toContain('<table class="agent-message-content__table">');
    expect(ordinary).toContain("统计图.png");
    expect(ordinary).toContain("业务数据.xlsx");
    expect(proactive.replace(/<div class="agent-proactive-message-divider"[^>]*>[\s\S]*?<\/div>/u, "")).toBe(ordinary);
  });

  it("also labels scheduled failures and media-only results", () => {
    const html = render([
      { id: "failure", role: "assistant", proactiveDelivery: "cron", proactiveTaskName: "每日汇总", content: "执行失败。", modelError: { category: "model_failed", detail: "provider unavailable" } },
      { id: "media-only", role: "assistant", proactiveDelivery: "cron", proactiveTaskName: "报表生成", content: "", media: [{ kind: "file", name: "报表.pdf", url: "http://localhost/api/media/report.pdf" }] },
    ]);
    expect(html.match(/class="agent-proactive-message-divider"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="每日汇总"');
    expect(html).toContain('aria-label="报表生成"');
    expect(html).toContain("报表.pdf");
  });

  it.each(["zh-CN", "en-US"] as const)("uses a localized fallback for old results in %s", (language) => {
    const html = render([{ id: "old", role: "assistant", proactiveDelivery: "cron", proactiveTaskName: "  ", content: "旧提醒" }], language);
    expect(html).toContain(language === "zh-CN" ? 'aria-label="定时更新"' : 'aria-label="Scheduled update"');
  });

  it("renders task names as plain text and keeps dates for results from previous days", () => {
    configureUserTimeZone("Asia/Shanghai");
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-12T12:30:00Z");
    const name = "<img onerror=alert(1)> " + "很长的定时任务名称".repeat(20);
    const html = render([{ id: "old-long", role: "assistant", proactiveDelivery: "cron", proactiveTaskName: name, content: "结果", createdAt: Date.parse("2026-10-11T12:13:00Z") }]);
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain('dateTime="2026-10-11T12:13:00.000Z">2026/10/11 20:13</time>');
  });
});
