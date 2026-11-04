// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { sidebarRecordingStatus, useRecordingEntry, type RecordingEntrySession } from "../recording-entry.js";

const mocks = vi.hoisted(() => {
  let resolveTranscription: ((value: { text: string; segments: []; transcribedAt: string; recording: Blob; recordingMimeType: string; durationMs: number }) => void) | undefined;
  const transcription = new Promise<{ text: string; segments: []; transcribedAt: string; recording: Blob; recordingMimeType: string; durationMs: number }>((resolve) => {
    resolveTranscription = resolve;
  });
  const recorder = {
    status: "recording" as "idle" | "recording",
    error: null,
    isRecording: true as boolean,
    isTranscribing: false,
    isStarting: false,
    start: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    finishAndTranscribe: vi.fn(async (options: { onRecordingReady?: (recording: Blob, mimeType: string, durationMs: number) => void }) => {
      recorder.status = "idle";
      recorder.isRecording = false;
      options.onRecordingReady?.(new Blob(["audio"]), "audio/webm", 4_000);
      return transcription;
    })
  };
  return { recorder, resolveTranscription: (value: Parameters<NonNullable<typeof resolveTranscription>>[0]) => resolveTranscription?.(value) };
});

vi.mock("../asr-recorder.js", async () => {
  const actual = await vi.importActual<typeof import("../asr-recorder.js")>("../asr-recorder.js");
  return { ...actual, useAsrRecorder: () => mocks.recorder };
});

function Harness(props: { onSession(session: RecordingEntrySession): void; allowed?: boolean; asrClient?: { transcribe: ReturnType<typeof vi.fn> } }) {
  props.onSession(useRecordingEntry((props.asrClient ?? {}) as never, undefined, undefined, undefined, props.allowed).session);
  return null;
}

describe("useRecordingEntry recording retention", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: RecordingEntrySession;

  beforeEach(() => {
    mocks.recorder.status = "recording";
    mocks.recorder.isRecording = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("keeps a stopped recording visible after returning while transcription is pending", async () => {
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <Harness onSession={(session) => { current = session; }} />
      </I18nProvider>
    ));

    await act(async () => current.finish());
    expect(current.recordings).toHaveLength(1);
    const title = current.recordings[0]!.title;
    expect(title).toMatch(/^录音记录 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(current.recordings[0]?.status).toBe("transcribing");
    expect(sidebarRecordingStatus(current)).toBe("transcribing");

    act(() => current.back());
    expect(current.view).toBe("list");
    expect(current.recordings[0]?.audioUrl).toBeTruthy();

    await act(async () => mocks.resolveTranscription({
      text: "转写完成",
      segments: [],
      transcribedAt: new Date().toISOString(),
      recording: new Blob(["audio"]),
      recordingMimeType: "audio/webm",
      durationMs: 4_000
    }));

    expect(current.view).toBe("list");
    expect(current.recordings[0]?.status).toBe("ready");
    expect(current.recordings[0]?.title).toBe(title);
    expect(current.recordings[0]?.transcript.text).toBe("转写完成");
    expect(sidebarRecordingStatus(current)).toBe("ready");
    await act(async () => { await current.remove?.(current.recordings[0]!); });
    expect(current.recordings).toHaveLength(0);
    expect(current.live).toBeNull();
  });

  it("does not start or upload a recording after account access is removed", async () => {
    mocks.recorder.status = "idle";
    mocks.recorder.isRecording = false;
    const asrClient = { transcribe: vi.fn() };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <Harness allowed={false} asrClient={asrClient} onSession={(session) => { current = session; }} />
      </I18nProvider>
    ));
    act(() => current.start());
    act(() => current.upload(new File(["audio"], "recording.webm", { type: "audio/webm" })));
    expect(mocks.recorder.start).not.toHaveBeenCalled();
    expect(asrClient.transcribe).not.toHaveBeenCalled();
  });
});
