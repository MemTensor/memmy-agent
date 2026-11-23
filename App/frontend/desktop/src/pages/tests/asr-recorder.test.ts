// @vitest-environment happy-dom

/** Asr recorder tests. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsrClient } from "../../api/asr-client.js";
import {
  hasTranscribedSpeech,
  MicrophonePermissionError,
  ensureMicrophoneAccess,
  isMicrophonePermissionDenial,
  microphonePermissionDeniedMessageKey,
  useAsrRecorder,
  type AsrRecorder
} from "../asr-recorder.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ASR recorder duration", () => {
  const transcribe = vi.fn<AsrClient["transcribe"]>();
  const client = { transcribe } as AsrClient;
  let root: ReturnType<typeof createRoot>;
  let recorder: AsrRecorder;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() { return true; }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;

      start() { this.state = "recording"; }
      pause() { this.state = "paused"; }
      resume() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
        this.onstop?.();
      }
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) }
    });
    const container = document.createElement("div");
    root = createRoot(container);
    function Harness() {
      recorder = useAsrRecorder(client);
      return null;
    }
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    transcribe.mockReset();
  });

  it("counts only active audio across multiple pauses and resets for a new recording", async () => {
    await act(async () => recorder.start());
    for (const [activeMs, pausedMs] of [[1_150, 4_000], [700, 5_000]]) {
      vi.advanceTimersByTime(activeMs);
      act(() => recorder.pause());
      vi.advanceTimersByTime(pausedMs);
      act(() => recorder.resume());
    }
    vi.advanceTimersByTime(950);
    await act(async () => {
      const stopped = await recorder.stop();
      expect(stopped.durationMs).toBe(2_800);
      expect(stopped.recording.size).toBe(5);
    });

    await act(async () => recorder.start());
    vi.advanceTimersByTime(1_400);
    await act(async () => {
      expect(await recorder.stop()).toMatchObject({ durationMs: 1_400 });
    });
  });

  it("keeps the duration frozen when finishing while paused", async () => {
    transcribe.mockResolvedValue({
      text: "录音", segments: [], transcribedAt: "2026-11-23T00:00:00Z",
      modelId: "asr", provider: "memmy_account", source: "account"
    });
    const onRecordingReady = vi.fn();
    await act(async () => recorder.start());
    vi.advanceTimersByTime(1_250);
    act(() => recorder.pause());
    vi.advanceTimersByTime(10_000);
    await act(async () => {
      expect(await recorder.finishAndTranscribe({ onRecordingReady })).toMatchObject({ durationMs: 1_250 });
    });
    expect(onRecordingReady).toHaveBeenCalledWith(expect.any(Blob), "audio/webm", 1_250);
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 1_250 }));
  });
});

describe("ASR recorder microphone access", () => {
  it("用户拒绝后再次点击仍会重新请求权限但不会视为已授权", async () => {
    const bridge = {
      getMicrophoneAccessStatus: vi.fn(async () => "denied" as const),
      requestMicrophoneAccess: vi.fn(async () => "denied" as const)
    };

    await expect(ensureMicrophoneAccess(bridge)).rejects.toBeInstanceOf(MicrophonePermissionError);

    expect(bridge.getMicrophoneAccessStatus).toHaveBeenCalledTimes(1);
    expect(bridge.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
  });

  it("已授权时不重复请求系统权限", async () => {
    const bridge = {
      getMicrophoneAccessStatus: vi.fn(async () => "granted" as const),
      requestMicrophoneAccess: vi.fn(async () => "granted" as const)
    };

    await expect(ensureMicrophoneAccess(bridge)).resolves.toBe("granted");

    expect(bridge.getMicrophoneAccessStatus).toHaveBeenCalledTimes(1);
    expect(bridge.requestMicrophoneAccess).not.toHaveBeenCalled();
  });

  it("受系统限制时直接阻断录音启动", async () => {
    const bridge = {
      getMicrophoneAccessStatus: vi.fn(async () => "restricted" as const),
      requestMicrophoneAccess: vi.fn(async () => "granted" as const)
    };

    await expect(ensureMicrophoneAccess(bridge)).rejects.toMatchObject({
      status: "restricted"
    });

    expect(bridge.requestMicrophoneAccess).not.toHaveBeenCalled();
  });

  it("未决定时放行给 getUserMedia 弹出系统权限窗", async () => {
    const bridge = {
      getMicrophoneAccessStatus: vi.fn(async () => "not-determined" as const),
      requestMicrophoneAccess: vi.fn(async () => "not-determined" as const)
    };

    await expect(ensureMicrophoneAccess(bridge)).resolves.toBe("not-determined");
    expect(bridge.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
  });

  it("按平台返回麦克风权限引导文案 key", () => {
    expect(microphonePermissionDeniedMessageKey("darwin")).toBe("asr.error.microphonePermissionDenied.mac");
    expect(microphonePermissionDeniedMessageKey("win32")).toBe("asr.error.microphonePermissionDenied.windows");
    expect(microphonePermissionDeniedMessageKey(undefined)).toBe("asr.error.microphonePermissionDenied.mac");
  });

  it("识别 getUserMedia 权限拒绝错误", () => {
    expect(isMicrophonePermissionDenial(new DOMException("Permission denied", "NotAllowedError"))).toBe(true);
    expect(isMicrophonePermissionDenial(new Error("network offline"))).toBe(false);
  });
});

describe("ASR recorder response handling", () => {
  it("uses the model transcript rather than microphone volume to identify speech", () => {
    expect(hasTranscribedSpeech({ text: "", segments: [] })).toBe(false);
    expect(hasTranscribedSpeech({ text: "  ", segments: [{ text: "你好", startMs: 0 }] })).toBe(true);
    expect(hasTranscribedSpeech({ text: "正常转写", segments: [] })).toBe(true);
  });
});
