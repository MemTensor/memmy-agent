// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MemoryAddDetail, MemorySearchDetail } from "../logs-sub-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("memory log Markdown interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("expands Markdown on demand and collapses each candidate again", async () => {
    const markdownCandidate = {
      refKind: "trace",
      refId: "trace_markdown",
      score: 0.88,
      tier: "L1",
      content: "## 任务背景\n\n**重点决定**\n\n- 保留现有修改\n- 单独提交"
    };
    const emptyCandidate = {
      refKind: "trace",
      refId: "trace_empty",
      score: 0.42,
      tier: "L2",
      content: ""
    };

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemorySearchDetail
            input={{ query: "日志展示" }}
            output={{ candidates: [markdownCandidate, emptyCandidate], filtered: [markdownCandidate, emptyCandidate] }}
          />
        </I18nProvider>
      );
    });

    const candidates = Array.from(container.querySelectorAll<HTMLDetailsElement>("details.memory-log-candidate"));
    expect(candidates).toHaveLength(2);

    const markdownDetails = candidates[0]!;
    const emptyDetails = candidates[1]!;
    const summary = markdownDetails.querySelector<HTMLElement>("summary");
    expect(summary).not.toBeNull();
    expect(markdownDetails.open).toBe(false);
    expect(markdownDetails.querySelector("h2")).toBeNull();
    expect(emptyDetails.querySelector("summary")?.textContent).toContain("(empty)");

    await act(async () => summary!.click());
    expect(markdownDetails.open).toBe(true);
    expect(markdownDetails.querySelector("h2")?.textContent).toBe("任务背景");
    expect(markdownDetails.querySelector("strong")?.textContent).toBe("重点决定");
    expect(Array.from(markdownDetails.querySelectorAll("li"), (item) => item.textContent)).toEqual([
      "保留现有修改",
      "单独提交"
    ]);

    await act(async () => summary!.click());
    expect(markdownDetails.open).toBe(false);
    expect(markdownDetails.querySelector("h2")).toBeNull();
  });

  it("renders memory_add User and Assistant bodies as safe Markdown", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryAddDetail
            input={{}}
            output={{
              details: [{
                query: "# 用户标题\n\n**重点问题**",
                agent: [
                  "```ts",
                  "const value = 1;",
                  "```",
                  "",
                  "| 列一 | 列二 |",
                  "| --- | --- |",
                  "| A | B |",
                  "",
                  "[安全链接](https://example.com) ![示意图](https://example.com/image.png)",
                  "<script>unsafe()</script>"
                ].join("\n")
              }]
            }}
          />
        </I18nProvider>
      );
    });

    expect(container.querySelector("h1")?.textContent).toBe("用户标题");
    expect(container.querySelector("strong")?.textContent).toBe("重点问题");
    expect(container.querySelector("pre code")?.textContent).toContain("const value = 1;");
    expect(container.querySelector("table")?.textContent).toContain("列一");
    expect(container.textContent).not.toContain("```");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("安全链接");
    expect(container.textContent).toContain("示意图");
  });

  it("renders memory_add fallback detail as Markdown", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryAddDetail input={{}} output={{ details: [{ content: "## 兜底详情\n\n- 第一项\n- 第二项" }] }} />
        </I18nProvider>
      );
    });

    expect(container.querySelector("h2")?.textContent).toBe("兜底详情");
    expect(Array.from(container.querySelectorAll("li"), (item) => item.textContent)).toEqual(["第一项", "第二项"]);
  });

  it("renders memory_search query and error bodies as Markdown", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemorySearchDetail
            input={{ query: "**检索重点**" }}
            output={{ error: "### 检索失败\n\n`timeout`" }}
          />
        </I18nProvider>
      );
    });

    expect(container.querySelector("strong")?.textContent).toBe("检索重点");
    expect(container.querySelector("h3")?.textContent).toBe("检索失败");
    expect(container.querySelector("code")?.textContent).toBe("timeout");
  });
});
