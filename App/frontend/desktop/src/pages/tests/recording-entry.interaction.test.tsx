// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  formatRecordingTitleTimestamp,
  RecordingEntryPage,
  type RecordingArchiveEntry,
  type RecordingEntrySession
} from "../recording-entry.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry: RecordingArchiveEntry = {
  id: "rec-1",
  title: "示例-制造企业用工访谈",
  recordedAt: "2026-09-07T01:30:00.000Z",
  durationMs: 785_000,
  speakerCount: 3,
  transcript: {
    text: "你连接到配置中心的时候要看变量名称。",
    segments: [
      { text: "你连接到配置中心的时候", speakerId: 0, startMs: 0 },
      { text: "要看变量名称。", speakerId: 2, startMs: 12_000 }
    ]
  },
  audioUrl: null
};

/** A session with everything stubbed, so the page can be rendered in isolation. */
function session(overrides: Partial<RecordingEntrySession> = {}): RecordingEntrySession {
  return {
    view: "list",
    status: "idle",
    elapsedMs: 0,
    lines: [],
    live: null,
    recordings: [entry],
    opened: null,
    deliverables: [],
    error: null,
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    finish: vi.fn(),
    back: vi.fn(),
    showLive: vi.fn(),
    open: vi.fn(),
    upload: vi.fn(),
    retry: vi.fn(),
    deliver: vi.fn(),
    reset: vi.fn(),
    ...overrides
  };
}

