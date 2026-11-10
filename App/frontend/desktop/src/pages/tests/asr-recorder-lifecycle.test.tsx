// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asrErrorMessageKey, useAsrRecorder, type AsrRecorder, transcribeRecording } from "../asr-recorder.js";
import type { AsrClient } from "../../api/asr-client.js";
const tap = vi.hoisted(() => ({ options: null as any, fail: false, setPaused: vi.fn(), ready: null as Promise<void> | null, close: vi.fn(async () => {}) }));
vi.mock("../../lib/audio-pcm-tap.js", () => ({ PCM_TAP_SAMPLE_RATE: 16000,
  createPcmTap: vi.fn(async (stream, options) => { tap.options = options; await tap.ready; if (tap.fail) throw new Error("worklet unavailable"); if (typeof stream === "function") await stream(); return { close: tap.close, setPaused: tap.setPaused }; }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class Socket {
  readyState = 0; binaryType = ""; bufferedAmount = 0;
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  addEventListener(type: string, listener: (event?: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event?: unknown) { this.listeners.get(type)?.forEach(listener => listener(event)); }
  send(data: string | ArrayBuffer) {
    if (typeof data === "string" && JSON.parse(data).type === "finish") this.emit("message", { data: JSON.stringify({ type: "finished" }) });
  }
  close() { this.readyState = 3; this.emit("close", { code: 1000, reason: "" }); }
  open() { this.readyState = 1; this.emit("open"); this.event({ type: "ready" }); }
  event(value: unknown) { this.emit("message", { data: JSON.stringify(value) }); }
}
class Recorder {
  static isTypeSupported() { return true; }
  static starts = 0;
  static current: Recorder;
  chunks = ["complete recording from first second"];
  state = "inactive"; mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
  start() { Recorder.current = this; Recorder.starts++; this.state = "recording"; }
  requestData() { this.ondataavailable?.({ data: new Blob(this.chunks) }); }
  stop() { this.state = "inactive"; this.onstop?.(); }
  pause() { this.state = "paused"; } resume() { this.state = "recording"; }
}
let root: Root; let container: HTMLDivElement; let recorder: AsrRecorder;
let socket: Socket; let client: AsrClient; const trackStop = vi.fn();
function Harness() { recorder = useAsrRecorder(client, { live: { onLine() {} } }); return null; }
beforeEach(async () => {
  Recorder.starts = 0; tap.ready = null; tap.fail = false; tap.close.mockReset(); tap.close.mockResolvedValue(undefined); tap.setPaused.mockClear(); trackStop.mockClear(); socket = new Socket();
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) } });
  client = { prepare: vi.fn(async () => ({ sessionId: "recording-config" })), release: vi.fn(async () => {}),
    openStream: vi.fn(() => socket as any), transcribe: vi.fn(async () => ({ text: "HTTP complete", modelId: "selected", provider: "dashscope", source: "byok", transcribedAt: new Date().toISOString() })) };
  container = document.createElement("div"); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function start() { await act(async () => { await recorder.start(); }); }
async function stream() { await start(); await act(async () => { tap.options.onSamples(new Int16Array(1600)); socket.open(); }); }
describe("complete recording fallback", () => {
  it("releases the microphone when the recorder constructor rejects", async () => {
    vi.stubGlobal("MediaRecorder", class extends Recorder { constructor() { super(); throw new Error("unsupported format"); } });
    await act(async () => { await expect(recorder.start()).rejects.toThrow("unsupported format"); });
    expect(trackStop).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith("recording-config");
  });
  it("pauses PCM at its source and excludes paused time from recording duration", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    await stream();
    now.mockReturnValue(500); await act(async () => recorder.pause());
    now.mockReturnValue(2500); await act(async () => recorder.resume());
    now.mockReturnValue(3000); socket.event({ type: "error", message: "disconnected" });
    let result: any; await act(async () => { result = await recorder.finishAndTranscribe(); });
    expect(result.durationMs).toBe(1000);
    expect(tap.setPaused.mock.calls).toEqual([[true], [false]]);
  });
  it("keeps a completed realtime transcript when handing recording ownership to a caller", async () => {
    await stream(); socket.event({ type: "sentence", sentenceId: 1, text: "live complete", beginMs: 0 });
    let stopped: any; await act(async () => { stopped = await recorder.stop(); });
    expect(stopped.liveText).toBe("live complete");
    const result = await transcribeRecording(client, stopped.recording, stopped.durationMs, stopped);
    expect(result.text).toBe("live complete"); expect(client.transcribe).not.toHaveBeenCalled();
  });
  it("prepares PCM before opening the microphone and starts recording immediately after acquisition", async () => {
    let ready!: () => void;
    tap.ready = new Promise<void>(resolve => { ready = resolve; });
    let starting!: Promise<void>;
    await act(async () => { starting = recorder.start(); });
    expect(Recorder.starts).toBe(0); expect(recorder.status).toBe("starting");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await act(async () => { ready(); await starting; });
    expect(Recorder.starts).toBe(1); expect(recorder.status).toBe("recording");
  });
  it("does not start an old microphone after cancellation during worklet setup", async () => {
    let ready!: () => void;
    tap.ready = new Promise<void>(resolve => { ready = resolve; });
    let starting!: Promise<void>;
    await act(async () => { starting = recorder.start(); });
    await act(async () => recorder.cancel());
    await act(async () => { ready(); await starting; });
    expect(Recorder.starts).toBe(0); expect(recorder.status).toBe("idle");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it("ignores an old HTTP response after a new recording starts", async () => {
    tap.fail = true; await start();
    let complete!: (value: any) => void;
    vi.mocked(client.transcribe).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    let finishing!: Promise<unknown>;
    await act(async () => { finishing = recorder.finishAndTranscribe().catch(error => error); });
    await vi.waitFor(() => expect(client.transcribe).toHaveBeenCalledOnce());
    await start();
    await act(async () => complete({ text: "old text" }));
    expect(await finishing).toMatchObject({ name: "AbortError" });
    expect(recorder.status).toBe("recording");
  });
  it("keeps recording after realtime failure and uses the same session for HTTP", async () => {
    await stream();
    await act(async () => socket.event({ type: "error", message: "upstream 404" }));
    expect(recorder.status).toBe("recording");
    let result: any;
    await act(async () => { result = await recorder.finishAndTranscribe(); });
    expect(result.text).toBe("HTTP complete");
    expect(client.transcribe).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "recording-config", audioBase64: expect.any(String) }), expect.any(AbortSignal));
    expect(atob(vi.mocked(client.transcribe).mock.calls[0]![0].audioBase64)).toBe("complete recording from first second");
    expect(client.release).toHaveBeenCalledWith("recording-config");
  });
  it("skips HTTP only after a complete realtime result", async () => {
    await stream(); socket.event({ type: "sentence", sentenceId: 1, text: "live complete", beginMs: 0 });
    let result: any; await act(async () => { result = await recorder.finishAndTranscribe(); });
    expect(result.text).toBe("live complete"); expect(client.transcribe).not.toHaveBeenCalled();
  });
  it("keeps the full recording when AudioWorklet setup fails", async () => {
    tap.fail = true; await start(); expect(recorder.status).toBe("recording");
    await act(async () => { await recorder.finishAndTranscribe(); });
    expect(client.transcribe).toHaveBeenCalledOnce();
  });
  it("retains diagnostic causes internally only after HTTP also fails", async () => {
    await stream(); socket.event({ type: "error", message: "upstream 404" });
    const httpError = Object.assign(new Error("no available channel"), { code: "unauthorized" });
    vi.mocked(client.transcribe).mockRejectedValue(httpError);
    await act(async () => {
      await expect(recorder.finishAndTranscribe()).rejects.toThrow(/upstream 404.*\n.*no available channel/);
    });
    expect(recorder.status).toBe("error");
    expect(recorder.error?.cause).toBe(httpError);
    expect(asrErrorMessageKey(recorder.error)).toBe("home.asrAccessDenied");
    expect(client.release).toHaveBeenCalledWith("recording-config");
  });
  it("transfers the pinned session to a background transcription", async () => {
    tap.fail = true; await start(); let stopped: any;
    await act(async () => { stopped = await recorder.stop(); });
    expect(stopped.sessionId).toBe("recording-config");
    await act(async () => recorder.cancel());
    expect(client.release).not.toHaveBeenCalled();
  });
});


describe("13-step ASR recording contract", () => {
  it("includes opening, middle and tail audio in HTTP fallback after a partial realtime result", async () => {
    await start();
    Recorder.current.chunks = [];
    Recorder.current.chunks.push("opening|");
    await act(async () => { tap.options.onSamples(new Int16Array([1, 2])); socket.open(); });
    socket.event({ type: "partial", sentenceId: 1, text: "opening", beginMs: 0 });
    Recorder.current.chunks.push("middle|");
    socket.event({ type: "error", message: "connection lost" });
    expect(recorder.isRecording).toBe(true);
    Recorder.current.chunks.push("tail");
    let result: any;
    await act(async () => { result = await recorder.finishAndTranscribe(); });
    const request = vi.mocked(client.transcribe).mock.calls[0]![0];
    expect(client.transcribe).toHaveBeenCalledOnce();
    expect(request.sessionId).toBe("recording-config");
    expect(atob(request.audioBase64)).toBe("opening|middle|tail");
    expect(result.text).toBe("HTTP complete");
  });
  it("does not treat retained realtime text as success after a recorded realtime failure", async () => {
    const result = await transcribeRecording(client, new Blob(["full audio"]), 1000, {
      sessionId: "recording-config", liveText: "unfinished text", liveError: new Error("final flush failed")
    });
    expect(client.transcribe).toHaveBeenCalledOnce();
    expect(result.text).toBe("HTTP complete");
  });
  it("does not ask for the microphone a second time after acquisition fails", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    await act(async () => { await expect(recorder.start()).rejects.toMatchObject({ name: "MicrophonePermissionError" }); });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(Recorder.starts).toBe(0);
    expect(client.release).toHaveBeenCalledWith("recording-config");
  });
});


