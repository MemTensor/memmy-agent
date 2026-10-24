import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { AgentMessageContent, normalizeLatexMathDelimiters } from "../agent-message-content.js";

// KaTeX renders math into elements carrying the `katex` class. These tests pin
// the behaviour that common LaTeX delimiters in assistant markdown are rendered
// instead of leaking their source into the transcript.
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

  it("renders block math (\\[...\\]) via KaTeX", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "条件：\\[ab+1\\mid a^2+b^2\\]成立" })
    );
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\[");
    expect(html).toContain("条件：");
    expect(html).toContain("成立");
  });

  it("renders inline math (\\(...\\)) via KaTeX", () => {
    const html = renderToString(
      createElement(AgentMessageContent, { content: "动量 \\(\\mathbf{p} = m\\mathbf{v}\\) 是矢量" })
    );
    expect(html).toContain("katex");
    expect(html).toContain("动量");
  });

  it("keeps LaTeX delimiters literal inside code", () => {
    const markdown = "`\\(x\\)`\n\n```text\n\\[y\\]\n```";
    expect(normalizeLatexMathDelimiters(markdown)).toBe(markdown);
    const html = renderToString(createElement(AgentMessageContent, { content: markdown }));
    expect(html).not.toContain("katex");
  });

  it("keeps unmatched and escaped delimiters unchanged", () => {
    const markdown = "未闭合 \\(x 与转义 \\\\(y\\\\)";
    expect(normalizeLatexMathDelimiters(markdown)).toBe(markdown);
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
