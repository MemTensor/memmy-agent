// @vitest-environment happy-dom

/** App-level update coordinator tests. */
import type {
  DesktopStoreMigrationToken,
  DesktopUpdateCheckResult,
  DesktopUpdateDownloadProgress,
  DesktopUpdateInstallResult,
  DesktopUpdateOfferToken
} from "@memmy/desktop-interface";
import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AppStateProvider, useAppState } from "../../state/app-state.js";
import {
  GlobalUpdateDialog,
  UpdateCoordinatorProvider,
  useUpdateCoordinator
} from "../update-coordinator.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OFFER_TOKEN = "a".repeat(43) as DesktopUpdateOfferToken;
const STORE_MIGRATION_TOKEN = "m".repeat(43) as DesktopStoreMigrationToken;
const SECOND_STORE_MIGRATION_TOKEN = "n".repeat(43) as DesktopStoreMigrationToken;

describe("UpdateCoordinatorProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "memmy");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps downloading across route content changes and reopens the prepared installer dialog", async () => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      offerToken: OFFER_TOKEN,
      downloadUrl: "https://updates.example.com/Memmy.dmg"
    }));
    const downloadUpdate = vi.fn(() => downloadPromise);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(getButtonByText("下载更新")).not.toBeNull();

    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("downloading");

    act(() => getButtonByLabel("toggle-route").click());
    expect(container.querySelector('[aria-label="update-action"]')).toBeNull();

    await act(async () => {
      resolveDownload({
        preparedUpdate: { kind: "installer-file", filePath: "/tmp/Memmy-2.2.0.dmg" },
        filePath: "/tmp/Memmy-2.2.0.dmg",
        opened: false
      });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("/tmp/Memmy-2.2.0.dmg");
    expect(getButtonByText("重启安装")).not.toBeNull();

    act(() => getButtonByText("稍后再说").click());
    expect(readOutput("phase")).toBe("prepared");
    expect(container.textContent).not.toContain("安装包已准备好，是否重启并安装更新？");

    act(() => getButtonByLabel("toggle-route").click());
    expect(getButtonByLabel("update-action").textContent).toBe("prepared");
    await act(async () => {
      getButtonByLabel("update-action").click();
    });

    expect(getButtonByText("重启安装")).not.toBeNull();
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledWith(OFFER_TOKEN, { openInstaller: false });
  });

  it("downloads from the inline account action without opening the installer dialog", async () => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      offerToken: OFFER_TOKEN,
      downloadUrl: "https://updates.example.com/Memmy.dmg"
    }));
    const downloadUpdate = vi.fn(() => downloadPromise);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    act(() => getButtonByText("稍后再说").click());
    expect(readOutput("phase")).toBe("available");

    await act(async () => {
      getButtonByLabel("inline-update-action").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("downloading");
    expect(downloadUpdate).toHaveBeenCalledWith(
      OFFER_TOKEN,
      { openInstaller: false }
    );

    await act(async () => {
      resolveDownload({
        preparedUpdate: { kind: "installer-file", filePath: "/tmp/Memmy-2.2.0.dmg" },
        filePath: "/tmp/Memmy-2.2.0.dmg",
        opened: false
      });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(container.textContent).not.toContain("安装包已准备好，是否重启并安装更新？");
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it.each(["dialog", "inline"] as const)("refreshes the manifest before %s download and skips an intermediate release", async (action) => {
    const refreshedOfferToken = "b".repeat(43) as DesktopUpdateOfferToken;
    const checkForUpdates = vi.fn()
      .mockResolvedValueOnce({
        status: "available" as const,
        currentVersion: "1.1.2",
        latestVersion: "1.1.3",
        offerToken: OFFER_TOKEN,
        downloadUrl: "https://updates.example.com/Memmy-1.1.3.dmg"
      })
      .mockResolvedValueOnce({
        status: "available" as const,
        currentVersion: "1.1.2",
        latestVersion: "1.1.4",
        offerToken: refreshedOfferToken,
        downloadUrl: "https://updates.example.com/Memmy-1.1.4.dmg"
      });
    const downloadUpdate = vi.fn(async () => ({
      preparedUpdate: { kind: "installer-file" as const, filePath: "/tmp/Memmy-1.1.4.dmg" },
      opened: false
    }));
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.2",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("1.1.3");

    await act(async () => {
      if (action === "dialog") getButtonByText("下载更新").click();
      else getButtonByLabel("inline-update-action").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledWith(
      refreshedOfferToken,
      { openInstaller: false }
    );
    expect(readOutput("prepared-path")).toBe("/tmp/Memmy-1.1.4.dmg");
  });

  it("keeps the prepared installer path when launching the installer fails", async () => {
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      downloadUrl: "https://updates.example.com/Memmy.dmg",
      preparedUpdate: { kind: "installer-file" as const, filePath: "/tmp/Memmy-2.2.0.dmg" }
    }));
    const openUpdateInstaller = vi.fn(async () => {
      throw new Error("installer unavailable");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(getButtonByText("重启安装")).not.toBeNull();

    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("/tmp/Memmy-2.2.0.dmg");
    expect(readOutput("feedback-key")).toBe("settings.about.updateInstallFailed");

    await act(async () => {
      getButtonByLabel("update-action").click();
    });
    expect(getButtonByText("重启安装")).not.toBeNull();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(openUpdateInstaller).toHaveBeenCalledTimes(1);
  });

  it("tracks desktop download progress until the installer is prepared", async () => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    let progressCallback!: (progress: DesktopUpdateDownloadProgress) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const unsubscribeProgress = vi.fn();
    const onUpdateDownloadProgress = vi.fn((callback: (progress: DesktopUpdateDownloadProgress) => void) => {
      progressCallback = callback;
      return unsubscribeProgress;
    });
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        currentVersion: "2.1.0",
        latestVersion: "2.2.0",
        offerToken: OFFER_TOKEN,
        downloadUrl: "https://updates.example.com/Memmy.dmg"
      })),
      downloadUpdate: vi.fn(() => downloadPromise),
      onUpdateDownloadProgress
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    expect(onUpdateDownloadProgress).toHaveBeenCalledTimes(1);

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("downloading");

    act(() => {
      progressCallback({
        kind: "installer-file",
        downloadUrl: "https://updates.example.com/Memmy.dmg",
        filePath: "/tmp/Memmy-2.2.0.dmg",
        transferredBytes: 512,
        totalBytes: 1024,
        percent: 50
      });
    });
    expect(readOutput("download-progress")).toBe("50");

    await act(async () => {
      resolveDownload({
        preparedUpdate: { kind: "installer-file", filePath: "/tmp/Memmy-2.2.0.dmg" },
        filePath: "/tmp/Memmy-2.2.0.dmg",
        opened: false
      });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("download-progress")).toBe("");
  });

  it.each(["token", "download URL"] as const)("does not download a legacy offer without its %s", async (missing) => {
    const downloadUpdate = vi.fn(async () => {
      throw new Error("must not be called");
    });
    setDesktopBridge({
      platform: "win32",
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        currentVersion: "1.1.2",
        latestVersion: "9.9.9",
        provider: "legacy-installer" as const,
        force: true,
        ...(missing === "token"
          ? { downloadUrl: "https://attacker.example/forged.exe" }
          : { offerToken: OFFER_TOKEN })
      })),
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });

    expect(readOutput("phase")).toBe("available");
    expect(container.textContent).not.toContain("下载更新");
    expect(readOutput("feedback-key")).toBe("settings.about.updateAvailableNoLink");
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it("keeps the browser fallback on the manifest download URL when no preload bridge exists", async () => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://updates.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          version: "2.2.0",
          downloads: { fallback: "https://updates.example.com/Memmy.dmg" }
        }
      })
    })));
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });

    expect(open).toHaveBeenCalledWith(
      "https://updates.example.com/Memmy.dmg",
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("keeps a versionless Microsoft Store handle out of installer file paths", async () => {
    const preparedUpdate = {
      kind: "microsoft-store" as const,
      baselinePackageVersion: "1.1.1.0",
      baselinePackageFullName: "Memtensor.Memmy_1.1.1.0_x64__eyack96k521x2"
    };
    const downloadUpdate = vi.fn(async () => ({ preparedUpdate, opened: false }));
    const openUpdateInstaller = vi.fn(async () => ({
      preparedUpdate,
      opened: true,
      willQuit: true,
      background: true
    }));
    setDesktopBridge({
      platform: "win32",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.1",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        isWindowsStore: true
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        provider: "microsoft-store" as const,
        currentVersion: "1.1.1",
        offerToken: OFFER_TOKEN,
        updateMode: "manual" as const,
        windowsStore: {
          baselinePackageVersion: preparedUpdate.baselinePackageVersion,
          baselinePackageFullName: preparedUpdate.baselinePackageFullName,
          canSilentlyDownload: false
        }
      })),
      downloadUpdate,
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("发现新版本");

    await act(async () => {
      getButtonByText("下载更新").click();
      await Promise.resolve();
    });
    expect(downloadUpdate).toHaveBeenCalledWith(OFFER_TOKEN, { openInstaller: false });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("");
    expect(container.textContent).toContain("安装包已准备好");

    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
    });
    expect(openUpdateInstaller).toHaveBeenCalledWith(preparedUpdate);
  });

  it.each(["microsoft-store", "store-migration"] as const)("reuses a prepared %s handle returned by the download-time refresh", async (provider) => {
    const preparedUpdate = provider === "microsoft-store"
      ? { kind: provider, baselinePackageVersion: "1.1.100.0", baselinePackageFullName: "Memtensor.Memmy_1.1.100.0_x64__eyack96k521x2" }
      : { kind: provider, offerToken: STORE_MIGRATION_TOKEN };
    const available: DesktopUpdateCheckResult = provider === "store-migration"
      ? createStoreMigrationResult()
      : { status: "available", provider, currentVersion: "1.1.1", offerToken: OFFER_TOKEN };
    const checkForUpdates = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce({ ...available, preparedUpdate });
    const downloadUpdate = vi.fn();
    const openUpdateInstaller = vi.fn(async () => ({ preparedUpdate, opened: true, willQuit: true }));
    setDesktopBridge({ platform: "win32", checkForUpdates, downloadUpdate, openUpdateInstaller });
    await renderUpdateHarness(root);
    await act(async () => getButtonByLabel("update-action").click());
    await act(async () => getButtonByText("下载更新").click());
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("");
    expect(readOutput("feedback-key")).toBe("settings.about.storeUpdatePrepared");
    expect(container.textContent).not.toContain("{version}");
    await act(async () => getButtonByText("重启安装").click());
    expect(openUpdateInstaller).toHaveBeenCalledExactlyOnceWith(preparedUpdate);
  });

  it.each(["dialog", "inline"] as const)("downloads Store migration asynchronously via %s and opens only on restart-install", async (action) => {
    let resolveDownload!: (result: DesktopUpdateInstallResult) => void;
    let progressCallback!: (progress: DesktopUpdateDownloadProgress) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((resolve) => {
      resolveDownload = resolve;
    });
    const preparedUpdate = { kind: "store-migration" as const, offerToken: STORE_MIGRATION_TOKEN };
    const checkForUpdates = vi.fn(async () => createStoreMigrationResult());
    const downloadUpdate = vi.fn(() => downloadPromise);
    const openUpdateInstaller = vi.fn(async () => ({ preparedUpdate, opened: true, willQuit: true }));
    const browserOpen = vi.spyOn(window, "open").mockReturnValue(null);
    setDesktopBridge({
      platform: "win32",
      checkForUpdates,
      downloadUpdate,
      openUpdateInstaller,
      onUpdateDownloadProgress: (callback) => {
        progressCallback = callback;
        return vi.fn();
      }
    });
    await renderUpdateHarness(root);
    await act(async () => getButtonByLabel("update-action").click());
    expect(readOutput("phase")).toBe("available");
    expect(readOutput("feedback-key")).toBe("settings.about.storeUpdateReady");
    expect(readOutput("feedback-values")).toBe("");
    expect(container.textContent).toContain("当前版本 v1.1.1。是否下载更新？");
    expect(container.textContent).not.toContain("安装包已准备好");
    expect(container.textContent).not.toContain("打开 Microsoft Store");
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(openUpdateInstaller).not.toHaveBeenCalled();

    if (action === "inline") {
      act(() => getButtonByText("稍后再说").click());
    }
    await act(async () => {
      (action === "inline" ? getButtonByLabel("inline-update-action") : getButtonByText("下载更新")).click();
    });
    expect(readOutput("phase")).toBe("downloading");
    expect(readOutput("feedback-key")).toBe("settings.about.storeUpdateDownloading");
    expect(readOutput("feedback-values")).toBe("");
    expect(downloadUpdate).toHaveBeenCalledExactlyOnceWith(OFFER_TOKEN, { openInstaller: false });

    act(() => progressCallback({
      kind: "installer-file",
      downloadUrl: "https://get.microsoft.com/installer/download/store-product",
      filePath: "C:\\Temp\\Memmy-WebInstaller.exe",
      transferredBytes: 512,
      totalBytes: 1024,
      percent: 50
    }));
    expect(readOutput("download-progress")).toBe("50");
    await act(async () => {
      getButtonByLabel("update-action").click();
      getButtonByLabel("inline-update-action").click();
    });
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(openUpdateInstaller).not.toHaveBeenCalled();
    act(() => getButtonByLabel("toggle-route").click());

    await act(async () => {
      resolveDownload({ preparedUpdate, opened: false });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("");
    expect(readOutput("download-progress")).toBe("");
    expect(readOutput("feedback-key")).toBe("settings.about.storeUpdatePrepared");
    expect(readOutput("feedback-values")).toBe("");
    expect(container.textContent?.includes("安装包已准备好")).toBe(action === "dialog");
    expect(openUpdateInstaller).not.toHaveBeenCalled();
    if (action === "dialog") {
      act(() => getButtonByText("稍后再说").click());
    }
    act(() => getButtonByLabel("toggle-route").click());
    await act(async () => getButtonByLabel("update-action").click());
    expect(container.textContent).toContain("安装包已准备好");
    expect(container.textContent).not.toMatch(/Microsoft Store|Web Installer|迁移|\{version\}/);
    expect(container.textContent).toContain("当前版本 v1.1.1。安装包已准备好，是否重启并安装更新？");
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    await act(async () => getButtonByText("重启安装").click());
    expect(openUpdateInstaller).toHaveBeenCalledExactlyOnceWith(preparedUpdate);
    expect(readOutput("phase")).toBe("installing");
    expect(readOutput("feedback-key")).toBe("settings.about.installerOpenedQuit");
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("rechecks and retries a failed Store migration download without opening an installer", async () => {
    let rejectDownload!: (error: Error) => void;
    let progressCallback!: (progress: DesktopUpdateDownloadProgress) => void;
    const downloadPromise = new Promise<DesktopUpdateInstallResult>((_resolve, reject) => { rejectDownload = reject; });
    const refreshedOfferToken = "b".repeat(43) as DesktopUpdateOfferToken;
    const preparedUpdate = { kind: "store-migration" as const, offerToken: SECOND_STORE_MIGRATION_TOKEN };
    const checkForUpdates = vi.fn()
      .mockResolvedValueOnce(createStoreMigrationResult())
      .mockResolvedValueOnce(createStoreMigrationResult())
      .mockResolvedValue(createStoreMigrationResult({ offerToken: refreshedOfferToken, storeMigrationOffer: preparedUpdate }));
    const downloadUpdate = vi.fn()
      .mockReturnValueOnce(downloadPromise)
      .mockResolvedValueOnce({ preparedUpdate, opened: false });
    const openUpdateInstaller = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setDesktopBridge({
      platform: "win32", checkForUpdates, downloadUpdate, openUpdateInstaller,
      onUpdateDownloadProgress: (callback) => { progressCallback = callback; return vi.fn(); }
    });
    await renderUpdateHarness(root);
    await act(async () => getButtonByLabel("update-action").click());
    await act(async () => getButtonByText("下载更新").click());
    act(() => progressCallback({
      kind: "installer-file", downloadUrl: "https://get.microsoft.com/installer/download/store-product",
      filePath: "C:\\Temp\\Memmy-WebInstaller.exe", transferredBytes: 512, totalBytes: 1024, percent: 50
    }));
    expect(readOutput("download-progress")).toBe("50");
    await act(async () => { rejectDownload(new Error("download failed")); });
    expect(readOutput("phase")).toBe("error");
    expect(readOutput("prepared-path")).toBe("");
    expect(readOutput("download-progress")).toBe("");
    expect(readOutput("feedback-key")).toBe("settings.about.updateInstallFailed");
    expect(container.textContent).not.toContain("重启安装");
    await act(async () => getButtonByLabel("update-action").click());
    expect(checkForUpdates).toHaveBeenCalledTimes(3);
    expect(readOutput("phase")).toBe("available");
    await act(async () => getButtonByText("下载更新").click());
    expect(checkForUpdates).toHaveBeenCalledTimes(4);
    expect(downloadUpdate).toHaveBeenNthCalledWith(1, OFFER_TOKEN, { openInstaller: false });
    expect(downloadUpdate).toHaveBeenNthCalledWith(2, refreshedOfferToken, { openInstaller: false });
    expect(readOutput("phase")).toBe("prepared");
    expect(openUpdateInstaller).not.toHaveBeenCalled();
  });

  it("does not fall back to a browser when the Store migration download bridge is unavailable", async () => {
    const browserOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const openUpdateInstaller = vi.fn();
    setDesktopBridge({
      platform: "win32",
      checkForUpdates: vi.fn(async () => createStoreMigrationResult({ downloadUrl: "https://get.microsoft.com/installer/download/store-product" })),
      openUpdateInstaller
    });
    await renderUpdateHarness(root);
    await act(async () => getButtonByLabel("update-action").click());
    await act(async () => getButtonByLabel("inline-update-action").click());
    expect(readOutput("phase")).toBe("available");
    expect(readOutput("feedback-key")).toBe("settings.about.versionlessUpdateAvailableNoLink");
    expect(readOutput("feedback-values")).toBe("");
    expect(container.textContent).not.toContain("下载更新");
    expect(browserOpen).not.toHaveBeenCalled();
    expect(openUpdateInstaller).not.toHaveBeenCalled();
  });

  it.each([false, true])("notifies about Store migration with cached ready = %s", async (cachedReady) => {
    vi.useFakeTimers();
    const preparedUpdate = { kind: "store-migration" as const, offerToken: STORE_MIGRATION_TOKEN };
    const checkForUpdates = vi.fn(async () => createStoreMigrationResult(cachedReady ? { preparedUpdate } : {}));
    const downloadUpdate = vi.fn();
    const openUpdateInstaller = vi.fn();
    const notifyUpdateAvailable = vi.fn(async () => undefined);
    setDesktopBridge({ platform: "win32", checkForUpdates, downloadUpdate, openUpdateInstaller, notifyUpdateAvailable });
    await renderUpdateHarness(root, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(readOutput("phase")).toBe(cachedReady ? "prepared" : "available");
    expect(readOutput("feedback-key")).toBe(cachedReady ? "settings.about.storeUpdatePrepared" : "settings.about.storeUpdateReady");
    expect(notifyUpdateAvailable).toHaveBeenCalledExactlyOnceWith({
      title: "Memmy 有新版本",
      body: "发现新版本，前往设置检查更新。",
      silent: false
    });
    expect(container.textContent).not.toContain("迁移到 Microsoft Store");
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(notifyUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(openUpdateInstaller).not.toHaveBeenCalled();
  });

  it("uses a cached ready Store migration installer without downloading again", async () => {
    const preparedUpdate = {
      kind: "store-migration" as const,
      offerToken: STORE_MIGRATION_TOKEN
    };
    const openUpdateInstaller = vi.fn(async () => ({
      preparedUpdate,
      opened: true,
      willQuit: true
    }));
    const downloadUpdate = vi.fn();
    setDesktopBridge({
      platform: "win32",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.1",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        provider: "store-migration" as const,
        currentVersion: "1.1.1",
        updateMode: "manual" as const,
        preparedUpdate
      })),
      openUpdateInstaller,
      downloadUpdate
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });

    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("prepared-path")).toBe("");
    expect(container.textContent).toContain("发现新版本");
    expect(container.textContent).not.toMatch(/Microsoft Store|Web Installer|迁移|\{version\}/);

    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
    });
    expect(openUpdateInstaller).toHaveBeenCalledWith(preparedUpdate);
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(readOutput("phase")).toBe("installing");
    expect(readOutput("feedback-key")).toBe("settings.about.installerOpenedQuit");
  });

  it("drops an expired Store migration handle so the next action can recheck", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const firstPreparedUpdate = {
      kind: "store-migration" as const,
      offerToken: STORE_MIGRATION_TOKEN
    };
    const refreshedPreparedUpdate = {
      kind: "store-migration" as const,
      offerToken: SECOND_STORE_MIGRATION_TOKEN
    };
    const checkForUpdates = vi.fn()
      .mockResolvedValueOnce({
        status: "available" as const,
        provider: "store-migration" as const,
        currentVersion: "1.1.1",
        updateMode: "manual" as const,
        preparedUpdate: firstPreparedUpdate
      })
      .mockResolvedValueOnce({
        status: "available" as const,
        provider: "store-migration" as const,
        currentVersion: "1.1.1",
        updateMode: "manual" as const,
        preparedUpdate: refreshedPreparedUpdate
      });
    const openUpdateInstaller = vi.fn()
      .mockRejectedValueOnce(new Error("Microsoft Store migration offer is missing, expired, or unavailable"))
      .mockResolvedValueOnce({
        preparedUpdate: refreshedPreparedUpdate,
        opened: true,
        willQuit: true
      });
    setDesktopBridge({
      platform: "win32",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "1.1.1",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        isWindowsStore: false
      })),
      checkForUpdates,
      openUpdateInstaller
    });

    await act(async () => {
      root.render(
        <AppStateProvider>
          <I18nProvider language="zh-CN">
            <UpdateCoordinatorProvider>
              <UpdateHarness />
            </UpdateCoordinatorProvider>
          </I18nProvider>
        </AppStateProvider>
      );
    });
    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
    });
    expect(readOutput("phase")).toBe("error");
    expect(readOutput("prepared-path")).toBe("");
    expect(container.textContent).not.toContain("重启安装");
    expect(readOutput("feedback-key")).toBe("settings.about.updateInstallFailed");

    await act(async () => {
      getButtonByLabel("update-action").click();
      await Promise.resolve();
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(readOutput("phase")).toBe("prepared");

    await act(async () => {
      getButtonByText("重启安装").click();
      await Promise.resolve();
    });
    expect(openUpdateInstaller).toHaveBeenNthCalledWith(1, firstPreparedUpdate);
    expect(openUpdateInstaller).toHaveBeenNthCalledWith(2, refreshedPreparedUpdate);
    expect(readOutput("phase")).toBe("installing");
  });
});

