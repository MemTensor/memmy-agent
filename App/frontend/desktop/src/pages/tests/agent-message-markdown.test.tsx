import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessageContent } from "../agent-message-content.js";

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
});
