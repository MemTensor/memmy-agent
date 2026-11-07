import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObservationSettingsStore } from "../../../../src/tools/computer-history/core/settings-store.js";
import { DEFAULT_OBSERVATION_SETTINGS, applicationObservationDecision, evaluateObservation, parseObservationSettings } from "../../../../src/tools/computer-history/core/observation-settings.js";
import { WindowsSettingsStore } from "../../../../src/tools/computer-history/win/settings.js";
import { migrateWindowsObservation, windowsScopeAllows, windowsScopeRule } from "../../../../src/tools/computer-history/win/unified-settings.js";
import { authorizedRule } from "../../../../src/tools/computer-history/win/policy.js";
import { bindSettings } from "../../../../src/tools/computer-history/win/session-policy.js";

const directories: string[] = [];
const a = "C:\\Apps\\one\\Code.exe", b = "C:\\Apps\\two\\Code.exe", chrome = "C:\\Apps\\chrome.exe";
const defaults = () => structuredClone(DEFAULT_OBSERVATION_SETTINGS);
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function stores() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-unified-settings-")); directories.push(directory);
  const shared = new ObservationSettingsStore(path.join(directory, "observation.json"));
  const file = path.join(directory, "windows.json");
  return { file, shared, legacy: new WindowsSettingsStore(file), unified: new WindowsSettingsStore(file, shared) };
}

