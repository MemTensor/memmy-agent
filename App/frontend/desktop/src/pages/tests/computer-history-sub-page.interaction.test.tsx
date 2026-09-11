// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComputerHistorySnapshot,
  MemmyAgentClient
} from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerHistorySubPage } from "../memory/computer-history-sub-page.js";

// The page reads its copy from the catalog, so it only renders inside a
// provider; these assertions read the zh-CN catalog the app defaults to.
function page(client: MemmyAgentClient) {
  return (
    <I18nProvider language="zh-CN">
      <ComputerHistorySubPage client={client} />
    </I18nProvider>
  );
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ComputerHistorySubPage", () => {
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

  const renderWith = async (initial: ComputerHistorySnapshot) => {
    const client = {
      getComputerHistory: vi.fn().mockResolvedValue(initial),
      deleteComputerHistory: vi.fn().mockResolvedValue(initial),
      startComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      pauseComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      resumeComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      stopComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      pinComputerHistory: vi.fn().mockResolvedValue(initial),
      getApplicationIcon: vi.fn().mockResolvedValue(null),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(page(client));
    });
  };

  it("keeps recording and read-only artifacts on the page, and requires two clicks to delete", async () => {
    const initial = snapshot();
    const afterDelete = snapshot({ histories: [], workflows: [] });
    const deleteComputerHistory = vi.fn().mockResolvedValue(afterDelete);
    const client = {
      getComputerHistory: vi.fn().mockResolvedValue(initial),
      deleteComputerHistory,
      startComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      pauseComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      resumeComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      stopComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      pinComputerHistory: vi.fn().mockResolvedValue(initial),
      getApplicationIcon: vi.fn().mockResolvedValue(null),
    } as unknown as MemmyAgentClient;

    await act(async () => {
      root.render(page(client));
    });

    expect(container.textContent).toContain("开始记录");
    // The timeline reads as a summary: each entry carries its own account.
    expect(container.textContent).toContain("You opened Notes and drafted a short entry.");
    expect(container.textContent).toContain("Workflow");
    expect(container.textContent).not.toContain("本次示范目标");
    expect(container.textContent).not.toContain("起始页面 URL");
    expect(container.textContent).not.toContain("运行 CUA 冒烟测试");
    // The account is the whole entry: the markdown body never reaches the page.
    expect(container.textContent).not.toContain("Recorded steps.");

    const deleteButton = container.querySelector<HTMLButtonElement>('[aria-label="删除 My recording"]');
    expect(deleteButton).not.toBeNull();
    act(() => deleteButton?.click());
    expect(deleteComputerHistory).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="确认删除 My recording"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="确认删除 My recording"]')?.click();
    });
    expect(deleteComputerHistory).toHaveBeenCalledWith("history-1");
    expect(container.textContent).toContain("还没有记录");
  });

  it("shows only what the model wrote, and names applications by their icon", async () => {
    await renderWith(snapshot());

    expect(container.textContent).toContain("My recording");
    expect(container.textContent).toContain("You opened Notes and drafted a short entry.");
    // The four frontmatter fields are the whole contract: neither the
    // frontmatter itself nor the markdown body belongs on the page.
    expect(container.textContent).not.toContain("capture_policy");
    expect(container.textContent).not.toContain("Recorded steps.");
    // An application is an icon, with the bundle id kept for the reader who
    // hovers or uses a screen reader.
    expect(container.querySelector('[aria-label="com.apple.Notes"]')).not.toBeNull();
  });

  it("keeps a current window at ten-minute resolution", async () => {
    const base = {
      applications: [] as string[],
      pinned: false,
      sourceType: "captured" as const,
      markdown: "## Memory summary\n\nbody",
      filePath: "/tmp/x.md",
    };
    // A rollup whose six hours have not elapsed is still being rewritten, so
    // the segments under it are the better account and it stays out of the way.
    const openWindow = new Date(Date.now() - 60 * 60_000);
    const segment = new Date(Date.now() - 30 * 60_000);
    await renderWith(snapshot({
      histories: [
        { ...base, id: "rollup", title: "A whole window", description: "Overview.", summaryWindow: "6h" as const, createdAt: openWindow.toISOString() },
        { ...base, id: "moment", title: "One moment", description: "Detail.", summaryWindow: "10min" as const, createdAt: segment.toISOString() },
      ],
    }));

    expect(container.textContent).toContain("今天");
    expect(container.textContent).toContain("One moment");
    expect(container.textContent).not.toContain("A whole window");
  });

  it("names each part of the day once", async () => {
    const base = {
      applications: [] as string[],
      pinned: false,
      sourceType: "captured" as const,
      markdown: "## Memory summary\n\nbody",
      filePath: "/tmp/x.md",
      summaryWindow: "6h" as const,
    };
    const day = new Date(Date.now() - 2 * 86_400_000);
    const at = (hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).toISOString();
    await renderWith(snapshot({
      histories: [
        { ...base, id: "evening", title: "Evening window", description: "d", createdAt: at(18) },
        { ...base, id: "afternoon", title: "Afternoon window", description: "d", createdAt: at(12) },
        { ...base, id: "morning", title: "Morning window", description: "d", createdAt: at(6) },
        { ...base, id: "night", title: "Night window", description: "d", createdAt: at(0) },
      ],
    }));

    // The window before six used to read as morning too, which is how a day
    // came to show two of them.
    const labels = [...container.querySelectorAll(".ch-entry__when")].map((node) => node.textContent);
    expect(labels).toEqual(["晚上", "下午", "上午", "凌晨"]);
  });

  it("lets a closed rollup stand in for the segments it covers", async () => {
    const base = {
      applications: [] as string[],
      pinned: false,
      sourceType: "captured" as const,
      markdown: "## Memory summary\n\nbody",
      filePath: "/tmp/x.md",
    };
    // Two days back, so the window is long closed.
    const windowStart = new Date(Date.now() - 2 * 86_400_000);
    const covered = new Date(windowStart.getTime() + 90 * 60_000);
    const outside = new Date(windowStart.getTime() + 7 * 60 * 60_000);
    await renderWith(snapshot({
      histories: [
        { ...base, id: "rollup", title: "That whole window", description: "Overview.", summaryWindow: "6h" as const, createdAt: windowStart.toISOString() },
        { ...base, id: "covered", title: "A covered minute", description: "Detail.", summaryWindow: "10min" as const, createdAt: covered.toISOString() },
        { ...base, id: "outside", title: "An uncovered minute", description: "Detail.", summaryWindow: "10min" as const, createdAt: outside.toISOString() },
      ],
    }));

    expect(container.textContent).toContain("That whole window");
    // Saying the same hours twice is what put a six-hour account in the middle
    // of the ten-minute ones it covers.
    expect(container.textContent).not.toContain("A covered minute");
    // A segment the rollup does not reach is not the rollup's to hide.
    expect(container.textContent).toContain("An uncovered minute");
  });
});

