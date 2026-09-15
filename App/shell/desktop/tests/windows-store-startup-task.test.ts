import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_STORE_STARTUP_TASK_ID,
  getWindowsStoreStartupTaskStatus,
  setWindowsStoreStartupTaskEnabled
} from "../src/main/windows-store-startup-task.js";
import {
  parseWindowsStoreHelperMessage,
  type WindowsStoreStartupTaskResult
} from "../src/main/windows-store-update.js";

const adapterSourcePath = fileURLToPath(new URL(
  "../src/main/windows-store-startup-task.ts",
  import.meta.url
));

describe("Windows Store StartupTask adapter", () => {
  it.each([
    ["disabled", false],
    ["disabled-by-user", false],
    ["disabled-by-policy", false],
    ["enabled", true]
  ] as const)("maps %s to its effective enabled value", async (state, enabled) => {
    const runStoreCommand = vi.fn(async (): Promise<WindowsStoreStartupTaskResult> => ({
      type: "startup-task",
      taskId: WINDOWS_STORE_STARTUP_TASK_ID,
      state
    }));

    await expect(getWindowsStoreStartupTaskStatus("C:\\resources", { runStoreCommand }))
      .resolves.toEqual({ taskId: WINDOWS_STORE_STARTUP_TASK_ID, state, enabled });
    expect(runStoreCommand).toHaveBeenCalledWith({
      resourcesPath: "C:\\resources",
      command: "startup-status"
    });
  });

  it.each([
    ["startup-enable", true],
    ["startup-disable", false]
  ] as const)("uses %s when setting enabled=%s", async (command, enabled) => {
    const runStoreCommand = vi.fn(async (): Promise<WindowsStoreStartupTaskResult> => ({
      type: "startup-task",
      taskId: WINDOWS_STORE_STARTUP_TASK_ID,
      state: enabled ? "enabled" : "disabled"
    }));

    await expect(setWindowsStoreStartupTaskEnabled(
      "C:\\resources",
      enabled,
      { runStoreCommand }
    )).resolves.toMatchObject({ enabled });
    expect(runStoreCommand).toHaveBeenCalledWith({
      resourcesPath: "C:\\resources",
      command
    });
  });

  it("does not report enable success when Windows preserves a user override", async () => {
    const runStoreCommand = vi.fn(async (): Promise<WindowsStoreStartupTaskResult> => ({
      type: "startup-task",
      taskId: WINDOWS_STORE_STARTUP_TASK_ID,
      state: "disabled-by-user"
    }));

    await expect(setWindowsStoreStartupTaskEnabled(
      "C:\\resources",
      true,
      { runStoreCommand }
    )).resolves.toEqual({
      taskId: WINDOWS_STORE_STARTUP_TASK_ID,
      state: "disabled-by-user",
      enabled: false
    });
  });

  it("rejects a helper result for a different manifest task", async () => {
    const runStoreCommand = vi.fn(async (): Promise<WindowsStoreStartupTaskResult> => ({
      type: "startup-task",
      taskId: "UnexpectedTask",
      state: "enabled"
    }));

    await expect(getWindowsStoreStartupTaskStatus("C:\\resources", { runStoreCommand }))
      .rejects.toThrow("unexpected task ID");
  });

  it.each([
    "disabled",
    "disabled-by-user",
    "disabled-by-policy",
    "enabled"
  ] as const)("parses the native %s state", (state) => {
    expect(parseWindowsStoreHelperMessage(JSON.stringify({
      type: "startup-task",
      taskId: WINDOWS_STORE_STARTUP_TASK_ID,
      state
    }))).toEqual({
      type: "startup-task",
      taskId: WINDOWS_STORE_STARTUP_TASK_ID,
      state
    });
  });

  it("contains no executable-path or script-based startup persistence", async () => {
    const source = (await readFile(adapterSourcePath, "utf8")).toLowerCase();

    expect(source).not.toContain("process.execpath");
    expect(source).not.toContain(".vbs");
    expect(source).not.toContain("wscript.exe");
    expect(source).not.toContain("windowsapps\\\\");
  });
});
