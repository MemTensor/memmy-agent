// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginsClient } from "../../api/plugins-client.js";
import { PLUGIN_CHANGE_EVENT } from "../../lib/plugin-change-event.js";
import { createPluginUpdateMonitor } from "../plugin-update-indicator.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });
function fixture(version = "2.0.0", installedVersion: string | null = "1.0.0", canInstall = true, autoUpdateFromVersion?: string) {
  const catalog = vi.fn(async () => [{ manifest: { id: "review", version }, eligibility: { canInstall }, autoUpdateFromVersion }]);
  const list = vi.fn(async () => installedVersion ? [{ id: "review", version: installedVersion }] : []);
  const update = vi.fn(async () => undefined);
  const install = vi.fn();
  const monitor = createPluginUpdateMonitor({ catalog, list, update, install } as unknown as PluginsClient);
  cleanups.push(monitor.subscribe(vi.fn()));
  return { monitor, catalog, list, update, install };
}

describe("desktop plugin update monitor", () => {
  it.each([
    ["2.0.0", "1.0.0", true, true],
    ["1.0.0", "1.0.0", true, false],
    ["1.0.0", "2.0.0", true, false],
    ["2.0.0", null, true, false],
    ["2.0.0", "1.0.0", false, false],
    ["2.0.0-beta.1", "2.0.0", true, false],
    ["2.0.0", "2.0.0-beta.1", true, true]
  ])("compares catalog %s with installed %s and eligibility %s", async (version, installed, eligible, expected) => {
    const f = fixture(version, installed, eligible);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.catalog).toHaveBeenCalledOnce();
    expect(f.monitor.getSnapshot()).toBe(expected);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
  });

  it("keeps the dot across viewing, polling and failed checks; clears after a completed manual update", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.monitor.getSnapshot()).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.monitor.getSnapshot()).toBe(true);
    f.catalog.mockRejectedValueOnce(new Error("offline"));
    await f.monitor.refresh();
    expect(f.monitor.getSnapshot()).toBe(true);
    f.list.mockResolvedValue([{ id: "review", version: "2.0.0" }]);
    window.dispatchEvent(new Event(PLUGIN_CHANGE_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.monitor.getSnapshot()).toBe(false);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    const checks = f.catalog.mock.calls.length;
    cleanups.pop()!();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.catalog).toHaveBeenCalledTimes(checks);
  });

  it("automatically requests the pinned target outside the marketplace, coalesces pending updates and retries failures on a later check", async () => {
    vi.useFakeTimers();
    const f = fixture("2.0.0", "1.0.0", true, "1.0.0");
    let fail!: (error: Error) => void;
    f.update.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.update).toHaveBeenCalledExactlyOnceWith("review", "2.0.0", "1.0.0");
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.update).toHaveBeenCalledOnce();
    fail(new Error("registry temporarily offline"));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event(PLUGIN_CHANGE_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.monitor.getSnapshot()).toBe(true);
    f.update.mockImplementationOnce(async () => {
      f.list.mockResolvedValue([{ id: "review", version: "2.0.0" }]);
      window.dispatchEvent(new Event(PLUGIN_CHANGE_EVENT));
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.monitor.getSnapshot()).toBe(false);
    expect(f.install).not.toHaveBeenCalled();
  });

  it("does not submit a stale automatic check after the installed version changes", async () => {
    vi.useFakeTimers();
    const f = fixture("3.0.0", "2.0.0", true, "1.0.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.monitor.getSnapshot()).toBe(true);
  });

  it("ignores checks that complete after the account view unsubscribes", async () => {
    let finish!: (value: unknown[]) => void;
    const monitor = createPluginUpdateMonitor({
      catalog: () => new Promise(resolve => { finish = resolve; }),
      list: async () => [{ id: "review", version: "1.0.0" }]
    } as unknown as PluginsClient);
    const listener = vi.fn();
    const stop = monitor.subscribe(listener);
    stop();
    finish([{ manifest: { id: "review", version: "2.0.0" }, eligibility: { canInstall: true } }]);
    await monitor.refresh();
    expect(listener).not.toHaveBeenCalled();
    expect(monitor.getSnapshot()).toBe(false);
  });
});
