// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebuiSessionTarget } from "../../api/memmy-agent-client.js";
import { AppProviders } from "../../app/providers.js";
import { ProjectTargetPicker } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projects = [
  { id: "one", name: "memmy-agent", rootPath: "C:\\work\\memmy-agent", pinned: false, createdAt: "2026-01-01" },
  { id: "two", name: "Playground", rootPath: "D:\\code\\sandbox", pinned: false, createdAt: "2026-01-02" }
];
const scrollIntoView = vi.fn();

describe("ProjectTargetPicker interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    scrollIntoView.mockReset();
    document.body.replaceChildren();
  });

  it("shows the project name in the trigger and list instead of the folder path", () => {
    renderPicker(root, { initialTarget: { kind: "project", projectId: "two" } });

    expect(getTrigger().textContent).toContain("Playground");
    expect(getTrigger().textContent).not.toContain("sandbox");
    act(() => getTrigger().click());
    const option = document.querySelector('[data-project-id="two"]');
    expect(option?.querySelector(".home-project-picker__name")?.textContent).toBe("Playground");
    expect(option?.textContent).not.toContain("sandbox");
    expect(option?.getAttribute("title")).toContain("sandbox");
  });

  it("filters by path and keeps new-project available to the keyboard", () => {
    const onCreateProject = vi.fn();
    renderPicker(root, { initialTarget: { kind: "standalone" }, onCreateProject });

    act(() => getTrigger().click());
    const search = getSearch();
    expect(document.activeElement).toBe(search);
    setInputValue(search, "sandbox");

    expect(document.querySelector('[data-project-id="one"]')).toBeNull();
    expect(document.querySelector('[data-project-id="two"]')?.classList.contains("home-project-picker__option--keyboard-active")).toBe(false);
    scrollIntoView.mockClear();
    pressKey(search, "ArrowDown");
    expect(document.getElementById("home-project-picker-option-1")?.classList.contains("home-project-picker__option--keyboard-active")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    pressKey(search, "Enter");

    expect(onCreateProject).toHaveBeenCalledOnce();
    expect(document.querySelector(".home-project-picker__menu")).not.toBeNull();
  });

  it("does not cancel the pointer press on New project", () => {
    const onCreateProject = vi.fn();
    renderPicker(root, { initialTarget: { kind: "standalone" }, onCreateProject });

    act(() => getTrigger().click());
    const button = getNewProjectButton();
    expect(button).not.toBeNull();
    const pointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      button!.dispatchEvent(pointerDown);
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(onCreateProject).toHaveBeenCalledOnce();
  });

  it("hides standalone when no project is selected", () => {
    renderPicker(root, { initialTarget: { kind: "standalone" } });

    act(() => getTrigger().click());

    expect(getStandaloneButton()).toBeNull();
  });

  it("clamps ArrowUp and ArrowDown while exposing the active option", () => {
    renderPicker(root, { initialTarget: { kind: "standalone" } });

    act(() => getTrigger().click());
    const search = getSearch();
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-0");
    expect(document.getElementById("home-project-picker-option-0")?.classList.contains("home-project-picker__option--keyboard-active")).toBe(false);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).every((option) => option.tabIndex === -1)).toBe(true);

    pressKey(search, "ArrowUp");
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-0");
    expect(document.getElementById("home-project-picker-option-0")?.classList.contains("home-project-picker__option--keyboard-active")).toBe(true);
    pressKey(search, "ArrowDown");
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-1");
    pressKey(search, "ArrowDown");
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-2");
    pressKey(search, "ArrowDown");
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-2");
    pressKey(search, "ArrowDown");
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-2");
    pressKey(search, "ArrowUp");
    expect(search.getAttribute("aria-activedescendant")).toBe("home-project-picker-option-1");
  });

  it("ignores composing Enter and dismisses on Tab without changing the target", () => {
    renderPicker(root, { initialTarget: { kind: "standalone" } });

    act(() => getTrigger().click());
    const search = getSearch();
    act(() => search.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true
    })));
    expect(document.querySelector(".home-project-picker__menu")).not.toBeNull();
    expect(document.querySelector('[data-testid="picker-target"]')?.textContent).toBe("standalone");

    pressKey(search, "Tab");
    expect(document.querySelector(".home-project-picker__menu")).toBeNull();
    expect(document.querySelector('[data-testid="picker-target"]')?.textContent).toBe("standalone");
  });

  it("selects standalone from the keyboard and closes", () => {
    renderPicker(root, { initialTarget: { kind: "project", projectId: "one" } });

    expect(getTrigger().textContent).toContain("memmy-agent");
    expect(getTrigger().textContent).not.toContain("C:\\work\\memmy-agent");
    act(() => getTrigger().click());
    expect(document.querySelector('[data-project-id="one"]')?.getAttribute("aria-selected")).toBe("true");
    expect(getStandaloneButton()).not.toBeNull();

    const search = getSearch();
    for (let index = 0; index < 4; index += 1) pressKey(search, "ArrowDown");
    pressKey(search, "Enter");

    expect(document.querySelector('[data-testid="picker-target"]')?.textContent).toBe("standalone");
    expect(document.querySelector(".home-project-picker__menu")).toBeNull();
  });

  it("closes on Escape and outside pointerdown without changing the target", () => {
    renderPicker(root, { initialTarget: { kind: "project", projectId: "one" } });

    act(() => getTrigger().click());
    act(() => getSearch().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".home-project-picker__menu")).toBeNull();
    expect(document.activeElement).toBe(getTrigger());

    act(() => getTrigger().click());
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));

    expect(document.querySelector(".home-project-picker__menu")).toBeNull();
    expect(document.querySelector('[data-testid="picker-target"]')?.textContent).toBe("project:one");
  });

  it("keeps standalone recovery when the project registry is corrupt", () => {
    renderPicker(root, {
      initialTarget: { kind: "project", projectId: "one" },
      registryState: "corrupt"
    });

    act(() => getTrigger().click());

    expect(document.querySelector("[data-project-id]")).toBeNull();
    expect(getNewProjectButton()).toBeNull();
    expect(getStandaloneButton()).not.toBeNull();
    pressKey(getSearch(), "Enter");
    expect(document.querySelector('[data-testid="picker-target"]')?.textContent).toBe("standalone");
  });
});

