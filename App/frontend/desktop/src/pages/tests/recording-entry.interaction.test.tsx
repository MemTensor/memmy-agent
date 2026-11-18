// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  formatRecordingTitleTimestamp,
  RecordingEntryCard,
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
    expect(container.querySelector('button[aria-label="上传录音"]')).not.toBeNull();
    expect(container.textContent).toContain("开始录音");
    expect(container.querySelector(".recording-page__bar .recording-page__controls")).toBeNull();
    expect(container.querySelector(".recording-page__bar + .recording-page__list-toolbar")).not.toBeNull();
    expect(container.querySelector(".recording-page__bar + .recording-page__controls")).toBeNull();
    expect(container.querySelector(".recording-page__table-head")?.textContent).toBe("名称时长");
    // The row keeps its title and duration in one button; speaker details are in the transcript.
    expect(container.textContent).toContain("示例-制造企业用工访谈");
    expect(container.querySelector(".recording-page__list-row--table .recording-page__list-body")?.textContent)
      .toBe("示例-制造企业用工访谈13:05");
  });

  it("keeps a live transcription warning on its recording row and current detail", async () => {
    const warning = "实时转写暂时超时，录音不受影响；结束录音后将重试转写。";
    const value = session({ status: "paused", liveWarning: warning });
    await render(value);
    expect(container.querySelector(".recording-page__error")).toBeNull();
    expect(container.querySelector(".recording-page__list-row--active .recording-page__live-warning")?.textContent).toBe(warning);
    expect(container.querySelector(".recording-page__list-row:not(.recording-page__list-row--active) .recording-page__live-warning")).toBeNull();
    await render({ ...value, view: "live" });
    expect(container.querySelector(".recording-page > .recording-page__live-warning")?.textContent).toBe(warning);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("starts recording and opens upload directly from the list header", async () => {
    const value = session();
    await render(value);
    const actions = container.querySelector(".recording-page__list-toolbar")!;
    await act(async () => [...actions.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("开始录音"))!.click());
    expect(value.start).toHaveBeenCalledOnce();
    const pickFile = vi.spyOn(container.querySelector<HTMLInputElement>('input[type="file"]')!, "click");
    await act(async () => actions.querySelector<HTMLButtonElement>('[aria-label="上传录音"]')!.click());
    expect(pickFile).toHaveBeenCalledOnce();
  });

  it("filters recording names, shows no matches, and clears search with Escape", async () => {
    await render(session({ recordings: [entry, { ...entry, id: "rec-2", title: "Product Review" }] }));
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const query = async (value: string) => act(async () => {
      setValue.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await query("  REVIEW  ");
    expect(container.querySelectorAll(".recording-page__list-row--table")).toHaveLength(1);
    expect(container.querySelector(".recording-page__list-title")?.textContent).toBe("Product Review");
    await query("制造");
    expect(container.querySelector(".recording-page__list-title")?.textContent).toBe(entry.title);
    await query("不存在");
    expect(container.querySelectorAll(".recording-page__list-row--table")).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("未找到匹配的录音");
    expect(container.querySelector(".recording-page__empty")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="清除搜索"]')!.click());
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(container.querySelectorAll(".recording-page__list-row--table")).toHaveLength(2);
    await query("不存在");
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(search.value).toBe("");
    expect(container.querySelectorAll(".recording-page__list-row--table")).toHaveLength(2);
  });

  it("shows one set of actions in the centered empty state", async () => {
    const emptySession = session({ recordings: [] });
    await render(emptySession);

    expect(container.querySelector(".recording-page__empty h3")?.textContent).toBe("开始你的第一条录音");
    expect(container.querySelector(".recording-page__empty p")?.textContent).toBe("录音或上传音频，交给 Memmy 处理");
    expect(container.querySelectorAll(".recording-page__controls button")).toHaveLength(0);
    const start = Array.from(container.querySelectorAll<HTMLButtonElement>(".recording-page__empty button"))
      .find((button) => button.textContent?.includes("开始录音"));
    expect(start).toBeDefined();
    await act(async () => start?.click());
    expect(emptySession.start).toHaveBeenCalledOnce();
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

    // Summary remains visible; attaching without sending lives in More.
    expect(container.querySelector('[aria-label="添加到会话"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__summary-action")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__more-trigger")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === "添加到会话")!.click());

    expect(value.deliver).toHaveBeenNthCalledWith(1, entry, "summarize");
    expect(value.deliver).toHaveBeenNthCalledWith(2, entry, "attach");
  });

  it("keeps detail summary visible and attaches through a dismissible More menu", async () => {
    const value = session({ view: "transcript", opened: entry });
    await render(value);
    expect(container.querySelector('[aria-label="添加到会话"]')).toBeNull();
    const summary = container.querySelector<HTMLButtonElement>('[aria-label="总结"]')!;
    expect(summary.textContent).toBe("");
    await act(async () => summary.click());
    expect(value.deliver).toHaveBeenCalledWith(entry, "summarize");
    const more = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    await act(async () => more.click());
    const attach = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(attach.textContent).toBe("添加到会话");
    await act(async () => attach.click());
    expect(value.deliver).toHaveBeenCalledWith(entry, "attach");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => more.click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    await act(async () => more.click());
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("only shows toolbar tooltips after their visible labels collapse", async () => {
    await render(session());
    const upload = container.querySelector<HTMLButtonElement>('[aria-label="上传录音"]')!;
    await act(async () => upload.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"][aria-hidden="false"]')).toBeNull();
    await act(async () => upload.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    upload.querySelector("span")!.style.display = "none";
    await act(async () => upload.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"][aria-hidden="false"]')?.textContent).toBe("上传录音");
  });

  it("shows the summary tooltip without sending on hover", async () => {
    const value = session();
    await render(value);
    const summary = container.querySelector<HTMLButtonElement>('[aria-label="总结"]')!;
    await act(async () => summary.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"][aria-hidden="false"]')?.textContent).toBe("总结");
    expect(value.deliver).not.toHaveBeenCalled();
  });

  it("keeps a pending recording below the only table header, once, with its duration", async () => {
    const pending = { ...entry, status: "transcribing" as const };
    await render(session({ status: "transcribing", live: pending, recordings: [pending] }));
    expect(container.querySelectorAll(".recording-page__list")).toHaveLength(1);
    const list = container.querySelector(".recording-page__list")!;
    expect(list.firstElementChild?.classList.contains("recording-page__table-head")).toBe(true);
    expect(list.querySelectorAll(".recording-page__list-row")).toHaveLength(1);
    expect(list.querySelector(".recording-page__list-status")?.textContent).toContain("正在转写");
    expect(list.querySelector(".recording-page__list-meta")?.textContent).toBe("13:05");
  });

  it("shows the speaking hint and keeps pause and finish controls functional", async () => {
    const value = session({ view: "live", status: "recording", lines: [] });
    await render(value);
    expect(container.textContent).toContain("请说话，我会将语音转文字");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click());
    expect(value.pause).toHaveBeenCalledOnce();
    await render({ ...value, status: "paused" });
    expect(container.querySelector(".recording-panel__empty")?.textContent).toBe("已暂停");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="继续"]')!.click());
    expect(value.resume).toHaveBeenCalledOnce();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="结束并转写"]')!.click());
    expect(value.finish).toHaveBeenCalledOnce();
  });

  it.each(["list", "transcript"] as const)("renames in place with cancel and save in %s", async (view) => {
    const value = session({ view, opened: view === "transcript" ? entry : null, rename: vi.fn(), remove: vi.fn(async () => true) });
    await render(value);
    const startRename = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
      const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      expect(items.map((item) => item.textContent)).toEqual(["添加到会话", "重命名", "删除"]);
      await act(async () => items.find((item) => item.textContent === "重命名")!.click());
    };
    await startRename();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const input = container.querySelector<HTMLInputElement>('.recording-name-editor input')!;
    expect(input.closest("button")).toBeNull();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(value.rename).not.toHaveBeenCalled();
    await startRename();
    const edited = container.querySelector<HTMLInputElement>('.recording-name-editor input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(edited, "新名称");
      edited.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => edited.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(value.rename).toHaveBeenCalledExactlyOnceWith(entry, "新名称");
    expect(container.querySelector('.recording-name-editor')).toBeNull();
  });

  it("keeps a recording-specific failure in its detail instead of the list header", async () => {
    const failed = { ...entry, status: "failed" as const, transcriptionError: "没有录到有效音频" };
    await render(session({ recordings: [failed], live: failed }));
    expect(container.querySelector('.recording-page__error')).toBeNull();
    expect(container.querySelector('.recording-page__list-status')?.textContent).toContain("转写失败");
    await render(session({ view: "transcript", opened: failed, recordings: [failed] }));
    expect(container.querySelector('.recording-page__transcription-state')?.textContent).toBe("没有录到有效音频");
    expect(container.querySelector('details')).toBeNull();
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
    const view = container.querySelector<HTMLButtonElement>(".recording-page__list-row--active .recording-page__list-open")!;
    expect(container.querySelector(".recording-page__list-row--active .lucide-chevron-right")).toBeNull();
    expect(container.textContent).toContain("正在录音");
    expect(container.textContent).not.toContain("继续");
    await act(async () => view.click());
    expect(value.showLive).toHaveBeenCalledTimes(1);
    expect(value.resume).not.toHaveBeenCalled();
  });

  it("offers pause and finish on the active row without opening its detail", async () => {
    const value = session({ status: "recording", recordings: [] });
    await render(value);
    expect(container.querySelector('.recording-page__name-heading .app-frame-recording-wave--live')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click());
    expect(value.pause).toHaveBeenCalledOnce();
    expect(value.showLive).not.toHaveBeenCalled();
    await render({ ...value, status: "paused" });
    expect(container.querySelector('.app-frame-recording-wave--live')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="继续"]')!.click());
    expect(value.resume).toHaveBeenCalledOnce();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="结束并转写"]')!.click());
    expect(value.finish).toHaveBeenCalledOnce();
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
    expect(container.querySelector(".recording-live__actions")?.querySelectorAll("button")).toHaveLength(2);
    expect(container.textContent).toContain("我们社保在北京参保");
  });

  it("groups the finished transcript by speaker", async () => {
    await render(session({ view: "transcript", opened: entry }));

    expect(container.querySelector("h3.recording-page__transcript-heading")?.textContent).toBe("转写内容");
    expect(container.querySelector(".recording-page__bar .thread-preview__actions")?.querySelectorAll(".thread-preview__action")).toHaveLength(2);
    expect(container.querySelector(".recording-page__bar + .recording-page__controls")).toBeNull();
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
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual(["重试转写"]);

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

    expect(container.querySelector(".recording-page__transcription-state")?.textContent).toBe(value.error);
    expect(container.textContent).not.toContain("错误详情");
    expect(container.querySelector(".recording-panel__turns")).toBeNull();
    expect(container.textContent).not.toContain("添加到会话");
    expect(container.textContent).not.toContain("总结");
    expect(container.querySelector('button[aria-label="重试转写"]')).not.toBeNull();
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
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog .button-danger')!.click());
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

describe("RecordingEntryCard", () => {
  it("does not repeat a failed recording's ASR error when reopened, but shows a new start error", async () => {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const failed = { ...entry, status: "failed" as const };
    const render = (value: RecordingEntrySession) => act(async () => root.render(
      <I18nProvider language="zh-CN"><RecordingEntryCard session={value}
        onClose={vi.fn()} /></I18nProvider>
    ));
    try {
      await render(session({ live: failed, error: "API接口错误: ASR upstream request failed" }));
      expect(container.querySelector(".recording-entry-card")).not.toBeNull();
      expect(container.textContent).not.toContain("ASR upstream request failed");
      await render(session({ live: null, error: "无法访问麦克风" }));
      expect(container.textContent).toContain("无法访问麦克风");
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
