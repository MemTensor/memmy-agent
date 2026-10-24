/** Global.d module. */
import type { DesktopAppInfo, DesktopImageActionRequest, DesktopImageSaveResult, DesktopMemoryServiceRestartResult, DesktopProjectDirectorySelection, DesktopUpdateCheckResult, DesktopUpdateDownloadProgress, DesktopUpdateInstallResult } from "@memmy/desktop-interface";
import type { AgentGatewayStartupIssue, BrowserAllowAllState, ComputerUseSurfaceAction, ComputerUseSurfaceMessage, ExternalBrowserInstallation } from "@memmy/local-api-contracts";

declare global {
  type MemmyMicrophoneAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unsupported";

  interface MemmyDiagnosticsReportExportSuccess {
    canceled: false;
    exportPath: string;
    bytes: number;
  }

  type MemmyDiagnosticsReportExportResult = { canceled: true } | MemmyDiagnosticsReportExportSuccess;

  interface MemmyWorkspaceDirectoryEntry {
    name: string;
    path: string;
    relativePath: string;
    kind: "file" | "directory";
  }

  interface MemmyWorkspaceDirectoryResult {
    rootPath: string;
    relativePath: string;
    entries: MemmyWorkspaceDirectoryEntry[];
    truncated: boolean;
  }

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
      osRelease: string;
      notifyRendererReady(): void;
      getRuntimeConfig(): Promise<unknown>;
      onAgentGatewayStartupIssue?(callback: (issue: AgentGatewayStartupIssue) => void): () => void;
      getAppInfo(): Promise<DesktopAppInfo>;
      getInstallationId(): Promise<string>;
      checkForUpdates(): Promise<DesktopUpdateCheckResult>;
      downloadUpdate(update: DesktopUpdateCheckResult, options?: import("@memmy/desktop-interface").DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult>;
      onUpdateDownloadProgress(callback: (progress: DesktopUpdateDownloadProgress) => void): () => void;
      openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult>;
      openExternal(url: string): Promise<void>;
      clearBrowserData?(categories?: Array<'cookies' | 'siteData' | 'cache' | 'downloadHistory' | 'browsingHistory'>): Promise<void>;
      markEmbeddedBrowserUserNavigation?(tabId: number): Promise<void>;
      getBrowserHistory?(): Promise<Array<{ id?: string; url: string; title: string; visitedAt: number;
        visitSource?: 'agent' | 'other' }>>;
      importLegacyBrowserHistory?(entries: Array<{ url: string; title: string; visitedAt: number }>): Promise<boolean>;
      removeBrowserHistory?(url: string): Promise<boolean>;
      removeSelectedBrowserHistory?(urls: string[]): Promise<number>;
      revealBrowserExtension?(): Promise<boolean>;
      dragBrowserExtension?(): boolean;
      getBrowserExtensionDirectory?(): Promise<string | null>;
      prepareBrowserExtension?(browser: 'chrome' | 'edge', revealFolder?: boolean): Promise<{
        status: 'browser-opened' | 'browser-not-found' | 'browser-launch-failed' | 'extension-missing';
        directory: string | null;
      }>;
      listInstalledBrowserExtensions?(): Promise<Array<'chrome' | 'edge'>>;
      getBrowserExtensionInstallation?(): Promise<Record<'chrome' | 'edge', ExternalBrowserInstallation>>;
      listRunningExternalBrowsers?(): Promise<Array<'chrome' | 'edge'> | null>;
      getNativeAppAllowAll?(): Promise<boolean>;
      setNativeAppAllowAll?(enabled: boolean): Promise<boolean>;
      getBrowserAllowAll?(): Promise<BrowserAllowAllState>;
      setBrowserAllowAll?(enabled: boolean): Promise<BrowserAllowAllState>;
      onBrowserAllowAllChanged?(listener: (state: BrowserAllowAllState) => void): () => void;
      getBrowserDownloadSettings?(): Promise<{ directory: string | null; approvedDirectories: string[]; askBeforeDownload: boolean }>;
      chooseBrowserDownloadDirectory?(): Promise<{ directory: string | null; approvedDirectories: string[]; askBeforeDownload: boolean }>;
      resetBrowserDownloadDirectory?(): Promise<{ directory: string | null; approvedDirectories: string[]; askBeforeDownload: boolean }>;
      setBrowserAskBeforeDownload?(enabled: boolean): Promise<{ directory: string | null; approvedDirectories: string[]; askBeforeDownload: boolean }>;
      getBrowserAccessRules?(): Promise<Array<{ origin: string; decision: 'allow' | 'deny' }>>;
      setBrowserAccessRule?(origin: string, decision: 'allow' | 'deny' | 'ask'): Promise<Array<{ origin: string; decision: 'allow' | 'deny' }>>;
      getBrowserUseSitePolicies?(): Promise<import('@memmy/local-api-contracts').BrowserUseSiteRule[]>;
      upsertBrowserUseSitePolicy?(rule: import('@memmy/local-api-contracts').BrowserUseSiteRule): Promise<import('@memmy/local-api-contracts').BrowserUseSiteRule[]>;
      removeBrowserUseSitePolicy?(pattern: string): Promise<import('@memmy/local-api-contracts').BrowserUseSiteRule[]>;
      getBrowserSidebarSurface?(sessionKey: string): Promise<ComputerUseSurfaceMessage | null>;
      onBrowserSidebarSurface?(callback: (message: ComputerUseSurfaceMessage) => void): () => void;
      onEmbeddedBrowserOpen?(callback: (url: string, owner?: { scopeKey?: string; sourceGuestId?: number }) => void): () => void;
      onEmbeddedBrowserClose?(callback: (tabId: number) => void): () => void;
      copyEmbeddedBrowserTabMention?(tabId: number): Promise<void>;
      selectEmbeddedBrowserTab?(tabId: number | null): void;
      sendBrowserSidebarAction?(sessionKey: string, action: Pick<ComputerUseSurfaceAction, "action" | "x" | "y" | "deltaY" | "key" | "url">): Promise<boolean>;
      getComputerHistoryPermissionSessionId?(): Promise<string>;
      guideMemmyPermission?(permission: "accessibility" | "inputMonitoring" | "screenRecording"): Promise<boolean>;
      restartForComputerHistoryPermissions?(): Promise<void>;
      openComputerHistoryMarkdown(filePath: string): Promise<void>;
      openAgentTool(sourceId: string, prompt: string): Promise<{ opened: boolean }>;
      openMailto(mailtoUrl: string): Promise<void>;
      copyImageToClipboard(request: DesktopImageActionRequest): Promise<void>;
      saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;
      saveFile(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;
      exportMemoryDatabase(): Promise<{ canceled: true } | { canceled: false; exportPath: string; bytes: number }>;
      installCliTools(): Promise<MemmyCliInstallResult>;
      restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;
      openLogsDirectory(): Promise<void>;
      exportDiagnosticsReport(): Promise<MemmyDiagnosticsReportExportResult>;
      getLogLevel(): Promise<"error" | "warn" | "info" | "debug">;
      setLogLevel(level: "error" | "warn" | "info" | "debug"): Promise<void>;
      getLaunchAtLogin(): Promise<boolean>;
      setLaunchAtLogin(enabled: boolean): Promise<boolean>;
      getMicrophoneAccessStatus(): Promise<MemmyMicrophoneAccessStatus>;
      requestMicrophoneAccess(): Promise<MemmyMicrophoneAccessStatus>;
      getFullDiskAccessStatus?(): Promise<boolean>;
      selectProjectDirectory(): Promise<DesktopProjectDirectorySelection>;
      selectEmptyProjectDirectory(): Promise<DesktopProjectDirectorySelection>;
      readWorkspaceDirectory(rootPath: string, relativePath?: string): Promise<MemmyWorkspaceDirectoryResult>;
      writeWorkspaceFile(rootPath: string, filePath: string, contents: string): Promise<void>;
      notifyTaskDone(payload: { title: string; body: string; silent: boolean; deliveryId?: string }): Promise<void>;
      notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void>;
      setPetWindow(enabled: boolean, target?: { route?: string; hash?: string; agentChatId?: string; petIntent?: "user" }): Promise<void>;
      hidePetWindow(): Promise<void>;
      onRouteTargetRequest(
        callback: (target: { route?: string; hash?: string; agentChatId?: string }) => void
      ): () => void;
      setMenuBarIcon(enabled: boolean): Promise<{ enabled: boolean }>;
      setComputerHistoryTrayIndicator?(state: { enabled: boolean; recording: boolean }): void;
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
      sendAnalyticsClientId(payload: {
        clientId: string;
        appEnv: "dev" | "prod";
        appEdition: "cn" | "intl";
      }): void;
    };
  }
}

export {};
