// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryReferenceTags } from "../memory-reference-tags.js";

describe("MemoryReferenceTags interaction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("passes the complete id and semantic fallback when clicked", () => {
    const onOpen = vi.fn();
    act(() => {
      root.render(<MemoryReferenceTags ids={["codex::policy_1"]} fallbackPage="policies" onOpen={onOpen} />);
    });

    act(() => container.querySelector("button")?.click());

    expect(onOpen).toHaveBeenCalledWith("codex::policy_1", "policies");
  });
});
