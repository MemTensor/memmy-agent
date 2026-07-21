/** Global.d module. */
import type { DesktopAppInfo, DesktopImageActionRequest, DesktopImageSaveResult, DesktopMemoryServiceRestartResult, DesktopUpdateCheckResult, DesktopUpdateDownloadProgress, DesktopUpdateInstallResult } from "@memmy/desktop-interface";

declare global {
  type MemmyMicrophoneAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unsupported";

  interface MemmyDiagnosticsReportExportSuccess {
    canceled: false;
    exportPath: string;
    bytes: number;
  }

  type MemmyDiagnosticsReportExportResult = { canceled: true } | MemmyDiagnosticsReportExportSuccess;

  interface MemmyCliInstallResult {
    ok: true;
    binDirectory: string;
    installed: Array<{
      name: string;
      source: string;
      target: string;
    }>;
    pathUpdated: boolean;
    profilePaths: string[];
  }

  interface Window {
    memmy?: {
      platform: string;
      getRuntimeConfig(): Promise<unknown>;
      getAppInfo(): Promise<DesktopAppInfo>;
      checkForUpdates(): Promise<DesktopUpdateCheckResult>;
      downloadUpdate(update: DesktopUpdateCheckResult, options?: import("@memmy/desktop-interface").DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult>;
      onUpdateDownloadProgress(callback: (progress: DesktopUpdateDownloadProgress) => void): () => void;
      openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult>;
      openExternal(url: string): Promise<void>;
      openMailto(mailtoUrl: string): Promise<void>;
      copyImageToClipboard(request: DesktopImageActionRequest): Promise<void>;
      saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;
      exportMemoryDatabase(): Promise<{ canceled: true } | { canceled: false; exportPath: string; bytes: number }>;
      installCliTools(): Promise<MemmyCliInstallResult>;
      restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;
      openLogsDirectory(): Promise<void>;
      exportDiagnosticsReport(): Promise<MemmyDiagnosticsReportExportResult>;
      getLogLevel(): Promise<"error" | "warn" | "info" | "debug">;
      setLogLevel(level: "error" | "warn" | "info" | "debug"): Promise<void>;
      getMicrophoneAccessStatus(): Promise<MemmyMicrophoneAccessStatus>;
      requestMicrophoneAccess(): Promise<MemmyMicrophoneAccessStatus>;
      notifyTaskDone(payload: { title: string; body: string; silent: boolean }): Promise<void>;
      notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void>;
      setPetWindow(enabled: boolean, target?: { route?: string; hash?: string; agentChatId?: string; petIntent?: "user" }): Promise<void>;
      hidePetWindow(): Promise<void>;
      onRouteTargetRequest(
        callback: (target: { route?: string; hash?: string; agentChatId?: string }) => void
      ): () => void;
      setMenuBarIcon(enabled: boolean): Promise<{ enabled: boolean }>;
      onMainWindowActionRequest(
        callback: (request: { id: string; action: "close" | "minimize" }) => void
      ): () => void;
      getMainWindowFullScreen(): Promise<{ isFullScreen: boolean }>;
      onMainWindowFullScreenChanged(callback: (state: { isFullScreen: boolean }) => void): () => void;
      completeMainWindowAction(response: { id: string; resolution: "close" | "hide" | "minimize" | "pet" | "quit" }): Promise<void>;
      movePetWindow(pointer: { clientX: number; clientY: number }): void;
      startPetWindowDrag(pointer: { clientX: number; clientY: number }): void;
      stopPetWindowDrag(): void;
      syncPetWindowLayout(layout: { width: number; height: number; mascotOffsetX: number; mascotOffsetY: number }): void;
      sendAnalyticsClientId(payload: { clientId: string; appEnv: "dev" | "prod" }): void;
    };
  }
}

export {};
