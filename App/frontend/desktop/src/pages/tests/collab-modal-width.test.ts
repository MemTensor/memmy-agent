/// <reference types="node" />
/**
 * The collaboration dialogs are wider than the shared modal default and must say so in a way the bundle order cannot
 * undo: main.tsx imports styles.css last, so its plain `.modal { width: min(440px, ...) }` lands after this module and
 * flattened the dialogs to 440px. The rules therefore also carry `.modal`, which wins on specificity.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const collabCss = readFileSync(fileURLToPath(new URL("../collab-page.module.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const globalCss = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return collabCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function selectorsFor(className: string): string[] {
  return [...collabCss.matchAll(new RegExp(`([^{}]*\\.${className})\\s*\\{`, "g"))].map((match) => match[1].trim());
}

describe("collab dialog widths", () => {
  it("keeps the shared modal default that the dialogs have to outrank", () => {
    expect(globalCss).toMatch(/\.modal \{[^}]*width: min\(440px, calc\(100vw - 64px\)\);/);
  });

  it("declares each dialog width on a .modal-prefixed rule and only there", () => {
    // 读取视图不再是弹窗，改成右侧浮起的面板，所以这里只剩两个弹窗。
    const expected = {
      createModal: "width: min(540px, calc(100vw - 32px));",
      pickModal: "width: min(880px, calc(100vw - 32px));"
    };

    for (const [className, width] of Object.entries(expected)) {
      expect(selectorsFor(className)).toEqual([`:global(.modal).${className}`]);
      expect(declarationsFor(`:global(.modal).${className}`)).toContain(width);
    }
  });
});
