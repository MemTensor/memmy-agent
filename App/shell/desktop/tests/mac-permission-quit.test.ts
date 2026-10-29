import { describe, expect, it, vi } from "vitest";
import { isMacPermissionSystemQuit, isMacSystemSessionQuit, MacPermissionRestartIntent,
  openMacPermissionSettingsFromRenderer,
  type MacPermissionQuitContext } from "../src/main/mac-permission-quit.js";

const systemSettings: MacPermissionQuitContext = {
  eventClass: "aevt",
  eventId: "quit",
  senderBundleId: "com.apple.systempreferences",
  senderExecutablePath: "/System/Applications/System Settings.app/Contents/MacOS/System Settings",
  quitReason: null,
};
const privacySettings: MacPermissionQuitContext = {
  ...systemSettings,
  senderBundleId: "com.apple.settings.PrivacySecurity.extension",
  senderExecutablePath: "/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension",
};

describe("macOS system permission quit classification", () => {
  it.each([
    systemSettings,
    { ...systemSettings, senderExecutablePath: "/System/Applications/System Preferences.app/Contents/MacOS/System Preferences" },
    privacySettings,
  ])("recognizes the real system settings executable $senderExecutablePath", (context) => {
    expect(isMacPermissionSystemQuit(context)).toBe(true);
  });

  it.each([null, undefined])("preserves an ordinary quit with no Apple event: %s", (context) => {
    expect(isMacPermissionSystemQuit(context)).toBe(false);
  });

  it.each([
    { ...systemSettings, eventClass: "GURL" },
    { ...systemSettings, eventId: "oapp" },
    { ...systemSettings, eventId: "rapp" },
    { ...systemSettings, senderBundleId: "com.apple.dock", senderExecutablePath: "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock" },
    { ...systemSettings, senderBundleId: "cn.memtensor.memmy", senderExecutablePath: "/Applications/Memmy.app/Contents/MacOS/Memmy" },
    { ...systemSettings, senderBundleId: null },
    { ...systemSettings, senderExecutablePath: null },
    { ...systemSettings, senderBundleId: "com.apple.tccd", senderExecutablePath: "/System/Library/PrivateFrameworks/TCC.framework/Support/tccd" },
    { ...systemSettings, senderBundleId: "com.apple.coreservices.launchservicesd", senderExecutablePath: "/System/Library/CoreServices/launchservicesd" },
  ])("rejects a non-permission or unidentified quit: %j", (context) => {
    expect(isMacPermissionSystemQuit(context)).toBe(false);
  });

  it.each(["rest", "shut", "logo", "rlgo", "quia", "unknown", "", "quit"])(
    "preserves a whole-system or unknown quit reason: %s",
    (quitReason) => {
      expect(isMacPermissionSystemQuit({ ...systemSettings, quitReason })).toBe(false);
      expect(isMacPermissionSystemQuit({ ...privacySettings, quitReason })).toBe(false);
    },
  );

  it.each([
    "/Applications/System Settings.app/Contents/MacOS/System Settings",
    "/tmp/System Settings.app/Contents/MacOS/System Settings",
    "/System/Applications/System Settings.app/Contents/MacOS/System Settings Helper",
    "/System/Applications/System Settings.app/Contents/MacOS/System Settings/extra",
    "/System/Applications/../Applications/System Settings.app/Contents/MacOS/System Settings",
  ])("rejects a copied or mismatched settings executable: %s", (senderExecutablePath) => {
    expect(isMacPermissionSystemQuit({ ...systemSettings, senderExecutablePath })).toBe(false);
  });

  it("rejects mismatched system bundles and extension executable paths", () => {
    expect(isMacPermissionSystemQuit({ ...systemSettings, senderExecutablePath: privacySettings.senderExecutablePath })).toBe(false);
    expect(isMacPermissionSystemQuit({ ...privacySettings, senderExecutablePath: systemSettings.senderExecutablePath })).toBe(false);
    expect(isMacPermissionSystemQuit({ ...privacySettings, senderExecutablePath: "/tmp/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension" })).toBe(false);
  });

  it("does not treat a malformed, omitted quit reason as a missing reason", () => {
    const malformed = { ...systemSettings, quitReason: undefined } as unknown as MacPermissionQuitContext;
    expect(isMacPermissionSystemQuit(malformed)).toBe(false);
  });

  it.each([systemSettings, privacySettings])("recognizes Settings rlgo only during an owned permission request: %j", (context) => {
    const request = { ...context, quitReason: "rlgo" };
    expect(isMacPermissionSystemQuit(request, { permissionRequested: true, systemSessionEnding: false })).toBe(true);
    expect(isMacPermissionSystemQuit(request, { permissionRequested: true })).toBe(false);
    expect(isMacPermissionSystemQuit(request)).toBe(false);
    expect(isMacPermissionSystemQuit(request, { permissionRequested: false })).toBe(false);
    expect(isMacPermissionSystemQuit(request, { permissionRequested: true, systemSessionEnding: true })).toBe(false);
  });

  it.each(["rest", "shut", "logo", "quia", "unknown", "", "quit"])(
    "a permission request never authorizes a different termination reason: %s", (quitReason) => {
      expect(isMacPermissionSystemQuit({ ...privacySettings, quitReason }, { permissionRequested: true, systemSessionEnding: false })).toBe(false);
    },
  );

  it.each([
    { ...privacySettings, senderBundleId: "com.apple.loginwindow", senderExecutablePath: "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow" },
    { ...privacySettings, senderBundleId: "cn.memtensor.memmy" },
    { ...privacySettings, senderExecutablePath: "/tmp/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension" },
    { ...systemSettings, senderExecutablePath: privacySettings.senderExecutablePath },
    { ...privacySettings, senderExecutablePath: null },
    { ...privacySettings, eventClass: "GURL" },
  ])("a permission request does not authorize a forged or unidentified sender: %j", (context) => {
    expect(isMacPermissionSystemQuit({ ...context, quitReason: "rlgo" }, { permissionRequested: true, systemSessionEnding: false })).toBe(false);
  });

  it("a system-session notification vetoes even the Settings quit without a reason", () => {
    expect(isMacPermissionSystemQuit(privacySettings, { systemSessionEnding: true })).toBe(false);
  });

  it.each(["rest", "shut", "logo", "rlgo", "quia"])("recognizes the system termination reason %s", (quitReason) => {
    expect(isMacSystemSessionQuit({ ...systemSettings, quitReason })).toBe(true);
  });

  it.each([null, "unknown", "", "quit"])("does not infer system termination from %s", (quitReason) => {
    expect(isMacSystemSessionQuit({ ...systemSettings, quitReason })).toBe(false);
    expect(isMacSystemSessionQuit({ ...systemSettings, eventId: "oapp", quitReason: "shut" })).toBe(false);
    expect(isMacSystemSessionQuit(null)).toBe(false);
  });
});

