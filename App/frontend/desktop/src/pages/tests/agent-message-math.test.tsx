import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { AgentMessageContent } from "../agent-message-content.js";

// KaTeX renders math into elements carrying the `katex` class. These tests pin
// the behaviour that LaTeX in assistant markdown is rendered instead of leaking
// its `$`/`$$` source into the transcript.
describe("AgentMessageContent math rendering", () => {
  it("renders block math ($$...$$) via KaTeX instead of raw source", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "$$\\mathbf{F} = m\\mathbf{a}$$" })
    );
    expect(html).toContain("katex");
    expect(html).not.toContain("$$");
  });

  it("renders inline math ($...$) via KaTeX", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "动量 $\\mathbf{p} = m\\mathbf{v}$ 是矢量" })
    );
    expect(html).toContain("katex");
    expect(html).toContain("动量");
  });

  it("still renders ordinary markdown around math", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "牛顿第二定律:\n\n$$F = ma$$\n\n即合外力等于质量乘加速度。" })
    );
    expect(html).toContain("katex");
    expect(html).toContain("牛顿第二定律");
    expect(html).toContain("即合外力等于质量乘加速度。");
  });
});
