// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_DRAG_EXCLUSION_SELECTOR,
  resolveObservedWindowDragExclusionSelector,
  resolveWindowDragExclusionSelector,
  THREAD_DRAG_EXCLUSION_SELECTOR,
  WINDOWS_TITLEBAR_DRAG_EXCLUSION_SELECTOR,
  WindowDragRegion
} from "../window-drag-region.js";

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("WindowDragRegion", () => {
  it("enables the dynamic exclusion only on the knowledge route", () => {
    expect(resolveWindowDragExclusionSelector("/knowledge")).toBe(
      KNOWLEDGE_DRAG_EXCLUSION_SELECTOR
    );
    expect(resolveWindowDragExclusionSelector("/main")).toBe(
      THREAD_DRAG_EXCLUSION_SELECTOR
    );
    expect(resolveWindowDragExclusionSelector("/settings")).toBeUndefined();
    expect(resolveObservedWindowDragExclusionSelector(undefined)).toBe(
      WINDOWS_TITLEBAR_DRAG_EXCLUSION_SELECTOR
    );
    expect(resolveObservedWindowDragExclusionSelector(THREAD_DRAG_EXCLUSION_SELECTOR)).toBe(
      `${THREAD_DRAG_EXCLUSION_SELECTOR}, ${WINDOWS_TITLEBAR_DRAG_EXCLUSION_SELECTOR}`
    );
  });

  it("mirrors every knowledge control group as a root-level no-drag exclusion", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const trigger = document.createElement("button");
    trigger.dataset.windowDragExclusion = "knowledge-create";
    let left = 320;
    trigger.getBoundingClientRect = () => ({
      x: left,
      y: 14,
      left,
      top: 14,
      right: left + 28,
      bottom: 42,
      width: 28,
      height: 28,
      toJSON: () => undefined
    });
    document.body.append(trigger);
    const headerActions = document.createElement("div");
    headerActions.dataset.windowDragExclusion = "knowledge-readonly-actions";
    headerActions.getBoundingClientRect = () => ({
      x: 700,
      y: 20,
      left: 700,
      top: 20,
      right: 960,
      bottom: 50,
      width: 260,
      height: 30,
      toJSON: () => undefined
    });
    document.body.append(headerActions);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <WindowDragRegion dynamicExclusionSelector={KNOWLEDGE_DRAG_EXCLUSION_SELECTOR} />
      );
    });

    const dragRegion = container.querySelector<HTMLElement>(".window-drag-region");
    const exclusions = container.querySelectorAll<HTMLElement>(".window-drag-exclusion--dynamic");
    expect(exclusions).toHaveLength(2);
    expect(exclusions[0]?.style.left).toBe("320px");
    expect(exclusions[0]?.style.top).toBe("14px");
    expect(exclusions[0]?.style.width).toBe("28px");
    expect(exclusions[0]?.style.height).toBe("28px");
    expect(exclusions[1]?.style.left).toBe("700px");
    expect(exclusions[1]?.style.width).toBe("260px");
    expect(
      dragRegion?.compareDocumentPosition(exclusions[0]!) ?? 0
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    left = 404;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(
      container.querySelectorAll<HTMLElement>(".window-drag-exclusion--dynamic")[0]?.style.left
    ).toBe("404px");
  });

  it("mirrors conversation toolbar and side-panel header controls on the chat route", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const toolbarActions = document.createElement("div");
    toolbarActions.dataset.windowDragExclusion = "thread-toolbar-actions";
    toolbarActions.getBoundingClientRect = () => ({
      x: 640,
      y: 8,
      left: 640,
      top: 8,
      right: 980,
      bottom: 40,
      width: 340,
      height: 32,
      toJSON: () => undefined
    });
    const panelHeader = document.createElement("header");
    panelHeader.dataset.windowDragExclusion = "thread-panel-header";
    panelHeader.getBoundingClientRect = () => ({
      x: 1000,
      y: 0,
      left: 1000,
      top: 0,
      right: 1440,
      bottom: 46,
      width: 440,
      height: 46,
      toJSON: () => undefined
    });
    document.body.append(toolbarActions, panelHeader);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <WindowDragRegion dynamicExclusionSelector={THREAD_DRAG_EXCLUSION_SELECTOR} />
      );
    });

    const exclusions = container.querySelectorAll<HTMLElement>(".window-drag-exclusion--dynamic");
    expect(exclusions).toHaveLength(2);
    expect(exclusions[0]?.style.left).toBe("640px");
    expect(exclusions[0]?.style.width).toBe("340px");
    expect(exclusions[1]?.style.left).toBe("1000px");
    expect(exclusions[1]?.style.height).toBe("46px");
  });

  it("mirrors the Windows titlebar controls even when the route has no other exclusions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const titlebar = document.createElement("div");
    titlebar.dataset.windowDragExclusion = "windows-titlebar";
    titlebar.getBoundingClientRect = () => ({
      x: 12,
      y: 9,
      left: 12,
      top: 9,
      right: 280,
      bottom: 37,
      width: 268,
      height: 28,
      toJSON: () => undefined
    });
    document.body.append(titlebar);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<WindowDragRegion />);
    });

    const exclusions = container.querySelectorAll<HTMLElement>(".window-drag-exclusion--dynamic");
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]?.style.left).toBe("12px");
    expect(exclusions[0]?.style.width).toBe("268px");
  });
});
