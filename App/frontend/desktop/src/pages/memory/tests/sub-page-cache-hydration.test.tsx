/** Sub page cache hydration tests. */
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../../app/providers.js";
import { AnalyticsSubPage } from "../analytics-sub-page.js";
import { LogsSubPage } from "../logs-sub-page.js";
import { MemoriesSubPage } from "../memories-sub-page.js";
import { OverviewSubPage } from "../overview-sub-page.js";
import { PoliciesSubPage } from "../policies-sub-page.js";
import { SkillsSubPage } from "../skills-sub-page.js";
import { TasksSubPage } from "../tasks-sub-page.js";
import { WorldModelSubPage } from "../world-model-sub-page.js";

describe("memory sub page cache hydration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["overview", () => <OverviewSubPage client={null} />],
    ["memories", () => <MemoriesSubPage client={null} />],
    ["tasks", () => <TasksSubPage client={null} />],
    ["policies", () => <PoliciesSubPage client={null} />],
    ["world-model", () => <WorldModelSubPage client={null} />],
    ["skills", () => <SkillsSubPage client={null} />],
    ["analytics", () => <AnalyticsSubPage client={null} />],
    ["logs", () => <LogsSubPage client={null} />]
  ] as Array<[string, () => ReactElement]>)("does not read sessionStorage during %s first render", (_name, renderSubPage) => {
    const sessionStorage = new CountingStorage();
    vi.stubGlobal("window", { sessionStorage });

    renderToString(<AppProviders>{renderSubPage()}</AppProviders>);

    expect(sessionStorage.getItemCalls).toBe(0);
  });
});

class CountingStorage implements Storage {
  readonly values = new Map<string, string>();
  getItemCalls = 0;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    this.getItemCalls += 1;
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
