// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComputerHistorySnapshot,
  MemmyAgentClient
} from "../../api/memmy-agent-client.js";
import { ComputerHistorySubPage } from "../memory/computer-history-sub-page.js";

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
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<ComputerHistorySubPage client={client} />);
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
    } as unknown as MemmyAgentClient;

    await act(async () => {
      root.render(<ComputerHistorySubPage client={client} />);
    });

    expect(container.textContent).toContain("Computer History：已停止");
    // The timeline reads as a summary: each entry carries its own account.
    expect(container.textContent).toContain("You opened Notes and drafted a short entry.");
    expect(container.textContent).toContain("Workflow");
    expect(container.textContent).toContain("具体执行统一在聊天框中触发");
    expect(container.textContent).not.toContain("本次示范目标");
    expect(container.textContent).not.toContain("起始页面 URL");
    expect(container.textContent).not.toContain("注入“微信里妈妈的 iPhone”");
    expect(container.textContent).not.toContain("运行 CUA 冒烟测试");

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    const deleteButton = container.querySelector<HTMLButtonElement>('[aria-label="删除 My recording"]');
    expect(deleteButton).not.toBeNull();
    act(() => deleteButton?.click());
    expect(deleteComputerHistory).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="确认删除 My recording"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="确认删除 My recording"]')?.click();
    });
    expect(deleteComputerHistory).toHaveBeenCalledWith("history-1");
    expect(container.textContent).toContain("还没有 History");
  });

  it("renders a history as a summary instead of raw markdown", async () => {
    await renderWith(snapshot());

    expect(container.textContent).toContain("My recording");
    expect(container.textContent).toContain("com.apple.Notes");
    expect(container.textContent).toContain("Recorded steps.");
    // Frontmatter is presentation metadata, not something to show the reader.
    expect(container.textContent).not.toContain("capture_policy");
  });

  it("groups entries by day and heads a day with its six-hour overview", async () => {
    const base = {
      applications: [] as string[],
      sourceType: "captured" as const,
      markdown: "## Memory summary\n\nbody",
      filePath: "/tmp/x.md",
    };
    await renderWith(snapshot({
      histories: [
        { ...base, id: "day-overview", title: "A whole day", description: "Overview.", summaryWindow: "6h" as const, createdAt: "2026-09-01T00:00:00.000Z" },
        { ...base, id: "moment", title: "One moment", description: "Detail.", summaryWindow: "10min" as const, createdAt: "2026-09-01T05:00:00.000Z" },
      ],
    }));

    expect(container.textContent).toContain("这一天");
    expect(container.textContent).toContain("A whole day");
    expect(container.textContent).toContain("One moment");
  });
});

function snapshot(overrides: Partial<ComputerHistorySnapshot> = {}): ComputerHistorySnapshot {
  return {
    observation: { state: "stopped", startedAt: null, segmentId: null, segmentStartedAt: null, error: null },
    cuaRun: { kind: null, status: "idle", startedAt: null, finishedAt: null, output: "", error: null },
    histories: [{
      id: "history-1",
      title: "My recording",
      description: "You opened Notes and drafted a short entry.",
      applications: ["com.apple.Notes"],
      summaryWindow: "10min",
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
