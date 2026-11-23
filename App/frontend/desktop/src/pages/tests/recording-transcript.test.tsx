// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginRecordingPage } from "../recording-entry.js";
import { formatClock, groupSpeakerTurns, RecordingPlayer, type RecordingPanelSession } from "../recording-transcript.js";

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

describe("RecordingPlayer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Test audio has no network source"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const render = (durationMs: number) => act(() => {
    root.render(<I18nProvider language="zh-CN"><RecordingPlayer src="blob:recording" durationMs={durationMs} /></I18nProvider>);
  });

  it("does not let implausibly short WebM metadata replace the measured duration", () => {
    render(3_000);
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 0.003 });
    act(() => audio.dispatchEvent(new Event("loadedmetadata")));

    const times = container.querySelectorAll(".recording-panel__player-time");
    const scrubber = container.querySelector<HTMLInputElement>(".recording-panel__player-scrubber")!;
    expect(times[1]?.textContent).toBe("00:03");
    expect(scrubber.max).toBe("3000");
  });

  it("uses the real media duration and keeps playback progress bounded", () => {
    render(500);
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 3 });
    act(() => audio.dispatchEvent(new Event("durationchange")));
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 1.5 });
    act(() => audio.dispatchEvent(new Event("timeupdate")));

    const scrubber = container.querySelector<HTMLInputElement>(".recording-panel__player-scrubber")!;
    expect(scrubber.max).toBe("3000");
    expect(scrubber.value).toBe("1500");
    expect(scrubber.style.getPropertyValue("--recording-playback-progress")).toBe("50%");

    Object.defineProperty(audio, "currentTime", { configurable: true, value: 9 });
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    expect(scrubber.value).toBe("3000");
    expect(scrubber.style.getPropertyValue("--recording-playback-progress")).toBe("100%");
  });

  it("seeks the audio and keeps playback events from pulling the thumb back while dragging", () => {
    render(3000);
    const audio = container.querySelector("audio")!;
    const scrubber = container.querySelector<HTMLInputElement>(".recording-panel__player-scrubber")!;
    act(() => scrubber.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(scrubber, "1500");
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(audio.currentTime).toBe(1.5);
    expect(scrubber.value).toBe("1500");
    audio.currentTime = .1;
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    expect(scrubber.value).toBe("1500");
    act(() => scrubber.dispatchEvent(new Event("pointerup", { bubbles: true })));
    audio.currentTime = 1.6;
    act(() => audio.dispatchEvent(new Event("timeupdate")));
    expect(scrubber.value).toBe("1600");
  });

  it("finishes at 100% when the playable media ends before the measured duration", () => {
    render(4_250);
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 4.05 });
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 4.05 });
    act(() => audio.dispatchEvent(new Event("ended")));

    const scrubber = container.querySelector<HTMLInputElement>(".recording-panel__player-scrubber")!;
    expect(scrubber.max).toBe("4250");
    expect(scrubber.value).toBe("4250");
    expect(scrubber.style.getPropertyValue("--recording-playback-progress")).toBe("100%");
  });
});

describe("PluginRecordingPage", () => {
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

  const render = (props: Parameters<typeof PluginRecordingPage>[0]) => act(() => {
    root.render(<I18nProvider language="zh-CN"><PluginRecordingPage {...props} /></I18nProvider>);
  });

  it("uses the shared live layout and transcript section", () => {
    render({ session: session({ lines: [{ startMs: 3_000, endMs: 4_000, text: "测试测试。" }] }) });
    expect(container.querySelector(".recording-page .recording-live")).not.toBeNull();
    expect(container.querySelector(".recording-page__transcript-heading")).not.toBeNull();
    expect(container.querySelector(".recording-panel__lines")?.textContent).toContain("测试测试。");
    expect(container.querySelector(".workspace-artifact-preview-pane")).toBeNull();
  });

  it("keeps the shared listening and transcription states", () => {
    render({ session: session() });
    expect(container.querySelector(".recording-panel__empty")).not.toBeNull();
    render({ session: session({ status: "transcribing" }) });
    expect(container.querySelector(".recording-live")?.textContent).toContain("转写");
    expect(container.querySelector(".recording-live__actions")).toBeNull();
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

  it("routes pause, resume, finish and close to the plugin recorder", () => {
    const pause = vi.fn(); const resume = vi.fn(); const finish = vi.fn(); const close = vi.fn();
    const mount = (status: RecordingPanelSession["status"]) => render({
      session: session({ status, onPause: pause, onResume: resume, onFinish: finish }), onClose: close
    });
    mount("recording");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click());
    expect(pause).toHaveBeenCalledOnce();
    mount("paused");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="继续"]')!.click());
    expect(resume).toHaveBeenCalledOnce();
    act(() => container.querySelector<HTMLButtonElement>(".recording-page__toolbar-action--start")!.click());
    expect(finish).toHaveBeenCalledOnce();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(close).toHaveBeenCalledOnce();
    mount("done");
    expect(container.querySelector(".recording-live__actions")).toBeNull();
  });
});

it("seeks and plays the recorded audio when a transcript timestamp is clicked", async () => {
  const { vi } = await import("vitest");
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><PluginRecordingPage session={{
      title: "访谈录音", status: "done", elapsedMs: 10_000, lines: [], audioUrl: "blob:recording",
      transcript: { text: "测试", segments: [{ speakerId: 0, startMs: 6_000, text: "测试" }] },
      onPause() {}, onResume() {}, onFinish() {}, onClose() {}
    }} /></I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-panel__turn-time")!.click());
    expect(container.querySelector<HTMLAudioElement>("audio")!.currentTime).toBe(6);
    expect(play).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); container.remove(); play.mockRestore(); }
});
