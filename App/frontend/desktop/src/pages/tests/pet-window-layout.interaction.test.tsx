// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { Task, TaskBusValue } from "../../lib/task-bus.js";
import { PetPageView, PET_TRANSPARENT_ROOT_CLASS } from "../pet-page.js";

vi.mock("../../components/mascot/pet-idle/pet-idle-animation.js", () => ({
  PetIdleAnimation: () => <canvas aria-hidden="true" />
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PetPageView native window layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  let syncPetWindowLayout: ReturnType<typeof vi.fn>;
  let readRect: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Hidden renderers may defer every animation frame until their window is shown.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    syncPetWindowLayout = vi.fn(() => {
      expect(document.documentElement.classList.contains(PET_TRANSPARENT_ROOT_CLASS)).toBe(true);
      expect(document.body.classList.contains(PET_TRANSPARENT_ROOT_CLASS)).toBe(true);
    });
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { syncPetWindowLayout }
    });
    readRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const petRoot = this.closest<HTMLElement>("[data-pet-root]");
      if (!petRoot) return new DOMRect();
      const x = Number.parseFloat(petRoot.style.left) || 0;
      const y = Number.parseFloat(petRoot.style.top) || 0;
      if (this.classList.contains("bottom-full")) {
        // A 260 px bubble centered above the 120 px mascot, with an 8 px gap.
        return new DOMRect(x - 70, y - 96, 260, 88);
      }
      return new DOMRect(x, y, 120, 120);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    delete window.memmy;
    vi.restoreAllMocks();
  });

  function renderPet(bus: TaskBusValue, strict = false) {
    act(() => {
      const pet = (
        <I18nProvider language="zh-CN">
          <PetPageView bus={bus} onNavigate={vi.fn()} />
        </I18nProvider>
      );
      root.render(strict ? <StrictMode>{pet}</StrictMode> : pet);
    });
  }

  it("reports a usable initial layout and settles its offset without an animation frame", () => {
    renderPet(createBus());

    expect(syncPetWindowLayout).toHaveBeenCalledExactlyOnceWith({
      width: 168,
      height: 168,
      mascotOffsetX: 24,
      mascotOffsetY: 24
    });
    const petRoot = container.querySelector<HTMLElement>("[data-pet-root]");
    expect(petRoot?.style.left).toBe("24px");
    expect(petRoot?.style.top).toBe("24px");
    // Measure the committed offset again, without emitting an identical native layout.
    expect(readRect).toHaveBeenCalledTimes(4);
  });

  it("reports changed bubble bounds and settles again while animation frames stay deferred", () => {
    renderPet(createBus());
    const processingTask: Task = {
      id: "task-processing",
      sessionId: "session-processing",
      title: "运行中的任务",
      status: "processing",
      startedAt: 1,
      updatedAt: 1,
      lastUserMessage: "运行中的任务",
      source: "pet"
    };
    renderPet(createBus(processingTask));

    expect(syncPetWindowLayout).toHaveBeenCalledTimes(2);
    expect(syncPetWindowLayout).toHaveBeenLastCalledWith({
      width: 308,
      height: 264,
      mascotOffsetX: 94,
      mascotOffsetY: 120
    });
    const petRoot = container.querySelector<HTMLElement>("[data-pet-root]");
    expect(petRoot?.style.left).toBe("94px");
    expect(petRoot?.style.top).toBe("120px");
  });

  it("settles and deduplicates the initial layout during StrictMode effect replay", () => {
    renderPet(createBus(), true);

    expect(syncPetWindowLayout).toHaveBeenCalledExactlyOnceWith({
      width: 168,
      height: 168,
      mascotOffsetX: 24,
      mascotOffsetY: 24
    });
    const petRoot = container.querySelector<HTMLElement>("[data-pet-root]");
    expect(petRoot?.style.left).toBe("24px");
    expect(petRoot?.style.top).toBe("24px");
  });
});

function createBus(focusedTask: Task | null = null): TaskBusValue {
  const tasks = focusedTask ? [focusedTask] : [];
  return {
    tasks,
    focusedTaskId: focusedTask?.id ?? null,
    focusedTask,
    runningTasks: tasks,
    lastFinishedTask: null,
    pendingNewSession: false,
    createTask: vi.fn(),
    appendChunk: vi.fn(),
    completeTask: vi.fn(),
    errorTask: vi.fn(),
    cancelTask: vi.fn(),
    bindTaskGoal: vi.fn(),
    focusTask: vi.fn(),
    startNewSession: vi.fn(),
    dismissTask: vi.fn(),
    markTaskRead: vi.fn(),
    removeTasksBySessionIds: vi.fn(),
    syncAgentConversation: vi.fn(),
    syncAgentTaskStatuses: vi.fn()
  };
}
