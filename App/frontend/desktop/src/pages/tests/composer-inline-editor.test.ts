// @vitest-environment happy-dom

/** The inline editor's text rules: chips are excluded, blocks become newlines, the caret maps to an offset. */
import { describe, expect, it } from "vitest";
import { caretAtTextStart, caretTextOffset, chipLabelText, readEditorPlainText } from "../composer-inline-editor.js";

function editor(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element;
}

const chip = '<span data-mention-chip="s-1" contenteditable="false">会话标题</span>';

describe("reading the editor", () => {
  it("leaves the chips out of the text", () => {
    expect(readEditorPlainText(editor(`${chip}帮我看下这个问题`))).toBe("帮我看下这个问题");
  });

  it("keeps a newline between block lines and for a <br>", () => {
    expect(readEditorPlainText(editor("第一行<div>第二行</div>"))).toBe("第一行\n第二行");
    expect(readEditorPlainText(editor("第一行<br>第二行"))).toBe("第一行\n第二行");
  });

  it("reads an editor that only holds chips as empty text", () => {
    expect(readEditorPlainText(editor(chip))).toBe("");
  });

  it("turns the browser's non-breaking space back into a space", () => {
    expect(readEditorPlainText(editor("你好\u00a0世界"))).toBe("你好 世界");
  });
});

describe("the caret inside the text", () => {
  it("counts characters after the chips, not the chip labels", () => {
    const element = editor(`${chip}你好`);
    document.body.append(element);
    const text = element.lastChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);

    expect(caretTextOffset(element, range)).toBe(1);
    expect(caretAtTextStart(element, range)).toBe(false);

    // A fresh range: moving a collapsed range back to 0 is unreliable in the test DOM.
    const atStart = document.createRange();
    atStart.setStart(text, 0);
    atStart.collapse(true);
    expect(caretTextOffset(element, atStart)).toBe(0);
    expect(caretAtTextStart(element, atStart)).toBe(true);
    element.remove();
  });

  it("treats a caret at the very start as the start of the text", () => {
    const element = editor("你好");
    document.body.append(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);

    expect(caretTextOffset(element, range)).toBe(0);
    expect(caretAtTextStart(element, range)).toBe(true);
    element.remove();
  });
});

describe("chip label", () => {
  it("keeps a short title as it is", () => {
    expect(chipLabelText("哈喽问候")).toBe("哈喽问候");
  });

  it("cuts a long title and marks the cut, counting characters not code units", () => {
    const label = "【Memmy】关于Memmy的共享空间，目前做成了纯管理台的形式";
    const shown = chipLabelText(label);
    expect(Array.from(shown)).toHaveLength(23);
    expect(shown.endsWith("…")).toBe(true);
  });
});
