// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualAgentNameField } from "../../memory-sources-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ManualAgentNameField", () => {
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

  it("uses one editable combobox for preset selection and custom input", () => {
    const onChange = vi.fn();
    act(() => root.render(
      <ManualAgentNameField
        label="Agent 名称"
        value=""
        placeholder="选择或输入 Agent 名称"
        options={["kimi code", "zcode"]}
        onChange={onChange}
      />
    ));

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(container.querySelectorAll("input")).toHaveLength(1);

    act(() => container.querySelector<HTMLButtonElement>(".manual-agent-combobox__toggle")?.click());
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);

    act(() => container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    expect(onChange).toHaveBeenCalledWith("zcode");
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "aider");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "aider" }));
    });
    expect(onChange).toHaveBeenCalledWith("aider");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