function UpdateHarness() {
  const update = useUpdateCoordinator();
  const [routeContentVisible, setRouteContentVisible] = useState(true);
  return (
    <>
      <button
        type="button"
        aria-label="toggle-route"
        onClick={() => setRouteContentVisible((visible) => !visible)}
      >
        Toggle route
      </button>
      {routeContentVisible && (
        <>
          <button
            type="button"
            aria-label="update-action"
            onClick={() => void update.requestPrimaryAction()}
          >
            {update.phase}
          </button>
          <button
            type="button"
            aria-label="inline-update-action"
            onClick={() => void update.requestInlineAction()}
          >
            {update.phase}
          </button>
        </>
      )}
      <output aria-label="phase">{update.phase}</output>
      <output aria-label="prepared-path">{update.preparedUpdatePath ?? ""}</output>
      <output aria-label="download-progress">{update.downloadProgress?.percent ?? ""}</output>
      <output aria-label="feedback-key">{update.feedback?.key ?? ""}</output>
      <output aria-label="feedback-values">{update.feedback?.values ? JSON.stringify(update.feedback.values) : ""}</output>
      <GlobalUpdateDialog />
    </>
  );
}

function createStoreMigrationResult(overrides: Partial<DesktopUpdateCheckResult> = {}): DesktopUpdateCheckResult {
  return {
    status: "available",
    provider: "store-migration",
    currentVersion: "1.1.1",
    offerToken: OFFER_TOKEN,
    storeMigrationOffer: { kind: "store-migration", offerToken: STORE_MIGRATION_TOKEN },
    updateMode: "manual",
    ...overrides
  };
}

