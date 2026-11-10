/** Asr recorder tests. */
import { describe, expect, it, vi } from "vitest";
import {
  asrErrorMessageKey,
  hasTranscribedSpeech,
  MicrophonePermissionError,
  ensureMicrophoneAccess,
  isMicrophonePermissionDenial,
  microphonePermissionDeniedMessageKey
} from "../asr-recorder.js";

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


describe("ASR error presentation", () => {
  it.each([
    ["empty_audio", "asr.error.emptyAudio"],
    ["audio_too_large", "asr.error.audioTooLarge"],
    ["unauthorized", "home.asrAccessDenied"],
    ["forbidden", "home.asrAccessDenied"],
    ["rate_limited", "home.asrRateLimited"],
    ["invalid_argument", "home.asrInvalidConfiguration"],
    ["internal", "home.asrServiceUnavailable"]
  ])("classifies the HTTP fallback code %s instead of the earlier network error", (code, key) => {
    const cause = Object.assign(new Error("private provider details"), { code });
    const error = Object.assign(new Error("Realtime ASR: network failure; HTTP ASR: private details", { cause }), {
      name: "AsrTranscriptionError"
    });
    expect(asrErrorMessageKey(error)).toBe(key);
  });

  it.each([
    [new DOMException("expired", "TimeoutError"), "home.asrTimeout"],
    [new Error("request timed out"), "home.asrTimeout"],
    [new TypeError("Failed to fetch"), "home.asrConnectionFailed"],
    [new Error("HTTP 200: missing choices[0].message.content"), "home.asrFailed"],
    [new Error("provider URL and private response"), "home.asrFailed"],
    [null, "home.asrFailed"]
  ])("returns a safe key for %s", (error, key) => {
    expect(asrErrorMessageKey(error)).toBe(key);
  });

  it("keeps microphone settings guidance", () => {
    expect(asrErrorMessageKey(new MicrophonePermissionError("denied"))).toBe(microphonePermissionDeniedMessageKey());
  });
});


it("reports an upstream model rejection as unavailable rather than unconfigured", () => {
  const error = Object.assign(new Error("ASR selected-model HTTP 404 (model_not_found)"), { code: "model_selection_unavailable" });
  expect(asrErrorMessageKey(error)).toBe("home.asrModelUnavailable");
});
