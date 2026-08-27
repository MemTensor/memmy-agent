/** Asr recorder tests. */
import { describe, expect, it, vi } from "vitest";
import {
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
