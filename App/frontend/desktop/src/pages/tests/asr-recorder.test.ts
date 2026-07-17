/** Asr recorder tests. */
import { describe, expect, it, vi } from "vitest";
import { MicrophonePermissionError, ensureMicrophoneAccess } from "../asr-recorder.js";

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
});
