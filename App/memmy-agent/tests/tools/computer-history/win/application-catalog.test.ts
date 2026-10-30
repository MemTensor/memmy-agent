import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../../../src/tools/computer-history/win/application-catalog.js";
import * as settings from "../../../../src/tools/computer-history/win/settings.js";
import { WindowsPlatformDriver } from "../../../../src/tools/computer-history/win/platform-driver.js";
import { bindSettings } from "../../../../src/tools/computer-history/win/session-policy.js";
import { context, executable } from "./fixtures.js";
import { authorizedRule } from "../../../../src/tools/computer-history/win/policy.js";

const envelope = (applications: unknown[]) => ({ protocol: "memmy.windows.computer-history", version: 1,
  platform: "windows", kind: "application.catalog", applications });
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Windows display application catalog", () => {
  it("validates names and paths without accepting capture identity or unknown fields", () => {
    const entry = { executable, name: "中文应用 📝" };
    expect(catalog.parseApplicationCatalog(envelope([entry]))).toEqual([entry]);
    for (const applications of [[{ ...entry, pid: 1 }], [{ ...entry, executable: "tool.exe" }],
      [{ ...entry, name: "secret\nline" }], [{ ...entry, name: "x".repeat(257) }],
      [entry, { ...entry, executable: executable.toUpperCase() }], Array(513).fill(entry)]) {
      expect(() => catalog.parseApplicationCatalog(envelope(applications))).toThrow("windows_catalog_invalid");
    }
    expect(() => catalog.parseApplicationCatalog({ ...envelope([entry]), version: 2 })).toThrow();
  });
  it("uses full-path identities, retains consent and never makes installed entries running", () => {
    const installed = [{ executable, name: "中文编辑器" }, { executable: "C:\\Other\\Fixture.exe", name: "中文编辑器" },
      { executable: "C:\\Apps\\chrome.exe", name: "Friendly browser" }];
    const input = settings.parseWindowsSettings({ version: 1, applications: [{ executable,
      searchFields: [{ controlType: "Edit", automationId: "search" }] }], deny: { executables: ["C:\\Other\\Fixture.exe"] } });
    const apps = settings.applicationCatalog([{ ...context, executable: executable.toUpperCase() }], input, installed);
    expect(apps.filter((app) => app.name === "中文编辑器").map((app) => app.id)[0]).not.toBe(apps.filter((app) => app.name === "中文编辑器")[1]!.id);
    expect(apps.find((app) => app.running)).toMatchObject({ allowed: true, name: "中文编辑器", rule: input.applications[0] });
    expect(apps.find((app) => app.executable === installed[1]!.executable)).toMatchObject({ running: false, allowed: false });
    expect(apps.find((app) => app.executable === installed[2]!.executable)).toMatchObject({ supported: false, allowed: false, running: false });
  });
  it("caches display metadata separately and keeps readiness dependent on live bindings", async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-catalog-")); roots.push(root);
    const binary = path.join(root, "native.exe"), recorder = path.join(root, "recorder.js");
    fs.writeFileSync(binary, "never executed"); fs.writeFileSync(recorder, "never executed");
    const store = new settings.WindowsSettingsStore(path.join(root, "settings.json"));
    store.write({ version: 1, applications: [{ executable }] });
    const live = vi.spyOn(settings, "discoverApplications").mockResolvedValue([]);
    const display = vi.spyOn(catalog, "discoverApplicationCatalog").mockResolvedValue([{ executable, name: "Installed fixture" }]);
    const driver = new WindowsPlatformDriver(store, binary, recorder);
    expect((await driver.configuration()).applications[0]).toMatchObject({ name: "Installed fixture", running: false });
    expect((await driver.readPermissions()).ready).toBe(false);
    expect(authorizedRule(bindSettings(store, []), context)).toBeNull();
    live.mockResolvedValue([context]);
    expect((await driver.configuration()).permissions.ready).toBe(true);
    expect(display).toHaveBeenCalledOnce();
    display.mockRejectedValue(new Error("catalog unavailable"));
    await vi.advanceTimersByTimeAsync(60001);
    const fallback = await driver.configuration();
    expect(fallback.applications[0]).toMatchObject({ name: path.win32.basename(executable), running: true });
    expect(fallback.permissions.ready).toBe(true);
  });
});
