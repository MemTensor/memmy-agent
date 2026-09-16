// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
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
    open: vi.fn(),
    upload: vi.fn(),
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

  it("sends a row as a summary task or into the current conversation", async () => {
    const value = session();
    await render(value);

    // 总结 starts a new task; 添加到会话 stays where the user is. Both send the
    // same transcript, so the two must be distinguishable by more than a click.
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".recording-page__list-action")];
    expect(actions.map((button) => button.textContent)).toEqual(["总结", "添加到会话"]);
    await act(async () => actions[0]!.click());
    await act(async () => actions[1]!.click());

    expect(value.deliver).toHaveBeenNthCalledWith(1, entry, "summarize");
    expect(value.deliver).toHaveBeenNthCalledWith(2, entry, "attach");
  });

  it("opens a row's transcript without leaving the page", async () => {
    const value = session();
    await render(value);

    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__list-open")!.click());
    expect(value.open).toHaveBeenCalledWith(entry);
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
});