describe("unified Windows observation policy", () => {
  it("migrates the intersection, preserves websites and metadata, and never authorizes a same-named executable", () => {
    const { file, shared, legacy, unified } = stores();
    legacy.write({ version: 1, applications: [{ executable: a, documentRegions: [] }, { executable: chrome }] });
    const settings = defaults(); settings.memory.syncEnabled = false;
    settings.observation.rules = [{ scope: "app", bundleID: "win32.chrome", behavior: "do_not_observe" },
      { scope: "url", urlDomain: "bank.example", behavior: "do_not_observe" }];
    shared.write(settings);
    const migrated = unified.readObservation()!;
    expect(windowsScopeAllows(migrated, a)).toBe(true);
    for (const executable of [b, chrome, "C:\\Other.exe"]) expect(windowsScopeAllows(migrated, executable)).toBe(false);
    expect(migrated.memory.syncEnabled).toBe(false);
    expect(migrated.observation.rules).toContainEqual(settings.observation.rules[1]);
    expect(unified.read().applications.find(rule => rule.executable === a)?.documentRegions).toEqual([]);
    const first = fs.readFileSync(shared.filePath, "utf8");
    expect(unified.readObservation()).toEqual(migrated);
    expect(fs.readFileSync(shared.filePath, "utf8")).toBe(first);
    expect(fs.existsSync(`${file}.before-unification.json`)).toBe(true);
    expect(fs.existsSync(`${shared.filePath}.before-unification.json`)).toBe(true);
  });

  it.each(["observe", "do_not_observe"] as const)("preserves effective rules for legacy default %s", behavior => {
    const shared = defaults(); shared.observation.defaultApplicationBehavior = "do_not_observe";
    shared.observation.rules = [{ scope: "app", bundleID: "win32.code", behavior: "observe" }, windowsScopeRule(b, "do_not_observe")];
    const legacy = { version: 1 as const, defaultApplicationBehavior: behavior, applications: [{ executable: a }, { executable: b }], deny: { executables: [b] } };
    const migrated = migrateWindowsObservation(legacy, shared);
    for (const executable of [a, b, chrome, "C:\\Another\\Code.exe"]) {
      const oldAllowed = (behavior === "observe" || legacy.applications.some(rule => rule.executable === executable))
        && !legacy.deny.executables.includes(executable) && windowsScopeAllows(shared, executable);
      expect(windowsScopeAllows(migrated, executable)).toBe(oldAllowed);
    }
    expect(migrateWindowsObservation(legacy, migrated)).toEqual(migrated);
  });

  it("uses the shared rules for native bindings, catalog edits and later tool updates", () => {
    const { shared, legacy, unified } = stores();
    legacy.write({ version: 1, defaultApplicationBehavior: "observe", applications: [] });
    unified.read();
    const next = defaults(); next.observation.defaultApplicationBehavior = "do_not_observe";
    next.observation.rules = [windowsScopeRule(a, "observe"), { scope: "url", urlDomain: "bank.example", behavior: "do_not_observe" }];
    shared.write(next);
    const bindings = [a, b].map((executable, index) => ({ executable, pid: index + 100, processStart: "123", hwnd: "456" }));
    expect(authorizedRule(bindSettings(unified, bindings), bindings[0]!)).not.toBeNull();
    expect(authorizedRule(bindSettings(unified, bindings), bindings[1]!)).toBeNull();
    unified.write({ version: 1, applications: [{ executable: b }] });
    expect(windowsScopeAllows(shared.readStrict(), a)).toBe(false);
    expect(windowsScopeAllows(shared.readStrict(), b)).toBe(true);
    expect(shared.readStrict().observation.rules).toContainEqual(next.observation.rules[1]);
    expect(unified.read()).not.toHaveProperty("observationSettingsVersion");
  });

  it("fails without replacing either policy when a shared file is corrupt", () => {
    const { file, shared, legacy, unified } = stores();
    legacy.write({ version: 1, applications: [{ executable: a }] });
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(shared.filePath, "broken");
    expect(() => unified.read()).toThrow("invalid Computer History settings file");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readFileSync(shared.filePath, "utf8")).toBe("broken");
  });
  it("does not restore broad defaults if the canonical policy disappears after migration", () => {
    const { shared, legacy, unified } = stores();
    legacy.write({ version: 1, applications: [{ executable: a }] });
    unified.read(); fs.unlinkSync(shared.filePath);
    expect(() => unified.read()).toThrow("windows_settings_invalid");
  });

  it("keeps app permission independent of a missing URL while retaining website filtering", () => {
    const settings = defaults(); settings.observation.rules = [{ scope: "url", urlDomain: "bank.example", behavior: "do_not_observe" }];
    const subject = { bundleId: "win32.chrome", executable: chrome };
    expect(applicationObservationDecision(settings, subject).observe).toBe(true);
    expect(evaluateObservation(settings, subject).observe).toBe(false);
    expect(evaluateObservation(settings, { ...subject, url: "https://books.example/" }).observe).toBe(true);
  });

  it("normalizes path rules and preserves alias exclusions without Mac helper matching", () => {
    const settings = parseObservationSettings({ ...defaults(), observation: { ...defaults().observation,
      rules: [{ scope: "app", executable: a, behavior: "observe" }, { scope: "app", bundleID: "win32.code", behavior: "do_not_observe" }] } });
    expect(windowsScopeAllows(settings, a.toUpperCase())).toBe(false);
    expect(applicationObservationDecision(settings, { bundleId: "win32.code.helper" }).observe).toBe(true);
    expect(() => parseObservationSettings({ ...settings, observation: { ...settings.observation,
      rules: [{ scope: "app", bundleID: "win32.code", executable: a, behavior: "observe" }] } })).toThrow("does not match");
  });

  it("applies the Windows broad browser policy without changing Mac defaults or known exclusions", () => {
    const settings = defaults();
    settings.observation.rules = [{ scope: "url", urlDomain: "bank.example", behavior: "do_not_observe" }];
    const subject = { bundleId: "win32.chrome", executable: chrome, browser: true, privateBrowsing: true };
    const broad = { ignorePrivateBrowsing: true, observeUnknownURL: true };
    expect(evaluateObservation(settings, subject).observe).toBe(false);
    expect(evaluateObservation(settings, subject, broad).observe).toBe(true);
    expect(evaluateObservation(settings, { ...subject, url: "https://bank.example/" }, broad).observe).toBe(false);
    settings.observation.rules.push(windowsScopeRule(chrome, "do_not_observe"));
    expect(evaluateObservation(settings, subject, broad).observe).toBe(false);
  });
});
