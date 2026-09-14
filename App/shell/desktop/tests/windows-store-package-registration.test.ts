import { describe, expect, it, vi } from "vitest";
import { queryWindowsPackageFamilyRegistration } from "../src/main/windows-store-package-registration.js";

describe("Windows package-family registration query", () => {
  it("uses the native helper for the current-user package-family query", async () => {
    const runHelper = vi.fn(async () => ({
      stdout: `${JSON.stringify({
        type: "package-family-registration",
        packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
        registered: true,
        packageFullNames: ["Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2"]
      })}\n`,
      stderr: ""
    }));

    await expect(queryWindowsPackageFamilyRegistration({
      resourcesPath: "D:\\memmy\\resources",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    }, { runHelper })).resolves.toEqual({
      registered: true,
      packageFullNames: ["Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2"]
    });
    expect(runHelper).toHaveBeenCalledWith(
      "D:\\memmy\\resources\\native\\MemmyStoreUpdate.exe",
      [
        "package-family-registration",
        "--package-family-name",
        "Memtensor.MemmyAgent_eyack96k521x2"
      ]
    );
  });

  it("accepts an explicit current-user not-registered result", async () => {
    await expect(queryWindowsPackageFamilyRegistration({
      resourcesPath: "D:\\memmy\\resources",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    }, {
      runHelper: async () => ({
        stdout: JSON.stringify({
          type: "package-family-registration",
          packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
          registered: false,
          packageFullNames: []
        }),
        stderr: ""
      })
    })).resolves.toEqual({ registered: false, packageFullNames: [] });
  });

  it("fails closed on mismatched or internally inconsistent helper output", async () => {
    const options = {
      resourcesPath: "D:\\memmy\\resources",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    };
    await expect(queryWindowsPackageFamilyRegistration(options, {
      runHelper: async () => ({
        stdout: JSON.stringify({
          type: "package-family-registration",
          packageFamilyName: "Other.Package_family",
          registered: false,
          packageFullNames: []
        }),
        stderr: ""
      })
    })).rejects.toThrow("does not match the requested package family");
    await expect(queryWindowsPackageFamilyRegistration(options, {
      runHelper: async () => ({
        stdout: JSON.stringify({
          type: "package-family-registration",
          packageFamilyName: options.packageFamilyName,
          registered: false,
          packageFullNames: ["Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2"]
        }),
        stderr: ""
      })
    })).rejects.toThrow("internally inconsistent");
  });

  it("fails closed when the native query itself fails", async () => {
    const queryError = Object.assign(new Error("native query failed"), { code: 2 });
    await expect(queryWindowsPackageFamilyRegistration({
      resourcesPath: "D:\\memmy\\resources",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    }, {
      runHelper: async () => {
        throw queryError;
      }
    })).rejects.toBe(queryError);
  });

  it("fails closed when a nominally successful helper writes stderr", async () => {
    await expect(queryWindowsPackageFamilyRegistration({
      resourcesPath: "D:\\memmy\\resources",
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    }, {
      runHelper: async () => ({
        stdout: JSON.stringify({
          type: "package-family-registration",
          packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
          registered: false,
          packageFullNames: []
        }),
        stderr: "warning"
      })
    })).rejects.toThrow("unexpected stderr");
  });
});
