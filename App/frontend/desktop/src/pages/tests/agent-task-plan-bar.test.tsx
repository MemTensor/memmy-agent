// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTaskPlanState } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentTaskPlanBar } from "../agent-task-plan-bar.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function plan(overrides: Partial<AgentTaskPlanState> = {}): AgentTaskPlanState {
  return {
    plan_id: "32f2868d-ae25-4f47-b33b-17f474eecc3a",
    title: "Generate literature review",
    status: "active",
    items: [
      { id: "evidence", content: "Map evidence", status: "completed" },
      { id: "sections", content: "Generate sections", status: "in_progress" },
      { id: "render", content: "Render and verify outputs", status: "pending" },
    ],
    created_at: "2026-09-14T06:00:00.000Z",
    updated_at: "2026-09-14T06:05:00.000Z",
    ...overrides,
  };
}

describe("AgentTaskPlanBar", () => {
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

  function render(value: AgentTaskPlanState): void {
    act(() => root.render(
      <I18nProvider language="en-US">
        <AgentTaskPlanBar plan={value} />
      </I18nProvider>
    ));
  }

  it("renders ordered progress and supports collapsing the fixed panel", () => {
    render(plan());
    const header = container.querySelector<HTMLButtonElement>(
      ".agent-task-plan-bar__header",
    )!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Generate literature review");
    expect(container.textContent).toContain("1/3");
    expect([...container.querySelectorAll(".agent-task-plan-bar__item")]
      .map((item) => item.textContent)).toEqual([
        "Map evidence",
        "Generate sections",
        "Render and verify outputs",
      ]);

    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".agent-task-plan-bar__items")).toBeNull();
  });

  it("starts a completed plan collapsed while preserving its summary", () => {
    render(plan({
      status: "completed",
      items: [
        { id: "evidence", content: "Map evidence", status: "completed" },
        { id: "sections", content: "Generate sections", status: "completed" },
      ],
    }));
    expect(container.querySelector(".agent-task-plan-bar__header")
      ?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("2/2");
  });

  it("does not render an empty task plan snapshot", () => {
    render(plan({
      plan_id: null,
      title: "",
      status: null,
      items: [],
      created_at: null,
      updated_at: null,
    }));
    expect(container.querySelector(".agent-task-plan-bar")).toBeNull();
  });
});
