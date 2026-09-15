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
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "memmy");
    vi.useRealTimers();
  });

  const renderWith = async (initial: ComputerHistorySnapshot, overrides: Partial<MemmyAgentClient> = {}) => {
    const client = {
      getComputerHistory: vi.fn().mockResolvedValue(initial),
      deleteComputerHistory: vi.fn().mockResolvedValue(initial),
      clearComputerHistories: vi.fn().mockResolvedValue(initial),
      startComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      pauseComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      resumeComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      stopComputerHistoryObservation: vi.fn().mockResolvedValue(initial),
      pinComputerHistory: vi.fn().mockResolvedValue(initial),
      getApplicationIcon: vi.fn().mockResolvedValue(null),
      ...overrides,
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(page(client));
    });
    return client;
  };

  it("opens history directly without an introduction or automatic recording on a fresh installation", async () => {
    const client = await renderWith(snapshot());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('button.ch__info')?.getAttribute("aria-label")).toBe("了解更多");
    expect(client.getComputerHistory).toHaveBeenCalledOnce();
    expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();
  });

  it("explains recording on hover and click without opening the introduction or starting recording", async () => {
    const client = await renderWith(snapshot());
    const info = container.querySelector<HTMLButtonElement>('button.ch__info')!;
    const tooltip = () => document.querySelector('[role="tooltip"]');
    act(() => { info.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(tooltip()?.textContent).toBe("Memmy 会记录你电脑活动，并整理为文本摘要。你可以通过删除单条记录或清除历史记录来控制 Memmy 可以引用的内容。");
    expect(tooltip()?.getAttribute("aria-hidden")).toBe("false");
    act(() => { info.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    expect(tooltip()?.getAttribute("aria-hidden")).toBe("true");
    act(() => { info.click(); });
    act(() => { info.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    expect(tooltip()?.getAttribute("aria-hidden")).toBe("false");
    act(() => { info.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(tooltip()?.getAttribute("aria-hidden")).toBe("true");
    act(() => { info.click(); });
    act(() => { document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(tooltip()?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();
  });

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

    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
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

  it("opens an entry's complete Markdown file through the desktop bridge", async () => {
    const openComputerHistoryMarkdown = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { openComputerHistoryMarkdown },
    });
    await renderWith(snapshot());

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="打开 My recording 的完整 Markdown"]')?.click();
    });

    expect(openComputerHistoryMarkdown).toHaveBeenCalledWith("/tmp/history-1.md");
    expect(openComputerHistoryMarkdown).toHaveBeenCalledTimes(1);
  });

  it("shows a readable error when the desktop cannot open the Markdown file", async () => {
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { openComputerHistoryMarkdown: vi.fn().mockRejectedValue(new Error("no default editor")) },
    });
    await renderWith(snapshot());

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="打开 My recording 的完整 Markdown"]')?.click();
    });

    expect(container.textContent).toContain("打开 Markdown 失败：no default editor");
  });

  it("keeps a current window at ten-minute resolution", async () => {
    const base = {
      applications: [] as string[],
      coveredHistoryIds: [] as string[],
      eventStreamPath: null,
      pinned: false,
      sourceType: "captured" as const,
      markdown: "## Memory summary\n\nbody",
      filePath: "/tmp/x.md",
    };
    // A rollup whose six hours have not elapsed is still being rewritten, so
    // the segments under it are the better account and it stays out of the way.
    // Anchor the fixture at local noon so the assertion remains stable when
    // the suite runs around midnight in UTC or in the developer's timezone.
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const openWindow = new Date(now.getTime() - 60 * 60_000);
    const segment = new Date(now.getTime() - 30 * 60_000);
    await renderWith(snapshot({
      histories: [
        { ...base, id: "rollup", title: "A whole window", description: "Overview.", sourceType: "rollup", summaryWindow: "6h" as const, coveredHistoryIds: ["moment"], createdAt: openWindow.toISOString() },
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
      coveredHistoryIds: [] as string[],
      eventStreamPath: null,
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

  it("offers no keep on a six-hour summary, and no delete on the window being recorded", async () => {
    const base = {
      applications: [] as string[],
      coveredHistoryIds: [] as string[],
      eventStreamPath: null,
      pinned: false,
      sourceType: "captured" as const,
      markdown: "## Memory summary\n\nbody",
      filePath: "/tmp/x.md",
    };
    const past = new Date(Date.now() - 2 * 86_400_000);
    past.setHours(6, 0, 0, 0);
    const now = new Date();
    const segmentId = "2026-09-11T02-10-00Z";
    await renderWith(snapshot({
      observation: { state: "running", startedAt: now.toISOString(), segmentId, segmentStartedAt: now.toISOString(), error: null, narrationError: null },
      histories: [
        { ...base, id: `${segmentId}-10min-summary`, title: "Being recorded", description: "d", summaryWindow: "10min" as const, createdAt: now.toISOString() },
        { ...base, id: "rollup", title: "A morning", description: "d", summaryWindow: "6h" as const, createdAt: past.toISOString() },
      ],
    }));

    // A rollup owns no raw events: keeping it used to keep someone else's.
    expect(container.querySelector('[aria-label="保留 A morning"]')).toBeNull();
    expect(container.querySelector('[aria-label="保留 Being recorded"]')).not.toBeNull();
    // Deleting the open window removed the directory the recorder writes to.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="删除 Being recorded"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="删除 A morning"]')?.disabled).toBe(false);
  });

  it("lets a closed rollup stand in for the segments it covers", async () => {
    const base = {
      applications: [] as string[],
      coveredHistoryIds: [] as string[],
      eventStreamPath: null,
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
        { ...base, id: "rollup", title: "That whole window", description: "Overview.", sourceType: "rollup", summaryWindow: "6h" as const, coveredHistoryIds: ["covered"], createdAt: windowStart.toISOString() },
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

  it("keeps imports and late summaries that did not contribute to a closed rollup", async () => {
    const at = new Date(Date.now() - 2 * 86_400_000);
    const base = snapshot().histories[0]!;
    await renderWith(snapshot({ histories: [
      { ...base, id: "rollup", title: "Closed rollup", sourceType: "rollup", summaryWindow: "6h", createdAt: at.toISOString(), coveredHistoryIds: ["covered", "imported-ten-minute"] },
      ...[
        { id: "covered", title: "Included segment", sourceType: "captured" as const, summaryWindow: "10min" as const },
        { id: "late", title: "Late segment", sourceType: "captured" as const, summaryWindow: "10min" as const },
        { id: "imported", title: "Imported history", sourceType: "imported" as const, summaryWindow: null },
        { id: "fixture", title: "Demo history", sourceType: "demo_fixture" as const, summaryWindow: null },
        { id: "imported-ten-minute", title: "Imported segment", sourceType: "imported" as const, summaryWindow: "10min" as const },
      ].map((entry) => ({ ...base, ...entry, createdAt: new Date(at.getTime() + 60 * 60_000).toISOString() })),
      { ...base, id: "imported-six-hour", title: "Imported six-hour history", sourceType: "imported", summaryWindow: "6h", createdAt: new Date().toISOString() },
    ] }));

    expect(container.textContent).not.toContain("Included segment");
    for (const title of ["Late segment", "Imported history", "Demo history", "Imported segment", "Imported six-hour history"]) {
      expect(container.textContent).toContain(title);
    }
  });

  it("keeps segments alongside an old rollup without coverage metadata", async () => {
    const at = new Date(Date.now() - 2 * 86_400_000);
    const base = snapshot().histories[0]!;
    await renderWith(snapshot({ histories: [
      { ...base, id: "rollup", title: "Legacy rollup", sourceType: "rollup", summaryWindow: "6h", createdAt: at.toISOString(), coveredHistoryIds: [] },
      { ...base, title: "Segment remains", createdAt: new Date(at.getTime() + 60 * 60_000).toISOString() },
    ] }));
    expect(container.textContent).toContain("Legacy rollup");
    expect(container.textContent).toContain("Segment remains");
  });

  it("keeps a pinned covered segment visible until the user cancels its pin", async () => {
    const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const base = snapshot().histories[0]!;
    const rollup = { ...base, id: "rollup", title: "Closed rollup", sourceType: "rollup" as const, summaryWindow: "6h" as const, createdAt: at, coveredHistoryIds: [base.id] };
    const child = { ...base, pinned: true, createdAt: at };
    const unpinned = snapshot({ histories: [rollup, { ...child, pinned: false }] });
    const pinComputerHistory = vi.fn().mockResolvedValue(unpinned);
    await renderWith(snapshot({ histories: [rollup, child] }), { pinComputerHistory });

    expect(container.textContent).toContain("Closed rollup");
    const unpin = container.querySelector<HTMLButtonElement>('[aria-label="取消保留 My recording"]');
    expect(unpin).not.toBeNull();
    await act(async () => { unpin?.click(); });

    expect(pinComputerHistory).toHaveBeenCalledWith(base.id, false);
    expect(container.textContent).not.toContain("My recording");
    expect(container.textContent).toContain("Closed rollup");
  });

  it("rejects a poll issued before a successful clear even when it returns afterwards", async () => {
    vi.useFakeTimers();
    const initial = snapshot();
    const oldPoll = deferred<ComputerHistorySnapshot>();
    const getComputerHistory = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(oldPoll.promise);
    const clearComputerHistories = vi.fn().mockResolvedValue(snapshot({ histories: [], workflows: [] }));
    await renderWith(initial, { getComputerHistory, clearComputerHistories });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("清除历史"))?.click();
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "清除全部")?.click();
    });
    expect(container.textContent).not.toContain("My recording");

    await act(async () => { oldPoll.resolve(initial); });
    expect(clearComputerHistories).toHaveBeenCalledWith("all");
    expect(container.textContent).not.toContain("My recording");
  });

  it("rejects older polls after a newer snapshot and ignores their errors", async () => {
    vi.useFakeTimers();
    const first = deferred<ComputerHistorySnapshot>();
    const second = deferred<ComputerHistorySnapshot>();
    const third = deferred<ComputerHistorySnapshot>();
    const initial = snapshot();
    const getComputerHistory = vi.fn().mockResolvedValueOnce(initial)
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    await renderWith(initial, { getComputerHistory });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { third.resolve(snapshot({ histories: [], workflows: [] })); });
    await act(async () => { second.resolve(initial); first.reject(new Error("outdated poll failure")); });

    expect(container.textContent).not.toContain("My recording");
    expect(container.textContent).not.toContain("outdated poll failure");
  });

  it("applies successful polling responses even when each takes longer than the interval", async () => {
    vi.useFakeTimers();
    const initial = snapshot({ observation: { ...snapshot().observation, state: "running" } });
    let sequence = 0;
    const getComputerHistory = vi.fn().mockResolvedValueOnce(initial).mockImplementation(() => {
      const title = `Slow result ${++sequence}`;
      return new Promise<ComputerHistorySnapshot>((resolve) => {
        setTimeout(() => resolve({ ...initial, histories: [{ ...initial.histories[0]!, title }] }), 2000);
      });
    });
    await renderWith(initial, { getComputerHistory });

    await act(async () => { await vi.advanceTimersByTimeAsync(6500); });

    // At 6500ms three polls have completed and a fourth is still in flight.
    // The pending fourth request must not prevent the first three rendering.
    expect(getComputerHistory).toHaveBeenCalledTimes(5);
    expect(container.textContent).toContain("Slow result 3");
  });

  it("shows the initial snapshot even when another poll starts before it arrives", async () => {
    vi.useFakeTimers();
    const initial = deferred<ComputerHistorySnapshot>();
    const later = deferred<ComputerHistorySnapshot>();
    const getComputerHistory = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(later.promise);
    await renderWith(snapshot(), { getComputerHistory });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { initial.resolve(snapshot()); });

    expect(getComputerHistory).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("My recording");
  });

  it("does not clear a newer polling failure with an older successful response", async () => {
    vi.useFakeTimers();
    const older = deferred<ComputerHistorySnapshot>();
    const newer = deferred<ComputerHistorySnapshot>();
    const initial = snapshot({ histories: [] });
    const getComputerHistory = vi.fn().mockResolvedValueOnce(initial)
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await renderWith(initial, { getComputerHistory });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await act(async () => { newer.reject(new Error("current polling failure")); });
    await act(async () => { older.resolve(snapshot()); });

    expect(container.textContent).toContain("current polling failure");
    expect(container.textContent).not.toContain("My recording");
  });

  it("invalidates pending responses across client changes and unmounts", async () => {
    vi.useFakeTimers();
    const firstPoll = deferred<ComputerHistorySnapshot>();
    const firstAction = deferred<ComputerHistorySnapshot>();
    const first = await renderWith(snapshot(), {
      getComputerHistory: vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(firstPoll.promise),
      pinComputerHistory: vi.fn().mockReturnValueOnce(firstAction.promise),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    act(() => { container.querySelector<HTMLButtonElement>('[aria-label="保留 My recording"]')?.click(); });

    const current = snapshot({ histories: [], workflows: [] });
    const next = await renderWith(current);
    await act(async () => { firstAction.resolve(snapshot()); firstPoll.reject(new Error("old client failure")); });
    expect(first.pinComputerHistory).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("My recording");
    expect(container.textContent).not.toContain("old client failure");

    const unmountedPoll = deferred<ComputerHistorySnapshot>();
    vi.mocked(next.getComputerHistory).mockReturnValueOnce(unmountedPoll.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { root.render(null); });
    await act(async () => { unmountedPoll.resolve(snapshot()); });
    await renderWith(current);
    expect(container.textContent).not.toContain("My recording");
  });

  it("waits for a pending stop before polling its resulting state", async () => {
    vi.useFakeTimers();
    const initial = snapshot({ observation: { ...snapshot().observation, state: "running" } });
    const stop = deferred<ComputerHistorySnapshot>();
    const getComputerHistory = vi.fn().mockResolvedValue(initial);
    await renderWith(initial, { getComputerHistory, stopComputerHistoryObservation: vi.fn().mockReturnValue(stop.promise) });

    const recordingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("true");
    act(() => { recordingSwitch?.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(recordingSwitch?.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(getComputerHistory).toHaveBeenCalledTimes(1);
    await act(async () => { stop.resolve(snapshot()); });
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(recordingSwitch?.disabled).toBe(false);
    getComputerHistory.mockResolvedValue(snapshot());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getComputerHistory).toHaveBeenCalledTimes(2);
  });

  it("waits for the recorder to start before turning the switch on and prevents duplicate starts", async () => {
    const start = deferred<ComputerHistorySnapshot>();
    const startComputerHistoryObservation = vi.fn().mockReturnValue(start.promise);
    await renderWith(snapshot(), { startComputerHistoryObservation });
    const recordingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");

    act(() => { recordingSwitch?.click(); });
    expect(startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("开启电脑历史记录？");
    expect(dialog?.textContent).toContain("大模型");
    expect(dialog?.textContent).toContain("本机");
    expect(dialog?.querySelector(".ch-recording-confirmation__details")?.textContent).toBe("开启后，你在电脑上的所有操作，会被记录并发送给已配置的大模型进行分析，使用记录保存在本机。");

    act(() => { confirmationButton()?.click(); });
    expect(recordingSwitch?.disabled).toBe(true);
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    act(() => { recordingSwitch?.click(); });
    expect(startComputerHistoryObservation).toHaveBeenCalledTimes(1);

    await act(async () => {
      start.resolve(snapshot({ observation: { ...snapshot().observation, state: "running" } }));
    });
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(recordingSwitch?.disabled).toBe(false);
  });

  it.each(["cancel", "escape"] as const)("does not start recording when the confirmation is dismissed with %s", async (dismiss) => {
    const client = await renderWith(snapshot());
    const recordingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    act(() => { recordingSwitch?.click(); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();

    act(() => {
      if (dismiss === "cancel") {
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
          .find((button) => button.textContent === "取消")?.click();
      } else {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(recordingSwitch?.disabled).toBe(false);
    expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(client.resumeComputerHistoryObservation).not.toHaveBeenCalled();
    expect(client.stopComputerHistoryObservation).not.toHaveBeenCalled();
  });

  it("keeps the switch off after a failed start and lets the user retry", async () => {
    const start = deferred<ComputerHistorySnapshot>();
    const startComputerHistoryObservation = vi.fn().mockReturnValueOnce(start.promise)
      .mockResolvedValue(snapshot({ observation: { ...snapshot().observation, state: "running" } }));
    await renderWith(snapshot(), { startComputerHistoryObservation });
    const recordingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    act(() => { recordingSwitch?.click(); });
    expect(startComputerHistoryObservation).not.toHaveBeenCalled();
    act(() => { confirmationButton()?.click(); });
    expect(recordingSwitch?.disabled).toBe(true);

    await act(async () => { start.reject(new Error("recorder could not start")); });
    expect(container.textContent).toContain("recorder could not start");
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(recordingSwitch?.disabled).toBe(false);

    await act(async () => { recordingSwitch?.click(); });
    expect(startComputerHistoryObservation).toHaveBeenCalledTimes(1);
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { confirmationButton()?.click(); });
    expect(startComputerHistoryObservation).toHaveBeenCalledTimes(2);
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("recorder could not start");
  });

  it.each(["resume", "stop"] as const)("can %s a paused recording without starting a new session", async (action) => {
    const initial = snapshot({ observation: { ...snapshot().observation, state: "paused" } });
    const resumed = snapshot({ observation: { ...initial.observation, state: "running" } });
    const client = await renderWith(initial, {
      resumeComputerHistoryObservation: vi.fn().mockResolvedValue(resumed),
      stopComputerHistoryObservation: vi.fn().mockResolvedValue(snapshot()),
    });
    const recordingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    const resume = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "恢复记录");
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(resume).toBeDefined();

    await act(async () => { (action === "resume" ? resume : recordingSwitch)?.click(); });
    if (action === "resume") {
      expect(client.resumeComputerHistoryObservation).not.toHaveBeenCalled();
      expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => { confirmationButton()?.click(); });
    } else {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }

    expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(client.resumeComputerHistoryObservation).toHaveBeenCalledTimes(action === "resume" ? 1 : 0);
    expect(client.stopComputerHistoryObservation).toHaveBeenCalledTimes(action === "stop" ? 1 : 0);
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe(action === "resume" ? "true" : "false");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "恢复记录")).toBe(false);
  });

  it("keeps a paused recording paused when its resume confirmation is cancelled", async () => {
    const initial = snapshot({ observation: { ...snapshot().observation, state: "paused" } });
    const client = await renderWith(initial);
    const resume = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "恢复记录");
    act(() => { resume?.click(); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(client.resumeComputerHistoryObservation).not.toHaveBeenCalled();

    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === "取消")?.click();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "恢复记录")).toBe(true);
    expect(client.resumeComputerHistoryObservation).not.toHaveBeenCalled();
    expect(client.startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(client.stopComputerHistoryObservation).not.toHaveBeenCalled();
  });

  it("shows asynchronous recording and narration failures until the backend recovers", async () => {
    vi.useFakeTimers();
    const initial = snapshot({ observation: { ...snapshot().observation, state: "failed", error: "recorder exited", narrationError: "model unavailable" } });
    const getComputerHistory = vi.fn().mockResolvedValue(initial);
    await renderWith(initial, { getComputerHistory });
    expect(container.textContent).toContain("记录失败：recorder exited");
    expect(container.textContent).toContain("摘要生成失败：model unavailable");
    const recordingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(recordingSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(recordingSwitch?.disabled).toBe(false);

    getComputerHistory.mockResolvedValue(snapshot());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).not.toContain("recorder exited");
    expect(container.textContent).not.toContain("model unavailable");
  });

  it("does not erase an action failure when the next snapshot refresh succeeds", async () => {
    vi.useFakeTimers();
    const initial = snapshot();
    const client = await renderWith(initial, { pinComputerHistory: vi.fn().mockRejectedValue(new Error("cannot keep raw events")) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="保留 My recording"]')?.click(); });
    expect(container.textContent).toContain("cannot keep raw events");

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(client.getComputerHistory).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("cannot keep raw events");

    vi.mocked(client.pinComputerHistory).mockResolvedValue(initial);
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="保留 My recording"]')?.click(); });
    expect(container.textContent).not.toContain("cannot keep raw events");
  });

  it.each([ ["today", "清除今天"], ["all", "清除全部"] ] as const)("clears %s through the service even when pending summaries are absent from the feed", async (scope, label) => {
    const client = await renderWith(snapshot({ histories: [], workflows: [] }));
    const clear = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("清除历史"));
    expect(clear?.disabled).toBe(false);
    act(() => clear?.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label)?.click();
    });
    expect(client.clearComputerHistories).toHaveBeenCalledWith(scope);
    expect(client.deleteComputerHistory).not.toHaveBeenCalled();
  });
});

function confirmationButton() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent === "确认开启");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(overrides: Partial<ComputerHistorySnapshot> = {}): ComputerHistorySnapshot {
  return {
    observation: { state: "stopped", startedAt: null, segmentId: null, segmentStartedAt: null, error: null, narrationError: null },
    histories: [{
      id: "history-1",
      title: "My recording",
      description: "You opened Notes and drafted a short entry.",
      applications: ["com.apple.Notes"],
      summaryWindow: "10min",
      coveredHistoryIds: [],
      pinned: false,
      eventStreamPath: null,
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
      eventStreamDirectory: "/tmp/recordings/segments",
    },
    ...overrides,
  };
}
