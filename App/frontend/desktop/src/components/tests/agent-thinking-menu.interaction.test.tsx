// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentModelSelector } from "../agent-model-selector.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    modelConfig: null,
    agent: {
      committedModelSelectionByScope: {},
      pendingPresetByScope: {},
      thinkingStateByScope: {}
    }
  }
}));

vi.mock("../../state/app-state.js", () => ({ useAppState: () => mocks }));
vi.mock("../../i18n/use-translation.js", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "home.modelSelector.label": "会话模型",
        "home.modelSelector.byokGroup": "自定义模型",
        "home.thinking.label": "思考模式",
        "home.thinking.levelHeader": "思考强度",
        "home.thinking.levelValue.low": "低",
        "home.thinking.levelValue.medium": "中",
        "home.thinking.levelValue.high": "高"
      };
      return labels[key] ?? key;
    }
  })
}));
vi.mock("../../state/model-workspace.js", () => ({
  createModelWorkspace: () => ({}),
  getTaskModelCandidates: () => [
    { id: "openai-1", source: "byok", provider: "openai", model: "local-review-model" },
    { id: "custom-1", source: "byok", provider: "custom", model: "local-review-model" }
  ],
  resolveModelSelection: () => ({
    candidateId: "custom-1",
    candidate: { id: "custom-1", source: "byok", provider: "custom", model: "local-review-model" }
  }),
  resolveThinkingConfigForModel: () => ({
    switchable: true,
    defaultEnabled: true,
    levels: ["low", "medium", "high"],
    defaultLevel: "medium"
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentModelSelector thinking popover", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.dispatch.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows thinking settings beside the selected model row only after that row is hovered", () => {
    act(() => root.render(
      <AgentModelSelector mode="byok" scopeKey="draft-new-task" disabled={false} />
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(container.querySelector(".select-control__aside")).toBeNull();

    act(() => trigger?.click());
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelector(".select-control__aside")).toBeNull();

    const options = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
    act(() => options[0]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector(".select-control__aside")).toBeNull();

    act(() => options[1]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector(".select-control__aside")).not.toBeNull();
    expect(container.querySelectorAll(".thinking-level-option")).toHaveLength(3);

    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click());
    expect(mocks.dispatch).toHaveBeenLastCalledWith({
      type: "agent/thinkingToggled", scopeKey: "draft-new-task", enabled: false
    });

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelector(".select-control__aside")).not.toBeNull();

    act(() => trigger?.click());
    expect(container.querySelector(".select-control__aside")).toBeNull();
  });
});