function renderPicker(
  root: Root,
  options: {
    initialTarget: WebuiSessionTarget;
    onCreateProject?: () => void;
    registryState?: "ready" | "corrupt";
  }
) {
  act(() => {
    root.render(
      <AppProviders>
        <PickerHarness {...options} />
      </AppProviders>
    );
  });
}

function PickerHarness(props: {
  initialTarget: WebuiSessionTarget;
  onCreateProject?: () => void;
  registryState?: "ready" | "corrupt";
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(props.initialTarget);
  const selectedProject = target.kind === "project"
    ? projects.find((project) => project.id === target.projectId) ?? null
    : null;

  return (
    <>
      <ProjectTargetPicker
        open={open}
        target={target}
        selectedProject={selectedProject}
        projects={projects}
        registryState={props.registryState ?? "ready"}
        disabled={false}
        onToggle={() => setOpen((current) => !current)}
        onClose={() => setOpen(false)}
        onSelect={(nextTarget) => {
          setTarget(nextTarget);
          setOpen(false);
        }}
        onCreateProject={() => props.onCreateProject?.()}
      />
      <output data-testid="picker-target">
        {target.kind === "project" ? `project:${target.projectId}` : "standalone"}
      </output>
    </>
  );
}

function getTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(".home-project-picker__trigger");
  if (!trigger) throw new Error("Missing project picker trigger");
  return trigger;
}

function getSearch(): HTMLInputElement {
  const search = document.querySelector<HTMLInputElement>(".home-project-picker__search input");
  if (!search) throw new Error("Missing project picker search");
  return search;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(input: HTMLInputElement, key: string) {
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

function getNewProjectButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    ".home-project-picker__actions [role='option']:has(.home-project-picker__action-icon)"
  );
}

function getStandaloneButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".home-project-picker__actions [role='option']"))
    .find((button) => button.querySelector(".lucide-x")) ?? null;
}
