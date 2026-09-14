import { describe, expect, it, vi } from "vitest";
import { resolveWindowsStorePackagedResourcesPath } from "../src/main/windows-store-packaged-resources.js";

describe("Windows Store packaged resources", () => {
  it("uses the physical resources directory derived from the loaded ASAR on a non-C drive", () => {
    const pathExists = vi.fn(() => true);
    const result = resolveWindowsStorePackagedResourcesPath({
      isPackaged: true,
      isWindowsStore: true,
      moduleDirectory: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app\\resources\\app.asar\\dist\\main",
      resourcesPath: "C:\\Program Files\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app\\resources"
    }, { pathExists });

    expect(result).toBe("E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app\\resources");
    expect(pathExists).toHaveBeenCalledWith(
      "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app\\resources\\native\\MemmyStoreUpdate.exe"
    );
  });

  it("falls back to Electron resources when the physical helper cannot be verified", () => {
    const result = resolveWindowsStorePackagedResourcesPath({
      isPackaged: true,
      isWindowsStore: true,
      moduleDirectory: "E:\\WindowsApps\\package\\app\\resources\\app.asar\\dist\\main",
      resourcesPath: "C:\\Program Files\\WindowsApps\\package\\app\\resources"
    }, { pathExists: () => false });

    expect(result).toBe("C:\\Program Files\\WindowsApps\\package\\app\\resources");
  });

  it("does not reinterpret ordinary NSIS resources", () => {
    expect(resolveWindowsStorePackagedResourcesPath({
      isPackaged: true,
      isWindowsStore: false,
      moduleDirectory: "D:\\memmy\\resources\\app.asar\\dist\\main",
      resourcesPath: "D:\\memmy\\resources"
    }, { pathExists: () => true })).toBe("D:\\memmy\\resources");
  });
});