function snapshot(overrides: Partial<ComputerHistorySnapshot> = {}): ComputerHistorySnapshot {
  return {
    observation: { state: "stopped", startedAt: null, segmentId: null, segmentStartedAt: null, error: null, narrationError: null },
    cuaRun: { kind: null, status: "idle", startedAt: null, finishedAt: null, output: "", error: null },
    histories: [{
      id: "history-1",
      title: "My recording",
      description: "You opened Notes and drafted a short entry.",
      applications: ["com.apple.Notes"],
      summaryWindow: "10min",
      pinned: false,
      sourceType: "captured",
      createdAt: "2026-09-01T05:00:00.000Z",
      markdown: '---\ncapture_policy: accessibility_events\ntitle: "My recording"\n---\n\n## Memory summary\n\nRecorded steps.',
      filePath: "/tmp/history-1.md",
    }],
    workflows: [{
      id: "workflow-1",
      title: "My workflow",
      createdAt: "2026-09-01T05:01:00.000Z",
      markdown: "# Workflow\n\nGenerated in chat.",
      filePath: "/tmp/workflow-1.md",
      sourceHistoryId: "history-1",
    }],
    privacy: {
      screenshots: false,
      audio: false,
      rawRetentionHours: 48,
      markdownDirectory: "/tmp/histories",
    },
    ...overrides,
  };
}
