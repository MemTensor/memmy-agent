import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryMarkdown } from "../memory-markdown.js";

const render = (text: string) => renderToStaticMarkup(<MemoryMarkdown text={text} literalHtml />);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("MemoryMarkdown literal HTML", () => {
  it("keeps HTML hidden unless literal rendering is explicitly enabled", () => {
    const text = '<div>旧页面隐藏内容</div>\n\n**正常正文**';
    const html = renderToStaticMarkup(<MemoryMarkdown text={text} />);
    expect(html).not.toContain("旧页面隐藏内容");
    expect(html).not.toContain("literal-html");
    expect(html).toContain("<strong>正常正文</strong>");
    for (const file of ["world-model-sub-page.tsx", "computer-history-sub-page.tsx"]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/<MemoryMarkdown[^>]*literalHtml/);
    }
  });

  it.each([
    '<in-app-browser-context source="ambient-ui-state">\n示例项目\n</in-app-browser-context>\n给搜索框增加清空按钮。',
    '<in-app-browser-context>\n示例项目\n</in-app-browser-context>\n\n给搜索框增加清空按钮。',
    '<in-app-browser-context>\n未闭合的上下文\n给搜索框增加清空按钮。',
    '<timestamp>Tuesday, Jun 16, 2026</timestamp>',
    '<!-- 原始注释 -->\n给搜索框增加清空按钮。',
    '<div>\n多行原文\n</div>\n给搜索框增加清空按钮。'
  ])("preserves envelope and request text: %s", (text) => {
    const html = render(text);
    for (const line of text.split("\n").filter(Boolean)) expect(html.replace(/<[^>]*>/g, "")).toContain(escape(line));
    expect(html).toContain('class="memory-markdown__literal-html"');
  });

  it("preserves raw block line breaks with a scoped style", () => {
    const html = render('<context>\n第一行\n第二行\n</context>');
    expect(html).toContain('&lt;context&gt;\n第一行\n第二行\n&lt;/context&gt;');
    const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.memory-markdown__literal-html\s*\{[^}]*white-space:\s*pre-wrap/s);
  });

  it.each([
    '<script>alert("test")</script>',
    '<iframe src="https://example.invalid"></iframe>',
    '<img src="https://example.invalid/a" onerror="alert(1)">',
    '<div onclick="alert(1)">原文</div>',
    '<a href="javascript:alert(1)">原文</a>',
    '<style>body{display:none}</style>'
  ])("renders active HTML only as text: %s", (text) => {
    const html = render(text);
    expect(html.replace(/<[^>]*>/g, "")).toContain(escape(text));
    expect(html).not.toMatch(/<(?:script|iframe|img|div\s+onclick|a\s+href|style)\b/i);
  });

  it("keeps inline tags literal and normal Markdown formatted", () => {
    const html = render('正文 <b>示例</b>，**加粗**。\n\n- 项目\n\n| 列 |\n| --- |\n| 值 |\n\n`<code>`\n\n```html\n<div>代码</div>\n```');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&lt;/b&gt;');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<li>项目</li>');
    expect(html).toContain('<table');
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;div&gt;代码&lt;/div&gt;');
    expect(html).not.toContain('<b>');
  });

  it("keeps existing inert links and images and accepts empty input", () => {
    const html = render('[链接](https://example.invalid) ![图片说明](https://example.invalid/img)');
    expect(html).toContain('链接');
    expect(html).toContain('图片说明');
    expect(html).not.toMatch(/<(?:a|img)\b/);
    expect(render('')).toBe('<div class="memory-markdown"></div>');
  });
});
