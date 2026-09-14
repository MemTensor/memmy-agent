import { describe, expect, it, vi } from "vitest";
import {
  executeWindowsStoreTransitionPreReady,
  runWindowsStoreTransitionPreReadyWorker,
  type WindowsStoreTransitionPreReadyInput
} from "../src/main/windows-store-transition-pre-ready.js";

const input: WindowsStoreTransitionPreReadyInput = {
  legacy: {
    platform: "win32",
    isPackaged: true,
    isWindowsStore: true,
    resourcesPath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\resources",
    localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
    roamingAppDataPath: "C:\\Users\\lee\\AppData\\Roaming",
    homeDirectory: "C:\\Users\\lee",
    storeUserDataPath: "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy",
    desktopPath: "E:\\Users\\lee\\Desktop",
    identity: {
      edition: "intl",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
      aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
    }
  }
};

describe("Windows Store pre-ready transition", () => {
  it("closes legacy processes before the one-time data import", async () => {
    const actions: string[] = [];
    const stopLegacy = vi.fn(async () => {
      actions.push("legacy");
      return true;
    });
    const record = { schemaVersion: 1 as const, status: "no-data" as const, generation: "standalone", checkedAt: "now" };
    const importData = vi.fn(async () => {
      actions.push("transition");
      return record;
    });

    await expect(executeWindowsStoreTransitionPreReady(input, { stopLegacy, importData }))
      .resolves.toEqual({ status: "ready", record });
    expect(actions).toEqual(["legacy", "transition"]);
  });

  it("starts the packaged executable as a synchronous plain-Node worker", () => {
    const execWorker = vi.fn(() => JSON.stringify({ status: "blocked" }));
    runWindowsStoreTransitionPreReadyWorker({
      executablePath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\Memmy.exe",
      workerPath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\resources\\app.asar\\dist\\main\\windows-store-transition-pre-ready-worker.js",
      input
    }, { execWorker });

    expect(execWorker).toHaveBeenCalledOnce();
    const [executablePath, args, options] = execWorker.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(executablePath).toBe("E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\Memmy.exe");
    expect(args[0]).toContain("windows-store-transition-pre-ready-worker.js");
    expect(JSON.parse(Buffer.from(args[1], "base64url").toString("utf8"))).toEqual(input);
    expect(options).toMatchObject({ windowsHide: true, timeout: 600_000 });
    expect(options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it.each([false, new Error("access denied")])("does not touch data if the old app cannot be closed: %s", async (result) => {
    const importData = vi.fn();
    await expect(executeWindowsStoreTransitionPreReady(input, {
      stopLegacy: async () => { if (result instanceof Error) throw result; return result; }, importData
    })).resolves.toEqual({ status: "blocked" });
    expect(importData).not.toHaveBeenCalled();
  });

  it("rejects ambiguous executable and worker paths before spawning", () => {
    expect(() => runWindowsStoreTransitionPreReadyWorker({
      executablePath: "Memmy.exe",
      workerPath: "C:\\worker.js",
      input
    })).toThrow("executable path is invalid");
    expect(() => runWindowsStoreTransitionPreReadyWorker({
      executablePath: "C:\\Memmy.exe",
      workerPath: "worker.js",
      input
    })).toThrow("worker script path is invalid");
  });

  it("rechecks occupancy after copy failure and leaves that import retryable", async () => {
    const writeRecord = vi.fn(async () => undefined);
    const stopLegacy = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await executeWindowsStoreTransitionPreReady(input, { stopLegacy, writeRecord,
      importData: async () => ({ schemaVersion: 1, status: "failed", generation: "standalone", checkedAt: "now", error: "EBUSY" }) });
    expect(result.status).toBe("blocked");
    expect(writeRecord).toHaveBeenCalledWith(input.legacy.storeUserDataPath, expect.objectContaining({ retryAfterLegacyExit: true }));
  });
});
