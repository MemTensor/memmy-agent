// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { useRecordingEntry, type RecordingEntrySession } from "../recording-entry.js";

const mocks = vi.hoisted(() => {
  let resolveTranscription: ((value: { text: string; segments: []; transcribedAt: string; recording: Blob; recordingMimeType: string; durationMs: number }) => void) | undefined;
  const transcription = new Promise<{ text: string; segments: []; transcribedAt: string; recording: Blob; recordingMimeType: string; durationMs: number }>((resolve) => {
    resolveTranscription = resolve;
  });
  const recorder = {
    status: "recording" as const,
    error: null,
    isRecording: true,
    isTranscribing: false,
    isStarting: false,
    start: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    finishAndTranscribe: vi.fn(async (options: { onRecordingReady?: (recording: Blob, mimeType: string, durationMs: number) => void }) => {
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

function Harness(props: { onSession(session: RecordingEntrySession): void }) {
  props.onSession(useRecordingEntry({} as never).session);
  return null;
}

describe("useRecordingEntry recording retention", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: RecordingEntrySession;

  beforeEach(() => {
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
    expect(current.recordings[0]?.status).toBe("transcribing");

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
    expect(current.recordings[0]?.transcript.text).toBe("转写完成");
  });
});
