/// <reference types="node" />
/**
 * Windows 上读任务 / 协助会话的浮起面板要让开标题栏。
 *
 * 面板与遮罩挂在 body 上、从窗口顶端开始铺，而 Windows 的标题栏是窗口最上面独立的一行（`--codex-toolbar-height`），
 * 最小化 / 最大化 / 关闭由系统画在这一行最上层。不让开时，面板右上角的「继续任务」与关闭压在系统按钮下面，
 * 点了没反应，看起来就是两块叠在一起。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const collabCss = readFileSync(fileURLToPath(new URL("../collab-page.module.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** 按选择器前缀找出完整规则（含选择器组与声明）。 */
function rulesMatching(prefix: string): string[] {
  return [...collabCss.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1]!.includes(prefix))
    .map((match) => `${match[1]!.trim()} {${match[2]!}}`);
}

describe("collab reader panel under the Windows titlebar", () => {
  it("keeps the layer filling the whole window on every other platform", () => {
    const base = collabCss.match(/\.readerLayer \{([^}]*)\}/)?.[1] ?? "";
    expect(base).toContain("inset: 0;");
  });

  it("starts the layer below the Windows chrome row", () => {
    // 面板与遮罩都在这层里，让开一次就同时解决上沿与右上角的点击。
    const rule = rulesMatching(".readerLayer").find((text) => text.includes("--codex-toolbar-height"));
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/body\.memmy-platform-windows/);
    expect(rule).toContain("top: var(--codex-toolbar-height, 46px);");
  });
});