describe("RecordingEntryPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (value: RecordingEntrySession) => act(async () => root.render(
    <I18nProvider language="zh-CN">
      <RecordingEntryPage session={value} />
    </I18nProvider>
  ));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("opens on the recording list the design calls 录音列表", async () => {
    await render(session());

    expect(container.textContent).toContain("录音列表");
    expect(container.textContent).toContain("上传录音");
    expect(container.textContent).toContain("开始录音");
    // The row carries the four facts the design shows.
    expect(container.textContent).toContain("示例-制造企业用工访谈");
    expect(container.textContent).toContain("时长 13:05");
    expect(container.textContent).toContain("3 人参与");
    expect(container.textContent).toContain("已转写");
  });

  it("does not repeat the timestamp beneath a generated recording title", async () => {
    const stamp = formatRecordingTitleTimestamp(entry.recordedAt);
    await render(session({ recordings: [{ ...entry, title: `录音记录 ${stamp}` }] }));
    const row = container.querySelector(".recording-page__list-row")!;
    expect(row.textContent?.split(stamp)).toHaveLength(2);
  });

  it("distinguishes older recordings that still have the undated default title", async () => {
    const stamp = formatRecordingTitleTimestamp(entry.recordedAt);
    await render(session({ recordings: [{ ...entry, title: "录音记录" }] }));
    const row = container.querySelector(".recording-page__list-row")!;
    expect(row.textContent).toContain(`录音记录 ${stamp}`);
    expect(row.textContent?.split(stamp)).toHaveLength(2);
  });

  it("sends a row as a summary task or into the current conversation", async () => {
    const value = session();
    await render(value);

    // 总结 starts a new task; 添加到会话 stays where the user is. Both send the
    // same transcript, so the two must be distinguishable by more than a click.
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__more-trigger")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("总结"))!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".recording-page__list-action")]
      .find((button) => button.textContent?.includes("添加到会话"))!.click());

    expect(value.deliver).toHaveBeenNthCalledWith(1, entry, "summarize");
    expect(value.deliver).toHaveBeenNthCalledWith(2, entry, "attach");
  });

  it("opens a row's transcript without leaving the page", async () => {
    const value = session();
    await render(value);

    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__list-open")!.click());
    expect(value.open).toHaveBeenCalledWith(entry);
  });

  it("labels the active recording action as a view, without implying playback resumes", async () => {
    const value = session({ status: "recording", recordings: [] });
    await render(value);
    const view = [...container.querySelectorAll<HTMLButtonElement>(".recording-page__list-action")]
      .find((button) => button.textContent === "查看")!;
    expect(container.textContent).toContain("正在录音");
    expect(container.textContent).not.toContain("继续");
    await act(async () => view.click());
    expect(value.showLive).toHaveBeenCalledTimes(1);
    expect(value.resume).not.toHaveBeenCalled();
  });

  it("shows the live transcript and the stop control while recording", async () => {
    await render(session({
      view: "live",
      status: "recording",
      elapsedMs: 1_000,
      lines: [{ startMs: 0, text: "我们社保在北京参保" }]
    }));

    expect(container.textContent).toContain("正在录音");
    expect(container.textContent).toContain("00:01");
    expect(container.textContent).toContain("暂停");
    expect(container.textContent).toContain("结束并转写");
    expect(container.textContent).toContain("我们社保在北京参保");
  });

  it("groups the finished transcript by speaker", async () => {
    await render(session({ view: "transcript", opened: entry }));

    expect(container.textContent).toContain("转写");
    // Speaker ids are shown one-based, as the design's badge does.
    expect(container.textContent).toContain("发言人 1");
    expect(container.textContent).toContain("发言人 3");
    expect(container.textContent).toContain("要看变量名称。");
  });

  it("offers to transcribe a failed row again", async () => {
    const value = session({ recordings: [{ ...entry, status: "failed" }] });
    await render(value);

    expect(container.textContent).toContain("转写失败，录音已保留");
    // A failed row has nothing to summarise or send yet, so retrying is the
    // only action it offers.
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".recording-page__list-action")];
    expect(actions.map((button) => button.textContent)).toEqual(["重试转写"]);

    await act(async () => actions[0]!.click());
    expect(value.retry).toHaveBeenCalledTimes(1);
    expect(value.deliver).not.toHaveBeenCalled();
  });

  it("keeps raw ASR errors out of the list while retaining the failed row and retry", async () => {
    const failed = { ...entry, status: "failed" as const };
    await render(session({ recordings: [failed], live: failed, error: "API接口错误: ASR upstream request failed" }));

    expect(container.querySelector(".recording-page__error")).toBeNull();
    expect(container.textContent).toContain("转写失败，录音已保留");
    expect(container.textContent).not.toContain("ASR upstream request failed");
    expect(container.querySelector(".recording-page__list-action--retry")).not.toBeNull();
  });

  it("shows a failed recording's details without offering transcript delivery", async () => {
    const failed = { ...entry, status: "failed" as const };
    const value = session({ view: "transcript", opened: failed, live: failed,
      error: "API接口错误: ASR upstream request failed" });
    await render(value);

    expect(container.textContent).toContain("转写失败，录音已保留");
    expect(container.textContent).toContain("错误详情");
    expect(container.querySelector(".recording-panel__turns")).toBeNull();
    expect(container.textContent).not.toContain("添加到会话");
    expect(container.textContent).not.toContain("总结");
    expect(container.textContent).toContain("重试转写");
  });

  it("does not call a stopped failed recording live", async () => {
    const failed = { ...entry, status: "failed" as const };
    await render(session({ view: "live", live: failed, error: "ASR upstream request failed" }));
    expect(container.querySelector(".recording-panel__status")?.textContent).toContain("转写失败，录音已保留");
    expect(container.querySelector(".recording-panel__status")?.textContent).not.toContain("正在录音");
  });

  it("does not call a completed recording live after it stops", async () => {
    await render(session({ view: "live", live: { ...entry, status: "ready" } }));
    expect(container.querySelector(".recording-panel__status")?.textContent).toContain("已转写");
    expect(container.querySelector(".recording-panel__status")?.textContent).not.toContain("正在录音");
    expect(container.querySelector(".recording-panel__pulse")).toBeNull();
  });

  it("asks before deleting a saved recording and its local files", async () => {
    const value = session({ remove: vi.fn(async () => true) });
    await render(value);
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__more-trigger")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("删除"))!.click());
    expect(document.body.textContent).toContain("删除本地录音和转写文件？");
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__delete-confirm-action")!.click());
    expect(value.remove).toHaveBeenCalledWith(entry);
  });

  it("keeps a failed row out of the ready actions and shows a retry in flight", async () => {
    await render(session({ recordings: [{ ...entry, status: "failed" }], retrying: new Set([entry.id]) }));

    // While the retry runs the row reads as transcribing and cannot be
    // retried a second time.
    expect(container.textContent).toContain("正在转写录音");
    expect(container.querySelectorAll(".recording-page__list-action--retry")).toHaveLength(0);
  });

  it("offers no retry on a row that transcribed", async () => {
    await render(session());

    expect(container.querySelectorAll(".recording-page__list-action--retry")).toHaveLength(0);
  });
});