describe("stop and cancellation boundaries", () => {
  it("does not submit HTTP after the recording-ready callback cancels the operation", async () => {
    tap.fail = true; await start();
    await act(async () => {
      await expect(recorder.finishAndTranscribe({ onRecordingReady: () => recorder.cancel() })).rejects.toMatchObject({ name: "AbortError" });
    });
    expect(client.transcribe).not.toHaveBeenCalled();
  });
  it("starts the PCM flush without waiting for the MediaRecorder stop event", async () => {
    await stream();
    let release!: () => void;
    vi.spyOn(Recorder.current, "stop").mockImplementation(function (this: Recorder) { this.state = "inactive"; release = () => this.onstop?.(); });
    let stopping!: Promise<unknown>;
    await act(async () => { stopping = recorder.stop(); });
    expect(tap.close).toHaveBeenCalledOnce();
    await act(async () => { release(); await stopping; });
  });
});


describe("HTTP cancellation", () => {
  it("does not upload audio if cancelled while encoding the full recording", async () => {
    const blob = new Blob(["audio"]);
    const controller = new AbortController();
    const result = transcribeRecording(client, blob, 1000, { signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(client.transcribe).not.toHaveBeenCalled();
  });
  it("aborts a pending HTTP request when the recorder is cancelled", async () => {
    tap.fail = true; await start();
    vi.mocked(client.transcribe).mockImplementationOnce((_input, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    let result!: Promise<unknown>;
    await act(async () => { result = recorder.finishAndTranscribe().catch(error => error); });
    await vi.waitFor(() => expect(client.transcribe).toHaveBeenCalledOnce());
    await act(async () => recorder.cancel());
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(recorder.status).toBe("idle");
  });
});
