// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select } from "../Select.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Select", () => {
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

  it("renders an accessible upward-opening list and selects an option", () => {
    const onValueChange = vi.fn();
    act(() => root.render(
      <Select
        ariaLabel="选择模型"
        value="fast"
        options={[
          { value: "fast", label: "openai / gpt-5.4" },
          { value: "deep", label: "anthropic / claude-sonnet" }
        ]}
        placement="top"
        onValueChange={onValueChange}
      />
    ));

    const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(trigger?.getAttribute("aria-label")).toBe("选择模型");
    expect(trigger?.closest(".select-control")?.classList.contains("select-control--placement-top")).toBe(true);

    act(() => trigger?.click());
    const options = document.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    act(() => options[1]?.click());
    expect(onValueChange).toHaveBeenCalledWith("deep");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
