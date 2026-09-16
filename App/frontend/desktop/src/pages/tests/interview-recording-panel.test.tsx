// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { formatClock, groupSpeakerTurns, InterviewRecordingPanel, type RecordingPanelSession } from "../interview-recording-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("groupSpeakerTurns", () => {
  it("merges consecutive sentences from the same speaker into one turn", () => {
    const turns = groupSpeakerTurns([
      { text: "喝水吗？", speakerId: 0, startMs: 55_000 },
      { text: "我给你们拿点水。", speakerId: 0, startMs: 55_800 },
      { text: "谢谢。", speakerId: 1, startMs: 57_000 },
      { text: "我先不用。", speakerId: 0, startMs: 57_500 }
    ]);

    expect(turns).toEqual([
      { speakerId: 0, startMs: 55_000, text: "喝水吗？我给你们拿点水。" },
      { speakerId: 1, startMs: 57_000, text: "谢谢。" },
      { speakerId: 0, startMs: 57_500, text: "我先不用。" }
    ]);
  });

  it("returns nothing to group when the model separated no speakers", () => {
    // The caller falls back to flat text, which is the only honest rendering
    // when every sentence would carry the same invented label.
    expect(groupSpeakerTurns([{ text: "一段没有发言人的转写" }])).toEqual([]);
  });

  it("skips blank segments", () => {
    const turns = groupSpeakerTurns([
      { text: "  ", speakerId: 0 },
      { text: "有内容", speakerId: 0 }
    ]);
    expect(turns).toEqual([{ speakerId: 0, startMs: undefined, text: "有内容" }]);
  });
});

describe("formatClock", () => {
  it("shows mm:ss inside the first hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(5_400)).toBe("00:05");
    expect(formatClock(68_000)).toBe("01:08");
  });

  it("grows to h:mm:ss for a long interview", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(7_265_000)).toBe("2:01:05");
  });

  it("floors a negative offset at zero", () => {
    expect(formatClock(-1_000)).toBe("00:00");
  });
});

describe("InterviewRecordingPanel", () => {
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

  const session = (overrides: Partial<RecordingPanelSession> = {}): RecordingPanelSession => ({
    title: "访谈录音",
    status: "recording",
    elapsedMs: 4_000,
    lines: [],
    transcript: null,
    audioUrl: null,
    onPause: () => undefined,
    onResume: () => undefined,
    onFinish: () => undefined,
    onClose: () => undefined,
    ...overrides
  });

  const render = (props: Parameters<typeof InterviewRecordingPanel>[0]) => act(() => {
    root.render(<I18nProvider language="zh-CN"><InterviewRecordingPanel {...props} /></I18nProvider>);
  });

  it("puts the recorder in the column, above the words it produces", () => {
    render({ session: session({ lines: [{ offsetMs: 3_000, text: "测试测试。" }] }), bar: <div data-testid="recorder-bar">录音条</div> });

    const pane = container.querySelector(".workspace-artifact-preview-pane");
    expect(pane).not.toBeNull();
    // The recorder is in the pane, not over the conversation, and it sits
    // ahead of the transcript it is feeding.
    const bar = pane!.querySelector(".recording-panel__bar-slot [data-testid='recorder-bar']");
    expect(bar).not.toBeNull();
    const body = pane!.querySelector(".recording-panel__body");
    expect(body).not.toBeNull();
    expect(bar!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The live lines are the transcript for a recording that is still running.
    expect(body!.textContent).toContain("测试测试。");
  });

  it("opens the column with only the recorder in it before a recording starts", () => {
    render({ session: null, bar: <div data-testid="recorder-bar">录音条</div>, title: "访谈录音" });

    // The card alone is enough to bring the column up, so pressing the button
    // opens the recorder where the design puts it rather than nowhere.
    expect(container.querySelector(".recording-panel__bar-slot [data-testid='recorder-bar']")).not.toBeNull();
    expect(container.textContent).toContain("访谈录音");
    // With nothing recorded there is no status row and no player to show.
    expect(container.querySelector(".recording-panel__status")).toBeNull();
    expect(container.querySelector(".recording-panel__player")).toBeNull();
  });

  it("frames the finished transcript with its player and speaker turns", () => {
    render({
      session: session({
        status: "done",
        audioUrl: "blob:recording",
        transcript: {
          text: "喝水吗？谢谢。",
          segments: [
            { text: "喝水吗？", speakerId: 0, startMs: 55_000 },
            { text: "谢谢。", speakerId: 1, startMs: 57_000 }
          ]
        }
      })
    });

    expect(container.querySelector(".recording-panel__player")).not.toBeNull();
    expect(container.querySelectorAll(".recording-panel__turn")).toHaveLength(2);
    // A finished recording has no running clock to report.
    expect(container.querySelector(".recording-panel__status")).toBeNull();
  });
});
