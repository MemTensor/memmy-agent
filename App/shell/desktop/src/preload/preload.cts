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
type DesktopProjectDirectorySelection = import("@memmy/desktop-interface").DesktopProjectDirectorySelection;
type AgentGatewayStartupIssue = import("@memmy/local-api-contracts").AgentGatewayStartupIssue;
type ExternalBrowserInstallation = import("@memmy/local-api-contracts").ExternalBrowserInstallation;
type DesktopWorkspaceDirectoryResult = import("@memmy/desktop-interface").DesktopWorkspaceDirectoryResult;
type MicrophoneAccessStatus = import("@memmy/desktop-interface").MicrophoneAccessStatus;
type ComputerUseSurfaceMessage = import("@memmy/local-api-contracts").ComputerUseSurfaceMessage;
type BrowserHistoryEntry = import("../main/browser-history-store.js").BrowserHistoryEntry;
type BrowserDataCategory = import("../main/browser-browsing-data.js").BrowserDataCategory;
type BrowserDownloadSettingsValue = import("../main/browser-download-settings.js").BrowserDownloadSettingsValue;
type BrowserAccessRecord = import("../main/browser-access-store.js").BrowserAccessRecord;
type BrowserUseSiteRule = import("@memmy/local-api-contracts").BrowserUseSiteRule;
type BrowserAllowAllState = import("@memmy/local-api-contracts").BrowserAllowAllState;
type BrowserSidebarAction = Pick<import("@memmy/local-api-contracts").ComputerUseSurfaceAction, "action" | "x" | "y" | "deltaY" | "key" | "url">;
type MainWindowActionRequest = { id: string; action: "close" | "minimize" };
type ExternalBrowserInstallPreparation = import("../main/external-browser-extension-install.js").ExternalBrowserInstallPreparation;

interface DiagnosticsReportExportSuccess {
  canceled: false;
  exportPath: string;
  bytes: number;
}

type DiagnosticsReportExportResult = { canceled: true } | DiagnosticsReportExportSuccess;

