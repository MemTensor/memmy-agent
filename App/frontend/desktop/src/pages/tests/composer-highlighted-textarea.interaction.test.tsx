// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ComposerHighlightedTextarea, composerHighlightSegments, removeHighlightedCommandAtCaret } from "../composer-highlighted-textarea.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("highlights known commands without changing the submitted text or matching prefixes", () => {
  const input = "/literature-review 研究人工智能 /literature-review-extra";
  const segments = composerHighlightSegments(input, ["/literature-review"]);
  expect(segments.filter((segment) => segment.command).map((segment) => segment.text)).toEqual(["/literature-review"]);
  expect(segments.map((segment) => segment.text).join("")).toBe(input);
});
it("preserves the 1.2.5 command deletion behavior", () => {
  const command = "/literature-review";
  expect(removeHighlightedCommandAtCaret(`${command} topic`, [command], command.length + 1, "Backspace"))
    .toEqual({ value: "topic", caret: 0 });
  expect(removeHighlightedCommandAtCaret(`${command}-extra`, [command], command.length, "Backspace")).toBeNull();
});
it("keeps the native textarea editable while displaying an inaccessible backdrop", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState("/literature-review topic");
    return <ComposerHighlightedTextarea value={value} highlightedCommands={["/literature-review"]}
      onChange={(event) => { setValue(event.target.value); changed(event.target.value); }} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("/literature-review topic");
    expect(container.querySelector(".composer-slash-chip")?.textContent).toBe("/literature-review");
    expect(container.querySelector(".composer-rich-input__backdrop")?.getAttribute("aria-hidden")).toBe("true");
    textarea.setSelectionRange(19, 19);
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })));
    expect(changed).toHaveBeenCalledWith("topic");
    expect(textarea.value).toBe("topic");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
