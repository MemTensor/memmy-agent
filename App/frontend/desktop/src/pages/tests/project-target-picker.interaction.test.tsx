// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebuiSessionTarget } from "../../api/memmy-agent-client.js";
import { AppProviders } from "../../app/providers.js";
import {
  ProjectTargetPicker,
  runProjectTargetFolderSelection,
  type RunProjectTargetFolderSelectionInput
} from "../home-page.js";

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
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
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

  it("filters by path and keeps new-project available to the keyboard", () => {
    const onChooseOther = vi.fn();
    renderPicker(root, { initialTarget: { kind: "standalone" }, onChooseOther });

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

    expect(onChooseOther).toHaveBeenCalledOnce();
    expect(document.querySelector(".home-project-picker__menu")).not.toBeNull();
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
    for (let index = 0; index < 3; index += 1) pressKey(search, "ArrowDown");
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

  it("keeps the picker open and usable when folder selection is canceled", async () => {
    const mutateProject = vi.fn();
    const onError = vi.fn();
    const onRefresh = vi.fn();
    renderPicker(root, {
      initialTarget: { kind: "standalone" },
      folderSelection: {
        selectDirectory: vi.fn(async () => ({ canceled: true as const })),
        mutateProject,
        onError,
        onRefresh
      }
    });

    act(() => getTrigger().click());
    await clickNewProject();

    expect(mutateProject).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expectPickerOpenAndDismissible();
  });

  it.each([
    ["rejected", vi.fn(async () => ({ status: "rejected" as const, code: "project_limit" }))],
    ["thrown", vi.fn(async () => { throw new Error("offline"); })]
  ])("keeps the picker open and usable when registration is %s", async (_label, mutateProject) => {
    const onError = vi.fn();
    const onRefresh = vi.fn();
    renderPicker(root, {
      initialTarget: { kind: "standalone" },
      folderSelection: {
        selectDirectory: vi.fn(async () => ({ canceled: false as const, path: "C:\\work\\new-project" })),
        mutateProject,
        onError,
        onRefresh
      }
    });

    act(() => getTrigger().click());
    await clickNewProject();

    expect(onError).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
    expectPickerOpenAndDismissible();
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

type FolderSelectionInput = Omit<RunProjectTargetFolderSelectionInput, "onCommitted">;

function renderPicker(
  root: Root,
  options: {
    initialTarget: WebuiSessionTarget;
    onChooseOther?: () => void;
    folderSelection?: FolderSelectionInput;
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
  onChooseOther?: () => void;
  folderSelection?: FolderSelectionInput;
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
        onChooseOther={() => {
          if (props.folderSelection) {
            void runProjectTargetFolderSelection({
              ...props.folderSelection,
              onCommitted: () => setOpen(false)
            });
            return;
          }
          props.onChooseOther?.();
        }}
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

async function clickNewProject() {
  const button = getNewProjectButton();
  if (!button) throw new Error("Missing New project button");
  await act(async () => {
    const pointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(pointerDown);
    if (!pointerDown.defaultPrevented) button.focus();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectPickerOpenAndDismissible() {
  expect(document.querySelector(".home-project-picker__menu")).not.toBeNull();
  expect(document.activeElement).toBe(getSearch());
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLInputElement)) throw new Error("Project search lost focus");
  pressKey(activeElement, "Escape");
  expect(document.querySelector(".home-project-picker__menu")).toBeNull();
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

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
