import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginUpdateService } from "../plugin-update-service.js";
import { compareVersions, type PluginService } from "../plugin-service.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  let busy = false;
  const entries = ["teach-mode", "not-installed"].map(id => ({ manifest: { id, version: id === "teach-mode" ? "0.2.0" : "1.0.0" },
    eligibility: { visible: true, canInstall: true, canUse: true, reason: null } }));
  const manifest: { rules?: { autoUpdate: boolean } } = { rules: { autoUpdate: true } };
  const update = vi.fn(async () => ({})), catalog = vi.fn(async () => entries);
  const plugins = { list: () => [{ id: "teach-mode", version: "0.1.0", state: "active", manifest }],
    catalog, isBusy: () => busy, update } as unknown as PluginService;
  return { plugins, update, catalog, manifest, entries, setBusy: (value: boolean) => { busy = value; } };
}
describe("automatic plugin updates", () => {
  it("keeps manifests without an explicit automatic-update rule on manual updates", async () => {
    const f = fixture(), updates = createPluginUpdateService(f.plugins);
    delete f.manifest.rules;
    await updates.check(); expect(f.update).not.toHaveBeenCalled();
    await updates.close();
  });
  it("honors official update rules and current account eligibility", async () => {
    const f = fixture(), updates = createPluginUpdateService(f.plugins);
    f.manifest.rules = { autoUpdate: false };
    await updates.check(); expect(f.update).not.toHaveBeenCalled();
    f.manifest.rules.autoUpdate = true;
    f.entries[0]!.eligibility.canUse = false;
    await updates.check(); expect(f.update).not.toHaveBeenCalled();
    f.entries[0]!.eligibility.canUse = true;
    await updates.check(); expect(f.update).toHaveBeenCalledWith("teach-mode", "0.2.0");
    await updates.close();
  });
  it("checks at startup and every six hours, without automatically installing catalog entries", async () => {
    vi.useFakeTimers(); const f = fixture(), updates = createPluginUpdateService(f.plugins);
    updates.start(); await vi.advanceTimersByTimeAsync(0); expect(f.update).toHaveBeenCalledWith("teach-mode", "0.2.0");
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(f.catalog).toHaveBeenCalledTimes(2); expect(f.update).toHaveBeenCalledTimes(2);
    await updates.close(); await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(f.catalog).toHaveBeenCalledTimes(2);
  });
  it("defers while the plugin owns a recording lease or active call", async () => {
    const f = fixture(), updates = createPluginUpdateService(f.plugins); f.setBusy(true);
    await updates.check(); expect(f.update).not.toHaveBeenCalled();
    f.setBusy(false); await updates.check(); expect(f.update).toHaveBeenCalledTimes(1); await updates.close();
  });
  it("leaves a failed update and offline check recoverable", async () => {
    const f = fixture(), updates = createPluginUpdateService(f.plugins);
    f.update.mockRejectedValueOnce(new Error("checksum mismatch")); await updates.check();
    f.catalog.mockRejectedValueOnce(new Error("offline")); await expect(updates.check()).rejects.toThrow("offline");
    await updates.check(); expect(f.update).toHaveBeenCalledTimes(2); await updates.close();
  });
  it("orders prereleases and stable versions correctly", () => {
    expect(compareVersions("1.2.3-rc.7", "1.2.3-rc.6")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-rc.7", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
  });
});
