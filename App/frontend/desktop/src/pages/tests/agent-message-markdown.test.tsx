import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessageContent } from "../agent-message-content.js";

const stylesSourceUrl = new URL("../../styles.css", import.meta.url);

describe("AgentMessageContent markdown rendering", () => {
  it("keeps single tildes in multiple temperature ranges as plain text", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "🌡️ 26~28°C，体感 29~32°C" })
    );

    expect(html).toContain("26~28°C，体感 29~32°C");
    expect(html).not.toContain("<del>");
  });

  it("keeps standard double-tilde strikethrough support", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "天气预报：~~阵雨~~多云" })
    );

    expect(html).toContain("<del>阵雨</del>");
  });

  it("keeps GFM column alignment on table cells", () => {
    const html = renderToString(
      createElement(AgentMessageContent, {
        content: ["| 左 | 中 | 右 |", "| :--- | :---: | ---: |", "| a | b | 1 |"].join("\n")
      })
    );

    expect(html).toContain("agent-message-content__table-frame");
    expect(html).toMatch(/<th class="agent-message-content__th[^"]*" style="text-align:center">中<\/th>/);
    expect(html).toMatch(/<td class="agent-message-content__td[^"]*" style="text-align:right">1<\/td>/);
  });

  it("renders fenced code as a block without a surrounding pre element", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: ["```", "single line", "```", "", "use `inline` code"].join("\n") })
    );

    expect(html).toContain('<div class="agent-message-content__code-block">');
    expect(html).not.toMatch(/<pre>\s*<div class="agent-message-content__code-block">/);
    expect(html).toContain('class="agent-message-content__inline-code');
  });

  it("keeps a paragraph between a tight list item and the code block under it", () => {
    const html = renderToString(
      createElement(AgentMessageContent, {
        content: [
          "- 查看界面：当前是未命名文稿",
          "- 输入结果：文档内容现为",
          "  ```text",
          "  额会",
          "  ```",
          "",
          "没有访问其他应用。"
        ].join("\n")
      })
    );
    const stylesSource = readFileSync(stylesSourceUrl, "utf8");

    expect(html).toMatch(/<li><p class="agent-message-content__p[^"]*">输入结果：文档内容现为<\/p><div class="agent-message-content__code-block">/);
    expect(html).not.toMatch(/<p class="agent-message-content__p[^"]*">\s*<p/);
    expect(stylesSource).toContain(".agent-message-content__list li > .agent-message-content__p + :is(");
    expect(stylesSource).toMatch(/\.agent-message-content__list li > \.agent-message-content__p \+ :is\([\s\S]*?\) \{\s*margin-top: 16px;/);
  });
});
