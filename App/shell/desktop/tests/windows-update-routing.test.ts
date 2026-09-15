import { describe, expect, it, vi } from "vitest";
import { checkLegacyUpdateThenStore } from "../src/main/windows-update-routing.js";
import type { DesktopUpdateCheckResult } from "@memmy/desktop-interface";

const store: DesktopUpdateCheckResult = { status: "available", provider: "store-migration", currentVersion: "1.1.4", updateMode: "manual" };
describe("NSIS before Web Install", () => {
  it("keeps a 1.1.3 to 1.1.4 NSIS upgrade ahead of Store", async () => {
    const legacy: DesktopUpdateCheckResult = { status: "available", provider: "legacy-installer", currentVersion: "1.1.3", latestVersion: "1.1.4", downloadUrl: "https://example.test/Memmy-1.1.4.exe" };
    const checkStore = vi.fn(async () => store);
    expect(await checkLegacyUpdateThenStore({ checkLegacy: async () => legacy, checkStore })).toEqual(legacy);
    expect(checkStore).not.toHaveBeenCalled();
  });
  it.each(["latest", "not-configured"] as const)("offers Store when NSIS is %s", async (status) => {
    expect(await checkLegacyUpdateThenStore({ checkLegacy: async () => ({ status, currentVersion: "1.1.4" }), checkStore: async () => store })).toEqual(store);
  });
  it("offers Store if the legacy update endpoint was removed", async () => {
    expect(await checkLegacyUpdateThenStore({ checkLegacy: async () => { throw new Error("404"); }, checkStore: async () => store })).toEqual(store);
  });
  it("preserves legacy errors when Store migration is disabled", async () => {
    await expect(checkLegacyUpdateThenStore({ checkLegacy: async () => { throw new Error("offline"); }, checkStore: async () => null })).rejects.toThrow("offline");
  });
});
