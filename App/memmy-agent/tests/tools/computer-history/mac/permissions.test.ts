import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ execute: vi.fn(), helper: vi.fn(), open: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: native.execute }) }));
vi.mock("../../../../src/tools/computer-history/mac/native-helper.js", () => ({ ensureNativeHistoryHelper: native.helper }));
vi.mock("../../../../src/tools/computer-use/mac-permission-settings.js", () => ({ macPermissionSettingsGuide: { show: native.open } }));
import { readHistoryPermissions, openHistoryPermission } from "../../../../src/tools/computer-history/mac/permissions.js";
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  native.helper.mockResolvedValue("/packaged/native/human-recorder");
  native.execute.mockResolvedValue({ stdout: JSON.stringify({ accessibility: false, inputMonitoring: true, screenRecording: false }) });
  native.open.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
describe("native History permission probe", () => {
  it("uses the recorder helper with a read-only permission probe", async () => {
    await expect(readHistoryPermissions()).resolves.toEqual({ supported: true, accessibility: false, inputMonitoring: true });
    expect(native.execute).toHaveBeenCalledExactlyOnceWith("/packaged/native/human-recorder", ["--permissions"], { timeout: 60_000 });
    expect(native.open).not.toHaveBeenCalled();
  });
  it.each([["accessibility", "--request-accessibility"], ["inputMonitoring", "--request-input-monitoring"]] as const)("requests only %s, never screen capture", async (permission, flag) => {
    await openHistoryPermission(permission, "request");
    expect(native.execute).toHaveBeenCalledExactlyOnceWith("/packaged/native/human-recorder", ["--permissions", flag], { timeout: 60_000 });
    expect(native.open).not.toHaveBeenCalled();
  });
  it.each(["accessibility", "inputMonitoring"] as const)("opens %s settings by default without requesting a native prompt", async (permission) => {
    await openHistoryPermission(permission);
    expect(native.execute).toHaveBeenCalledExactlyOnceWith("/packaged/native/human-recorder", ["--permissions"], { timeout: 60_000 });
    expect(native.open).toHaveBeenCalledExactlyOnceWith("computer-history", permission, true);
  });
  it("rejects malformed native responses instead of treating them as grants", async () => {
    native.execute.mockResolvedValue({ stdout: '{"accessibility":"yes","inputMonitoring":true}' });
    await expect(readHistoryPermissions()).rejects.toThrow("Invalid Computer History permission response");
  });
  it("reports failed settings navigation so the UI can retry", async () => {
    native.open.mockResolvedValue(false);
    await expect(openHistoryPermission("accessibility", "settings")).rejects.toThrow("Could not open");
  });
  it("does not execute macOS helpers on other platforms", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await expect(readHistoryPermissions()).resolves.toEqual({ supported: false, accessibility: false, inputMonitoring: false });
    expect(native.helper).not.toHaveBeenCalled();
  });
});
