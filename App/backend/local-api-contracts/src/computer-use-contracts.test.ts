import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_ONBOARDING_PREFIX,
  SCREEN_CAPTURE_PREFIX,
  isComputerUseOnboardingRequest,
  isComputerUsePermissions,
  isComputerUseProbeTarget,
  isScreenCaptureMessage,
  isScreenCaptureRequest,
  isScreenCaptureResult,
} from "./index.js";

describe("computer-use local API exports", () => {
  it("exports and validates the permission onboarding messages", () => {
    expect(COMPUTER_USE_ONBOARDING_PREFIX).toBe("memmy:computer-use-onboarding:");
    expect(isComputerUseOnboardingRequest({
      type: `${COMPUTER_USE_ONBOARDING_PREFIX}prepare`,
      requestId: "prepare-1",
    })).toBe(true);
    expect(isComputerUseOnboardingRequest({
      type: `${COMPUTER_USE_ONBOARDING_PREFIX}guide`,
      requestId: "guide-1",
      reason: "accessibility",
      helperApp: "/Applications/Open Computer Use.app",
      canContinue: false,
    })).toBe(true);
    expect(isComputerUseOnboardingRequest({
      type: `${COMPUTER_USE_ONBOARDING_PREFIX}guide`,
      requestId: "guide-1",
      reason: "accessibility",
      helperApp: "/tmp/helper.app",
    })).toBe(false);
    expect(isComputerUseOnboardingRequest({
      type: `${COMPUTER_USE_ONBOARDING_PREFIX}prepare`,
      requestId: "prepare-1",
      extra: true,
    })).toBe(false);
  });

  it("bounds permission probe payloads and states", () => {
    expect(isComputerUsePermissions({
      accessibility: "granted",
      screenRecording: "required",
      failure: "helperPauseFailed",
    })).toBe(true);
    expect(isComputerUsePermissions({
      accessibility: "granted",
      screenRecording: "required",
      unexpected: true,
    })).toBe(false);
    expect(isComputerUseProbeTarget({ app: "com.example.Helper", pid: 42 })).toBe(true);
    expect(isComputerUseProbeTarget({ app: "/Applications/Helper.app", pid: 42 })).toBe(false);
    expect(isComputerUseProbeTarget({ app: "com.example.Helper", pid: 0 })).toBe(false);
  });

  it("exports and validates screen capture requests and results", () => {
    expect(SCREEN_CAPTURE_PREFIX).toBe("memmy:screen-capture:");
    const request = {
      type: `${SCREEN_CAPTURE_PREFIX}request`,
      requestId: "capture-1",
      displayId: "7",
    };
    expect(isScreenCaptureMessage(request)).toBe(true);
    expect(isScreenCaptureRequest(request)).toBe(true);
    expect(isScreenCaptureRequest({ ...request, displayId: "../../secret" })).toBe(false);
    expect(isScreenCaptureRequest({ ...request, command: "open" })).toBe(false);

    expect(isScreenCaptureResult({
      ok: true,
      pngBase64: "png",
      displayId: "7",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      width: 1280,
      height: 720,
    })).toBe(true);
    expect(isScreenCaptureResult({
      ok: false,
      code: "permission_required",
      message: "Screen recording permission is required",
    })).toBe(true);
    expect(isScreenCaptureResult({
      ok: false,
      code: "permission_required",
      message: "x".repeat(2001),
    })).toBe(false);
  });
});