interface MemmyPreloadApi {
  platform: string;
  osRelease: string;
  notifyRendererReady(): void;
  getRuntimeConfig(): Promise<unknown>;
  onAgentGatewayStartupIssue(callback: (issue: AgentGatewayStartupIssue) => void): () => void;
  getAppInfo(): Promise<DesktopAppInfo>;
  getInstallationId(): Promise<string>;
  checkForUpdates(): Promise<DesktopUpdateCheckResult>;
  downloadUpdate(update: DesktopUpdateCheckResult, options?: DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult>;
  onUpdateDownloadProgress(callback: (progress: DesktopUpdateDownloadProgress) => void): () => void;
  openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult>;
  openExternal(url: string): Promise<void>;
  clearBrowserData(categories?: BrowserDataCategory[]): Promise<void>;
  markEmbeddedBrowserUserNavigation(tabId: number): Promise<void>;
  getBrowserHistory(): Promise<BrowserHistoryEntry[]>;
  importLegacyBrowserHistory(entries: BrowserHistoryEntry[]): Promise<boolean>;
  removeBrowserHistory(url: string): Promise<boolean>;
  removeSelectedBrowserHistory(urls: string[]): Promise<number>;
  revealBrowserExtension(): Promise<boolean>;
  getBrowserExtensionDirectory(): Promise<string | null>;
  dragBrowserExtension(): boolean;
  prepareBrowserExtension(browser: 'chrome' | 'edge', revealFolder?: boolean): Promise<ExternalBrowserInstallPreparation>;
  listInstalledBrowserExtensions(): Promise<Array<'chrome' | 'edge'>>;
  getBrowserExtensionInstallation(): Promise<Record<'chrome' | 'edge', ExternalBrowserInstallation>>;
  listRunningExternalBrowsers(): Promise<Array<'chrome' | 'edge'> | null>;
  getNativeAppAllowAll(): Promise<boolean>;
  setNativeAppAllowAll(enabled: boolean): Promise<boolean>;
  getBrowserAllowAll(): Promise<BrowserAllowAllState>;
  setBrowserAllowAll(enabled: boolean): Promise<BrowserAllowAllState>;
  onBrowserAllowAllChanged(listener: (state: BrowserAllowAllState) => void): () => void;
  getBrowserDownloadSettings(): Promise<BrowserDownloadSettingsValue>;
  chooseBrowserDownloadDirectory(): Promise<BrowserDownloadSettingsValue>;
  resetBrowserDownloadDirectory(): Promise<BrowserDownloadSettingsValue>;
  setBrowserAskBeforeDownload(enabled: boolean): Promise<BrowserDownloadSettingsValue>;
  getBrowserAccessRules(): Promise<BrowserAccessRecord[]>;
  setBrowserAccessRule(origin: string, decision: 'allow' | 'deny' | 'ask'): Promise<BrowserAccessRecord[]>;
  getBrowserUseSitePolicies(): Promise<BrowserUseSiteRule[]>;
  upsertBrowserUseSitePolicy(rule: BrowserUseSiteRule): Promise<BrowserUseSiteRule[]>;
  removeBrowserUseSitePolicy(pattern: string): Promise<BrowserUseSiteRule[]>;
  getBrowserSidebarSurface(sessionKey: string): Promise<ComputerUseSurfaceMessage | null>;
  onBrowserSidebarSurface(callback: (message: ComputerUseSurfaceMessage) => void): () => void;
  sendBrowserSidebarAction(sessionKey: string, action: BrowserSidebarAction): Promise<boolean>;
  getComputerHistoryPermissionSessionId?(): Promise<string>;
  guideMemmyPermission?(permission: "accessibility" | "inputMonitoring" | "screenRecording"): Promise<boolean>;
  restartForComputerHistoryPermissions?(): Promise<void>;
  openComputerHistoryMarkdown(filePath: string): Promise<void>;
  openAgentTool(sourceId: string, prompt: string): Promise<{ opened: boolean }>;
  openMailto(mailtoUrl: string): Promise<void>;
  copyImageToClipboard(request: DesktopImageActionRequest): Promise<void>;
  saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;
  saveFile(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;
  exportMemoryDatabase(): Promise<unknown>;
  installCliTools(): Promise<unknown>;
  restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;
  openLogsDirectory(): Promise<void>;
  exportDiagnosticsReport(): Promise<DiagnosticsReportExportResult>;
  getLogLevel(): Promise<"error" | "warn" | "info" | "debug">;
  setLogLevel(level: "error" | "warn" | "info" | "debug"): Promise<void>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus>;
  requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;
  getFullDiskAccessStatus(): Promise<boolean>;
  selectProjectDirectory(): Promise<DesktopProjectDirectorySelection>;
  selectEmptyProjectDirectory(): Promise<DesktopProjectDirectorySelection>;
  readWorkspaceDirectory(rootPath: string, relativePath?: string): Promise<DesktopWorkspaceDirectoryResult>;
  writeWorkspaceFile(rootPath: string, filePath: string, contents: string): Promise<void>;
  notifyTaskDone(payload: { title: string; body: string; silent: boolean; deliveryId?: string }): Promise<void>;
  notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void>;
  setPetWindow(enabled: boolean, target?: { route?: string; hash?: string; agentChatId?: string; petIntent?: "user" }): Promise<void>;
  hidePetWindow(): Promise<void>;
  onRouteTargetRequest(callback: (target: { route?: string; hash?: string; agentChatId?: string }) => void): () => void;
  onEmbeddedBrowserOpen(callback: (url: string, owner?: { scopeKey?: string; sourceGuestId?: number }) => void): () => void;
  onEmbeddedBrowserClose(callback: (tabId: number) => void): () => void;
  copyEmbeddedBrowserTabMention(tabId: number): Promise<void>;
  selectEmbeddedBrowserTab(tabId: number | null): void;
  setMenuBarIcon(enabled: boolean): Promise<DesktopMenuBarIconResult>;
  setComputerHistoryTrayIndicator(state: { enabled: boolean; recording: boolean }): void;
  onMainWindowActionRequest(callback: (request: MainWindowActionRequest) => void): () => void;
  getMainWindowFullScreen(): Promise<{ isFullScreen: boolean }>;
  onMainWindowFullScreenChanged(callback: (state: { isFullScreen: boolean }) => void): () => void;
  completeMainWindowAction(response: { id: string; resolution: "close" | "hide" | "minimize" | "pet" | "quit" }): Promise<void>;
  movePetWindow(pointer: { clientX: number; clientY: number }): void;
  startPetWindowDrag(pointer: { clientX: number; clientY: number }): void;
  stopPetWindowDrag(): void;
  syncPetWindowLayout(layout: { width: number; height: number; mascotOffsetX: number; mascotOffsetY: number }): void;
  sendAnalyticsClientId(payload: {
    clientId: string;
    appEnv: "dev" | "prod";
    appEdition: "cn" | "intl";
  }): void;
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
  osRelease: typeof process.getSystemVersion === "function" ? process.getSystemVersion() : "",

  notifyRendererReady(): void {
    ipcRenderer.send("memmy:renderer-ready");
  },

  async getRuntimeConfig(): Promise<unknown> {
    return ipcRenderer.invoke("memmy:get-runtime-config");
  },
  onAgentGatewayStartupIssue(callback: (issue: AgentGatewayStartupIssue) => void): () => void {
    const listener = (_event: IpcRendererEvent, issue: AgentGatewayStartupIssue) => callback(issue);
    ipcRenderer.on("memmy:agent-gateway-startup-issue", listener);
    return () => ipcRenderer.removeListener("memmy:agent-gateway-startup-issue", listener);
  },

  async getAppInfo(): Promise<DesktopAppInfo> {
    return ipcRenderer.invoke("memmy:get-app-info");
  },

  async getInstallationId(): Promise<string> {
    return ipcRenderer.invoke("memmy:get-installation-id");
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
  async clearBrowserData(categories?: BrowserDataCategory[]): Promise<void> {
    return ipcRenderer.invoke("memmy:browser-clear-data", categories);
  },
  async markEmbeddedBrowserUserNavigation(tabId: number): Promise<void> {
    return ipcRenderer.invoke('memmy:browser:user-navigation', tabId);
  },
  async getBrowserHistory(): Promise<BrowserHistoryEntry[]> {
    return ipcRenderer.invoke("memmy:browser-sidebar:history");
  },
  async importLegacyBrowserHistory(entries: BrowserHistoryEntry[]): Promise<boolean> {
    return ipcRenderer.invoke("memmy:browser-sidebar:history-import-legacy", entries);
  },
  async removeBrowserHistory(url: string): Promise<boolean> {
    return ipcRenderer.invoke("memmy:browser-sidebar:history-remove", url);
  },
  async removeSelectedBrowserHistory(urls: string[]): Promise<number> {
    return ipcRenderer.invoke('memmy:browser-sidebar:history-remove-selected', urls);
  },
  async revealBrowserExtension(): Promise<boolean> {
    return ipcRenderer.invoke('memmy:browser-extension:reveal');
  },
  async getBrowserExtensionDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('memmy:browser-extension:directory');
  },
  dragBrowserExtension(): boolean {
    return ipcRenderer.sendSync('memmy:browser-extension:drag') === true;
  },
  async prepareBrowserExtension(browser: 'chrome' | 'edge', revealFolder?: boolean): Promise<ExternalBrowserInstallPreparation> {
    return ipcRenderer.invoke('memmy:browser-extension:prepare', browser, revealFolder);
  },
  async listInstalledBrowserExtensions(): Promise<Array<'chrome' | 'edge'>> {
    return ipcRenderer.invoke('memmy:browser-extension:installed');
  },
  async getBrowserExtensionInstallation(): Promise<Record<'chrome' | 'edge', ExternalBrowserInstallation>> {
    return ipcRenderer.invoke('memmy:browser-extension:installation');
  },
  async listRunningExternalBrowsers(): Promise<Array<'chrome' | 'edge'> | null> {
    return ipcRenderer.invoke('memmy:browser-extension:running');
  },
  async getNativeAppAllowAll(): Promise<boolean> {
    return ipcRenderer.invoke('memmy:computer-use:allow-all-apps:get');
  },
  async setNativeAppAllowAll(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke('memmy:computer-use:allow-all-apps:set', enabled);
  },
  async getBrowserAllowAll(): Promise<BrowserAllowAllState> {
    return ipcRenderer.invoke('memmy:browser-allow-all:get');
  },
  async setBrowserAllowAll(enabled: boolean): Promise<BrowserAllowAllState> {
    return ipcRenderer.invoke('memmy:browser-allow-all:set', enabled);
  },
  onBrowserAllowAllChanged(callback: (state: BrowserAllowAllState) => void): () => void {
    const listener = (_event: IpcRendererEvent, state: BrowserAllowAllState) => callback(state);
    ipcRenderer.on('memmy:browser-allow-all:changed', listener);
    return () => { ipcRenderer.removeListener('memmy:browser-allow-all:changed', listener); };
  },
  async getBrowserDownloadSettings(): Promise<BrowserDownloadSettingsValue> {
    return ipcRenderer.invoke('memmy:browser-downloads:settings');
  },
  async chooseBrowserDownloadDirectory(): Promise<BrowserDownloadSettingsValue> {
    return ipcRenderer.invoke('memmy:browser-downloads:choose-directory');
  },
  async resetBrowserDownloadDirectory(): Promise<BrowserDownloadSettingsValue> {
    return ipcRenderer.invoke('memmy:browser-downloads:default-directory');
  },
  async setBrowserAskBeforeDownload(enabled: boolean): Promise<BrowserDownloadSettingsValue> {
    return ipcRenderer.invoke('memmy:browser-downloads:ask-before', enabled);
  },
  async getBrowserAccessRules(): Promise<BrowserAccessRecord[]> {
    return ipcRenderer.invoke('memmy:browser-access:list');
  },
  async setBrowserAccessRule(origin: string, decision: 'allow' | 'deny' | 'ask'): Promise<BrowserAccessRecord[]> {
    return ipcRenderer.invoke('memmy:browser-access:set', origin, decision);
  },
  async getBrowserUseSitePolicies(): Promise<BrowserUseSiteRule[]> {
    return ipcRenderer.invoke('memmy:browser-use-site-policy:list');
  },
  async upsertBrowserUseSitePolicy(rule: BrowserUseSiteRule): Promise<BrowserUseSiteRule[]> {
    return ipcRenderer.invoke('memmy:browser-use-site-policy:upsert', rule);
  },
  async removeBrowserUseSitePolicy(pattern: string): Promise<BrowserUseSiteRule[]> {
    return ipcRenderer.invoke('memmy:browser-use-site-policy:remove', pattern);
  },
  async getBrowserSidebarSurface(sessionKey: string): Promise<ComputerUseSurfaceMessage | null> {
    return ipcRenderer.invoke("memmy:browser-sidebar:get", sessionKey);
  },
  onBrowserSidebarSurface(callback: (message: ComputerUseSurfaceMessage) => void): () => void {
    const listener = (_event: IpcRendererEvent, message: ComputerUseSurfaceMessage) => callback(message);
    ipcRenderer.on("memmy:browser-sidebar:surface", listener);
    return () => ipcRenderer.removeListener("memmy:browser-sidebar:surface", listener);
  },
  async sendBrowserSidebarAction(sessionKey: string, action: BrowserSidebarAction): Promise<boolean> {
    return ipcRenderer.invoke("memmy:browser-sidebar:action", sessionKey, action);
  },

  async getFullDiskAccessStatus(): Promise<boolean> {
    return ipcRenderer.invoke("memmy:get-full-disk-access-status");
  },

  async getComputerHistoryPermissionSessionId(): Promise<string> {
    return ipcRenderer.invoke("memmy:get-computer-history-permission-session");
  },

  async guideMemmyPermission(permission: "accessibility" | "inputMonitoring" | "screenRecording"): Promise<boolean> {
    return ipcRenderer.invoke("memmy:guide-memmy-permission", permission);
  },

  async restartForComputerHistoryPermissions(): Promise<void> {
    return ipcRenderer.invoke("memmy:restart-for-computer-history-permissions");
  },

  async openComputerHistoryMarkdown(filePath: string): Promise<void> {
    return ipcRenderer.invoke("memmy:open-computer-history-markdown", filePath);
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

  async saveFile(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult> {
    return ipcRenderer.invoke("memmy:save-file", request);
  },

  async notifyTaskDone(payload: { title: string; body: string; silent: boolean; deliveryId?: string }): Promise<void> {
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

  async getLaunchAtLogin(): Promise<boolean> {
    return ipcRenderer.invoke("memmy:get-launch-at-login");
  },

  async setLaunchAtLogin(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke("memmy:set-launch-at-login", enabled);
  },

  async getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus> {
    return ipcRenderer.invoke("memmy:get-microphone-access-status");
  },

  async requestMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
    return ipcRenderer.invoke("memmy:request-microphone-access");
  },

  async selectProjectDirectory(): Promise<DesktopProjectDirectorySelection> {
    return ipcRenderer.invoke("memmy:select-project-directory");
  },

  async selectEmptyProjectDirectory(): Promise<DesktopProjectDirectorySelection> {
    return ipcRenderer.invoke("memmy:select-empty-project-directory");
  },

  async readWorkspaceDirectory(rootPath: string, relativePath = ""): Promise<DesktopWorkspaceDirectoryResult> {
    return ipcRenderer.invoke("memmy:read-workspace-directory", rootPath, relativePath);
  },

  async writeWorkspaceFile(rootPath: string, filePath: string, contents: string): Promise<void> {
    return ipcRenderer.invoke("memmy:write-workspace-file", rootPath, filePath, contents);
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

  onEmbeddedBrowserOpen(callback: (url: string, owner?: { scopeKey?: string; sourceGuestId?: number }) => void): () => void {
    const listener = (_event: IpcRendererEvent, url: string, owner: unknown) => {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
      if (owner === undefined) { callback(url); return; }
      if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return;
      const input = owner as Record<string, unknown>;
      if (Object.keys(input).some(key => key !== 'scopeKey' && key !== 'sourceGuestId')) return;
      if (input.scopeKey !== undefined && (typeof input.scopeKey !== 'string'
        || !input.scopeKey.trim() || input.scopeKey.length > 512 || /[\u0000-\u001f\u007f]/.test(input.scopeKey))) return;
      if (input.sourceGuestId !== undefined && (!Number.isSafeInteger(input.sourceGuestId)
        || (input.sourceGuestId as number) <= 0)) return;
      callback(url, { ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey as string }),
        ...(input.sourceGuestId === undefined ? {} : { sourceGuestId: input.sourceGuestId as number }) });
    };
    ipcRenderer.on('memmy:browser:open-url', listener);
    return () => ipcRenderer.removeListener('memmy:browser:open-url', listener);
  },

  onEmbeddedBrowserClose(callback: (tabId: number) => void): () => void {
    const listener = (_event: IpcRendererEvent, tabId: number) => {
      if (Number.isSafeInteger(tabId) && tabId > 0) callback(tabId);
    };
    ipcRenderer.on('memmy:browser:close-tab', listener);
    return () => ipcRenderer.removeListener('memmy:browser:close-tab', listener);
  },

  copyEmbeddedBrowserTabMention(tabId: number): Promise<void> {
    return ipcRenderer.invoke('memmy:browser:copy-tab-mention', tabId);
  },

  selectEmbeddedBrowserTab(tabId: number | null): void {
    if (tabId === null || (Number.isSafeInteger(tabId) && tabId! > 0)) {
      ipcRenderer.send('memmy:browser:select-tab', tabId);
    }
  },

  async setMenuBarIcon(enabled: boolean): Promise<DesktopMenuBarIconResult> {
    return ipcRenderer.invoke("memmy:set-menu-bar-icon", enabled);
  },

  setComputerHistoryTrayIndicator(state: { enabled: boolean; recording: boolean }): void {
    ipcRenderer.send("memmy:set-computer-history-tray-indicator", state);
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

  sendAnalyticsClientId(payload: {
    clientId: string;
    appEnv: "dev" | "prod";
    appEdition: "cn" | "intl";
  }): void {
    ipcRenderer.send("memmy:analytics-client-id", payload);
  }
};

contextBridge.exposeInMainWorld("memmy", memmyPreloadApi);