describe("owned macOS permission restart intent", () => {
  function clock() {
    let now = 1_000;
    return { intent: new MacPermissionRestartIntent(() => now), advance: (milliseconds: number) => { now += milliseconds; } };
  }

  it("requires an explicit request and consumes it once", () => {
    const { intent } = clock();
    expect(intent.consume()).toBe(false);
    intent.begin();
    expect(intent.consume()).toBe(true);
    expect(intent.consume()).toBe(false);
  });

  it("expires an unfinished guide after five minutes", () => {
    const { intent, advance } = clock();
    intent.begin(); advance(5 * 60_000 + 1);
    expect(intent.consume()).toBe(false);
  });

  it("keeps a short restart grace after successful verification", () => {
    const { intent, advance } = clock();
    const token = intent.begin(); advance(15_000); intent.finish(token, true); advance(29_999);
    expect(intent.consume()).toBe(true);
    const next = intent.begin(); intent.finish(next, true); advance(30_001);
    expect(intent.consume()).toBe(false);
  });

  it("approval cannot extend the original guide deadline", () => {
    const { intent, advance } = clock();
    const token = intent.begin(); advance(5 * 60_000 - 5_000); intent.finish(token, true); advance(5_001);
    expect(intent.consume()).toBe(false);
  });

  it("cancelling a guide clears its restart request", () => {
    const { intent } = clock();
    const token = intent.begin(); intent.finish(token, false);
    expect(intent.consume()).toBe(false);
  });

  it("an older guide cannot approve or cancel a newer guide", () => {
    const { intent, advance } = clock();
    const old = intent.begin(); const current = intent.begin();
    intent.finish(old, false); intent.finish(old, true); advance(31_000);
    expect(intent.consume()).toBe(true);
    intent.finish(current, true);
    expect(intent.consume()).toBe(false);
  });

  it("canceling another permission guide leaves the Full Disk Access request active", () => {
    const { intent } = clock();
    intent.begin(); // WeChat opened Full Disk Access.
    const accessibility = intent.begin();
    intent.finish(accessibility, false);
    expect(intent.consume()).toBe(true);
  });

  it("does not accept a request after the clock moves backwards", () => {
    const { intent, advance } = clock();
    intent.begin(); advance(-1);
    expect(intent.consume()).toBe(false);
  });
});

describe("renderer permission settings launch", () => {
  const fullDiskAccess = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
  const automation = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

  it.each([fullDiskAccess, automation])("arms a one-use intent before opening %s", async url => {
    const intent = new MacPermissionRestartIntent();
    let finishOpen!: () => void;
    const openExternal = vi.fn(() => new Promise<void>(resolve => { finishOpen = resolve; }));
    const opening = openMacPermissionSettingsFromRenderer(` ${url} `, true, openExternal, intent);
    expect(intent.consume()).toBe(true);
    finishOpen();
    expect(await opening).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(intent.consume()).toBe(false);
  });

  it("retains the intent after Settings opens for a later Quit & Reopen", async () => {
    const intent = new MacPermissionRestartIntent();
    expect(await openMacPermissionSettingsFromRenderer(fullDiskAccess, true,
      vi.fn().mockResolvedValue(undefined), intent)).toBe(true);
    expect(intent.consume()).toBe(true);
  });

  it("clears the intent when System Settings fails to open", async () => {
    const intent = new MacPermissionRestartIntent();
    const openExternal = vi.fn().mockRejectedValue(new Error("settings unavailable"));
    await expect(openMacPermissionSettingsFromRenderer(fullDiskAccess, true, openExternal, intent))
      .rejects.toThrow("settings unavailable");
    expect(intent.consume()).toBe(false);
  });

  it("a later failed Automation open cannot clear a pending Full Disk Access request", async () => {
    const intent = new MacPermissionRestartIntent();
    await openMacPermissionSettingsFromRenderer(fullDiskAccess, true,
      vi.fn().mockResolvedValue(undefined), intent);
    await expect(openMacPermissionSettingsFromRenderer(automation, true,
      vi.fn().mockRejectedValue(new Error("settings unavailable")), intent)).rejects.toThrow();
    expect(intent.consume()).toBe(true);
  });

  it("rejects an untrusted renderer and unrelated URLs", async () => {
    const intent = new MacPermissionRestartIntent();
    const openExternal = vi.fn();
    await expect(openMacPermissionSettingsFromRenderer(fullDiskAccess, false, openExternal, intent))
      .rejects.toThrow("Invalid permission settings request");
    expect(await openMacPermissionSettingsFromRenderer("https://example.com", true, openExternal, intent)).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(intent.consume()).toBe(false);
  });
});
