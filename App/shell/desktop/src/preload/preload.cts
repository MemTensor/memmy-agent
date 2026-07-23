const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");
type IpcRendererEvent = import("electron").IpcRendererEvent;
type DesktopAppInfo = import("@memmy/desktop-interface").DesktopAppInfo;
type DesktopUpdateCheckResult = import("@memmy/desktop-interface").DesktopUpdateCheckResult;
type DesktopUpdateDownloadOptions = import("@memmy/desktop-interface").DesktopUpdateDownloadOptions;
type DesktopUpdateDownloadProgress = import("@memmy/desktop-interface").DesktopUpdateDownloadProgress;
type DesktopUpdateInstallResult = import("@memmy/desktop-interface").DesktopUpdateInstallResult;
type DesktopMenuBarIconResult = import("@memmy/desktop-interface").DesktopMenuBarIconResult;
type DesktopImageActionRequest = import("@memmy/desktop-interface").DesktopImageActionRequest;
type DesktopImageSaveResult = import("@memmy/desktop-interface").DesktopImageSaveResult;
type DesktopMemoryServiceRestartResult = import("@memmy/desktop-interface").DesktopMemoryServiceRestartResult;
type MicrophoneAccessStatus = import("@memmy/desktop-interface").MicrophoneAccessStatus;
type MainWindowActionRequest = { id: string; action: "close" | "minimize" };

interface DiagnosticsReportExportSuccess {
  canceled: false;
  exportPath: string;
  bytes: number;
}

type DiagnosticsReportExportResult = { canceled: true } | DiagnosticsReportExportSuccess;

interface MemmyPreloadApi {
  platform: string;
  getRuntimeConfig(): Promise<unknown>;
  getAppInfo(): Promise<DesktopAppInfo>;
  checkForUpdates(): Promise<DesktopUpdateCheckResult>;
  downloadUpdate(update: DesktopUpdateCheckResult, options?: DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult>;
  onUpdateDownloadProgress(callback: (progress: DesktopUpdateDownloadProgress) => void): () => void;
  openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult>;
  openExternal(url: string): Promise<void>;
  openAgentTool(sourceId: string, prompt: string): Promise<{ opened: boolean }>;
  openMailto(mailtoUrl: string): Promise<void>;
  copyImageToClipboard(request: DesktopImageActionRequest): Promise<void>;
  saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;
  exportMemoryDatabase(): Promise<unknown>;
  installCliTools(): Promise<unknown>;
  restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;
  openLogsDirectory(): Promise<void>;
  exportDiagnosticsReport(): Promise<DiagnosticsReportExportResult>;
  getLogLevel(): Promise<"error" | "warn" | "info" | "debug">;
  setLogLevel(level: "error" | "warn" | "info" | "debug"): Promise<void>;
  getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus>;
  requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;
  notifyTaskDone(payload: { title: string; body: string; silent: boolean }): Promise<void>;
  notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void>;
  setPetWindow(enabled: boolean, target?: { route?: string; hash?: string; agentChatId?: string; petIntent?: "user" }): Promise<void>;
  hidePetWindow(): Promise<void>;
  onRouteTargetRequest(callback: (target: { route?: string; hash?: string; agentChatId?: string }) => void): () => void;
  setMenuBarIcon(enabled: boolean): Promise<DesktopMenuBarIconResult>;
  onMainWindowActionRequest(callback: (request: MainWindowActionRequest) => void): () => void;
  getMainWindowFullScreen(): Promise<{ isFullScreen: boolean }>;
  onMainWindowFullScreenChanged(callback: (state: { isFullScreen: boolean }) => void): () => void;
  completeMainWindowAction(response: { id: string; resolution: "close" | "hide" | "minimize" | "pet" | "quit" }): Promise<void>;
  movePetWindow(pointer: { clientX: number; clientY: number }): void;
  startPetWindowDrag(pointer: { clientX: number; clientY: number }): void;
  stopPetWindowDrag(): void;
  syncPetWindowLayout(layout: { width: number; height: number; mascotOffsetX: number; mascotOffsetY: number }): void;
  sendAnalyticsClientId(payload: { clientId: string; appEnv: "dev" | "prod" }): void;
}

/**
 * Buffers the main process' window action until the renderer installs its React listener.
 *
 * Electron can deliver IPC as soon as the preload starts, while the renderer listener is installed
 * later from an effect. The main process permits only one pending window action, so retaining the
 * latest undelivered request is sufficient and prevents a lost close/minimize event from wedging the
 * window permanently.
 */
class MainWindowActionRequestBuffer {
  private readonly callbacks = new Set<(request: MainWindowActionRequest) => void>();
  private pendingRequest: MainWindowActionRequest | null = null;

  publish(request: MainWindowActionRequest): void {
    if (this.callbacks.size === 0) {
      this.pendingRequest = request;
      return;
    }

    for (const callback of this.callbacks) {
      callback(request);
    }
  }

