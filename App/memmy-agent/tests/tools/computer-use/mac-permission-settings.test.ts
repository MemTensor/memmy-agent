import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputerHistoryDemoService } from "../../../src/tools/computer-history/mac/computer-history-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerUsePermissionError, computerHistoryPermissionError, MacPermissionSettingsGuide, macPermissionSettingsGuide } from "../../../src/tools/computer-use/mac-permission-settings.js";
import { MCPToolWrapper } from "../../../src/core/agent-runtime/tools/mcp.js";
import { checkPermissions } from "../../../src/tools/computer-history/mac/record-human-history.js";
const text = "Accessibility permission is required. Run `open-computer-use doctor` and grant access to Open Computer Use.";
const denied = () => ({ isError: true, content: [{ type: "text", text }] });
afterEach(() => vi.restoreAllMocks());

describe("macOS permission guidance", () => {
  it("opens only the fixed panel once across concurrent calls and repeated failures", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const guide = new MacPermissionSettingsGuide("darwin", open);
    await Promise.all([guide.show("computer-use", "accessibility"), guide.show("computer-use", "accessibility")]);
    await guide.show("computer-use", "accessibility");
    expect(open).toHaveBeenCalledExactlyOnceWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    await guide.show("computer-history", "inputMonitoring");
    expect(open).toHaveBeenLastCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent");
  });
  it.each(["linux", "win32"])("does not open macOS settings on %s", async (platform) => {
    const open = vi.fn();
    expect(await new MacPermissionSettingsGuide(platform, open).show("computer-use", "accessibility")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("allows a later retry after opening Settings fails", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined);
    const guide = new MacPermissionSettingsGuide("darwin", open);
    expect(await guide.show("computer-use", "accessibility")).toBe(false);
    expect(await guide.show("computer-use", "accessibility")).toBe(true);
  });
  it("does not mistake page text, another server or app safety policy for a permission request", () => {
    expect(computerUsePermissionError("open_computer_use", denied())).toBe("accessibility");
    expect(computerUsePermissionError("another_server", denied())).toBeNull();
    expect(computerUsePermissionError("open_computer_use", { ...denied(), isError: false })).toBeNull();
    expect(computerUsePermissionError("open_computer_use", { isError: true, content: [{ type: "text", text: "Computer Use is not allowed to use the app 'test' for safety reasons." }] })).toBeNull();
  });
  it("opens Settings from a real MCP error without repeating the action", async () => {
    const show = vi.spyOn(macPermissionSettingsGuide, "show").mockResolvedValue(true);
    const callTool = vi.fn().mockResolvedValue(denied());
    const tool = new MCPToolWrapper({ callTool }, "open_computer_use", { name: "click" });
    const result = await tool.execute({ app: "Notes", element_index: 1 });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("computer-use", "accessibility");
    expect(JSON.stringify(result)).toContain(text);
    expect(JSON.stringify(result)).toContain("Do not claim permission was granted");
  });
  it("preserves ordinary tool results without showing Settings", async () => {
    const show = vi.spyOn(macPermissionSettingsGuide, "show").mockResolvedValue(true);
    const tool = new MCPToolWrapper({ callTool: async () => ({ content: [{ type: "text", text }] }) }, "open_computer_use", { name: "get_app_state" });
    await tool.execute();
    expect(show).not.toHaveBeenCalled();
  });
  it("recognizes the recorder failure and guides one permission at a time", () => {
    const prefix = "human history recording failed: missing macOS permission: ";
    expect(computerHistoryPermissionError(prefix + "Input Monitoring, Accessibility. Grant it to the app.")).toBe("accessibility");
    expect(computerHistoryPermissionError(prefix + "Input Monitoring. Grant it to the app.")).toBe("inputMonitoring");
    expect(computerHistoryPermissionError("a page mentions missing macOS permission: Accessibility.")).toBeNull();
  });
});

describe("recorder requests only required missing permissions", () => {
  const granted = { accessibility: true, inputMonitoring: true, screenRecording: false, mainDisplayWidth: 100, mainDisplayHeight: 100 };
  it("does not request Screen Recording for screenshot-free History", async () => {
    const read = vi.fn().mockResolvedValue(granted);
    await expect(checkPermissions("recorder", { screenshots: false }, read)).resolves.toEqual(granted);
    expect(read).toHaveBeenCalledExactlyOnceWith("recorder", "--permissions");
  });
  it("requests only missing Accessibility and checks the returned status", async () => {
    const read = vi.fn().mockResolvedValueOnce({ ...granted, accessibility: false }).mockResolvedValue(granted);
    await checkPermissions("recorder", { screenshots: false }, read);
    expect(read).toHaveBeenLastCalledWith("recorder", "--permissions", ["--request-accessibility"]);
  });
  it("does not claim access after a denied native prompt", async () => {
    const read = vi.fn().mockResolvedValue({ ...granted, inputMonitoring: false });
    await expect(checkPermissions("recorder", { screenshots: false }, read)).rejects.toThrow("missing macOS permission: Input Monitoring.");
    expect(read).toHaveBeenLastCalledWith("recorder", "--permissions", ["--request-input-monitoring"]);
  });
  it("requests Screen Recording only for screenshot capture", async () => {
    const read = vi.fn().mockResolvedValueOnce(granted).mockResolvedValue({ ...granted, screenRecording: true });
    await checkPermissions("recorder", { screenshots: true }, read);
    expect(read).toHaveBeenLastCalledWith("recorder", "--permissions", ["--request-screen-recording"]);
  });
});

it("returns structured onboarding status after a recorder permission race", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-permission-recorder-"));
  const recorder = path.join(root, "denied.mjs");
  fs.writeFileSync(recorder, 'console.error("human history recording failed: missing macOS permission: Input Monitoring, Accessibility. Grant it to the app."); process.exitCode = 1;');
  const show = vi.spyOn(macPermissionSettingsGuide, "show").mockResolvedValue(true);
  const service = new ComputerHistoryDemoService({ recorderScript: recorder,
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
  try {
    service.startObservation();
    await vi.waitFor(() => expect(service.snapshot().observation.state).toBe("stopped"));
    expect(service.snapshot().observation.segmentId).toBeNull();
    expect(show).not.toHaveBeenCalled();
    expect(service.snapshot().observation).toMatchObject({ error: null, permissions: { supported: true, accessibility: false, inputMonitoring: false } });
  } finally {
    await service.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

 it("allows repeated explicit settings opens even after an automatic jump", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  const guide = new MacPermissionSettingsGuide("darwin", open);
  await guide.show("computer-history", "inputMonitoring");
  await guide.show("computer-history", "inputMonitoring");
  expect(open).toHaveBeenCalledTimes(1);
  await guide.show("computer-history", "inputMonitoring", true);
  await guide.show("computer-history", "inputMonitoring", true);
  expect(open).toHaveBeenCalledTimes(3);
});
