import { describe, expect, it } from "vitest";
import {
  desktopRuntimeHomeDirectoryName,
  desktopUserDataDirectoryName,
  resolveDesktopEdition,
  resolveDesktopPackageSigning,
  resolveDesktopWindowsStoreMigrationConfig
} from "../src/main/desktop-edition.js";

describe("desktop edition identity", () => {
  it("defaults to the China package identity", () => {
    expect(resolveDesktopEdition(null)).toBe("cn");
    expect(desktopUserDataDirectoryName("cn")).toBe("Memmy");
    expect(desktopRuntimeHomeDirectoryName("cn")).toBe(".memmy");
  });

  it("resolves the international package identity from the packaged manifest", () => {
    const manifest = JSON.stringify({ edition: "intl", accountChannel: "email" });

    expect(resolveDesktopEdition(manifest)).toBe("intl");
    expect(desktopUserDataDirectoryName("intl")).toBe("Memmy");
    expect(desktopRuntimeHomeDirectoryName("intl")).toBe(".memmy");
  });

  it("prefers edition when both manifest identity fields are present", () => {
    expect(resolveDesktopEdition(JSON.stringify({ edition: "cn", accountChannel: "email" }))).toBe("cn");
    expect(resolveDesktopEdition(JSON.stringify({ edition: "intl", accountChannel: "phone" }))).toBe("intl");
  });

  it("falls back to the build account channel when the manifest is absent", () => {
    expect(resolveDesktopEdition(null, "email")).toBe("intl");
    expect(resolveDesktopEdition(null, "phone")).toBe("cn");
  });

  it("resolves package signing identity from the packaged manifest", () => {
    expect(resolveDesktopPackageSigning(JSON.stringify({ signing: "unsigned" }))).toBe("unsigned");
    expect(resolveDesktopPackageSigning(JSON.stringify({ signing: "signed" }))).toBe("signed");
  });

  it("falls back to the build signing identity when the manifest is absent", () => {
    expect(resolveDesktopPackageSigning(null)).toBe("signed");
    expect(resolveDesktopPackageSigning(JSON.stringify({ signing: "unknown" }), "unsigned")).toBe("unsigned");
  });

  it("reads only the explicit allowlisted Windows Store migration runtime config", () => {
    const storeDestination = {
      edition: "cn",
      storeId: "9MZGLKWMZZV6",
      packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
      aumid: "Memtensor.Memmy_eyack96k521x2!Memmy"
    };
    expect(resolveDesktopWindowsStoreMigrationConfig(JSON.stringify({
      windowsStoreMigration: { internalEnabled: true, storeDestination }
    }))).toEqual({ internalEnabled: true, storeDestination });
    expect(resolveDesktopWindowsStoreMigrationConfig(JSON.stringify({
      windowsStoreMigration: { internalEnabled: false, storeDestination }
    }))?.internalEnabled).toBe(false);
  });

  it("fails closed for missing, malformed, or expanded Store migration config", () => {
    expect(resolveDesktopWindowsStoreMigrationConfig(null)).toBeNull();
    expect(resolveDesktopWindowsStoreMigrationConfig(JSON.stringify({
      windowsStoreMigration: { storeDestination: {} }
    }))).toBeNull();
    expect(resolveDesktopWindowsStoreMigrationConfig(JSON.stringify({
      windowsStoreMigration: { internalEnabled: "true", storeDestination: {} }
    }))).toBeNull();
    expect(resolveDesktopWindowsStoreMigrationConfig(JSON.stringify({
      windowsStoreMigration: {
        internalEnabled: true,
        storeDestination: {},
        unexpected: "value"
      }
    }))).toBeNull();
  });
});