  subscribe(callback: (request: MainWindowActionRequest) => void): () => void {
    this.callbacks.add(callback);
    if (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      callback(request);
    }

    return () => this.callbacks.delete(callback);
  }
}

const mainWindowActionRequestBuffer = new MainWindowActionRequestBuffer();

ipcRenderer.on("memmy:main-window-action-requested", (_event: IpcRendererEvent, request: MainWindowActionRequest) => {
  mainWindowActionRequestBuffer.publish(request);
});

const memmyPreloadApi: MemmyPreloadApi = {
  platform: process.platform,

  async getRuntimeConfig(): Promise<unknown> {
    return ipcRenderer.invoke("memmy:get-runtime-config");
  },

  async getAppInfo(): Promise<DesktopAppInfo> {
    return ipcRenderer.invoke("memmy:get-app-info");
  },

  async checkForUpdates(): Promise<DesktopUpdateCheckResult> {
    return ipcRenderer.invoke("memmy:check-for-updates");
  },

  async downloadUpdate(update: DesktopUpdateCheckResult, options?: DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult> {
    return ipcRenderer.invoke("memmy:download-update", update, options);
  },

  onUpdateDownloadProgress(callback: (progress: DesktopUpdateDownloadProgress) => void): () => void {
    const listener = (_event: IpcRendererEvent, progress: DesktopUpdateDownloadProgress) => {
      callback(progress);
    };
    ipcRenderer.on("memmy:update-download-progress", listener);
    return () => ipcRenderer.removeListener("memmy:update-download-progress", listener);
  },

  async openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult> {
    return ipcRenderer.invoke("memmy:open-update-installer", filePath);
  },

  async openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("memmy:openExternal", url);
  },

  async openAgentTool(sourceId: string, prompt: string): Promise<{ opened: boolean }> {
    return ipcRenderer.invoke("memmy:openAgentTool", sourceId, prompt);
  },

  async openMailto(mailtoUrl: string): Promise<void> {
    return ipcRenderer.invoke("memmy:openMailto", mailtoUrl);
  },

  async copyImageToClipboard(request: DesktopImageActionRequest): Promise<void> {
    return ipcRenderer.invoke("memmy:copy-image-to-clipboard", request);
  },

  async saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult> {
    return ipcRenderer.invoke("memmy:save-image", request);
  },

  async notifyTaskDone(payload: { title: string; body: string; silent: boolean }): Promise<void> {
    return ipcRenderer.invoke("memmy:notify-task-done", payload);
  },

  async notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void> {
    return ipcRenderer.invoke("memmy:notify-update-available", payload);
  },

  async exportMemoryDatabase(): Promise<unknown> {
    return ipcRenderer.invoke("memmy:export-memory-database");
  },

  async installCliTools(): Promise<unknown> {
    return ipcRenderer.invoke("memmy:install-cli-tools");
  },

  async restartMemoryService(): Promise<DesktopMemoryServiceRestartResult> {
    return ipcRenderer.invoke("memmy:restart-memory-service");
  },

  async openLogsDirectory(): Promise<void> {
    return ipcRenderer.invoke("memmy:open-logs-directory");
  },

  async exportDiagnosticsReport(): Promise<DiagnosticsReportExportResult> {
    return ipcRenderer.invoke("memmy:export-diagnostics-report");
  },

  async getLogLevel(): Promise<"error" | "warn" | "info" | "debug"> {
    return ipcRenderer.invoke("memmy:get-log-level");
  },

  async setLogLevel(level: "error" | "warn" | "info" | "debug"): Promise<void> {
    return ipcRenderer.invoke("memmy:set-log-level", level);
  },

  async getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus> {
    return ipcRenderer.invoke("memmy:get-microphone-access-status");
  },

  async requestMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
    return ipcRenderer.invoke("memmy:request-microphone-access");
  },

  async setPetWindow(enabled: boolean, target?: { route?: string; hash?: string; agentChatId?: string; petIntent?: "user" }): Promise<void> {
    return ipcRenderer.invoke("memmy:set-pet-window", enabled, target);
  },

  async hidePetWindow(): Promise<void> {
    return ipcRenderer.invoke("memmy:hide-pet-window");
  },

  onRouteTargetRequest(callback: (target: { route?: string; hash?: string; agentChatId?: string }) => void): () => void {
    const listener = (_event: IpcRendererEvent, target: { route?: string; hash?: string; agentChatId?: string }) => {
      callback(target);
    };
    ipcRenderer.on("memmy:route-target-request", listener);
    return () => ipcRenderer.removeListener("memmy:route-target-request", listener);
  },

  async setMenuBarIcon(enabled: boolean): Promise<DesktopMenuBarIconResult> {
    return ipcRenderer.invoke("memmy:set-menu-bar-icon", enabled);
  },

  onMainWindowActionRequest(callback: (request: MainWindowActionRequest) => void): () => void {
    return mainWindowActionRequestBuffer.subscribe(callback);
  },

  async getMainWindowFullScreen(): Promise<{ isFullScreen: boolean }> {
    return ipcRenderer.invoke("memmy:get-main-window-fullscreen");
  },

  onMainWindowFullScreenChanged(callback: (state: { isFullScreen: boolean }) => void): () => void {
    const listener = (_event: IpcRendererEvent, state: { isFullScreen: boolean }) => {
      callback(state);
    };
    ipcRenderer.on("memmy:main-window-fullscreen-changed", listener);
    return () => ipcRenderer.removeListener("memmy:main-window-fullscreen-changed", listener);
  },

  async completeMainWindowAction(response: { id: string; resolution: "close" | "hide" | "minimize" | "pet" | "quit" }): Promise<void> {
    return ipcRenderer.invoke("memmy:complete-main-window-action", response);
  },

  movePetWindow(pointer: { clientX: number; clientY: number }): void {
    ipcRenderer.send("memmy:move-pet-window", pointer);
  },

  startPetWindowDrag(pointer: { clientX: number; clientY: number }): void {
    ipcRenderer.send("memmy:start-pet-window-drag", pointer);
  },

  stopPetWindowDrag(): void {
    ipcRenderer.send("memmy:stop-pet-window-drag");
  },

  syncPetWindowLayout(layout: { width: number; height: number; mascotOffsetX: number; mascotOffsetY: number }): void {
    ipcRenderer.send("memmy:update-pet-window-layout", layout);
  },

  sendAnalyticsClientId(payload: { clientId: string; appEnv: "dev" | "prod" }): void {
    ipcRenderer.send("memmy:analytics-client-id", payload);
  }
};

contextBridge.exposeInMainWorld("memmy", memmyPreloadApi);