async function renderUpdateHarness(root: Root, startupReady = false): Promise<void> {
  await act(async () => {
    root.render(
      <AppStateProvider>
        <I18nProvider language="zh-CN">
          {startupReady && <StartupReadyHarness />}
          <UpdateCoordinatorProvider><UpdateHarness /></UpdateCoordinatorProvider>
        </I18nProvider>
      </AppStateProvider>
    );
  });
}

function StartupReadyHarness() {
  const { dispatch } = useAppState();
  useEffect(() => {
    dispatch({ type: "bootstrap/loaded", initialPath: "/main", bootstrap: AppBootstrapResponseSchema.parse({
      app: { userMode: "unset", language: "system", theme: "system", autoUpdateEnabled: true },
      onboarding: {
        completed: false, currentStep: "scan_permission_required", hasAcceptedTerms: false,
        acceptedTermsVersion: null, scanPermission: "unset", improvementProgram: "unset", completedAt: null
      },
      privacy: { telemetryOptIn: false, crashReportOptIn: false, allowMemoryImprovementUpload: false, localOnlyMode: false },
      tokenUsage: { planName: "Test", totalTokens: 0, usedTokens: 0, remainingTokens: 0, expiresAt: null, lastSyncedAt: null },
      health: { localApi: "ok", memory: "mock", cloud: "mock" }
    }) });
  }, [dispatch]);
  return null;
}

function setDesktopBridge(bridge: Partial<NonNullable<Window["memmy"]>>): void {
  Object.defineProperty(window, "memmy", {
    configurable: true,
    writable: true,
    value: bridge
  });
}

function getButtonByLabel(label: string): HTMLButtonElement {
  const button = containerQuery<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === text);
  expect(button).not.toBeNull();
  return button!;
}

function readOutput(label: string): string {
  return containerQuery<HTMLOutputElement>(`output[aria-label="${label}"]`)?.textContent ?? "";
}

function containerQuery<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
