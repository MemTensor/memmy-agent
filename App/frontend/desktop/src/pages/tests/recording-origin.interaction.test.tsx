// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { useRecordingEntry, type RecordingEntrySession } from "../recording-entry.js";

const recorder = vi.hoisted(() => {
  const value = { status: "idle", isRecording: false, isStarting: false, isTranscribing: false, error: null,
    start: vi.fn(async () => { value.status = "recording"; value.isRecording = true; }),
    pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    finishAndTranscribe: vi.fn(async () => ({ text: "Interview", segments: [], transcribedAt: "2026-10-26T00:00:00Z",
      recording: new Blob(["audio"], { type: "audio/webm" }), recordingMimeType: "audio/webm", durationMs: 1000 })) };
  return value;
});
vi.mock("../asr-recorder.js", async (original) => ({
  ...await original<typeof import("../asr-recorder.js")>(), useAsrRecorder: () => recorder
}));

it("keeps the originating conversation when a recording finishes after switching chats", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const archived = vi.fn();
  const asr = { transcribe: vi.fn() };
  let session: RecordingEntrySession;
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recording-test");
  function Harness(props: { sessionKey: string }) {
    session = useRecordingEntry(asr as never, undefined, undefined, {
      scope: "recording-origin-test", sessionKey: props.sessionKey,
      onArchived: archived, resolveAudio: async () => null
    }).session;
    return null;
  }
  const render = (sessionKey: string) => root.render(<I18nProvider language="zh-CN"><Harness sessionKey={sessionKey} /></I18nProvider>);
  try {
    await act(async () => render("websocket:chat-a"));
    await act(async () => session!.start());
    await act(async () => render("websocket:chat-b"));
    await act(async () => session!.finish());
    expect(archived).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "websocket:chat-a" }));
  } finally { await act(async () => root.unmount()); container.remove(); createUrl.mockRestore(); }
});
