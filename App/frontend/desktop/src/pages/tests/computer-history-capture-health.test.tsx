// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerHistoryCaptureHealthSchema, ComputerHistorySnapshotSchema,
  type ComputerHistoryCaptureHealth } from "../../api/computer-history-contract.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { zhCNMessages, enUSMessages } from "../../i18n/messages.js";
import { ComputerHistorySubPage } from "../memory/computer-history-sub-page.js";
import type { ComputerHistorySnapshot, MemmyAgentClient } from "../../api/memmy-agent-client.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let originalMemmyDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  originalMemmyDescriptor = Object.getOwnPropertyDescriptor(window, "memmy");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); document.body.replaceChildren();
  if (originalMemmyDescriptor) Object.defineProperty(window, "memmy", originalMemmyDescriptor);
  else delete window.memmy;
});
const health = (input: Partial<ComputerHistoryCaptureHealth> = {}): ComputerHistoryCaptureHealth => ({
  status: "healthy", lastEventAt: null, lastHeartbeatAt: "2026-10-09T10:49:00Z", issues: [],
  limitations: ["foreground_accessibility_only", "screenshots_and_audio_not_recorded"],
  ...input,
});
describe("Computer History capture coverage", () => {
  it("keeps the snapshot backward compatible and validates the new content-free health shape", () => {
    const snapshot = {
      observation: { state: "running", startedAt: null, segmentId: null, segmentStartedAt: null, error: null, narrationError: null },
      histories: [], workflows: [], privacy: { screenshots: false, audio: false, rawRetentionHours: 48,
        markdownDirectory: "/synthetic/history", eventStreamDirectory: "/synthetic/events" },
    };
    expect(ComputerHistorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(ComputerHistorySnapshotSchema.safeParse({ ...snapshot, observation: {
      ...snapshot.observation, captureHealth: health(),
    } }).success).toBe(true);
    expect(ComputerHistoryCaptureHealthSchema.safeParse({ ...health(), app: "Private app" }).success).toBe(false);
    expect(ComputerHistoryCaptureHealthSchema.safeParse(health({ issues: [{ code: "enrichment_backlog", count: -1 }] })).success).toBe(false);
  });

  it.each([
    { platform: "darwin", status: "degraded" },
    { platform: "darwin", status: "reconnecting" },
    { platform: "win32", status: "degraded" },
    { platform: "win32", status: "reconnecting" },
  ] as const)("keeps collecting status and pending summaries on $platform while capture is $status", async ({ platform, status }) => {
    Object.defineProperty(window, "memmy", { configurable: true, value: { platform } });
    const snapshot: ComputerHistorySnapshot = {
      observation: { state: "running", startedAt: "2026-10-09T10:49:00Z", segmentId: "2026-10-09T10-50-00Z",
        segmentStartedAt: "2026-10-09T10:50:00Z", error: null, narrationError: null,
        captureHealth: health({ status, issues: [{ code: "ax_snapshot_budget_exceeded", count: 1 }] }) },
      histories: [{ id: "2026-10-09T10-50-00Z-10min-summary", title: "Recent activity", description: null,
        applications: [], summaryWindow: "10min", summaryStatus: "pending", coveredHistoryIds: [],
        sourceType: "captured", pinned: false, eventStreamPath: "/synthetic/events/events.jsonl",
        filePath: "/synthetic/history/current.md", createdAt: "2026-10-09T10:50:00Z" }],
      workflows: [], privacy: { screenshots: false, audio: false, rawRetentionHours: 48,
        markdownDirectory: "/synthetic/history", eventStreamDirectory: "/synthetic/events" },
    };
    expect(ComputerHistorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    const client = { getComputerHistory: async () => snapshot, getComputerHistorySettings: async () => ({
      observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [] },
    }) } as unknown as MemmyAgentClient;
    await act(async () => root.render(<I18nProvider language="zh-CN"><ComputerHistorySubPage client={client} /></I18nProvider>));
    expect(document.querySelector(".ch__recording-status")?.textContent).toBe("采集中");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("采集受限");
    expect(document.body.textContent).not.toContain("正在重连");
    expect(document.querySelector(".ch__capture-health")).toBeNull();
    expect(document.body.textContent).not.toContain("ax_snapshot_budget_exceeded");
    expect(document.body.textContent).not.toContain("部分活动可能未记录");
    expect(document.body.textContent).not.toContain("本次采集尚无已写入的活动记录");
    expect(document.querySelector(".ch-entry__body")?.textContent).toContain("原始活动已保存，摘要正在整理或更新");
  });

  it("limits the enable notice to readable foreground activity in both languages", () => {
    expect(zhCNMessages["computerHistory.enableAllOperations"]).toBe("前台应用中可读取的操作和文字");
    expect(enUSMessages["computerHistory.enableAllOperations"]).toBe("readable actions and text in foreground apps");
    expect(zhCNMessages["computerHistory.info"]).toContain("无法读取的内容不会被完整记录");
  });
});
