// @vitest-environment happy-dom

/** App-level update coordinator tests. */
import type { DesktopUpdateDownloadProgress, DesktopUpdateInstallResult } from "@memmy/desktop-interface";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../state/app-state.js";
import {
  GlobalUpdateDialog,
  UpdateCoordinatorProvider,
  useUpdateCoordinator
} from "../update-coordinator.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
      downloadUrl: "https://updates.example.com/Memmy.dmg"
    }));
    const downloadUpdate = vi.fn(() => downloadPromise);
    setDesktopBridge({
      platform: "darwin",
      getAppInfo: vi.fn(async () => ({
        name: "Memmy",
        version: "2.1.0",
        platform: "darwin",
        arch: "arm64"
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
      resolveDownload({ filePath: "/tmp/Memmy-2.2.0.dmg", opened: false });
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
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps the prepared installer path when launching the installer fails", async () => {
    const checkForUpdates = vi.fn(async () => ({
      status: "available" as const,
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      downloadUrl: "https://updates.example.com/Memmy.dmg",
      preparedUpdatePath: "/tmp/Memmy-2.2.0.dmg"
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
        arch: "arm64"
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
        arch: "arm64"
      })),
      checkForUpdates: vi.fn(async () => ({
        status: "available" as const,
        currentVersion: "2.1.0",
        latestVersion: "2.2.0",
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
        downloadUrl: "https://updates.example.com/Memmy.dmg",
        filePath: "/tmp/Memmy-2.2.0.dmg",
        transferredBytes: 512,
        totalBytes: 1024,
        percent: 50
      });
    });
    expect(readOutput("download-progress")).toBe("50");

    await act(async () => {
      resolveDownload({ filePath: "/tmp/Memmy-2.2.0.dmg", opened: false });
      await downloadPromise;
    });
    expect(readOutput("phase")).toBe("prepared");
    expect(readOutput("download-progress")).toBe("");
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
        <button
          type="button"
          aria-label="update-action"
          onClick={() => void update.requestPrimaryAction()}
        >
          {update.phase}
        </button>
      )}
      <output aria-label="phase">{update.phase}</output>
      <output aria-label="prepared-path">{update.preparedUpdatePath ?? ""}</output>
      <output aria-label="download-progress">{update.downloadProgress?.percent ?? ""}</output>
      <output aria-label="feedback-key">{update.feedback?.key ?? ""}</output>
      <GlobalUpdateDialog />
    </>
  );
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
