import { createLocalBackend, loadCloudServiceEnv, sendGa4Events, resolveGa4Config, type BootstrapScenario, type LocalBackend } from "@memmy/backend";
import { resolveCloudServiceBaseUrl } from "@memmy/local-api-contracts";
import type {
  DesktopAppInfo,
  DesktopImageActionRequest,
  DesktopImageSaveResult,
  DesktopRuntimeConfig,
  DesktopUpdateCheckResult,
  DesktopUpdateDownloadProgress,
  DesktopUpdateDownloadOptions,
  DesktopUpdateInstallResult,
  DesktopUpdateMode,
  MicrophoneAccessStatus
} from "@memmy/desktop-interface";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, systemPreferences, Tray, type Event as ElectronEvent, type FileFilter, type IpcMainEvent, type MenuItemConstructorOptions, type Rectangle, type WebContents } from "electron";
import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { access, appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  fullWindowOptions,
  parsePetWindowLayout,
  parsePetWindowPointer,
  petWindowAlwaysOnTopLevel,
  petWindowOptions,
  resolveFullWindowButtonPosition,
  resolveFullWindowChromeOptions,
  resolveFullWindowSize,
  resolveBootWindowMode,
  resolvePetWindowBounds,
  resolvePetWindowDragAnchor,
  resolveRendererUrl as resolveDesktopRendererUrl,
  type DesktopWindowMode,
  type RendererRouteTarget,
  type PetWindowLayout,
  type PetWindowPointer
} from "./window-mode.js";
import {
  preparePackagedRuntimeConfig,
  resolveAgentGatewayRuntimeConfig,
  startPackagedRuntimeServices,
  type PackagedRuntimeServices
} from "./runtime-services.js";
import { resolveRendererContextMenuCommands, resolveRendererContextMenuMaxLabelWidth, type RendererContextMenuCommand } from "./renderer-context-menu.js";
import { startPackagedRendererStaticServer, type PackagedRendererStaticServer } from "./renderer-static-server.js";
import { shouldBlockRendererReloadShortcut } from "./renderer-shortcuts.js";
import { normalizeMailtoUrl } from "./mailto-url.js";
import {
  desktopRuntimeHomeDirectoryName,
  desktopUserDataDirectoryName,
  resolveDesktopEdition,
  resolveDesktopPackageSigning,
  type DesktopEdition,
  type DesktopPackageSigning
} from "./desktop-edition.js";
import {
  getCurrentLogLevel,
  initLogger,
  setLogLevel as applyAndPersistLogLevel,
  type LogLevel
} from "./logger.js";

let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let localBackend: LocalBackend | null = null;
let menuBarTray: Tray | null = null;
const MENU_BAR_TRAY_GUID = "8B2A0C33-45C0-4C43-8F1C-77F7D4FDF2D4";
let runtimeServices: PackagedRuntimeServices | null = null;
let runtimeConfig: DesktopRuntimeConfig | null = null;
let packagedRendererServer: PackagedRendererStaticServer | null = null;
let packagedRendererBaseUrl: string | null = null;
let queuedPetWindowClose: ReturnType<typeof setTimeout> | null = null;
let petWindowCloseActivateSuppressionTimer: ReturnType<typeof setTimeout> | null = null;
let latestPetWindowLayout: PetWindowLayout | null = null;
let petMascotScreenAnchor: { x: number; y: number } | null = null;
let latestPetWindowBounds: Rectangle | null = null;
let isPetWindowReadyToShow = false;
let activePetWindowDrag: ActivePetWindowDrag | null = null;
let cancelPendingPetModeAfterFullScreenExit: (() => void) | null = null;
let pendingMainWindowAction: PendingMainWindowAction | null = null;
let nextMainWindowActionId = 0;
let isReplayingMainWindowAction = false;
let isQuitting = false;
let isQuitCleanupInProgress = false;
let isQuitCleanupComplete = false;
let quitCleanupForceExitTimer: ReturnType<typeof setTimeout> | null = null;
let areIpcHandlersRegistered = false;
let isBootReady = false;
let analyticsClientId: string | null = null;
let analyticsAppEnv: "dev" | "prod" | null = null;
let requiredUpdateBackgroundFirstCheckTimer: ReturnType<typeof setTimeout> | null = null;
let requiredUpdateBackgroundCheckTimer: ReturnType<typeof setTimeout> | null = null;
let isRequiredUpdateBackgroundCheckRunning = false;
let preparedManagedBackgroundUpdateVersion: string | null = null;
let updateInstallForceExitTimer: ReturnType<typeof setTimeout> | null = null;
let isManagedUpdateInstallerRunning = false;
let shouldSuppressActivateAfterPetWindowClose = false;
const programmaticPetWindowCloses = new WeakSet<BrowserWindow>();

type MainWindowUserAction = "close" | "minimize";
type MainWindowActionResolution = "close" | "hide" | "minimize" | "pet" | "quit";
type ElectronMediaAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";
const PET_WINDOW_DRAG_FRAME_MS = 1000 / 60;
const PET_WINDOW_CLOSE_ACTIVATE_SUPPRESSION_MS = 500;
const PET_FULLSCREEN_EXIT_CHECK_MS = 50;
const PET_FULLSCREEN_EXIT_TIMEOUT_MS = 2500;
loadCloudServiceEnv();
const UPDATE_MANIFEST_BASE_URL = resolveCloudServiceBaseUrl(process.env.MEMMY_CLOUD_SERVICE);
const UPDATE_MANIFEST_PATH = "/api/memmy/desktop/latest";
const DEFAULT_UPDATE_MANIFEST_URL = `${UPDATE_MANIFEST_BASE_URL}${UPDATE_MANIFEST_PATH}`;
const UPDATE_INSTALL_QUIT_DELAY_MS = 300;
const WINDOWS_UPDATE_INSTALL_QUIT_DELAY_MS = 1200;
const UPDATE_INSTALL_FORCE_EXIT_DELAY_MS = 10000;
const WINDOWS_UPDATE_INSTALL_FORCE_EXIT_DELAY_MS = 4000;
const WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS = 250;
const WINDOWS_PREPARED_UPDATE_RELAUNCH_DELAY_MS = 500;
const APP_QUIT_CLEANUP_FORCE_EXIT_DELAY_MS = 5000;
const APP_QUIT_ANALYTICS_GRACE_MS = 150;
const SINGLE_INSTANCE_LOCK_RETRY_INTERVAL_MS = 500;
const SINGLE_INSTANCE_LOCK_WAIT_DEADLINE_MS = 10000;
const SECOND_INSTANCE_ACTIVATE_DEBOUNCE_MS = 3000;
const MACOS_STALE_REOPEN_QUIT_GRACE_MS = 20000;
const MAIN_WINDOW_ROUTE_TARGET_CHANNEL = "memmy:route-target-request";
const UPDATE_DOWNLOAD_PROGRESS_CHANNEL = "memmy:update-download-progress";
const PREPARED_REQUIRED_UPDATE_FILE = "prepared-required-update.json";
const WINDOWS_UPDATE_PROMPT_LANGUAGE_FILE = "update-prompt-language.txt";
const WINDOWS_APP_USER_MODEL_ID = "cn.memtensor.memmy";
const REQUIRED_UPDATE_BACKGROUND_FIRST_CHECK_DELAY_MS = 60 * 1000;
// Background update check interval: defaults to 5 minutes; can be overridden via the
// MEMMY_UPDATE_CHECK_INTERVAL_MIN env var (set a small value during testing without changing code).
const REQUIRED_UPDATE_BACKGROUND_CHECK_INTERVAL_MS =
  Math.max(1, Number(process.env.MEMMY_UPDATE_CHECK_INTERVAL_MIN) || 5) * 60 * 1000;
// Jitter ratio: the actual interval is randomized within [base, base×(1+ratio)] so that not every
// client hits the server at the exact same moment when a release ships (thundering herd).
const REQUIRED_UPDATE_BACKGROUND_CHECK_JITTER_RATIO = 0.2;
// How long after boot to run the fallback cleanup of the updates directory, avoiding the startup peak.
const UPDATES_PRUNE_STARTUP_DELAY_MS = 10 * 1000;
// Opening/restoring the full window may fire show/focus/activate in quick succession; the
// auto-inject check only needs to run once within a short window.
const AGENT_SOURCE_AUTO_INJECT_TRIGGER_DEBOUNCE_MS = 10 * 1000;

let agentSourceAutoInjectInFlight = false;
let lastAgentSourceAutoInjectTriggeredAt = 0;

/**
 * Computes one background update check interval with jitter applied.
 *
 * @returns The base interval plus a random offset in [0, base×jitterRatio), in milliseconds.
 */
function resolveRequiredUpdateCheckIntervalMs(): number {
  const jitter = REQUIRED_UPDATE_BACKGROUND_CHECK_INTERVAL_MS * REQUIRED_UPDATE_BACKGROUND_CHECK_JITTER_RATIO * Math.random();
  return REQUIRED_UPDATE_BACKGROUND_CHECK_INTERVAL_MS + jitter;
}

interface ActivePetWindowDrag {
  pointer: PetWindowPointer;
  intervalId: ReturnType<typeof setInterval>;
}

interface PendingMainWindowAction {
  id: string;
  action: MainWindowUserAction;
  targetWindow: BrowserWindow;
}

interface PreparedRequiredUpdate {
  filePath: string;
  preparedAt: string;
  downloadUrl?: string;
  latestVersion?: string;
  showUpdatePrompt?: boolean;
}

interface BackgroundUpdateInstallOptions {
  quitCurrentApp: boolean;
  openAfterInstall: boolean;
  expectedVersion?: string;
  showUpdatePrompt?: boolean;
}

type WindowsUpdatePromptLanguage = "zh-CN" | "en-US";

interface MemoryDatabaseExportResult {
  canceled: boolean;
  exportPath?: string;
  bytes?: number;
}

interface CliInstallResult {
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

/**
 * Successful result of a diagnostics report export.
 *
 * Field meanings:
 * - canceled: always false, indicating the user chose a save path.
 * - exportPath: the absolute path the diagnostics report was finally written to.
 * - bytes: the number of bytes written to the file.
 */
interface DiagnosticsReportExportSuccess {
  canceled: false;
  exportPath: string;
  bytes: number;
}

/**
 * Result of a diagnostics report export.
 *
 * Field meanings:
 * - canceled: true means the user canceled the save; false means the export succeeded.
 * - exportPath: the report path on a successful export.
 * - bytes: the report size on a successful export.
 */
type DiagnosticsReportExportResult = { canceled: true } | DiagnosticsReportExportSuccess;

configureAppIdentity();

/**
 * Starts the loopback renderer server used by packaged builds.
 */
async function startPackagedRendererServerIfNeeded(): Promise<void> {
  if (!app.isPackaged || packagedRendererServer) {
    return;
  }

  const rendererRoot = join(import.meta.dirname, "../renderer");
  packagedRendererServer = await startPackagedRendererStaticServer({ rootDirectory: rendererRoot });
  packagedRendererBaseUrl = packagedRendererServer.baseUrl;
}

/**
 * Stops the packaged renderer static server.
 */
async function stopPackagedRendererServer(): Promise<void> {
  const server = packagedRendererServer;
  packagedRendererServer = null;
  packagedRendererBaseUrl = null;
  await server?.close();
}

/**
 * Boots the main desktop flow.
 * @returns Resolves once the local API, IPC, and main window are all initialized.
 */
async function boot(): Promise<void> {
  try {
    initLogger();
    forceLightWindowChrome();
    await writePackagedStartupLog("boot:start");
    if (await installPreparedRequiredUpdateBeforeBoot()) {
      await writePackagedStartupLog("boot:prepared-required-update-started");
      return;
    }

    showSplashWindow(); // Only show the splash on a normal boot (the update-handoff exit branch already returned above)
    registerIpcHandlers();
    await installBundledCliIfNeeded();
    await startPackagedRendererServerIfNeeded();
    runtimeServices = app.isPackaged
      ? await startPackagedRuntimeServices({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        logDirectory: app.getPath("logs"),
        logLevel: getCurrentLogLevel()
      })
      : null;
    runtimeConfig = await startLocalApi(runtimeServices);
    isBootReady = true;
    createInitialWindow();
    triggerAgentSourceAutoInject("boot");
    if (process.platform === "darwin") {
      syncMenuBarTray(resolveMenuBarIconEnabled());
    }
    setDevelopmentDockIcon();
    await writePackagedStartupLog("boot:ready");
    startRequiredUpdateBackgroundChecks();
    // Fallback cleanup of leftover packages in the updates directory: deferred and async, to avoid
    // the startup peak and not block the window from showing.
    setTimeout(() => void pruneUpdatesDirectory(), UPDATES_PRUNE_STARTUP_DELAY_MS);
  } catch (error) {
    await runtimeServices?.close();
    runtimeServices = null;
    throw error;
  }
}

/**
 * Configures the app name and user data directory.
 * @returns Nothing.
 */
function configureAppIdentity(): void {
  const edition = resolveCurrentDesktopEdition();
  const memmyHome = join(homedir(), desktopRuntimeHomeDirectoryName(edition));
  app.setName("Memmy");
  if (process.platform === "win32") {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }
  app.setPath("userData", join(app.getPath("appData"), desktopUserDataDirectoryName(edition)));
  if (app.isPackaged) {
    process.env.MEMMY_HOME = memmyHome;
    process.env.MEMMY_CONFIG = join(memmyHome, "config.yaml");
  } else {
    process.env.MEMMY_HOME ??= memmyHome;
    process.env.MEMMY_CONFIG ??= join(memmyHome, "config.yaml");
  }
}

/**
 * Reads the edition identity written at packaging time.
 * @returns The desktop package edition identity.
 */
function resolveCurrentDesktopEdition(): DesktopEdition {
  return resolveDesktopEdition(readCurrentDesktopEditionManifest(), process.env.MEMMY_ACCOUNT_CHANNEL);
}

/**
 * Reads the signing identity written at packaging time.
 * @returns The desktop package signing identity.
 */
function resolveCurrentDesktopPackageSigning(): DesktopPackageSigning {
  return resolveDesktopPackageSigning(readCurrentDesktopEditionManifest(), process.env.MEMMY_PACKAGE_SIGNING);
}

function resolveCurrentDesktopPlatformType(): string {
  return `${process.platform}-${process.arch}-${resolveCurrentDesktopEdition()}-${resolveCurrentDesktopPackageSigning()}`;
}

function readCurrentDesktopEditionManifest(): string | null {
  const manifestPath = join(import.meta.dirname, "desktop-edition.json");
  return existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
}

/**
 * Installs the bundled CLI into the user's PATH.
 *
 * A drag-and-drop DMG cannot run scripts automatically when dragged into
 * Applications, so we create user-level symlinks the first time the app launches
 * from /Applications. Failures are only logged and do not affect GUI startup.
 *
 * @returns Resolves once installation completes.
 */
async function installBundledCliIfNeeded(): Promise<void> {
  if (!app.isPackaged || !isInstalledApplicationsApp()) {
    return;
  }

  try {
    const cliDirectory = join(process.resourcesPath, "cli");
    const memoryCli = join(cliDirectory, "memmy-memory");
    const memmyCli = join(cliDirectory, "memmy");
    await Promise.all([access(memoryCli), access(memmyCli)]);

    const binDirectory = await resolveCliInstallDirectory();
    await mkdir(binDirectory, { recursive: true });
    await installSymlink(memoryCli, join(binDirectory, "memmy-memory"));
    await installSymlink(memmyCli, join(binDirectory, "memmy"));
    await ensureUserPathIncludes(binDirectory);
  } catch (error) {
    console.warn("Memmy CLI auto-install skipped:", error);
  }
}

async function installCliTools(): Promise<CliInstallResult> {
  const binDirectory = join(homedir(), ".local", "bin");
  const entries = resolveCliToolEntries();
  await mkdir(binDirectory, { recursive: true });

  const installed: CliInstallResult["installed"] = [];
  for (const entry of entries) {
    await access(entry.source, fsConstants.R_OK);
    await chmod(entry.source, 0o755).catch(() => undefined);

    const target = join(binDirectory, entry.name);
    await replaceCliSymlink(entry.source, target);
    installed.push({ ...entry, target });
  }

  const profilePaths = await ensureDirectoryOnUserPath(binDirectory, "# Memmy CLI PATH", 'export PATH="$HOME/.local/bin:$PATH"');
  return {
    ok: true,
    binDirectory,
    installed,
    pathUpdated: profilePaths.length > 0,
    profilePaths
  };
}

function resolveCliToolEntries(): Array<{ name: string; source: string }> {
  if (app.isPackaged) {
    const cliDirectory = join(process.resourcesPath, "cli");
    return [
      { name: "memmy-memory", source: join(cliDirectory, "memmy-memory") }
    ];
  }

  const rootDirectory = resolveDevelopmentRoot();
  const memoryCli = join(rootDirectory, "Memory", "dist", "src", "cli", "index.js");
  return [
    { name: "memmy-memory", source: memoryCli }
  ];
}

function resolveDevelopmentRoot(): string {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), "../../.."),
    app.getAppPath(),
    resolve(app.getAppPath(), "../../.."),
    resolve(app.getAppPath(), "../../../.."),
    resolve(app.getAppPath(), "../../../../..")
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "Memory", "dist", "src", "cli", "index.js"))) {
      return candidate;
    }
  }

  return resolve(process.cwd(), "../../..");
}

async function replaceCliSymlink(source: string, target: string): Promise<void> {
  try {
    const current = await lstat(target);
    if (!current.isSymbolicLink()) {
      throw new Error(`${target} already exists and is not a symlink`);
    }
    await unlink(target);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await symlink(source, target);
}

/**
 * Determines whether the current packaged app is already installed under /Applications.
 *
 * @returns True when it is installed.
 */
function isInstalledApplicationsApp(): boolean {
  return resolveCurrentAppBundlePath().startsWith("/Applications/");
}

/**
 * Path of the currently running macOS `.app` bundle.
 *
 * @returns The current app bundle path.
 */
function resolveCurrentAppBundlePath(): string {
  return dirname(dirname(dirname(process.execPath)));
}

/**
 * Resolves the CLI install directory.
 *
 * Defaults to the user-level ~/.local/bin to avoid touching system directory permissions.
 *
 * @returns The CLI install directory.
 */
async function resolveCliInstallDirectory(): Promise<string> {
  return join(homedir(), ".local", "bin");
}

/**
 * Creates or refreshes a CLI symlink.
 *
 * @param source The bundled CLI launcher.
 * @param target The command path under the user's PATH.
 * @returns Resolves once done.
 */
async function installSymlink(source: string, target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isSymbolicLink()) {
      return;
    }
    await unlink(target);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await symlink(source, target);
}

async function ensureUserPathIncludes(binDirectory: string): Promise<void> {
  if (binDirectory !== join(homedir(), ".local", "bin")) {
    return;
  }

  const marker = "# Memmy CLI PATH";
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  await Promise.all([
    ensureShellProfileIncludesPath(join(homedir(), ".zshrc"), marker, line),
    ensureShellProfileIncludesPath(join(homedir(), ".bash_profile"), marker, line)
  ]);
}

async function ensureDirectoryOnUserPath(binDirectory: string, marker: string, line: string): Promise<string[]> {
  if (binDirectory !== join(homedir(), ".local", "bin")) {
    return [];
  }

  const profilePaths = [
    join(homedir(), ".zshrc"),
    join(homedir(), ".bash_profile")
  ];
  const results = await Promise.all(profilePaths.map(async (profilePath) => ({
    profilePath,
    changed: await ensureShellProfileIncludesPath(profilePath, marker, line)
  })));
  return results.filter((result) => result.changed).map((result) => result.profilePath);
}

/**
 * Ensures the shell profile includes the Memmy CLI PATH.
 *
 * @param profilePath The shell profile path.
 * @param marker The Memmy CLI PATH marker.
 * @param line The PATH export statement.
 * @returns Resolves once done.
 */
async function ensureShellProfileIncludesPath(profilePath: string, marker: string, line: string): Promise<boolean> {
  let content = "";

  try {
    content = await readFile(profilePath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (content.includes(marker) || content.includes(line)) {
    return false;
  }

  await appendFile(profilePath, `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}\n${marker}\n${line}\n`, "utf8");
  return true;
}

/**
 * Determines whether a Node file error means the path does not exist.
 *
 * @param error The caught error.
 * @returns True when it is ENOENT.
 */
function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function startupLogPath(): string {
  return join(app.getPath("userData"), "startup.log");
}

async function writePackagedStartupLog(message: string): Promise<void> {
  if (!app.isPackaged) {
    return;
  }

  try {
    const logPath = startupLogPath();
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Startup diagnostics must never block the app from opening.
  }
}

function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function showPackagedStartupError(error: unknown): void {
  if (!app.isPackaged) {
    return;
  }

  const message = formatStartupError(error);
  const truncatedMessage = message.length > 4000 ? `${message.slice(0, 4000)}\n...` : message;
  dialog.showErrorBox(
    "Memmy 启动失败",
    `${truncatedMessage}\n\n启动日志：${startupLogPath()}`
  );
}

/**
 * Starts the local API backend.
 * @returns The runtime config the main process stores and exposes to the renderer.
 */
async function startLocalApi(services: PackagedRuntimeServices | null): Promise<DesktopRuntimeConfig> {
  const databasePath = join(app.getPath("userData"), "app.sqlite");
  if (services) {
    process.env.MEMMY_CONFIG ??= services.memory.configPath;
    process.env.MEMMY_MEMORY_LAYER_URL = services.memory.baseUrl;
    process.env.MEMMY_MEMORY_LAYER_TOKEN = services.memory.token;
    process.env.MEMMY_MEMORY_DB_PATH = services.memory.databasePath;
  } else {
    const memoryRuntime = await preparePackagedRuntimeConfig({
      ensureDirectories: false,
      fillMissingAgentSecret: false,
      secretFactory: () => "",
      writeConfig: false
    });
    process.env.MEMMY_CONFIG ??= memoryRuntime.configPath;
    process.env.MEMMY_MEMORY_LAYER_URL ??= memoryRuntime.memoryBaseUrl;
    process.env.MEMMY_MEMORY_LAYER_TOKEN ??= memoryRuntime.memoryToken;
    process.env.MEMMY_MEMORY_DB_PATH ??= memoryRuntime.memoryDatabasePath;
  }
  const desktopInstallFingerprint = app.isPackaged ? await resolveDesktopInstallFingerprint() : undefined;
  localBackend = await createLocalBackend({
    // databasePath: the desktop-side local SQLite database path.
    databasePath,
    // bootstrapScenario: overrides the first-launch state during development/debugging.
    bootstrapScenario: getBootstrapScenario(),
    desktopInstallFingerprint,
    memmyConfigPath: process.env.MEMMY_CONFIG,
    runtimeConfigPath: process.env.MEMMY_HOME ? join(process.env.MEMMY_HOME, "runtime.json") : undefined
  });
  const agentGateway = services?.agentGateway ?? await resolveAgentGatewayRuntimeConfig();
  const agentGatewayConfig: NonNullable<DesktopRuntimeConfig["agentGateway"]> = {
    baseUrl: agentGateway.baseUrl
  };
  if (agentGateway.bootstrapSecret) {
    agentGatewayConfig.bootstrapSecret = agentGateway.bootstrapSecret;
  }

  return {
    ...localBackend.runtimeConfig,
    agentGateway: agentGatewayConfig
  };
}

/**
 * Registers the IPC handlers the renderer uses to read the runtime config.
 * @returns Nothing.
 */
function registerIpcHandlers(): void {
  if (areIpcHandlersRegistered) {
    return;
  }

  areIpcHandlersRegistered = true;

  ipcMain.handle("memmy:get-runtime-config", () => {
    if (!runtimeConfig) {
      throw new Error("Memmy runtime config is not ready");
    }

    return runtimeConfig;
  });

  ipcMain.handle("memmy:get-app-info", () => getDesktopAppInfo());

  ipcMain.handle("memmy:check-for-updates", async () => checkForUpdates());

  ipcMain.handle("memmy:download-update", async (event, update: DesktopUpdateCheckResult, options?: DesktopUpdateDownloadOptions) => downloadUpdate(update, options, event.sender));
  ipcMain.handle("memmy:open-update-installer", async (_event, filePath: string) => openUpdateInstaller(filePath));

  ipcMain.handle("memmy:openExternal", async (_event, url: string) => {
    await openExternalUrl(url);
  });

  ipcMain.handle("memmy:openMailto", async (_event, mailtoUrl: string) => {
    await openMailtoUrl(mailtoUrl);
  });

  ipcMain.handle("memmy:copy-image-to-clipboard", async (event, request: DesktopImageActionRequest) => {
    await copyDesktopImageToClipboard(request, event.sender.getURL());
  });

  ipcMain.handle("memmy:save-image", async (event, request: DesktopImageActionRequest) => (
    saveDesktopImage(request, event.sender.getURL(), BrowserWindow.fromWebContents(event.sender))
  ));

  ipcMain.handle("memmy:notify-task-done", (_event, payload: { title: string; body: string; silent: boolean }) => {
    showTaskDoneNotification(payload);
  });
  ipcMain.handle("memmy:notify-update-available", (_event, payload: { title: string; body: string; silent: boolean }) => {
    showUpdateAvailableNotification(payload);
  });

  ipcMain.handle("memmy:export-memory-database", async (event) => exportMemoryDatabase(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.handle("memmy:install-cli-tools", async () => installCliTools());

  ipcMain.handle("memmy:open-logs-directory", async () => {
    await openLogsDirectory();
  });

  ipcMain.handle("memmy:export-diagnostics-report", async (event) => exportDiagnosticsReport(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.handle("memmy:get-log-level", () => getCurrentLogLevel());

  ipcMain.handle("memmy:set-log-level", (_event, level: LogLevel) => {
    applyAndPersistLogLevel(level);
  });

  ipcMain.handle("memmy:get-microphone-access-status", () => getMicrophoneAccessStatus());

  ipcMain.handle("memmy:request-microphone-access", async () => requestMicrophoneAccess());

  ipcMain.handle("memmy:set-pet-window", (_event, enabled: boolean, target?: RendererRouteTarget | null) => {
    setPetWindowMode(Boolean(enabled), parseRendererRouteTarget(target));
  });

  ipcMain.handle("memmy:hide-pet-window", () => {
    hidePetWindowToBackground();
  });

  ipcMain.handle("memmy:set-menu-bar-icon", (_event, enabled: boolean) => {
    const normalizedEnabled = Boolean(enabled);
    syncMenuBarTray(normalizedEnabled);
    return { enabled: normalizedEnabled };
  });

  ipcMain.handle("memmy:complete-main-window-action", (event, rawResponse: unknown) => {
    const response = parseMainWindowActionResponse(rawResponse);
    if (!response || !pendingMainWindowAction || response.id !== pendingMainWindowAction.id) {
      return;
    }

    if (BrowserWindow.fromWebContents(event.sender) !== pendingMainWindowAction.targetWindow) {
      return;
    }

    applyMainWindowActionResolution(pendingMainWindowAction, response.resolution);
  });

  ipcMain.handle("memmy:get-main-window-fullscreen", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { isFullScreen: false };
    }

    return { isFullScreen: isWindowFullScreenLike(targetWindow) };
  });

  ipcMain.on("memmy:move-pet-window", handleMovePetWindow);
  ipcMain.on("memmy:start-pet-window-drag", handleStartPetWindowDrag);
  ipcMain.on("memmy:stop-pet-window-drag", handleStopPetWindowDrag);
  ipcMain.on("memmy:update-pet-window-layout", handleUpdatePetWindowLayout);
  ipcMain.on("memmy:analytics-client-id", handleAnalyticsClientId);
}

/**
 * Reads the desktop app's own info for display on the About page.
 *
 * @returns The current Electron app info.
 */
function getDesktopAppInfo(): DesktopAppInfo {
  const updateManifestUrl = resolveUpdateManifestUrl();
  return {
    name: app.getName(),
    version: resolveDesktopAppVersion(),
    platform: process.platform,
    arch: process.arch,
    ...(updateManifestUrl ? { updateManifestUrl } : {})
  };
}

/**
 * Resolves the Memmy desktop app version.
 *
 * In development mode, Electron may resolve app.getVersion() to Electron's own
 * version, so we fall back to reading the desktop workspace package.json.
 *
 * @returns The Memmy desktop app version.
 */
function resolveDesktopAppVersion(): string {
  const electronAppVersion = app.getVersion();
  if (electronAppVersion && electronAppVersion !== process.versions.electron) {
    return electronAppVersion;
  }

  return resolveDesktopPackageVersion() ?? electronAppVersion;
}

/**
 * Generates an install fingerprint for the packaged app.
 *
 * @returns A stable fingerprint composed of version, platform, arch, executable path, mtime, and ctime.
 */
async function resolveDesktopInstallFingerprint(): Promise<string> {
  const version = resolveDesktopAppVersion();
  try {
    const executableStat = await stat(process.execPath);
    return [
      version,
      process.platform,
      process.arch,
      process.execPath,
      Math.trunc(executableStat.mtimeMs),
      Math.trunc(executableStat.ctimeMs)
    ].join("|");
  } catch {
    return [version, process.platform, process.arch, process.execPath].join("|");
  }
}

/**
 * Reads the version number from the desktop workspace package.json.
 *
 * @returns The package.json version; null if reading fails.
 */
function resolveDesktopPackageVersion(): string | null {
  const packagePaths = [
    join(process.cwd(), "package.json"),
    join(app.getAppPath(), "package.json"),
    resolve(app.getAppPath(), "../package.json"),
    resolve(app.getAppPath(), "../../package.json")
  ];

  for (const packagePath of packagePaths) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
      const version = readManifestString(packageJson, "version");
      if (version) {
        return version;
      }
    } catch {
      // Continue trying the next development/package candidate.
    }
  }

  return null;
}

/**
 * Checks the remote manifest for a newer version for the current platform.
 *
 * @returns The software update check result.
 */
async function checkForUpdates(): Promise<DesktopUpdateCheckResult> {
  const currentVersion = resolveDesktopAppVersion();
  const manifestUrl = resolveUpdateManifestUrl();
  if (!manifestUrl) {
    return { status: "not-configured", currentVersion };
  }

  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`update manifest request failed: ${response.status}`);
  }

  const manifest = readUpdateEnvelopeManifest(await response.json() as unknown);
  const latestVersion = readManifestString(manifest, "version");
  if (!latestVersion) {
    throw new Error("update manifest missing version");
  }

  if (compareVersionSegments(latestVersion, currentVersion) <= 0) {
    return { status: "latest", currentVersion, latestVersion };
  }

  const downloadUrl = resolveUpdateDownloadUrl(manifest);
  const minSupportedVersion = readManifestString(manifest, "minSupportedVersion");
  const updateMode = readUpdateMode(manifest);
  const force = updateMode === "force" || Boolean(minSupportedVersion && compareVersionSegments(currentVersion, minSupportedVersion) < 0);
  const releaseNotes = readManifestString(manifest, "releaseNotes");
  const publishedAt = readManifestString(manifest, "publishedAt");
  const preparedUpdatePath = downloadUrl ? await resolvePreparedUpdatePackagePath(downloadUrl, latestVersion) : null;
  return {
    status: "available",
    currentVersion,
    latestVersion,
    ...(minSupportedVersion ? { minSupportedVersion } : {}),
    ...(updateMode ? { updateMode } : {}),
    ...(force ? { force } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(preparedUpdatePath ? { preparedUpdatePath } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(publishedAt ? { publishedAt } : {})
  };
}

/**
 * Installs an already-prepared required update during the boot phase.
 *
 * No remote check or download happens here, to avoid leaving the user with no
 * window for a long time after opening the app. The remote check runs in the
 * background after the window is created; if the update package is already
 * downloaded, the next launch installs it directly from local disk.
 *
 * @returns True when a background update install has been started.
 */
async function installPreparedRequiredUpdateBeforeBoot(): Promise<boolean> {
  if (!shouldManageRequiredUpdates()) {
    return false;
  }
  if (process.platform === "win32") {
    return waitForWindowsPreparedRequiredUpdateBeforeBoot();
  }

  try {
    const preparedUpdate = await readPreparedRequiredUpdate();
    if (!preparedUpdate) {
      // The update marker was deleted by the helper (install succeeded); clean up the leftover attempt marker and boot normally.
      await clearPreparedRequiredUpdateAttempt();
      return false;
    }

    const targetVersion = preparedUpdate.latestVersion ?? "unknown";
    const attemptedVersion = await readPreparedRequiredUpdateAttempt();
    if (attemptedVersion !== null && attemptedVersion === targetVersion) {
      // We already tried installing this same version last time, yet the update marker is still
      // present — meaning the install did not succeed. Do not hand it to the installer again
      // (otherwise we get stuck in a "hand off but never open a window" loop); clean up the marker
      // and boot normally. The background check will re-prepare this update later and retry on the
      // next restart.
      await writePackagedStartupLog(`boot:prepared-required-update install-not-completed, boot normally ${targetVersion}`);
      await clearPreparedRequiredUpdate();
      await clearPreparedRequiredUpdateAttempt();
      return false;
    }

    const safeFilePath = resolveDownloadedUpdatePath(preparedUpdate.filePath);
    await access(safeFilePath, fsConstants.R_OK);
    hideMacDockForPreparedUpdateInstall();
    await writePackagedStartupLog(`boot:prepared-required-update ${targetVersion}`);
    if (existsSync(resolvePreparedRequiredUpdateLockPath())) {
      await writePackagedStartupLog(`boot:prepared-required-update waiting-for-lock ${targetVersion}`);
      await waitForPreparedRequiredUpdateLock();
      if (!(await readPreparedRequiredUpdate()) && await reopenInstalledAppAfterPreparedUpdate()) {
        await clearPreparedRequiredUpdateAttempt();
        return true;
      }
    }
    // Record the target version of this attempt; if this install still fails, the next launch uses
    // it to self-heal and open a window normally.
    await writePreparedRequiredUpdateAttempt(targetVersion);
    const installResult = await openBackgroundUpdateInstaller(safeFilePath);
    return Boolean(installResult.willQuit);
  } catch (error) {
    console.warn("prepared required app update skipped:", error);
    await clearPreparedRequiredUpdate();
    await clearPreparedRequiredUpdateAttempt();
    await writePackagedStartupLog(`boot:prepared-required-update skipped\n${formatStartupError(error)}`);
    return false;
  }
}

/**
 * Hands off an already prepared managed update before boot on Windows.
 *
 * Silent updates show an "update in progress" prompt; forced/manual updates just exit silently,
 * which the user perceives as clicking the icon with no response.
 *
 * @returns True when the background update install has been started and the current boot exits.
 */
async function waitForWindowsPreparedRequiredUpdateBeforeBoot(): Promise<boolean> {
  const lockPath = resolvePreparedRequiredUpdateLockPath();

  try {
    if (existsSync(lockPath)) {
      await writePackagedStartupLog("boot:prepared-required-update waiting-for-lock win32");
      if (existsSync(resolveWindowsUpdatePromptMarkerPath())) {
        await showWindowsUpdateInProgressMessage();
      }
      app.exit(0);
      return true;
    }

    const preparedUpdate = await readPreparedRequiredUpdate();
    if (!preparedUpdate) {
      await clearPreparedRequiredUpdateAttempt();
      return false;
    }

    const targetVersion = preparedUpdate.latestVersion ?? "unknown";
    const attemptedVersion = await readPreparedRequiredUpdateAttempt();
    if (attemptedVersion !== null && attemptedVersion === targetVersion) {
      await writePackagedStartupLog(`boot:prepared-required-update install-not-completed, boot normally win32 ${targetVersion}`);
      await clearPreparedRequiredUpdate();
      await clearPreparedRequiredUpdateAttempt();
      return false;
    }

    const safeFilePath = resolveDownloadedUpdatePath(preparedUpdate.filePath);
    await access(safeFilePath, fsConstants.R_OK);
    await writePackagedStartupLog(`boot:prepared-required-update win32 ${targetVersion}`);
    await writePreparedRequiredUpdateAttempt(targetVersion);
    const showUpdatePrompt = preparedUpdate.showUpdatePrompt === true;
    const installResult = await openBackgroundUpdateInstaller(safeFilePath, {
      quitCurrentApp: true,
      openAfterInstall: true,
      expectedVersion: preparedUpdate.latestVersion,
      showUpdatePrompt
    });
    if (showUpdatePrompt && await waitForPreparedRequiredUpdateLockStart()) {
      await showWindowsUpdateInProgressMessage();
    }
    return Boolean(installResult.willQuit);
  } catch (error) {
    console.warn("windows prepared update wait skipped:", error);
    await clearPreparedRequiredUpdate();
    await clearPreparedRequiredUpdateAttempt();
    await writePackagedStartupLog(`boot:prepared-required-update wait skipped win32\n${formatStartupError(error)}`);
    return false;
  }
}

/**
 * Native prompt shown while the Windows update lock exists.
 *
 * @returns True when the auto-dismissable prompt has been started successfully.
 */
async function showWindowsUpdateInProgressMessage(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const promptScriptPath = resolveInstalledWindowsUpdatePromptScriptPath();
  const powerShellPath = resolveWindowsPowerShellPath();
  if (!promptScriptPath || !powerShellPath) {
    return false;
  }

  const languagePath = await ensureWindowsUpdatePromptLanguageFile();
  return startWindowsUpdatePromptProcess(powerShellPath, promptScriptPath, languagePath);
}

/**
 * Starts the Windows update prompt script.
 *
 * @param powerShellPath The system PowerShell path.
 * @param promptScriptPath The prompt script path.
 * @param languagePath The language file path.
 * @returns True when the script starts successfully or exits quickly with a normal code.
 */
async function startWindowsUpdatePromptProcess(powerShellPath: string, promptScriptPath: string, languagePath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const promptProcess = spawn(powerShellPath, [
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      promptScriptPath,
      "-LockPath",
      resolvePreparedRequiredUpdateLockPath(),
      "-AppExe",
      process.execPath,
      "-LanguagePath",
      languagePath
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    const startupTimer = setTimeout(() => {
      cleanup();
      promptProcess.unref();
      resolvePromise(true);
    }, 1000);

    const cleanup = () => {
      clearTimeout(startupTimer);
      promptProcess.removeAllListeners("error");
      promptProcess.removeAllListeners("exit");
    };

    promptProcess.once("error", (error) => {
      void writePackagedStartupLog(`windows-update-prompt-failed:${String(error)}`);
      cleanup();
      resolvePromise(false);
    });
    promptProcess.once("exit", (code) => {
      cleanup();
      resolvePromise(code === 0);
    });
  });
}

/**
 * Path of the Windows update prompt language file.
 *
 * @returns The prompt language file under userData.
 */
function resolveWindowsUpdatePromptLanguagePath(): string {
  return join(app.getPath("userData"), WINDOWS_UPDATE_PROMPT_LANGUAGE_FILE);
}

/**
 * Path of the Windows update prompt script placed by the installer.
 *
 * @returns The installed script path, or null when it does not exist.
 */
function resolveInstalledWindowsUpdatePromptScriptPath(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const scriptPath = join(localAppData, "Memmy", "launcher", "MemmyUpdatePrompt.ps1");
  return existsSync(scriptPath) ? scriptPath : null;
}

/**
 * System path of Windows PowerShell.
 *
 * @returns The absolute path when PowerShell exists.
 */
function resolveWindowsPowerShellPath(): string | null {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    return null;
  }

  const powerShellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(powerShellPath) ? powerShellPath : null;
}

/**
 * Writes the Windows update prompt language.
 *
 * @param language The prompt language.
 * @returns The language file path.
 */
async function writeWindowsUpdatePromptLanguage(language: WindowsUpdatePromptLanguage): Promise<string> {
  const languagePath = resolveWindowsUpdatePromptLanguagePath();
  await mkdir(dirname(languagePath), { recursive: true });
  await writeFile(languagePath, language, "utf8");
  return languagePath;
}

/**
 * Ensures the Windows update prompt language file exists.
 *
 * @returns The language file path.
 */
async function ensureWindowsUpdatePromptLanguageFile(): Promise<string> {
  const languagePath = resolveWindowsUpdatePromptLanguagePath();
  if (!existsSync(languagePath)) {
    await writeWindowsUpdatePromptLanguage(resolveDefaultWindowsUpdatePromptLanguage());
  }
  return languagePath;
}

/**
 * Resolves the Windows update prompt language from the app settings.
 *
 * @returns The app's current display language.
 */
function resolveWindowsUpdatePromptLanguageFromAppSettings(): WindowsUpdatePromptLanguage {
  try {
    const language = localBackend?.getAppSettings().language;
    if (language === "zh-CN" || language === "en-US") {
      return language;
    }
  } catch (error) {
    void writePackagedStartupLog(`windows-update-prompt-language-failed:${String(error)}`);
  }

  return resolveDefaultWindowsUpdatePromptLanguage();
}

/**
 * Windows update prompt language used when the app has no explicitly selected language.
 *
 * @returns The default display language of the current edition.
 */
function resolveDefaultWindowsUpdatePromptLanguage(): WindowsUpdatePromptLanguage {
  return resolveCurrentDesktopEdition() === "intl" ? "en-US" : "zh-CN";
}

/**
 * Starts the background checks for required updates.
 *
 * @returns Nothing.
 */
function startRequiredUpdateBackgroundChecks(): void {
  if (!shouldManageRequiredUpdates() || requiredUpdateBackgroundFirstCheckTimer || requiredUpdateBackgroundCheckTimer) {
    return;
  }

  requiredUpdateBackgroundFirstCheckTimer = setTimeout(() => {
    requiredUpdateBackgroundFirstCheckTimer = null;
    void prepareRequiredUpdateAfterBoot();
    scheduleNextRequiredUpdateCheck();
  }, REQUIRED_UPDATE_BACKGROUND_FIRST_CHECK_DELAY_MS);
}

/**
 * Schedules the next background update check.
 *
 * Uses a recursive setTimeout rather than setInterval so each interval can carry its own jitter,
 * avoiding all clients running on the exact same cadence.
 *
 * @returns Nothing.
 */
function scheduleNextRequiredUpdateCheck(): void {
  requiredUpdateBackgroundCheckTimer = setTimeout(() => {
    void prepareRequiredUpdateAfterBoot();
    scheduleNextRequiredUpdateCheck();
  }, resolveRequiredUpdateCheckIntervalMs());
}

/**
 * Prepares required updates in the background after boot completes.
 *
 * @returns Resolves once preparation is done; failures are only logged and do not affect the current session.
 */
async function prepareRequiredUpdateAfterBoot(): Promise<void> {
  if (!shouldManageRequiredUpdates()) {
    return;
  }
  if (isRequiredUpdateBackgroundCheckRunning) {
    return;
  }

  isRequiredUpdateBackgroundCheckRunning = true;
  try {
    const update = await checkForUpdates();
    if (update.status !== "available" || !update.downloadUrl || !isManagedBackgroundUpdate(update)) {
      return;
    }

    const targetVersion = update.latestVersion ?? update.currentVersion;
    if (preparedManagedBackgroundUpdateVersion === targetVersion) {
      await writePackagedStartupLog(`boot:managed-update already-prepared ${targetVersion}`);
      return;
    }

    if (await hasPreparedRequiredUpdate(update)) {
      preparedManagedBackgroundUpdateVersion = targetVersion;
      await writePackagedStartupLog(`boot:managed-update already-recorded ${targetVersion}`);
      return;
    }

    await writePackagedStartupLog(`boot:managed-update prepare ${update.currentVersion}->${targetVersion}`);
    const preparedFilePath = update.preparedUpdatePath ?? (await downloadUpdate(update, { openInstaller: false })).filePath;
    await writePreparedRequiredUpdate(update, preparedFilePath);
    preparedManagedBackgroundUpdateVersion = targetVersion;
    await writePackagedStartupLog(`boot:managed-update prepared ${targetVersion}`);
  } catch (error) {
    preparedManagedBackgroundUpdateVersion = null;
    console.warn("required app update preparation skipped:", error);
    await writePackagedStartupLog(`boot:managed-update prepare skipped\n${formatStartupError(error)}`);
  } finally {
    isRequiredUpdateBackgroundCheckRunning = false;
  }
}

/**
 * Installs an already-prepared managed update on normal quit.
 *
 * The background check only downloads and writes the marker; the replacement happens on quit,
 * ensuring the next manual open is the new version. The install-before-boot path remains as a
 * fallback for cases where a hard kill or abnormal exit never reached before-quit.
 *
 * @returns Nothing.
 */
async function installPreparedRequiredUpdateOnQuit(): Promise<void> {
  // Only instances that truly finished booting install on quit: this avoids a second instance that
  // was blocked by the single-instance lock (and never started) mistakenly triggering an install,
  // and avoids a repeat install by an instance that exited early during boot (e.g. one that already
  // handed off the install in the boot phase).
  if (!isBootReady || !shouldManageRequiredUpdates() || isManagedUpdateInstallerRunning) {
    return;
  }

  try {
    const preparedUpdate = await readPreparedRequiredUpdate();
    if (!preparedUpdate) {
      return;
    }

    const safeFilePath = resolveDownloadedUpdatePath(preparedUpdate.filePath);
    await access(safeFilePath, fsConstants.R_OK);
    await writePackagedStartupLog(`quit:prepared-required-update ${preparedUpdate.latestVersion ?? "unknown"}`);
    const installOptions: BackgroundUpdateInstallOptions = {
      quitCurrentApp: false,
      // Since the user has already quit, the silent update only replaces the install directory; the
      // user opens the new version manually next time.
      openAfterInstall: false,
      showUpdatePrompt: preparedUpdate.showUpdatePrompt === true
    };
    if (process.platform === "win32") {
      installOptions.expectedVersion = preparedUpdate.latestVersion;
    }
    await openBackgroundUpdateInstaller(safeFilePath, installOptions);
  } catch (error) {
    console.warn("prepared required app update on quit skipped:", error);
    if (isMissingFileError(error)) {
      await clearPreparedRequiredUpdate().catch(() => undefined);
    }
    await writePackagedStartupLog(`quit:prepared-required-update skipped\n${formatStartupError(error)}`);
  }
}

/**
 * Hides the Dock icon during the boot fallback install, reducing the flicker of the old version
 * appearing and then exiting.
 *
 * @returns Nothing.
 */
function hideMacDockForPreparedUpdateInstall(): void {
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
}

/**
 * Determines whether the current platform supports managed required updates.
 *
 * @returns True when it is a packaged app and the current platform supports background install.
 */
function shouldManageRequiredUpdates(): boolean {
  if (!app.isPackaged) {
    return false;
  }

  if (process.platform === "darwin") {
    return isInstalledApplicationsApp();
  }

  return process.platform === "win32";
}

/**
 * Determines whether the target update has already been downloaded and recorded.
 *
 * @param update The update check result.
 * @returns True when the local prepared record is still valid.
 */
async function hasPreparedRequiredUpdate(update: DesktopUpdateCheckResult): Promise<boolean> {
  const preparedUpdate = await readPreparedRequiredUpdate();
  if (!preparedUpdate) {
    return false;
  }

  if (preparedUpdate.latestVersion !== update.latestVersion || preparedUpdate.downloadUrl !== update.downloadUrl) {
    return false;
  }

  try {
    const safeFilePath = resolveDownloadedUpdatePath(preparedUpdate.filePath);
    await access(safeFilePath, fsConstants.R_OK);
    return true;
  } catch {
    await clearPreparedRequiredUpdate();
    return false;
  }
}

/**
 * Reads the prepared required update record.
 *
 * @returns The prepared record; null when it is missing or malformed.
 */
async function readPreparedRequiredUpdate(): Promise<PreparedRequiredUpdate | null> {
  try {
    const raw = await readFile(resolvePreparedRequiredUpdatePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isPreparedRequiredUpdate(parsed) ? parsed : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Writes the prepared required update record.
 *
 * @param update The update check result.
 * @param filePath The path of the downloaded installer package.
 * @returns Resolves once the write completes.
 */
async function writePreparedRequiredUpdate(update: DesktopUpdateCheckResult, filePath: string): Promise<void> {
  const safeFilePath = resolveDownloadedUpdatePath(filePath);
  const preparedUpdate: PreparedRequiredUpdate = {
    filePath: safeFilePath,
    preparedAt: new Date().toISOString(),
    showUpdatePrompt: shouldShowWindowsUpdatePromptForPreparedUpdate(update),
    ...(update.downloadUrl ? { downloadUrl: update.downloadUrl } : {}),
    ...(update.latestVersion ? { latestVersion: update.latestVersion } : {})
  };
  const markerPath = resolvePreparedRequiredUpdatePath();
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(preparedUpdate, null, 2), "utf8");
}

/**
 * Clears the prepared required update record.
 *
 * @returns Resolves once cleanup completes.
 */
async function clearPreparedRequiredUpdate(): Promise<void> {
  try {
    await unlink(resolvePreparedRequiredUpdatePath());
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  } finally {
    if (process.platform === "win32") {
      await clearWindowsUpdatePromptMarker().catch(() => undefined);
    }
  }
}

/**
 * The path of the "install attempted" target-version marker.
 *
 * Kept alongside the update marker: if the install succeeds, the helper deletes the update marker;
 * the next launch uses this marker to judge whether the previous install actually succeeded,
 * avoiding repeatedly handing off to the installer on failure and locking the app into a "hand off
 * but never open a window" loop.
 *
 * @returns The attempt marker file path.
 */
function resolvePreparedRequiredUpdateAttemptPath(): string {
  return `${resolvePreparedRequiredUpdatePath()}.attempt`;
}

/**
 * Reads the target version of the last install attempt.
 *
 * @returns The target version number; null when it does not exist.
 */
async function readPreparedRequiredUpdateAttempt(): Promise<string | null> {
  try {
    const version = (await readFile(resolvePreparedRequiredUpdateAttemptPath(), "utf8")).trim();
    return version.length > 0 ? version : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Records the target version of the current install attempt.
 *
 * @param version The target version number.
 * @returns Resolves once the write completes.
 */
async function writePreparedRequiredUpdateAttempt(version: string): Promise<void> {
  const attemptPath = resolvePreparedRequiredUpdateAttemptPath();
  await mkdir(dirname(attemptPath), { recursive: true });
  await writeFile(attemptPath, version, "utf8");
}

/**
 * Clears the "install attempted" marker.
 *
 * @returns Resolves once cleanup completes.
 */
async function clearPreparedRequiredUpdateAttempt(): Promise<void> {
  try {
    await unlink(resolvePreparedRequiredUpdateAttemptPath());
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

/**
 * Determines whether an unknown value is a valid prepared required update record.
 *
 * @param value The value to check.
 * @returns True when it is a valid record.
 */
function isPreparedRequiredUpdate(value: unknown): value is PreparedRequiredUpdate {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.filePath === "string"
    && value.filePath.trim().length > 0
    && typeof value.preparedAt === "string"
    && value.preparedAt.trim().length > 0
    && (value.downloadUrl === undefined || typeof value.downloadUrl === "string")
    && (value.latestVersion === undefined || typeof value.latestVersion === "string")
    && (value.showUpdatePrompt === undefined || typeof value.showUpdatePrompt === "boolean");
}

/**
 * Determines whether a prepared Windows update should prompt the user the next time they click the icon.
 *
 * @param update Update check result.
 * @returns True for a normal silent update; forced updates exit without any UI.
 */
function shouldShowWindowsUpdatePromptForPreparedUpdate(update: DesktopUpdateCheckResult): boolean {
  return update.updateMode === "silent" && !isRequiredUpdate(update);
}

/**
 * The local record path for a prepared required update.
 *
 * @returns The marker file path under userData.
 */
function resolvePreparedRequiredUpdatePath(): string {
  return join(app.getPath("userData"), PREPARED_REQUIRED_UPDATE_FILE);
}

/**
 * The mutex lock path for the background update helper.
 *
 * @returns The lock directory path next to the marker file.
 */
function resolvePreparedRequiredUpdateLockPath(): string {
  return `${resolvePreparedRequiredUpdatePath()}.lock`;
}

/**
 * Path of the Windows silent-update prompt marker.
 *
 * Only the after-quit silent install writes this marker; a restart update triggered by the user
 * does not, so no extra "update in progress" prompt pops up in that case.
 *
 * @returns The prompt marker file path.
 */
function resolveWindowsUpdatePromptMarkerPath(): string {
  return `${resolvePreparedRequiredUpdatePath()}.prompt`;
}

/**
 * Writes the Windows silent-update prompt marker.
 *
 * @returns Resolves once the write completes.
 */
async function writeWindowsUpdatePromptMarker(): Promise<void> {
  const promptMarkerPath = resolveWindowsUpdatePromptMarkerPath();
  await mkdir(dirname(promptMarkerPath), { recursive: true });
  await writeFile(promptMarkerPath, new Date().toISOString(), "utf8");
}

/**
 * Clears the Windows silent-update prompt marker.
 *
 * @returns Resolves once the cleanup completes.
 */
async function clearWindowsUpdatePromptMarker(): Promise<void> {
  try {
    await unlink(resolveWindowsUpdatePromptMarkerPath());
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

/**
 * Waits for an existing background update helper to finish.
 *
 * @returns Resolves once the lock is released or the wait times out.
 */
async function waitForPreparedRequiredUpdateLock(): Promise<void> {
  const lockPath = resolvePreparedRequiredUpdateLockPath();
  for (let index = 0; index < 600; index += 1) {
    if (!existsSync(lockPath)) {
      return;
    }
    await delay(200);
  }
}

/**
 * Waits for the just-started background update helper to create its lock.
 *
 * @returns True when the lock appears; false on timeout.
 */
async function waitForPreparedRequiredUpdateLockStart(): Promise<boolean> {
  const lockPath = resolvePreparedRequiredUpdateLockPath();
  for (let index = 0; index < 20; index += 1) {
    if (existsSync(lockPath)) {
      return true;
    }
    await delay(100);
  }
  return false;
}

/**
 * When the background update has been completed by the previous exit, opens the newly installed app
 * and exits the current old process.
 *
 * @returns Resolves once the new version of the app has been opened.
 */
async function reopenInstalledAppAfterPreparedUpdate(): Promise<boolean> {
  if (process.platform === "win32") {
    await writePackagedStartupLog(`boot:prepared-required-update reopen ${process.execPath}`);
    await delay(WINDOWS_PREPARED_UPDATE_RELAUNCH_DELAY_MS);
    const opener = spawn(process.execPath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    opener.unref();
    setTimeout(() => {
      app.exit(0);
    }, 100);
    return true;
  }

  if (process.platform === "darwin") {
    const destinationAppPath = resolveMacUpdateDestinationAppPath();
    if (!destinationAppPath) {
      return false;
    }

    await writePackagedStartupLog(`boot:prepared-required-update reopen ${destinationAppPath}`);
    const opener = spawn("/usr/bin/open", ["-n", destinationAppPath], {
      detached: true,
      stdio: "ignore"
    });
    opener.unref();
    setTimeout(() => {
      app.exit(0);
    }, 100);
    return true;
  }

  return false;
}

/**
 * Promise-based delay.
 *
 * @param milliseconds The delay in milliseconds.
 * @returns Resolves once the delay elapses.
 */
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

/**
 * Determines whether the update result is a required update.
 *
 * @param update The update check result.
 * @returns True when the current version must be updated.
 */
function isRequiredUpdate(update: DesktopUpdateCheckResult): boolean {
  return update.force === true || update.updateMode === "force";
}

/**
 * Determines whether the update should be prepared in the background by the main process.
 *
 * @param update The update check result.
 * @returns True for a silent update or a forced update.
 */
function isManagedBackgroundUpdate(update: DesktopUpdateCheckResult): boolean {
  return update.updateMode === "silent" || isRequiredUpdate(update);
}

/**
 * Resolves whether the target update already has a locally downloaded package.
 *
 * @param downloadUrl The installer package download URL.
 * @param latestVersion The target version.
 * @returns The downloaded installer package path; null when it does not exist.
 */
async function resolvePreparedUpdatePackagePath(downloadUrl: string, latestVersion: string | undefined): Promise<string | null> {
  try {
    const filePath = resolveDownloadedUpdatePath(join(resolveUpdatesDirectory(), resolveUpdatePackageFileName(downloadUrl, latestVersion)));
    await access(filePath, fsConstants.R_OK);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Downloads the update installer package and hands it to the system to open.
 *
 * @param update The update check result.
 * @returns The installer package's local path and open state.
 */
async function downloadUpdate(
  update: DesktopUpdateCheckResult,
  options: DesktopUpdateDownloadOptions = {},
  progressTarget?: WebContents
): Promise<DesktopUpdateInstallResult> {
  if (update.status !== "available" || !update.downloadUrl) {
    throw new Error("no update package is available");
  }

  const downloadUrl = normalizeHttpUrl(update.downloadUrl);
  const response = await fetch(downloadUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`update package download failed: ${response.status}`);
  }

  const updatesDirectory = resolveUpdatesDirectory();
  await mkdir(updatesDirectory, { recursive: true });
  const filePath = join(updatesDirectory, resolveUpdatePackageFileName(downloadUrl, update.latestVersion));
  await downloadUpdatePackageToFile(response, filePath, downloadUrl, progressTarget);

  if (options.openInstaller === false) {
    await stageMacDmgUpdatePackage(filePath).catch(async (error) => {
      console.warn("mac update package staging skipped:", error);
      await writePackagedStartupLog(`mac-update-stage skipped\n${formatStartupError(error)}`);
    });
    return { filePath, opened: false };
  }

  if (isRequiredUpdate(update)) {
    return openBackgroundUpdateInstaller(filePath);
  }

  return openUpdateInstaller(filePath);
}

async function downloadUpdatePackageToFile(
  response: Response,
  filePath: string,
  downloadUrl: string,
  progressTarget?: WebContents
): Promise<void> {
  const temporaryFilePath = `${filePath}.download`;
  const totalBytes = readDownloadContentLength(response.headers);
  let transferredBytes = 0;
  let lastPublishedAt = 0;
  let lastPublishedPercent: number | null = null;

  const publishProgress = (force = false) => {
    const progress = createUpdateDownloadProgress(downloadUrl, filePath, transferredBytes, totalBytes);
    const now = Date.now();
    if (!force && now - lastPublishedAt < 100 && progress.percent === lastPublishedPercent) {
      return;
    }

    lastPublishedAt = now;
    lastPublishedPercent = progress.percent;
    emitUpdateDownloadProgress(progressTarget, progress);
  };

  await removeFileIfExists(temporaryFilePath);
  publishProgress(true);

  try {
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      transferredBytes = buffer.byteLength;
      await writeFile(temporaryFilePath, buffer);
      publishProgress(true);
    } else {
      const reader = response.body.getReader();
      const fileHandle = await open(temporaryFilePath, "w");
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }

          await fileHandle.write(value);
          transferredBytes += value.byteLength;
          publishProgress();
        }
      } finally {
        reader.releaseLock();
        await fileHandle.close().catch(() => undefined);
      }
      publishProgress(true);
    }

    await removeFileIfExists(filePath);
    await rename(temporaryFilePath, filePath);
  } catch (error) {
    await removeFileIfExists(temporaryFilePath).catch(() => undefined);
    throw error;
  }
}

function readDownloadContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) {
    return null;
  }

  const bytes = Number.parseInt(value, 10);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function createUpdateDownloadProgress(
  downloadUrl: string,
  filePath: string,
  transferredBytes: number,
  totalBytes: number | null
): DesktopUpdateDownloadProgress {
  const safeTransferredBytes = Math.max(0, Math.round(transferredBytes));
  const safeTotalBytes = totalBytes && totalBytes > 0 ? Math.round(totalBytes) : null;
  return {
    downloadUrl,
    filePath,
    transferredBytes: safeTransferredBytes,
    totalBytes: safeTotalBytes,
    percent: safeTotalBytes
      ? Math.min(100, Math.max(0, Math.round((safeTransferredBytes / safeTotalBytes) * 100)))
      : null
  };
}

function emitUpdateDownloadProgress(
  progressTarget: WebContents | undefined,
  progress: DesktopUpdateDownloadProgress
): void {
  if (!progressTarget || progressTarget.isDestroyed()) {
    return;
  }

  progressTarget.send(UPDATE_DOWNLOAD_PROGRESS_CHANNEL, progress);
}

async function removeFileIfExists(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: unknown) => {
    if (!isMissingFileError(error)) {
      throw error;
    }
  });
}

/**
 * Opens an update installer package already downloaded to this machine.
 *
 * @param filePath The installer package path returned by the main process download.
 * @returns The installer package's local path and open state.
 */
async function openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult> {
  const safeFilePath = resolveDownloadedUpdatePath(filePath);
  if (shouldInstallMacDmgUpdateInBackground(safeFilePath)) {
    const result = await installMacDmgUpdateInBackground(safeFilePath);
    if (!result.background) {
      await clearPreparedRequiredUpdate().catch(() => undefined);
    }
    return result;
  }

  if (shouldInstallWindowsUpdateInBackground(safeFilePath)) {
    const result = await installWindowsUpdateInBackground(safeFilePath);
    if (!result.background) {
      await clearPreparedRequiredUpdate().catch(() => undefined);
    }
    return result;
  }

  const openError = await shell.openPath(safeFilePath);
  if (openError) {
    throw new Error(openError);
  }

  const willQuit = shouldQuitForManualUpdateInstall(safeFilePath);
  if (willQuit) {
    scheduleQuitForManualUpdateInstall();
  }

  await clearPreparedRequiredUpdate().catch(() => undefined);
  return { filePath: safeFilePath, opened: true, willQuit };
}

/**
 * Opens the background update installer during the boot phase.
 *
 * @param filePath The update package path downloaded by the main process.
 * @returns The installer launch result.
 */
async function openBackgroundUpdateInstaller(
  filePath: string,
  options: BackgroundUpdateInstallOptions = { quitCurrentApp: true, openAfterInstall: true }
): Promise<DesktopUpdateInstallResult> {
  const safeFilePath = resolveDownloadedUpdatePath(filePath);
  if (shouldInstallMacDmgUpdateInBackground(safeFilePath)) {
    return installMacDmgUpdateInBackground(safeFilePath, options);
  }

  if (shouldInstallWindowsUpdateInBackground(safeFilePath)) {
    return installWindowsUpdateInBackground(safeFilePath, options);
  }

  return openUpdateInstaller(safeFilePath);
}

/**
 * Determines whether a macOS DMG update can use background replacement.
 *
 * First-time installs still keep the standard DMG drag-and-drop window; only in-app upgrades of an
 * app already running under `/Applications` use background replacement.
 *
 * @param filePath The path of the downloaded update installer package.
 * @returns True when it can be installed in the background.
 */
function shouldInstallMacDmgUpdateInBackground(filePath: string): boolean {
  return process.platform === "darwin"
    && filePath.toLowerCase().endsWith(".dmg")
    && app.isPackaged
    && resolveMacUpdateDestinationAppPath() !== null;
}

/**
 * Determines whether a Windows installer package can use silent background installation.
 *
 * @param filePath The path of the downloaded update installer package.
 * @returns True when it can be installed in the background.
 */
function shouldInstallWindowsUpdateInBackground(filePath: string): boolean {
  return process.platform === "win32" && filePath.toLowerCase().endsWith(".exe") && app.isPackaged;
}

/**
 * Installs a macOS DMG update in the background.
 *
 * The main process cannot reliably replace its own bundle while running, so we launch a temporary
 * helper. If the app was pre-expanded during the download phase, the helper just waits for the old
 * app to exit, then quickly replaces it and reopens as needed. When there is no staged app, the
 * fallback path of mounting the DMG, copying, and replacing is kept.
 *
 * @param filePath The path of the downloaded DMG.
 * @returns The background install launch result.
 */
async function installMacDmgUpdateInBackground(
  filePath: string,
  options: BackgroundUpdateInstallOptions = { quitCurrentApp: true, openAfterInstall: true }
): Promise<DesktopUpdateInstallResult> {
  const updatesDirectory = resolveUpdatesDirectory();
  await mkdir(updatesDirectory, { recursive: true });
  const destinationAppPath = resolveMacUpdateDestinationAppPath();
  if (!destinationAppPath) {
    throw new Error("Cannot resolve installed Memmy.app path for background update");
  }
  const helperPath = join(updatesDirectory, `install-mac-update-${Date.now()}.zsh`);
  const logPath = join(updatesDirectory, "mac-update-install.log");
  const markerPath = resolvePreparedRequiredUpdatePath();
  const stagedAppPath = resolveStagedMacUpdateAppPath(filePath);
  const stagedReadyPath = resolveStagedMacUpdateReadyPath(filePath);
  const stagedAppArg = existsSync(stagedAppPath) && existsSync(stagedReadyPath) ? stagedAppPath : "";
  const stagedReadyArg = stagedAppArg ? stagedReadyPath : "";
  await writeFile(helperPath, createMacDmgUpdateInstallScript(), { mode: 0o700 });
  await chmod(helperPath, 0o700).catch(() => undefined);

  const helper = spawn("/bin/zsh", [helperPath, filePath, destinationAppPath, logPath, String(process.pid), options.openAfterInstall ? "1" : "0", markerPath, stagedAppArg, stagedReadyArg], {
    detached: true,
    stdio: "ignore"
  });
  helper.unref();
  isManagedUpdateInstallerRunning = true;
  if (options.quitCurrentApp) {
    scheduleQuitForManualUpdateInstall();
  }
  return { filePath, opened: false, willQuit: options.quitCurrentApp, background: true };
}

/**
 * Resolves the app bundle path that a macOS background update should replace.
 *
 * An unsigned test build may, due to App Translocation, have a current execution path that is not
 * under `/Applications`; but as long as the user has already drag-installed `/Applications/Memmy.app`,
 * that official install location should still be the one replaced.
 *
 * @returns The app path that can be replaced in the background; null when the install location cannot be confirmed.
 */
function resolveMacUpdateDestinationAppPath(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const currentAppPath = resolveCurrentAppBundlePath();
  if (currentAppPath.startsWith("/Applications/")) {
    return currentAppPath;
  }

  const installedMemmyAppPath = "/Applications/Memmy.app";
  if (existsSync(installedMemmyAppPath)) {
    return installedMemmyAppPath;
  }

  const applicationsAppPath = join("/Applications", basename(currentAppPath));
  return existsSync(applicationsAppPath) ? applicationsAppPath : null;
}

/**
 * Creates the macOS DMG background install script.
 *
 * @returns The zsh script content.
 */
function createMacDmgUpdateInstallScript(): string {
  return `#!/bin/zsh
set -eu
set -o pipefail

DMG_PATH="$1"
DEST_APP_PATH="$2"
LOG_PATH="$3"
CURRENT_APP_PID="\${4:-}"
OPEN_AFTER_INSTALL="\${5:-1}"
MARKER_PATH="\${6:-}"
STAGED_APP_PATH="\${7:-}"
STAGED_READY_PATH="\${8:-}"
SCRIPT_PATH="$0"
MOUNT_POINT=""
LOCK_DIR=""
TMP_APP_PATH=""
BACKUP_APP_PATH=""
INSTALL_SUCCEEDED=0

exec >> "$LOG_PATH" 2>&1
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] starting Memmy background update"

cleanup() {
  if [[ "$INSTALL_SUCCEEDED" != "1" && -n "$BACKUP_APP_PATH" && -d "$BACKUP_APP_PATH" && ! -d "$DEST_APP_PATH" ]]; then
    /bin/mv "$BACKUP_APP_PATH" "$DEST_APP_PATH" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TMP_APP_PATH" ]]; then
    /bin/rm -rf "$TMP_APP_PATH" >/dev/null 2>&1 || true
  fi
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet || true
    /bin/rmdir "$MOUNT_POINT" 2>/dev/null || true
  fi
  if [[ -n "$LOCK_DIR" && -d "$LOCK_DIR" ]]; then
    /bin/rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  /bin/rm -f "$SCRIPT_PATH" || true
}
trap cleanup EXIT

TMP_APP_PATH="$DEST_APP_PATH.update-tmp"
BACKUP_APP_PATH="$DEST_APP_PATH.update-backup"

validate_app_bundle() {
  local app_path="$1"
  if [[ ! -d "$app_path" ]]; then
    echo "Memmy app bundle missing: $app_path"
    exit 1
  fi
  if [[ ! -f "$app_path/Contents/Info.plist" ]]; then
    echo "Memmy app Info.plist missing: $app_path"
    exit 1
  fi
  local bundle_executable
  bundle_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$bundle_executable" || ! -x "$app_path/Contents/MacOS/$bundle_executable" ]]; then
    echo "Memmy app executable missing: $app_path"
    exit 1
  fi
}

if [[ -n "$MARKER_PATH" ]]; then
  LOCK_DIR="$MARKER_PATH.lock"
  if ! /bin/mkdir "$LOCK_DIR" >/dev/null 2>&1; then
    echo "Memmy background update already running"
    exit 0
  fi
fi

if [[ "$CURRENT_APP_PID" =~ '^[0-9]+$' ]]; then
  echo "waiting for Memmy PID $CURRENT_APP_PID to exit"
  while /bin/kill -0 "$CURRENT_APP_PID" >/dev/null 2>&1; do
    /bin/sleep 0.2
  done
else
  echo "missing Memmy PID, falling back to app path wait"
  while /usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" >/dev/null 2>&1; do
    /bin/sleep 0.2
  done
fi

LEFTOVER_PIDS="$(/usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" || true)"
if [[ -n "$LEFTOVER_PIDS" ]]; then
  echo "terminating leftover Memmy runtime processes: $LEFTOVER_PIDS"
  /bin/kill $LEFTOVER_PIDS >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    LEFTOVER_PIDS="$(/usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" || true)"
    if [[ -z "$LEFTOVER_PIDS" ]]; then
      break
    fi
    /bin/sleep 0.2
  done
  LEFTOVER_PIDS="$(/usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" || true)"
  if [[ -n "$LEFTOVER_PIDS" ]]; then
    /bin/kill -9 $LEFTOVER_PIDS >/dev/null 2>&1 || true
  fi
fi

if [[ -n "$STAGED_APP_PATH" && -n "$STAGED_READY_PATH" && -d "$STAGED_APP_PATH" && -f "$STAGED_READY_PATH" ]]; then
  echo "using staged Memmy app: $STAGED_APP_PATH"
  /bin/rm -rf "$TMP_APP_PATH"
  /bin/mv "$STAGED_APP_PATH" "$TMP_APP_PATH"
  /bin/rm -f "$STAGED_READY_PATH" >/dev/null 2>&1 || true
else
  MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/memmy-update.XXXXXX)"
  /usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT"
  SOURCE_APP_PATH="$(/usr/bin/find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d -print -quit)"
  if [[ -z "$SOURCE_APP_PATH" ]]; then
    echo "update DMG does not contain an app bundle"
    exit 1
  fi

  /bin/rm -rf "$TMP_APP_PATH"
  /usr/bin/ditto "$SOURCE_APP_PATH" "$TMP_APP_PATH"
fi
validate_app_bundle "$TMP_APP_PATH"
/bin/rm -rf "$BACKUP_APP_PATH"
if [[ -d "$DEST_APP_PATH" ]]; then
  /bin/mv "$DEST_APP_PATH" "$BACKUP_APP_PATH"
fi
/bin/mv "$TMP_APP_PATH" "$DEST_APP_PATH"
validate_app_bundle "$DEST_APP_PATH"
/usr/bin/xattr -dr com.apple.quarantine "$DEST_APP_PATH" >/dev/null 2>&1 || true
if [[ -n "$MARKER_PATH" ]]; then
  /bin/rm -f "$MARKER_PATH" >/dev/null 2>&1 || true
fi
/bin/rm -rf "$BACKUP_APP_PATH" >/dev/null 2>&1 || true
INSTALL_SUCCEEDED=1
if [[ "$OPEN_AFTER_INSTALL" == "1" ]]; then
  /bin/sleep 0.1
  /usr/bin/open -n "$DEST_APP_PATH" >/dev/null 2>&1 || true
fi
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Memmy background update finished"
`;
}

/**
 * Pre-expands the app bundle inside the macOS DMG, reducing the blank window time during the actual
 * exit-and-replace.
 *
 * @param filePath The path of the downloaded DMG.
 * @returns Resolves once pre-expansion completes.
 */
async function stageMacDmgUpdatePackage(filePath: string): Promise<void> {
  if (!shouldInstallMacDmgUpdateInBackground(filePath)) {
    return;
  }

  const stagedAppPath = resolveStagedMacUpdateAppPath(filePath);
  const stagedReadyPath = resolveStagedMacUpdateReadyPath(filePath);
  const helperPath = join(resolveUpdatesDirectory(), `stage-mac-update-${Date.now()}.zsh`);
  const logPath = join(resolveUpdatesDirectory(), "mac-update-install.log");
  await writeFile(helperPath, createMacDmgUpdateStageScript(), { mode: 0o700 });
  await chmod(helperPath, 0o700).catch(() => undefined);
  await runHelperScript(helperPath, [filePath, stagedAppPath, stagedReadyPath, logPath]);
}

/**
 * Resolves the pre-expanded app path for a macOS update package.
 *
 * @param filePath The path of the downloaded DMG.
 * @returns The staged app path within the updates directory.
 */
function resolveStagedMacUpdateAppPath(filePath: string): string {
  const safeFilePath = resolveDownloadedUpdatePath(filePath);
  const stageName = basename(safeFilePath).replace(/\.[^.]+$/, "");
  return join(resolveUpdatesDirectory(), `${stageName}.staged.app`);
}

/**
 * Resolves the pre-expansion completion marker for a macOS update package.
 *
 * The staged app directory can only be used by the install script once the ready file exists,
 * preventing the install script from picking up a half-finished bundle.
 *
 * @param filePath The path of the downloaded DMG.
 * @returns The ready file path corresponding to the staged app.
 */
function resolveStagedMacUpdateReadyPath(filePath: string): string {
  return `${resolveStagedMacUpdateAppPath(filePath)}.ready`;
}

/**
 * Creates the macOS update package pre-expansion script.
 *
 * @returns The zsh script content.
 */
function createMacDmgUpdateStageScript(): string {
  return `#!/bin/zsh
set -eu
set -o pipefail

DMG_PATH="$1"
STAGED_APP_PATH="$2"
STAGED_READY_PATH="$3"
LOG_PATH="$4"
SCRIPT_PATH="$0"
MOUNT_POINT=""
STAGED_TMP_PATH="$STAGED_APP_PATH.tmp"

exec >> "$LOG_PATH" 2>&1
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] staging Memmy update package"

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet || true
    /bin/rmdir "$MOUNT_POINT" 2>/dev/null || true
  fi
  /bin/rm -rf "$STAGED_TMP_PATH" 2>/dev/null || true
  /bin/rm -f "$SCRIPT_PATH" || true
}
trap cleanup EXIT

validate_app_bundle() {
  local app_path="$1"
  if [[ ! -d "$app_path" ]]; then
    echo "Memmy staged app bundle missing: $app_path"
    exit 1
  fi
  if [[ ! -f "$app_path/Contents/Info.plist" ]]; then
    echo "Memmy staged app Info.plist missing: $app_path"
    exit 1
  fi
  local bundle_executable
  bundle_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$bundle_executable" || ! -x "$app_path/Contents/MacOS/$bundle_executable" ]]; then
    echo "Memmy staged app executable missing: $app_path"
    exit 1
  fi
}

/bin/rm -rf "$STAGED_TMP_PATH"
/bin/rm -f "$STAGED_READY_PATH"
MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/memmy-stage.XXXXXX)"
/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT"
SOURCE_APP_PATH="$(/usr/bin/find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d -print -quit)"
if [[ -z "$SOURCE_APP_PATH" ]]; then
  echo "update DMG does not contain an app bundle"
  exit 1
fi

/usr/bin/ditto "$SOURCE_APP_PATH" "$STAGED_TMP_PATH"
validate_app_bundle "$STAGED_TMP_PATH"
/bin/rm -rf "$STAGED_APP_PATH"
/bin/mv "$STAGED_TMP_PATH" "$STAGED_APP_PATH"
/usr/bin/xattr -dr com.apple.quarantine "$STAGED_APP_PATH" >/dev/null 2>&1 || true
/usr/bin/touch "$STAGED_READY_PATH"
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] staged Memmy update package"
`;
}

/**
 * Runs a temporary helper script and waits for the result.
 *
 * @param helperPath The helper script path.
 * @param args The helper arguments.
 * @returns Resolves when the helper exits normally.
 */
async function runHelperScript(helperPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const helper = spawn("/bin/zsh", [helperPath, ...args], { stdio: "ignore" });
    helper.once("error", reject);
    helper.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`helper script exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * Silently installs a Windows update in the background.
 *
 * @param filePath The path of the downloaded NSIS installer package.
 * @returns The background install launch result.
 */
async function installWindowsUpdateInBackground(
  filePath: string,
  options: BackgroundUpdateInstallOptions = { quitCurrentApp: true, openAfterInstall: true }
): Promise<DesktopUpdateInstallResult> {
  const updatesDirectory = resolveUpdatesDirectory();
  await mkdir(updatesDirectory, { recursive: true });
  const helperPath = join(updatesDirectory, `install-win-update-${Date.now()}.ps1`);
  const launcherPath = join(updatesDirectory, `launch-win-update-${Date.now()}.vbs`);
  const logPath = join(updatesDirectory, "win-update-install.log");
  if (options.showUpdatePrompt) {
    await writeWindowsUpdatePromptLanguage(resolveWindowsUpdatePromptLanguageFromAppSettings());
    await writeWindowsUpdatePromptMarker();
  } else {
    await clearWindowsUpdatePromptMarker().catch(() => undefined);
  }
  await writeFile(helperPath, createWindowsUpdateInstallScript(), { mode: 0o700 });
  await writeFile(launcherPath, createWindowsUpdateLauncherScript([
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    helperPath,
    filePath,
    process.execPath,
    logPath,
    String(process.pid),
    options.openAfterInstall ? "1" : "0",
    resolvePreparedRequiredUpdatePath(),
    options.expectedVersion ?? ""
  ]), "utf8");
  await appendFile(logPath, `[${new Date().toISOString()}] queued Memmy Windows update helper "${helperPath}"\n`).catch(() => undefined);

  const helper = spawn("wscript.exe", [launcherPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  helper.once("error", (error) => {
    void appendFile(logPath, `[${new Date().toISOString()}] failed to start Memmy Windows update helper: ${String(error)}\n`).catch(() => undefined);
  });
  helper.unref();
  isManagedUpdateInstallerRunning = true;
  if (options.quitCurrentApp) {
    scheduleQuitForManualUpdateInstall();
  }
  return { filePath, opened: false, willQuit: options.quitCurrentApp, background: true };
}

/**
 * Creates the VBS script that launches the Windows update helper hidden.
 *
 * @param command The PowerShell helper launch command and arguments.
 * @returns The VBS script content.
 */
function createWindowsUpdateLauncherScript(command: string[]): string {
  const shellCommand = command.map(quoteWindowsShellArgument).join(" ");
  return `Set shell = CreateObject("WScript.Shell")
shell.Run "${escapeVbsString(shellCommand)}", 0, False
Set fso = CreateObject("Scripting.FileSystemObject")
On Error Resume Next
fso.DeleteFile WScript.ScriptFullName, True
`;
}

/**
 * Quotes a Windows shell command argument.
 *
 * @param value The argument value.
 * @returns The argument ready to be spliced into the command line.
 */
function quoteWindowsShellArgument(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}

function escapeVbsString(value: string): string {
  return value.replace(/"/g, "\"\"");
}

function createWindowsUpdateInstallScript(): string {
  return `param(
  [string]$Installer,
  [string]$AppExe,
  [string]$LogPath,
  [string]$AppPid,
  [string]$OpenAfterInstall,
  [string]$MarkerPath,
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Continue'
$installExit = 0
$lockPath = ''
$promptMarkerPath = ''
if ($MarkerPath) {
  $lockPath = "$MarkerPath.lock"
  $promptMarkerPath = "$MarkerPath.prompt"
}

function Write-MemmyUpdateLog([string]$Message) {
  Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date), $Message)
}

function Start-MemmyAfterUpdate([string]$ExePath, [string]$WorkingDir) {
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    if (Test-Path -LiteralPath $ExePath) {
      try {
        Write-MemmyUpdateLog ('starting app attempt ' + $attempt)
        Start-Process -FilePath $ExePath -WorkingDirectory $WorkingDir -WindowStyle Normal
        return $true
      } catch {
        Write-MemmyUpdateLog ('start app failed: ' + ($_ | Out-String))
      }
    } else {
      Write-MemmyUpdateLog ('app exe not ready for start attempt ' + $attempt)
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

try {
  Write-MemmyUpdateLog 'starting Memmy background update'
  Write-MemmyUpdateLog "installer $Installer"
  Write-MemmyUpdateLog "app $AppExe"
  Write-MemmyUpdateLog "expected version $ExpectedVersion"

  if ($lockPath) {
    try {
      New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
    } catch {
      Write-MemmyUpdateLog 'another Memmy update installer is already running'
      exit 0
    }
  }

  $appDir = Split-Path -Parent $AppExe
  Write-MemmyUpdateLog "install dir $appDir"

  $id = 0
  if ([int]::TryParse($AppPid, [ref]$id)) {
    $deadline = (Get-Date).AddSeconds(60)
    do {
      $process = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($null -eq $process) {
        break
      }
      Start-Sleep -Milliseconds ${WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS}
    } while ((Get-Date) -lt $deadline)
  }

  $deadline = (Get-Date).AddSeconds(30)
  do {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      try {
        $_.Path -eq $AppExe
      } catch {
        $false
      }
    })
    if ($running.Count -eq 0) {
      Write-MemmyUpdateLog 'all app processes exited'
      break
    }
    Write-MemmyUpdateLog ('waiting app processes: ' + (($running | ForEach-Object { $_.Id }) -join ','))
    Start-Sleep -Milliseconds ${WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS}
  } while ((Get-Date) -lt $deadline)

  $runningBeforeInstall = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -eq $AppExe
    } catch {
      $false
    }
  })

  if ($runningBeforeInstall.Count -gt 0) {
    Write-MemmyUpdateLog ('app processes still running before install; waiting: ' + (($runningBeforeInstall | ForEach-Object { $_.Id }) -join ','))
    $deadline = (Get-Date).AddSeconds(120)
    do {
      Start-Sleep -Milliseconds ${WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS}
      $runningBeforeInstall = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try {
          $_.Path -eq $AppExe
        } catch {
          $false
        }
      })
      if ($runningBeforeInstall.Count -eq 0) {
        Write-MemmyUpdateLog 'app processes exited before install'
        break
      }
    } while ((Get-Date) -lt $deadline)
  }

  if ($runningBeforeInstall.Count -gt 0) {
    Write-MemmyUpdateLog ('app processes still running; update cannot start safely: ' + (($runningBeforeInstall | ForEach-Object { $_.Id }) -join ','))
    $installExit = 5
  } elseif (-not (Test-Path -LiteralPath $Installer)) {
    Write-MemmyUpdateLog 'installer missing'
    $installExit = 2
  } elseif (-not $appDir) {
    Write-MemmyUpdateLog 'install dir missing'
    $installExit = 3
  } else {
    if (Test-Path -LiteralPath $AppExe) {
      $beforeVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($AppExe)
      Write-MemmyUpdateLog ('before fileVersion=' + $beforeVersion.FileVersion + '; productVersion=' + $beforeVersion.ProductVersion)
    }

    $arguments = @('/S', '--updated', '/currentuser', ('/D=' + $appDir))
    $installerProcess = Start-Process -FilePath $Installer -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    $installExit = if ($null -eq $installerProcess.ExitCode) { 0 } else { $installerProcess.ExitCode }

    if (Test-Path -LiteralPath $AppExe) {
      $afterVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($AppExe)
      Write-MemmyUpdateLog ('after fileVersion=' + $afterVersion.FileVersion + '; productVersion=' + $afterVersion.ProductVersion)
    }

    if ($installExit -eq 0 -and $ExpectedVersion) {
      if (-not (Test-Path -LiteralPath $AppExe)) {
        Write-MemmyUpdateLog 'installed exe missing after install'
        $installExit = 4
      } else {
        $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($AppExe)
        $actual = @($version.ProductVersion, $version.FileVersion) | Where-Object { $_ } | Select-Object -First 1
        Write-MemmyUpdateLog ('expected version=' + $ExpectedVersion + '; actual version=' + $actual)
        if (-not $actual -or -not $actual.StartsWith($ExpectedVersion)) {
          $installExit = 4
        }
      }
    }
  }

  Write-MemmyUpdateLog "installer exit $installExit"
  if ($installExit -eq 0 -and $MarkerPath) {
    Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
  }
  if ($installExit -eq 0 -and $OpenAfterInstall -eq '1') {
    $started = Start-MemmyAfterUpdate -ExePath $AppExe -WorkingDir $appDir
    if (-not $started) {
      Write-MemmyUpdateLog 'failed to start app after install'
    }
  }
} catch {
  Write-MemmyUpdateLog ('unexpected error: ' + ($_ | Out-String))
  $installExit = 1
} finally {
  if ($lockPath) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
  if ($promptMarkerPath) {
    Remove-Item -LiteralPath $promptMarkerPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}

exit $installExit
`;
}

/**
 * Determines whether the current app needs to quit after opening the update installer package.
 *
 * In non-background install scenarios, a macOS DMG still requires the user to drag the new app into
 * /Applications.
 *
 * @param filePath The path of the downloaded update installer package.
 * @returns True when the current app needs to quit.
 */
function shouldQuitForManualUpdateInstall(filePath: string): boolean {
  return process.platform === "darwin" && filePath.toLowerCase().endsWith(".dmg");
}

/**
 * Delays quitting the current app so Finder has time to open the DMG window before we release
 * /Applications/Memmy.app.
 *
 * @returns Nothing.
 */
function scheduleQuitForManualUpdateInstall(): void {
  setTimeout(() => {
    isQuitting = true;
    const forceExitDelayMs = process.platform === "win32" ? WINDOWS_UPDATE_INSTALL_FORCE_EXIT_DELAY_MS : UPDATE_INSTALL_FORCE_EXIT_DELAY_MS;
    if (process.platform === "win32") {
      hideAppShellForQuit();
      runtimeServices?.terminateSync();
      app.exit(0);
      return;
    }
    app.quit();
    if (!updateInstallForceExitTimer) {
      updateInstallForceExitTimer = setTimeout(() => {
        // Synchronously kill the child services before force-exiting, so memory / agent-gateway do
        // not become orphans holding ports and drag down the new instance reopened after the update.
        runtimeServices?.terminateSync();
        app.exit(0);
      }, forceExitDelayMs);
      updateInstallForceExitTimer.unref?.();
    }
  }, process.platform === "win32" ? WINDOWS_UPDATE_INSTALL_QUIT_DELAY_MS : UPDATE_INSTALL_QUIT_DELAY_MS);
}

/**
 * The download directory for update installer packages.
 *
 * @returns The local update package directory.
 */
function resolveUpdatesDirectory(): string {
  return join(app.getPath("userData"), "updates");
}

/**
 * Parses the version number from an update package / pre-expanded app file name.
 *
 * File names look like `Memmy-0.0.2-darwin-arm64-cn-unsigned.dmg` / `...-unsigned.staged.app`.
 *
 * @param fileName The file name.
 * @returns The version number (e.g. "0.0.2"); null when it cannot be parsed.
 */
function parseUpdatePackageVersion(fileName: string): string | null {
  const match = fileName.match(/-(\d+(?:\.\d+)+)-/u);
  return match?.[1] ?? null;
}

/**
 * Collects the installer package paths that the current update task still needs to keep.
 *
 * @returns The set of updates-directory paths to skip during cleanup.
 */
async function collectProtectedUpdatePaths(): Promise<Set<string>> {
  const protectedPaths = new Set<string>();
  const preparedUpdate = await readPreparedRequiredUpdate().catch(() => null);
  if (!preparedUpdate) {
    return protectedPaths;
  }

  try {
    const safeFilePath = resolveDownloadedUpdatePath(preparedUpdate.filePath);
    protectedPaths.add(resolve(safeFilePath));
    if (process.platform === "darwin" && safeFilePath.toLowerCase().endsWith(".dmg")) {
      const stagedAppPath = resolveStagedMacUpdateAppPath(safeFilePath);
      protectedPaths.add(resolve(stagedAppPath));
      protectedPaths.add(resolve(resolveStagedMacUpdateReadyPath(safeFilePath)));
      protectedPaths.add(resolve(`${stagedAppPath}.tmp`));
    }
  } catch {
    // When the marker is abnormal, do not widen the cleanup scope, to avoid deleting by mistake.
  }

  return protectedPaths;
}

/**
 * Startup fallback cleanup: deletes installer packages and pre-expanded apps in the updates
 * directory that are no longer needed.
 *
 * Cleanup happens after the new app has already started: the current version and older installer
 * packages can be cleaned up; packages being installed or awaiting install are protected by the
 * marker/lock. Only installer packages (.exe/.dmg) and pre-expanded apps (.staged.app) are cleaned;
 * helper/log/lock files are managed by their own flows. Delete failures are ignored.
 *
 * @returns Resolves once cleanup completes; any exception is only logged and does not affect startup.
 */
async function pruneUpdatesDirectory(): Promise<void> {
  try {
    if (isManagedUpdateInstallerRunning || existsSync(resolvePreparedRequiredUpdateLockPath())) {
      return;
    }
    const updatesDirectory = resolveUpdatesDirectory();
    let entries: string[];
    try {
      entries = await readdir(updatesDirectory);
    } catch {
      return; // The directory does not exist; no cleanup needed
    }
    const currentVersion = resolveDesktopAppVersion();
    const protectedPaths = await collectProtectedUpdatePaths();
    for (const entry of entries) {
      if (!/\.(exe|dmg)$/iu.test(entry) && !entry.endsWith(".staged.app")) {
        continue; // Only clean installer packages and pre-expanded apps
      }
      const fullPath = join(updatesDirectory, entry);
      if (protectedPaths.has(resolve(fullPath))) {
        continue;
      }
      const packageVersion = parseUpdatePackageVersion(entry);
      // Version cannot be parsed, or is higher than the currently running version → keep.
      if (!packageVersion || compareVersionSegments(packageVersion, currentVersion) > 0) {
        continue;
      }
      await rm(fullPath, { recursive: true, force: true }).catch(() => undefined);
      if (entry.endsWith(".staged.app")) {
        await rm(`${fullPath}.ready`, { force: true }).catch(() => undefined);
        await rm(`${fullPath}.tmp`, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    console.warn("prune updates directory skipped:", error);
  }
}

/**
 * Restricts the renderer to only opening update packages inside the main process download directory.
 *
 * @param filePath The file path sent back by the renderer.
 * @returns The normalized safe path.
 */
function resolveDownloadedUpdatePath(filePath: string): string {
  const updatesDirectory = resolve(resolveUpdatesDirectory());
  const candidatePath = resolve(filePath);
  if (candidatePath !== updatesDirectory && !candidatePath.startsWith(`${updatesDirectory}${sep}`)) {
    throw new Error("update installer path is outside the update directory");
  }
  return candidatePath;
}

/**
 * Reads and validates the update manifest URL.
 *
 * @returns A usable manifest URL; null when it is not configured.
 */
function resolveUpdateManifestUrl(): string | null {
  const url = new URL(normalizeHttpUrl(DEFAULT_UPDATE_MANIFEST_URL));
  url.searchParams.set("platformType", resolveCurrentDesktopPlatformType());
  url.searchParams.set("version", resolveDesktopAppVersion());
  return url.toString();
}

/**
 * Reads the update manifest from the cloud's unified response envelope.
 *
 * @param value The remote response in `{ code, data, message }` format.
 * @returns The manifest for the update logic to read.
 */
function readUpdateEnvelopeManifest(value: unknown): unknown {
  if (!isRecord(value)) {
    return {};
  }

  if (value.code !== 0) {
    throw new Error("update manifest response code is not ok");
  }

  return readManifestRecord(value, "data") ?? {};
}

/**
 * Selects the download URL for the current platform and architecture from the manifest.
 *
 * @param manifest The remote update manifest.
 * @returns The download URL; null when the manifest does not provide one.
 */
function resolveUpdateDownloadUrl(manifest: unknown): string | null {
  const downloads = readManifestRecord(manifest, "downloads");
  if (!downloads) {
    return null;
  }

  for (const key of buildUpdateDownloadKeys()) {
    const value = downloads[key];
    if (typeof value === "string" && value.trim()) {
      return normalizeHttpUrl(value);
    }
  }

  return null;
}

/**
 * Resolves the update installer package file name.
 *
 * @param downloadUrl The installer package URL.
 * @param latestVersion The latest version number.
 * @returns A safe local file name.
 */
function resolveUpdatePackageFileName(downloadUrl: string, latestVersion: string | undefined): string {
  const urlPathName = new URL(downloadUrl).pathname;
  const urlFileName = basename(urlPathName);
  if (/^[a-zA-Z0-9._+-]+$/u.test(urlFileName) && urlFileName.includes(".")) {
    return urlFileName;
  }

  const version = (latestVersion ?? resolveDesktopAppVersion()).replace(/[^a-zA-Z0-9._+-]/gu, "");
  return `Memmy-${version}-${process.platform}-${process.arch}${resolveUpdatePackageExtension()}`;
}

/**
 * The default installer package extension for the current platform.
 *
 * @returns The installer package extension.
 */
function resolveUpdatePackageExtension(): string {
  if (process.platform === "darwin") {
    return ".dmg";
  }
  if (process.platform === "win32") {
    return ".exe";
  }
  return ".zip";
}

/**
 * Generates the unique download key for the current installer package.
 *
 * @returns The full platformType that can be matched in the manifest downloads.
 */
function buildUpdateDownloadKeys(): string[] {
  return [resolveCurrentDesktopPlatformType()];
}

/**
 * Compares the numeric segments of two version numbers.
 *
 * @param left The left-hand version.
 * @param right The right-hand version.
 * @returns A positive number when left is greater than right, negative when less, and 0 when equal.
 */
function compareVersionSegments(left: string, right: string): number {
  const leftParts = extractVersionSegments(left);
  const rightParts = extractVersionSegments(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Extracts the numeric segments from a version number.
 *
 * @param version The raw version string.
 * @returns The list of numeric segments.
 */
function extractVersionSegments(version: string): number[] {
  return (version.match(/\d+/gu) ?? []).map((part) => Number(part));
}

/**
 * Reads a string field from the manifest.
 *
 * @param value The raw manifest value.
 * @param key The field name.
 * @returns A non-empty string; null when it does not exist.
 */
function readManifestString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Reads the update mode from the manifest.
 *
 * @param value The raw manifest value.
 * @returns A supported update mode; undefined when it is missing or invalid.
 */
function readUpdateMode(value: unknown): DesktopUpdateMode | undefined {
  const updateMode = readManifestString(value, "updateMode");
  return updateMode === "manual" || updateMode === "silent" || updateMode === "force" ? updateMode : undefined;
}

/**
 * Reads an object field from the manifest.
 *
 * @param value The raw manifest value.
 * @param key The field name.
 * @returns The object field; null when it does not exist.
 */
function readManifestRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const raw = value[key];
  return isRecord(raw) ? raw : null;
}

/**
 * Determines whether an unknown value is a plain object.
 *
 * @param value The value to check.
 * @returns True when it is an object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the system microphone permission status.
 *
 * @returns The normalized microphone permission status.
 */
function getMicrophoneAccessStatus(): MicrophoneAccessStatus {
  try {
    return normalizeMicrophoneAccessStatus(systemPreferences.getMediaAccessStatus("microphone") as ElectronMediaAccessStatus);
  } catch {
    return "unsupported";
  }
}

/**
 * Requests system microphone permission.
 *
 * Even when already denied, the Electron API is called again; macOS may simply return the existing
 * denied status and does not necessarily re-show the native confirmation dialog.
 *
 * @returns The microphone permission status after the request.
 */
async function requestMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
  if (process.platform !== "darwin") {
    return getMicrophoneAccessStatus();
  }

  try {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return granted ? "granted" : getMicrophoneAccessStatus();
  } catch {
    return "unsupported";
  }
}

/**
 * Maps Electron's raw permission status to the stable status set used by the renderer.
 *
 * @param status The raw media permission status returned by Electron.
 * @returns A microphone permission status the renderer can understand.
 */
function normalizeMicrophoneAccessStatus(status: ElectronMediaAccessStatus): MicrophoneAccessStatus {
  if (status === "not-determined" || status === "granted" || status === "denied" || status === "restricted") {
    return status;
  }
  return "unsupported";
}

/**
 * Creates and loads the desktop main window.
 *
 * @param target An optional renderer first-screen target; only used in the initial URL construction when creating a new window.
 * @returns The desktop main window instance.
 */
/**
 * Creates the first window based on the persisted default launch mode.
 *
 * When the default launch mode is pet, it goes straight into the transparent pet window; otherwise
 * it creates the full main window.
 *
 * @returns Nothing.
 */
// Startup splash: covers the blank gap between "process starts up" and "main window appears"
// (spinning up local services + a few seconds of first-screen loading).
let splashWindow: BrowserWindow | null = null;
let splashCloseTimer: ReturnType<typeof setTimeout> | null = null;
// Fallback: regardless of whether the close signal arrives, force-close after at most this long, so
// it never blocks the UI permanently.
const SPLASH_MAX_VISIBLE_MS = 15 * 1000;

/**
 * The splash page HTML (purely static, inline data URL, no extra files or preload needed).
 *
 * @returns The splash HTML string.
 */
function resolveSplashHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font-family:-apple-system,"Segoe UI",sans-serif;}
body{display:flex;align-items:center;justify-content:center;background:#1f2937;color:#f9fafb;-webkit-user-select:none;cursor:default;}
.box{display:flex;flex-direction:column;align-items:center;gap:16px;}
.title{font-size:22px;font-weight:600;letter-spacing:1px;}
.hint{font-size:13px;color:#9ca3af;}
.spinner{width:28px;height:28px;border:3px solid rgba(255,255,255,.2);border-top-color:#34d399;border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
</style></head><body><div class="box"><div class="spinner"></div><div class="title">Memmy</div><div class="hint">正在启动…</div></div></body></html>`;
}

/**
 * Shows the startup splash. Only called on the normal boot path; creation failures do not affect the boot flow.
 *
 * @returns Nothing.
 */
function showSplashWindow(): void {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      return;
    }
    const splash = new BrowserWindow({
      width: 300,
      height: 200,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      center: true,
      alwaysOnTop: true,
      backgroundColor: "#1f2937"
    });
    splashWindow = splash;
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(resolveSplashHtml())}`);
    splashCloseTimer = setTimeout(closeSplashWindow, SPLASH_MAX_VISIBLE_MS);
    splashCloseTimer.unref?.();
  } catch (error) {
    console.warn("splash window skipped:", error);
  }
}

/**
 * Closes the startup splash (idempotent, safe to call multiple times).
 *
 * @returns Nothing.
 */
function closeSplashWindow(): void {
  if (splashCloseTimer) {
    clearTimeout(splashCloseTimer);
    splashCloseTimer = null;
  }
  const splash = splashWindow;
  splashWindow = null;
  if (splash && !splash.isDestroyed()) {
    splash.close();
  }
}

function createInitialWindow(): void {
  if (resolveInitialWindowMode() === "pet") {
    setPetWindowMode(true);
    closeSplashWindow(); // Pet mode starts fast; no splash needed
    return;
  }

  createMainWindow();
}

/**
 * Reads the persisted settings to resolve this process's launch window mode.
 *
 * Falls back to the full window when the read fails or the backend is not ready, guaranteeing the
 * GUI always comes up.
 *
 * @returns The window mode this launch should create.
 */
function resolveInitialWindowMode(): DesktopWindowMode {
  try {
    const settings = localBackend?.getAppSettings();
    if (!settings) {
      return "full";
    }

    return resolveBootWindowMode({
      defaultLaunchMode: settings.defaultLaunchMode,
      lastLaunchMode: settings.lastLaunchMode
    });
  } catch (error) {
    void writePackagedStartupLog(`boot:launch-mode-resolve-failed:${String(error)}`);
    return "full";
  }
}

/**
 * Records the window mode last actually used, for resolving when the default launch mode is `last`.
 *
 * A write failure does not affect the window switch; it is only logged.
 *
 * @param mode The window mode after the switch.
 * @returns Nothing.
 */
function recordLaunchMode(mode: DesktopWindowMode): void {
  try {
    localBackend?.recordLaunchMode(mode);
  } catch (error) {
    void writePackagedStartupLog(`launch-mode-record-failed:${String(error)}`);
  }
}

/**
 * Reads the macOS menu bar icon setting, keeping the default (enabled) on failure.
 *
 * @returns Whether to show the menu bar icon.
 */
function resolveMenuBarIconEnabled(): boolean {
  try {
    return localBackend?.getAppSettings().menuBarIconEnabled ?? true;
  } catch (error) {
    void writePackagedStartupLog(`menu-bar-icon-resolve-failed:${String(error)}`);
    return true;
  }
}

/**
 * Syncs the native menu-bar/tray icon according to the current setting.
 *
 * macOS uses the status-bar template icon. Windows only creates the tray icon when forced by a
 * background mode, such as "close to tray", so the normal full window does not gain an extra icon
 * during boot.
 *
 * @param enabled Whether to show the menu bar icon.
 */
function syncMenuBarTray(enabled: boolean): void {
  if (!isNativeTraySupported() || !enabled) {
    destroyMenuBarTray();
    return;
  }

  const trayImage = resolveMenuBarTrayImage();
  if (menuBarTray) {
    menuBarTray.setImage(trayImage);
    return;
  }

  menuBarTray = new Tray(trayImage, MENU_BAR_TRAY_GUID);
  menuBarTray.setToolTip("Memmy");
  if (process.platform === "darwin") {
    menuBarTray.setIgnoreDoubleClickEvents(true);
  }
  menuBarTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "显示 Memmy",
      click: () => activateMainWindow()
    },
    {
      label: "桌宠模式",
      click: () => setPetWindowMode(true, { petIntent: "user" })
    },
    { type: "separator" },
    {
      label: "退出 Memmy",
      click: () => app.quit()
    }
  ]));
  menuBarTray.on("click", () => activateMainWindow());
}

/**
 * Determines whether the current OS has a native tray/status area Memmy should manage.
 *
 * @returns True on macOS and Windows.
 */
function isNativeTraySupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/**
 * Generates the native menu bar/tray icon.
 *
 * @returns The Electron menu bar tray icon.
 */
function resolveMenuBarTrayImage() {
  if (process.platform === "win32") {
    return resolveWindowsTrayImage();
  }

  const packagedIconPath = join(process.resourcesPath, "MenuBarIconTemplate.png");
  const developmentIconPath = resolve(import.meta.dirname, "../../build/MenuBarIconTemplate.png");
  const trayIcon = nativeImage.createFromPath(existsSync(packagedIconPath) ? packagedIconPath : developmentIconPath);
  trayIcon.setTemplateImage(true);
  return trayIcon;
}

/**
 * Resolves the Windows tray icon from the packaged resources, falling back to the dev icon.
 *
 * @returns The Electron tray icon.
 */
function resolveWindowsTrayImage() {
  const iconPath = resolveWindowsTaskbarIconPath() ?? resolve(import.meta.dirname, "../../build/icon.ico");
  return nativeImage.createFromPath(iconPath);
}

/**
 * Sets a custom app icon on the macOS Dock in development mode.
 * After packaging, electron-builder injects icon.icns, so no runtime setup is needed.
 */
function setDevelopmentDockIcon(): void {
  if (app.isPackaged || process.platform !== "darwin") {
    return;
  }
  const devIconPath = resolve(import.meta.dirname, "../../build/icon-dev-dock.png");
  const fallbackPath = resolve(import.meta.dirname, "../../build/icon.png");
  const iconPath = existsSync(devIconPath) ? devIconPath : fallbackPath;
  if (existsSync(iconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath));
  }
}

/**
 * Removes the macOS menu bar icon.
 */
function destroyMenuBarTray(): void {
  if (!menuBarTray) {
    return;
  }

  menuBarTray.destroy();
  menuBarTray = null;
}

function createMainWindow(target: RendererRouteTarget | null = null): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  const windowsTaskbarIconPath = resolveWindowsTaskbarIconPath();
  const targetMainWindow = new BrowserWindow({
    ...fullWindowOptions,
    ...resolveFullWindowChromeOptions(process.platform),
    ...resolveFullWindowSize(screen.getPrimaryDisplay().workArea),
    ...(windowsTaskbarIconPath ? { icon: windowsTaskbarIconPath } : {}),
    // webPreferences: the renderer's security isolation and preload configuration.
    webPreferences: createWebPreferences()
  });
  mainWindow = targetMainWindow;

  hideInWindowMenuBar(targetMainWindow);
  updateFullWindowButtonPosition(targetMainWindow);
  attachWindowOpenHandler(targetMainWindow);
  attachRendererContextMenu(targetMainWindow);
  attachRendererShortcutGuards(targetMainWindow);
  attachMainWindowFullScreenSync(targetMainWindow);
  targetMainWindow.on("resize", () => updateFullWindowButtonPosition(targetMainWindow));
  mainWindow.on("close", handleMainWindowClose);
  const mainWindowWithMinimize = mainWindow as BrowserWindow & {
    on(eventName: "minimize", listener: (event: ElectronEvent) => void): BrowserWindow;
  };
  mainWindowWithMinimize.on("minimize", handleMainWindowMinimize);

  void targetMainWindow.loadURL(resolveRendererUrl("full", target));
  // Close the splash as soon as the main window is ready (dual signals + the timeout fallback above
  // ensure it always gets closed).
  targetMainWindow.once("ready-to-show", closeSplashWindow);
  targetMainWindow.webContents.once("did-finish-load", closeSplashWindow);

  targetMainWindow.on("closed", () => {
    mainWindow = null;
  });

  return targetMainWindow;
}

/**
 * Hides the default Windows/Linux window menu bar, preventing File/Edit/View from taking up the app
 * content area.
 *
 * @param targetWindow The window to handle.
 */
function hideInWindowMenuBar(targetWindow: BrowserWindow): void {
  if (process.platform === "darwin") {
    return;
  }

  targetWindow.setMenu(null);
}

function resolveWindowsTaskbarIconPath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const candidatePaths = app.isPackaged
    ? [join(process.resourcesPath, "icon.ico"), resolve(import.meta.dirname, "../../build/icon.ico")]
    : [resolve(import.meta.dirname, "../../build/icon.ico")];
  return candidatePaths.find((candidatePath) => existsSync(candidatePath));
}

/**
 * Intercepts the main window close, letting the renderer decide whether to show the pet first-run
 * guidance.
 *
 * @param event The Electron close event.
 */
function handleMainWindowClose(event: ElectronEvent): void {
  if (!mainWindow || isQuitting || isReplayingMainWindowAction) {
    return;
  }

  event.preventDefault();
  requestMainWindowAction(mainWindow, "close");
}

/**
 * Intercepts the main window minimize, letting the renderer decide whether to show the pet first-run
 * guidance.
 *
 * @param event The Electron minimize event.
 */
function handleMainWindowMinimize(event: ElectronEvent): void {
  if (!mainWindow || isReplayingMainWindowAction) {
    return;
  }

  event.preventDefault();
  requestMainWindowAction(mainWindow, "minimize");
}

/**
 * Sends one main window action request to the renderer.
 *
 * @param targetWindow The main window that initiated the action.
 * @param action The raw action the user just triggered.
 */
function requestMainWindowAction(targetWindow: BrowserWindow, action: MainWindowUserAction): void {
  // Discard a stale request pointing at an already-destroyed window, so a renderer failure does not
  // permanently block subsequent close/minimize.
  if (pendingMainWindowAction?.targetWindow.isDestroyed()) {
    pendingMainWindowAction = null;
  }

  if (targetWindow.isDestroyed() || pendingMainWindowAction) {
    return;
  }

  // No fallback timeout is set: the pet guidance dialog needs to wait indefinitely for the user's
  // choice. Any timeout would misjudge "the user is thinking" as "the renderer is hung" and force
  // the window closed, making the app look like it crashed. A healthy renderer always sends back a
  // resolution; if the renderer really is hung, keeping the window open is the safe behavior.
  const id = `main-window-action-${++nextMainWindowActionId}`;
  pendingMainWindowAction = { id, action, targetWindow };
  targetWindow.webContents.send("memmy:main-window-action-requested", { id, action });
}

/**
 * Applies the main window action result returned by the renderer.
 *
 * @param pending The current window action request.
 * @param resolution The final action resolved by the renderer.
 */
function applyMainWindowActionResolution(
  pending: PendingMainWindowAction,
  resolution: MainWindowActionResolution
): void {
  pendingMainWindowAction = null;

  if (resolution === "quit") {
    app.quit();
    return;
  }

  const targetWindow = pending.targetWindow;
  if (targetWindow.isDestroyed()) {
    return;
  }

  if (resolution === "pet") {
    setPetWindowMode(true, { petIntent: "user" });
    return;
  }

  if (resolution === "hide") {
    if (process.platform === "win32") {
      syncMenuBarTray(true);
    }
    targetWindow.hide();
    return;
  }

  replayMainWindowAction(() => {
    if (resolution === "close") {
      targetWindow.close();
      return;
    }

    targetWindow.minimize();
  });
}

/**
 * Marks the next native window action as a replay action, so it no longer triggers the guidance
 * interception.
 *
 * @param run The native window action.
 */
function replayMainWindowAction(run: () => void): void {
  isReplayingMainWindowAction = true;
  try {
    run();
  } finally {
    setTimeout(() => {
      isReplayingMainWindowAction = false;
    }, 0);
  }
}

/**
 * Parses the main window action result sent back by the renderer.
 *
 * @param rawResponse The raw IPC input.
 * @returns A valid result; null when invalid.
 */
function parseMainWindowActionResponse(
  rawResponse: unknown
): { id: string; resolution: MainWindowActionResolution } | null {
  if (!rawResponse || typeof rawResponse !== "object") {
    return null;
  }

  const response = rawResponse as Record<string, unknown>;
  if (typeof response.id !== "string" || !isMainWindowActionResolution(response.resolution)) {
    return null;
  }

  return { id: response.id, resolution: response.resolution };
}

/**
 * Determines whether an IPC return value is a supported window action.
 *
 * @param value The value to validate.
 * @returns True means it is executable.
 */
function isMainWindowActionResolution(value: unknown): value is MainWindowActionResolution {
  return value === "close" || value === "hide" || value === "minimize" || value === "pet" || value === "quit";
}

/**
 * Creates and loads the standalone transparent pet window.
 *
 * @returns The pet window instance.
 */
function createPetWindow(target: RendererRouteTarget | null = null): BrowserWindow {
  if (petWindow && !petWindow.isDestroyed()) {
    configurePetWindowPriority(petWindow);
    if (target) {
      void petWindow.loadURL(resolveRendererUrl("pet", target));
    }
    return petWindow;
  }

  const targetPetWindow = new BrowserWindow({
    ...petWindowOptions,
    // show: wait until the renderer is ready before showing, to avoid the transparent window
    // flashing its default background.
    show: false,
    // webPreferences: the renderer's security isolation and preload configuration.
    webPreferences: createWebPreferences()
  });
  petWindow = targetPetWindow;

  attachWindowOpenHandler(petWindow);
  attachRendererContextMenu(petWindow);
  attachRendererShortcutGuards(petWindow);
  configurePetWindowPriority(petWindow);

  targetPetWindow.once("ready-to-show", () => {
    if (targetPetWindow.isDestroyed()) {
      return;
    }

    configurePetWindowPriority(targetPetWindow);
  });

  void targetPetWindow.loadURL(resolveRendererUrl("pet", target));

  targetPetWindow.on("closed", () => {
    const wasProgrammaticClose = programmaticPetWindowCloses.delete(targetPetWindow);
    stopActivePetWindowDrag(false);
    if (petWindow === targetPetWindow) {
      petWindow = null;
    }
    latestPetWindowLayout = null;
    petMascotScreenAnchor = null;
    latestPetWindowBounds = null;
    isPetWindowReadyToShow = false;
    if (!wasProgrammaticClose && !isQuitting) {
      handleDirectPetWindowClose();
    }
  });

  return targetPetWindow;
}

/**
 * Toggles the pet window mode.
 *
 * @param enabled True enters the standalone transparent pet window; false restores the full main window.
 * @returns Nothing.
 */
function setPetWindowMode(enabled: boolean, target: RendererRouteTarget | null = null): void {
  recordLaunchMode(enabled ? "pet" : "full");
  if (enabled) {
    enterPetWindowMode(target);
    return;
  }

  cancelPendingPetModeAfterFullScreenExit?.();
  suspendPetWindowBeforeFullMode();
  showMainWindow(target);
  queuePetWindowClose();
}

/**
 * Closes the pet and hides it to the background: does not restore the full main window, and instead
 * forces the menu bar tray to stay resident, so the user can still re-summon it from the tray via
 * "Pet mode / Show Memmy"; the next cold start returns to full mode.
 * @returns Nothing.
 */
function hidePetWindowToBackground(): void {
  recordLaunchMode("full");
  cancelPendingPetModeAfterFullScreenExit?.();
  // Force the tray icon to show, ensuring there is still a re-summon entry after hiding the pet,
  // regardless of the menuBarIcon setting.
  syncMenuBarTray(true);
  suspendPetWindowBeforeFullMode();
  queuePetWindowClose();
}

/**
 * When the user closes the pet window directly via Cmd+W or a system close action, converge to
 * "return to background full mode".
 * @returns Nothing.
 */
function handleDirectPetWindowClose(): void {
  recordLaunchMode("full");
  syncMenuBarTray(true);
  markPetWindowCloseActivateSuppression();
}

function markPetWindowCloseActivateSuppression(): void {
  if (process.platform !== "darwin") {
    return;
  }

  clearPetWindowCloseActivateSuppression();
  shouldSuppressActivateAfterPetWindowClose = true;
  petWindowCloseActivateSuppressionTimer = setTimeout(() => {
    shouldSuppressActivateAfterPetWindowClose = false;
    petWindowCloseActivateSuppressionTimer = null;
  }, PET_WINDOW_CLOSE_ACTIVATE_SUPPRESSION_MS);
  petWindowCloseActivateSuppressionTimer.unref?.();
}

function consumePetWindowCloseActivateSuppression(): boolean {
  if (!shouldSuppressActivateAfterPetWindowClose) {
    return false;
  }

  clearPetWindowCloseActivateSuppression();
  return true;
}

function clearPetWindowCloseActivateSuppression(): void {
  shouldSuppressActivateAfterPetWindowClose = false;
  if (!petWindowCloseActivateSuppressionTimer) {
    return;
  }

  clearTimeout(petWindowCloseActivateSuppressionTimer);
  petWindowCloseActivateSuppressionTimer = null;
}

/**
 * Enters the pet window mode; if the full main window is inside a macOS fullscreen Space, exit
 * fullscreen first and then hide the main window, to avoid the transparent pet landing on a black
 * screen or at the wrong z-level.
 * @returns Nothing.
 */
function enterPetWindowMode(target: RendererRouteTarget | null = null): void {
  cancelQueuedPetWindowClose();
  const sourceMainWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (sourceMainWindow && isWindowFullScreenLike(sourceMainWindow)) {
    setMacOsActivationPolicy("accessory");
    waitForWindowToLeaveFullScreen(sourceMainWindow, () => {
      if (mainWindow === sourceMainWindow && !sourceMainWindow.isDestroyed()) {
        showPetWindowAndHideMainWindow(sourceMainWindow, target);
      } else {
        showPetWindowAndHideMainWindow(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, target);
      }
    });
    leaveWindowFullScreen(sourceMainWindow);
    return;
  }

  // Non-fullscreen: hide the opaque main window first, then switch the activation policy and create
  // the always-on-top transparent pet window. Otherwise, switching the policy / overlaying the
  // always-on-top transparent pet window while the main window is still visible would make the main
  // window repaint its #f1f8f7 native background, producing a "looks broken" blank bad frame between
  // full->pet.
  sourceMainWindow?.hide();
  setMacOsActivationPolicy("accessory");
  showPetWindowAndHideMainWindow(sourceMainWindow, target);
}

/**
 * Creates/shows the pet window and hides the full main window.
 *
 * @param sourceMainWindow The full main window to hide; when absent, only the pet is shown.
 * @returns Nothing.
 */
function showPetWindowAndHideMainWindow(sourceMainWindow: BrowserWindow | null, target: RendererRouteTarget | null = null): void {
  cancelPendingPetModeAfterFullScreenExit?.();
  const targetPetWindow = createPetWindow(target);
  configurePetWindowPriority(targetPetWindow);
  if (!targetPetWindow.isVisible()) {
    isPetWindowReadyToShow = false;
  }
  if (targetPetWindow.isMinimized()) {
    targetPetWindow.restore();
  }
  if (targetPetWindow.isVisible()) {
    targetPetWindow.showInactive();
  }
  if (sourceMainWindow && !sourceMainWindow.isDestroyed()) {
    sourceMainWindow.hide();
  }
}

/**
 * Before returning to full mode, synchronously demotes and hides the pet window, so the transparent
 * always-on-top window does not keep covering the system menu bar while the main window is fullscreen.
 * @returns Nothing.
 */
function suspendPetWindowBeforeFullMode(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  stopActivePetWindowDrag(false);
  petWindow.setVisibleOnAllWorkspaces(false);
  petWindow.setAlwaysOnTop(false);
  petWindow.hide();
  isPetWindowReadyToShow = false;
}

/**
 * Determines whether the window is in system fullscreen or simpleFullScreen.
 *
 * @param targetWindow The window to check.
 * @returns True means we need to exit fullscreen before hiding.
 */
function isWindowFullScreenLike(targetWindow: BrowserWindow): boolean {
  const simpleFullScreenWindow = targetWindow as BrowserWindow & { isSimpleFullScreen?: () => boolean };
  return targetWindow.isFullScreen() || Boolean(simpleFullScreenWindow.isSimpleFullScreen?.());
}

/**
 * Exits the window's fullscreen state, compatible with macOS simpleFullScreen.
 *
 * @param targetWindow The window to exit fullscreen.
 * @returns Nothing.
 */
function leaveWindowFullScreen(targetWindow: BrowserWindow): void {
  const simpleFullScreenWindow = targetWindow as BrowserWindow & { isSimpleFullScreen?: () => boolean; setSimpleFullScreen?: (flag: boolean) => void };
  if (simpleFullScreenWindow.isSimpleFullScreen?.()) {
    simpleFullScreenWindow.setSimpleFullScreen?.(false);
  }
  if (targetWindow.isFullScreen()) {
    targetWindow.setFullScreen(false);
  }
}

/**
 * Waits until the main window has truly left the fullscreen Space before performing the switch-to-pet
 * action; includes a timeout fallback so a lost system event does not stall the switch.
 *
 * @param targetWindow The window that is exiting fullscreen.
 * @param onReady The callback invoked once entering pet mode is confirmed safe.
 * @returns Nothing.
 */
function waitForWindowToLeaveFullScreen(targetWindow: BrowserWindow, onReady: () => void): void {
  cancelPendingPetModeAfterFullScreenExit?.();
  let completed = false;
  const startedAt = Date.now();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const complete = () => {
    if (completed) {
      return;
    }
    completed = true;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    targetWindow.off("leave-full-screen", complete);
    cancelPendingPetModeAfterFullScreenExit = null;
    onReady();
  };

  cancelPendingPetModeAfterFullScreenExit = () => {
    if (completed) {
      return;
    }
    completed = true;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    targetWindow.off("leave-full-screen", complete);
    cancelPendingPetModeAfterFullScreenExit = null;
  };

  targetWindow.once("leave-full-screen", complete);
  intervalId = setInterval(() => {
    if (targetWindow.isDestroyed() || !isWindowFullScreenLike(targetWindow) || Date.now() - startedAt >= PET_FULLSCREEN_EXIT_TIMEOUT_MS) {
      complete();
    }
  }, PET_FULLSCREEN_EXIT_CHECK_MS);
}

/**
 * Moves the native pet window to the renderer's current mouse position.
 *
 * @param event The IPC event, used to confirm the request comes from the current pet window.
 * @param rawPointer The in-window mouse coordinates passed in by the renderer.
 * @returns Nothing.
 */
function handleMovePetWindow(event: IpcMainEvent, rawPointer: unknown): void {
  if (!petWindow || petWindow.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== petWindow || !latestPetWindowLayout) {
    return;
  }

  const pointer = parsePetWindowPointer(rawPointer);
  if (!pointer) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  petMascotScreenAnchor = resolvePetWindowDragAnchor({
    cursorX: cursor.x,
    cursorY: cursor.y,
    clientX: pointer.clientX,
    clientY: pointer.clientY,
    layout: latestPetWindowLayout
  });
  applyPetWindowBounds();
}

/**
 * Starts having the main process drive the pet window drag by the system cursor position.
 *
 * @param event The IPC event, used to confirm the request comes from the current pet window.
 * @param rawPointer The in-window mouse coordinates passed in by the renderer.
 * @returns Nothing.
 */
function handleStartPetWindowDrag(event: IpcMainEvent, rawPointer: unknown): void {
  if (!petWindow || petWindow.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== petWindow || !latestPetWindowLayout) {
    return;
  }

  const pointer = parsePetWindowPointer(rawPointer);
  if (!pointer) {
    return;
  }

  stopActivePetWindowDrag(false);
  activePetWindowDrag = {
    pointer,
    intervalId: setInterval(updateActivePetWindowDrag, PET_WINDOW_DRAG_FRAME_MS)
  };
  updateActivePetWindowDrag();
}

/**
 * Stops the main-process-driven pet window drag.
 *
 * @param event The IPC event, used to confirm the request comes from the current pet window.
 * @returns Nothing.
 */
function handleStopPetWindowDrag(event: IpcMainEvent): void {
  if (BrowserWindow.fromWebContents(event.sender) !== petWindow) {
    return;
  }

  stopActivePetWindowDrag(true);
}

/**
 * Receives the pet content bounds measured by the renderer and updates the native window bounds.
 *
 * @param event The IPC event, used to confirm the request comes from the current pet window.
 * @param rawLayout The dynamic window layout passed in by the renderer.
 * @returns Nothing.
 */
function handleUpdatePetWindowLayout(event: IpcMainEvent, rawLayout: unknown): void {
  if (!petWindow || petWindow.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== petWindow) {
    return;
  }

  const layout = parsePetWindowLayout(rawLayout);
  if (!layout) {
    return;
  }

  latestPetWindowLayout = layout;
  petMascotScreenAnchor ??= resolveDefaultPetMascotAnchor();
  if (activePetWindowDrag) {
    updateActivePetWindowDrag();
    return;
  }

  applyPetWindowBounds();
  showPetWindowAfterRendererLayout();
}

/**
 * On the first entry into pet mode, waits for the renderer to send the real layout before showing
 * the window, avoiding a one-frame flash of the full page cropped into the small transparent window.
 *
 * @returns Nothing.
 */
function showPetWindowAfterRendererLayout(): void {
  if (!petWindow || petWindow.isDestroyed() || isPetWindowReadyToShow || !latestPetWindowLayout || !petMascotScreenAnchor) {
    return;
  }

  isPetWindowReadyToShow = true;
  configurePetWindowPriority(petWindow);
  applyPetWindowBounds();
  petWindow.showInactive();
}

/**
 * Sets the native pet window bounds based on the current screen anchor and the renderer layout.
 * @returns Nothing.
 */
function applyPetWindowBounds(): void {
  if (!petWindow || petWindow.isDestroyed() || !latestPetWindowLayout || !petMascotScreenAnchor) {
    return;
  }

  const bounds = resolvePetWindowBounds({
    anchorX: petMascotScreenAnchor.x,
    anchorY: petMascotScreenAnchor.y,
    layout: latestPetWindowLayout
  });
  if (areBoundsEqual(latestPetWindowBounds, bounds)) {
    return;
  }

  latestPetWindowBounds = bounds;
  petWindow.setBounds(bounds, false);
}

/**
 * During a drag, moves the pet window position by the current system cursor position, avoiding
 * renderer mousemove IPC becoming a bottleneck.
 * @returns Nothing.
 */
function updateActivePetWindowDrag(): void {
  if (!activePetWindowDrag) {
    return;
  }

  if (!petWindow || petWindow.isDestroyed() || !latestPetWindowLayout) {
    stopActivePetWindowDrag(false);
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  petMascotScreenAnchor = resolvePetWindowDragAnchor({
    cursorX: cursor.x,
    cursorY: cursor.y,
    clientX: activePetWindowDrag.pointer.clientX,
    clientY: activePetWindowDrag.pointer.clientY,
    layout: latestPetWindowLayout
  });
  const nextBounds = resolvePetWindowBounds({
    anchorX: petMascotScreenAnchor.x,
    anchorY: petMascotScreenAnchor.y,
    layout: latestPetWindowLayout
  });
  const currentBounds = latestPetWindowBounds ?? petWindow.getBounds();
  if (currentBounds.x === nextBounds.x && currentBounds.y === nextBounds.y) {
    latestPetWindowBounds = currentBounds;
    return;
  }

  latestPetWindowBounds = {
    ...currentBounds,
    x: nextBounds.x,
    y: nextBounds.y
  };
  petWindow.setPosition(nextBounds.x, nextBounds.y, false);
}

/**
 * Cleans up the pet window drag loop and, when needed, finalizes the bounds once using the latest
 * layout.
 *
 * @param applyFinalBounds Whether to correct the final window size by the latest dynamic layout.
 * @returns Nothing.
 */
function stopActivePetWindowDrag(applyFinalBounds = true): void {
  if (!activePetWindowDrag) {
    return;
  }

  clearInterval(activePetWindowDrag.intervalId);
  activePetWindowDrag = null;
  if (applyFinalBounds) {
    applyPetWindowBounds();
  }
}

function areBoundsEqual(left: Rectangle | null, right: Rectangle): boolean {
  return Boolean(left && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height);
}

/**
 * Resolves the screen anchor for the pet's first appearance.
 * @returns The top-left corner of the Memmy mascot, defaulting to the bottom-right of the primary screen.
 */
function resolveDefaultPetMascotAnchor(): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea;
  const marginX = 200;
  const marginY = 180;
  return {
    x: Math.round(workArea.x + workArea.width - petWindowOptions.minWidth - marginX),
    y: Math.round(workArea.y + workArea.height - petWindowOptions.minHeight - marginY)
  };
}

/**
 * Restores and shows the full main window.
 * @returns Nothing.
 */
function showMainWindow(target: RendererRouteTarget | null = null): void {
  setMacOsActivationPolicy("regular");
  let targetMainWindow: BrowserWindow;
  let shouldNotifyRouteTarget = false;

  if (!mainWindow || mainWindow.isDestroyed()) {
    targetMainWindow = createMainWindow(target);
  } else {
    targetMainWindow = mainWindow;
    shouldNotifyRouteTarget = Boolean(target);
  }

  targetMainWindow.setSkipTaskbar(false);
  targetMainWindow.setAlwaysOnTop(false);
  targetMainWindow.setVisibleOnAllWorkspaces(false);
  targetMainWindow.setResizable(true);
  targetMainWindow.setMinimumSize(fullWindowOptions.minWidth, fullWindowOptions.minHeight);
  targetMainWindow.setBackgroundColor(fullWindowOptions.backgroundColor);
  updateFullWindowButtonPosition(targetMainWindow);
  if (target && shouldNotifyRouteTarget) {
    deliverMainWindowRouteTarget(targetMainWindow, target);
  }
  if (targetMainWindow.isMinimized()) {
    targetMainWindow.restore();
  }
  targetMainWindow.show();
  targetMainWindow.focus();
  triggerAgentSourceAutoInject("show_main_window");
}

function deliverMainWindowRouteTarget(targetWindow: BrowserWindow, target: RendererRouteTarget): void {
  const sendTarget = () => {
    if (targetWindow.isDestroyed()) {
      return;
    }

    targetWindow.webContents.send(MAIN_WINDOW_ROUTE_TARGET_CHANNEL, target);
  };

  if (targetWindow.webContents.isLoading()) {
    targetWindow.webContents.once("did-finish-load", sendTarget);
    return;
  }

  sendTarget();
}

/**
 * Responds to macOS Dock activation, restoring a hidden or minimized main window.
 * @returns Nothing.
 */
function activateMainWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    setPetWindowMode(false);
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    triggerAgentSourceAutoInject("activate_main_window");
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  triggerAgentSourceAutoInject("activate_main_window");
}

function triggerAgentSourceAutoInject(reason: string): void {
  const config = runtimeConfig;
  if (!config || agentSourceAutoInjectInFlight) {
    return;
  }

  const now = Date.now();
  if (now - lastAgentSourceAutoInjectTriggeredAt < AGENT_SOURCE_AUTO_INJECT_TRIGGER_DEBOUNCE_MS) {
    return;
  }

  agentSourceAutoInjectInFlight = true;
  lastAgentSourceAutoInjectTriggeredAt = now;
  const url = new URL("/api/agent-sources/auto-inject/run", config.baseUrl).toString();
  void fetch(url, {
    method: "POST",
    headers: {
      "x-memmy-local-token": config.localToken
    }
  }).catch((error) => {
    void writePackagedStartupLog(`agent-source-auto-inject-failed:${reason}:${String(error)}`);
  }).finally(() => {
    agentSourceAutoInjectInFlight = false;
  });
}

/**
 * After hiding the macOS title bar, puts the window buttons back in the top-left corner.
 *
 * @param targetWindow The main window to update.
 */
function updateFullWindowButtonPosition(targetWindow: BrowserWindow): void {
  if (process.platform !== "darwin") {
    return;
  }

  // A hiddenInset window with a custom traffic-light position drops the buttons to invisible (still
  // clickable) after a hide()/show() round-trip or an activation-policy flip (full<->pet). setWindowButtonPosition
  // only moves them, so force visibility back on every reposition to keep the buttons from vanishing.
  targetWindow.setWindowButtonVisibility(true);
  targetWindow.setWindowButtonPosition(resolveFullWindowButtonPosition());
}

/**
 * Pins the app to the light system theme.
 *
 * macOS paints the INACTIVE (blurred) hiddenInset traffic-light buttons using the color it infers for
 * the app theme. When it infers dark mode it draws them in a light color, which is invisible against
 * our light window background (#f1f8f7) — so the buttons look like they "disappear" whenever the window
 * loses focus. Forcing themeSource to "light" makes macOS draw the visible dark-gray inactive buttons.
 * The desktop UI is a fixed light theme, so this has no other visual impact.
 *
 * @returns Nothing.
 */
function forceLightWindowChrome(): void {
  if (process.platform !== "darwin") {
    return;
  }

  nativeTheme.themeSource = "light";
}

/**
 * Broadcasts the main window's fullscreen state to the renderer, driving the sidebar tool buttons'
 * edge-aligned layout.
 *
 * @param targetWindow The window to sync.
 * @returns Nothing.
 */
function syncMainWindowFullScreenState(targetWindow: BrowserWindow): void {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send("memmy:main-window-fullscreen-changed", {
    isFullScreen: isWindowFullScreenLike(targetWindow)
  });
}

/**
 * Listens for the main window entering/leaving system fullscreen and pushes the initial state once
 * the page finishes loading.
 *
 * @param targetWindow The window to sync.
 * @returns Nothing.
 */
function attachMainWindowFullScreenSync(targetWindow: BrowserWindow): void {
  const sync = () => syncMainWindowFullScreenState(targetWindow);
  targetWindow.on("enter-full-screen", sync);
  targetWindow.on("leave-full-screen", sync);
  targetWindow.webContents.on("did-finish-load", sync);
}

/**
 * Switches the macOS app activation policy: full mode stays a regular app, pet mode stays resident
 * across Spaces as an accessory floating window.
 *
 * @param policy The macOS activation policy.
 * @returns Nothing.
 */
function setMacOsActivationPolicy(policy: "regular" | "accessory"): void {
  if (process.platform !== "darwin") {
    return;
  }

  app.setActivationPolicy(policy);
}

/**
 * Closes the pet window.
 * @returns Nothing.
 */
function closePetWindow(): void {
  cancelQueuedPetWindowClose();
  stopActivePetWindowDrag(false);
  const targetPetWindow = petWindow;
  petWindow = null;
  latestPetWindowLayout = null;
  petMascotScreenAnchor = null;
  latestPetWindowBounds = null;
  if (targetPetWindow && !targetPetWindow.isDestroyed()) {
    programmaticPetWindowCloses.add(targetPetWindow);
    targetPetWindow.close();
  }
}

/**
 * Closes the pet window asynchronously, to avoid destroying the requesting renderer inside the
 * setPetWindow IPC handler.
 * @returns Nothing.
 */
function queuePetWindowClose(): void {
  cancelQueuedPetWindowClose();
  queuedPetWindowClose = setTimeout(() => {
    queuedPetWindowClose = null;
    closePetWindow();
  }, 0);
}

/**
 * Cancels a pending pet window close task.
 * @returns Nothing.
 */
function cancelQueuedPetWindowClose(): void {
  if (!queuedPetWindowClose) {
    return;
  }

  clearTimeout(queuedPetWindowClose);
  queuedPetWindowClose = null;
}

/**
 * Configures the pet window's always-on-top priority and all-workspace visibility.
 *
 * @param targetWindow The pet window whose priority should be raised.
 * @returns Nothing.
 */
function configurePetWindowPriority(targetWindow: BrowserWindow): void {
  targetWindow.setAlwaysOnTop(true, petWindowAlwaysOnTopLevel);
  targetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  targetWindow.setSkipTaskbar(true);
}

/**
 * Creates the renderer's security isolation configuration.
 *
 * @returns The BrowserWindow webPreferences configuration.
 */
function createWebPreferences() {
  return {
    // preload: path to the CommonJS preload file, responsible for exposing the controlled IPC bridge.
    preload: join(import.meta.dirname, "../preload/preload.cjs"),
    // contextIsolation: isolates the web page context from the Electron preload context.
    contextIsolation: true,
    // nodeIntegration: forbids the renderer from directly accessing Node.js APIs.
    nodeIntegration: false
  } as const;
}

/**
 * Binds the new-window open interception.
 *
 * @param targetWindow The Electron window whose window.open should be intercepted.
 * @returns Nothing.
 */
function attachWindowOpenHandler(targetWindow: BrowserWindow): void {
  targetWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });
}

/**
 * Provides the renderer with a browser-style context menu for text, input fields, and links.
 *
 * @param targetWindow The window to bind the menu policy to.
 * @returns Nothing.
 */
function attachRendererContextMenu(targetWindow: BrowserWindow): void {
  targetWindow.webContents.on("context-menu", (event, params) => {
    const appContentWidth = targetWindow.getContentBounds().width;
    const commands = resolveRendererContextMenuCommands({
      ...params,
      maxLabelWidthPx: resolveRendererContextMenuMaxLabelWidth(appContentWidth)
    });
    if (!commands.length) {
      return;
    }

    event.preventDefault();
    Menu.buildFromTemplate(commands.map((command) => rendererContextMenuCommandToItem(command))).popup({
      window: targetWindow
    });
  });
}

function rendererContextMenuCommandToItem(command: RendererContextMenuCommand): MenuItemConstructorOptions {
  switch (command.kind) {
    case "separator":
      return { type: "separator" };
    case "role":
      return { role: command.role, enabled: command.enabled };
    case "openLink":
      return {
        label: command.label,
        click: () => {
          void openExternalUrl(command.url).catch((error: unknown) => {
            console.warn("open context menu link failed", error);
          });
        }
      };
    case "copyLink":
      return {
        label: command.label,
        click: () => clipboard.writeText(command.url)
      };
    case "searchSelection":
      return {
        label: command.label,
        click: () => {
          void openExternalUrl(command.url).catch((error: unknown) => {
            console.warn("open context menu search failed", error);
          });
        }
      };
  }
}

/**
 * Intercepts browser-level keyboard shortcuts in the Electron renderer.
 *
 * @param targetWindow The window to bind the shortcut policy to.
 * @returns Nothing.
 */
function attachRendererShortcutGuards(targetWindow: BrowserWindow): void {
  targetWindow.webContents.on("before-input-event", (event, input) => {
    if (shouldBlockRendererReloadShortcut(input)) {
      event.preventDefault();
    }
  });
}

/**
 * Resolves the renderer page URL.
 *
 * @param mode The frontend mode this window should force into.
 * @returns The dev-mode Vite URL or the production local index.html URL.
 */
function resolveRendererUrl(mode: DesktopWindowMode, target: RendererRouteTarget | null = null): string {
  return resolveDesktopRendererUrl({
    explicitUrl: process.env.MEMMY_RENDERER_URL,
    isPackaged: app.isPackaged,
    mainDir: import.meta.dirname,
    mode,
    packagedRendererBaseUrl: packagedRendererBaseUrl ?? undefined,
    target
  });
}

/**
 * Validates the full-window target route requested by the renderer.
 *
 * @param value The raw IPC target.
 * @returns A supported target route; null when invalid.
 */
function parseRendererRouteTarget(value: unknown): RendererRouteTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const route = typeof record.route === "string" && ["/welcome", "/token-detail", "/login", "/api-key", "/api-key-models", "/api-key-optional", "/onboarding", "/main", "/tools", "/memory", "/memory-sources", "/settings"].includes(record.route) ? record.route : null;
  const hash = typeof record.hash === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(record.hash) ? record.hash : null;
  const agentChatId = route === "/main" && typeof record.agentChatId === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(record.agentChatId) ? record.agentChatId : null;
  const petIntent = record.petIntent === "user" ? "user" : null;
  if (!route && !hash && !agentChatId && !petIntent) {
    return null;
  }

  return { route, hash, agentChatId, petIntent };
}

/**
 * Reads the bootstrap scenario used for development/debugging.
 * @returns The completed scenario or undefined.
 */
function getBootstrapScenario(): BootstrapScenario | undefined {
  return process.env.MEMMY_BOOTSTRAP_SCENARIO === "completed" ? "completed" : undefined;
}

function handleAnalyticsClientId(_event: IpcMainEvent, payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const { clientId, appEnv } = payload as { clientId?: unknown; appEnv?: unknown };
  if (typeof clientId === "string" && clientId) {
    analyticsClientId = clientId;
  }
  if (appEnv === "dev" || appEnv === "prod") {
    analyticsAppEnv = appEnv;
  }
}

async function sendAppExitEvent(): Promise<void> {
  const config = resolveGa4Config();
  if (!config || !analyticsClientId) return;
  try {
    await sendGa4Events({
      config,
      clientId: analyticsClientId,
      appEnv: analyticsAppEnv ?? undefined,
      events: [{ name: "app_exit" }]
    });
    console.log("[analytics] app_exit sent");
  } catch (error) {
    console.warn("[analytics] app_exit send failed:", error);
  }
}

async function sendAppExitEventBeforeQuit(): Promise<void> {
  const exitEvent = sendAppExitEvent();
  await Promise.race([exitEvent, delay(APP_QUIT_ANALYTICS_GRACE_MS)]);
}

let hasSingleInstanceLock = app.requestSingleInstanceLock();
let lastSecondInstanceActivateAt = 0;
let didWaitForSingleInstanceLock = false;
let hasIgnoredStaleReopenQuit = false;
let shouldRelaunchAfterQuitCleanup = false;
const appProcessStartedAt = Date.now();

/**
 * Waits for the single-instance lock while a previous instance finishes exiting.
 *
 * macOS "Quit & Reopen" (shown after privacy toggles such as the microphone permission) starts the
 * replacement instance while the old process is still running its quit cleanup and therefore still
 * holds the lock. Instead of giving up immediately — which turns "Quit & Reopen" into a plain quit —
 * retry until the old instance releases the lock or the deadline passes. The deadline comfortably
 * exceeds the quit-cleanup force-exit delay, so a genuinely running healthy instance is the only
 * case that still reaches the timeout.
 *
 * @returns Whether this instance owns the single-instance lock.
 */
async function waitForSingleInstanceLock(): Promise<boolean> {
  const deadline = Date.now() + SINGLE_INSTANCE_LOCK_WAIT_DEADLINE_MS;
  while (!hasSingleInstanceLock && Date.now() < deadline) {
    didWaitForSingleInstanceLock = true;
    await delay(SINGLE_INSTANCE_LOCK_RETRY_INTERVAL_MS);
    hasSingleInstanceLock = app.requestSingleInstanceLock();
  }
  return hasSingleInstanceLock;
}

/**
 * Detects the stale quit request macOS delivers to a freshly reopened instance.
 *
 * The "Quit & Reopen" flow quits the old instance and reopens the app, but when the old instance
 * shuts down slowly the reopen races ahead and the quit request is delivered to the replacement
 * instance instead — the reopened window flashes briefly and the app is gone. Having waited for the
 * single-instance lock is the fingerprint of that reopen race (a normal launch acquires the lock on
 * the first try), so shortly after such a launch the first quit request is treated as stale and
 * ignored once. Every later quit request behaves normally.
 *
 * @returns Whether the current quit request should be ignored as stale.
 */
function shouldIgnoreStaleReopenQuit(): boolean {
  return process.platform === "darwin"
    && didWaitForSingleInstanceLock
    && !hasIgnoredStaleReopenQuit
    && Date.now() - appProcessStartedAt <= MACOS_STALE_REOPEN_QUIT_GRACE_MS;
}

app.on("second-instance", () => {
  if (isQuitting || isQuitCleanupInProgress) {
    // The other instance is a replacement waiting for this instance's lock; let it take over.
    return;
  }

  // A waiting replacement instance retries the lock every few hundred milliseconds and each retry
  // fires second-instance; debounce so a healthy primary does not keep re-stealing focus.
  const now = Date.now();
  if (now - lastSecondInstanceActivateAt < SECOND_INSTANCE_ACTIVATE_DEBOUNCE_MS) {
    return;
  }
  lastSecondInstanceActivateAt = now;

  if (isBootReady) {
    activateMainWindow();
  }
});

app.whenReady().then(async () => {
  if (!(await waitForSingleInstanceLock())) {
    // An instance is already running: this instance exits directly, to avoid a second instance
    // contending for the fixed ports (memory 18799 / agent-gateway 18997) and causing a startup failure.
    app.quit();
    return;
  }

  await boot();
}).catch(async (error: unknown) => {
  console.error(error);
  closeSplashWindow(); // Close the splash even on boot failure, so it does not stay stuck on screen
  await writePackagedStartupLog(`boot:error\n${formatStartupError(error)}`);
  showPackagedStartupError(error);
  app.quit();
});

app.on("activate", () => {
  if (isQuitting || isQuitCleanupInProgress) {
    // macOS "Quit & Reopen" delivers the reopen as an activate event to this still-dying instance
    // when the quit cleanup is slow, so no replacement process is ever spawned. Honor the reopen
    // by relaunching once cleanup finishes instead of letting the app end up fully closed.
    shouldRelaunchAfterQuitCleanup = true;
    void writePackagedStartupLog("quit:reopen-requested-during-quit");
    return;
  }

  if (isBootReady) {
    if (consumePetWindowCloseActivateSuppression()) {
      return;
    }

    activateMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shouldIgnoreStaleReopenQuit()) {
    hasIgnoredStaleReopenQuit = true;
    event.preventDefault();
    void writePackagedStartupLog("quit:ignored-stale-reopen-quit");
    return;
  }
  if (!hasSingleInstanceLock) {
    return;
  }
  if (isQuitCleanupComplete) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  hideAppShellForQuit();
  if (isQuitCleanupInProgress) {
    return;
  }

  isQuitCleanupInProgress = true;
  void writePackagedStartupLog("quit:cleanup-start");
  armQuitCleanupForceExitTimer();
  void cleanupBeforeQuit()
    .catch(async (error: unknown) => {
      console.warn("quit cleanup failed:", error);
      await writePackagedStartupLog(`quit:cleanup-failed\n${formatStartupError(error)}`);
    })
    .finally(() => {
      clearQuitCleanupForceExitTimer();
      isQuitCleanupComplete = true;
      isQuitCleanupInProgress = false;
      relaunchAfterQuitCleanupIfRequested();
      app.quit();
    });
});

/**
 * Relaunches the app after quit cleanup when a reopen request arrived mid-quit.
 *
 * @returns Nothing.
 */
function relaunchAfterQuitCleanupIfRequested(): void {
  if (!shouldRelaunchAfterQuitCleanup) {
    return;
  }

  shouldRelaunchAfterQuitCleanup = false;
  void writePackagedStartupLog("quit:relaunching-after-cleanup");
  app.relaunch();
}

function armQuitCleanupForceExitTimer(): void {
  clearQuitCleanupForceExitTimer();
  quitCleanupForceExitTimer = setTimeout(() => {
    console.warn("quit cleanup timed out; forcing app exit");
    // Before force-exiting on a cleanup timeout, synchronously kill the child services, so leftover
    // orphan processes do not keep holding the fixed ports.
    runtimeServices?.terminateSync();
    relaunchAfterQuitCleanupIfRequested();
    app.exit(0);
  }, APP_QUIT_CLEANUP_FORCE_EXIT_DELAY_MS);
  quitCleanupForceExitTimer.unref?.();
}

function hideAppShellForQuit(): void {
  for (const targetWindow of BrowserWindow.getAllWindows()) {
    if (!targetWindow.isDestroyed()) {
      targetWindow.hide();
    }
  }

  if (process.platform === "darwin") {
    app.dock?.hide();
  }
}

function clearQuitCleanupForceExitTimer(): void {
  if (!quitCleanupForceExitTimer) {
    return;
  }

  clearTimeout(quitCleanupForceExitTimer);
  quitCleanupForceExitTimer = null;
}

async function cleanupBeforeQuit(): Promise<void> {
  if (requiredUpdateBackgroundFirstCheckTimer) {
    clearTimeout(requiredUpdateBackgroundFirstCheckTimer);
    requiredUpdateBackgroundFirstCheckTimer = null;
  }
  if (requiredUpdateBackgroundCheckTimer) {
    clearTimeout(requiredUpdateBackgroundCheckTimer);
    requiredUpdateBackgroundCheckTimer = null;
  }
  if (pendingMainWindowAction) {
    pendingMainWindowAction = null;
  }
  clearPetWindowCloseActivateSuppression();
  closePetWindow();
  await installPreparedRequiredUpdateOnQuit();
  ipcMain.removeHandler("memmy:get-runtime-config");
  ipcMain.removeHandler("memmy:get-app-info");
  ipcMain.removeHandler("memmy:check-for-updates");
  ipcMain.removeHandler("memmy:download-update");
  ipcMain.removeHandler("memmy:open-update-installer");
  ipcMain.removeHandler("memmy:openExternal");
  ipcMain.removeHandler("memmy:openMailto");
  ipcMain.removeHandler("memmy:copy-image-to-clipboard");
  ipcMain.removeHandler("memmy:save-image");
  ipcMain.removeHandler("memmy:export-memory-database");
  ipcMain.removeHandler("memmy:install-cli-tools");
  ipcMain.removeHandler("memmy:open-logs-directory");
  ipcMain.removeHandler("memmy:export-diagnostics-report");
  ipcMain.removeHandler("memmy:get-microphone-access-status");
  ipcMain.removeHandler("memmy:request-microphone-access");
  ipcMain.removeHandler("memmy:notify-task-done");
  ipcMain.removeHandler("memmy:notify-update-available");
  ipcMain.removeHandler("memmy:set-pet-window");
  ipcMain.removeHandler("memmy:hide-pet-window");
  ipcMain.removeHandler("memmy:set-menu-bar-icon");
  ipcMain.removeHandler("memmy:complete-main-window-action");
  ipcMain.removeListener("memmy:move-pet-window", handleMovePetWindow);
  ipcMain.removeListener("memmy:start-pet-window-drag", handleStartPetWindowDrag);
  ipcMain.removeListener("memmy:stop-pet-window-drag", handleStopPetWindowDrag);
  ipcMain.removeListener("memmy:update-pet-window-layout", handleUpdatePetWindowLayout);
  ipcMain.removeListener("memmy:analytics-client-id", handleAnalyticsClientId);
  areIpcHandlersRegistered = false;
  destroyMenuBarTray();
  const services = runtimeServices;
  runtimeServices = null;
  const backend = localBackend;
  localBackend = null;
  await services?.close();
  await backend?.close();
  await stopPackagedRendererServer();
  await sendAppExitEventBeforeQuit();
}

async function copyDesktopImageToClipboard(request: DesktopImageActionRequest, senderUrl: string): Promise<void> {
  const imageData = await fetchDesktopImage(request, senderUrl);
  const image = nativeImage.createFromBuffer(imageData.buffer);
  if (image.isEmpty()) {
    throw new Error("image clipboard payload is not supported");
  }
  clipboard.writeImage(image);
}

async function saveDesktopImage(request: DesktopImageActionRequest, senderUrl: string, owner: BrowserWindow | null): Promise<DesktopImageSaveResult> {
  const imageData = await fetchDesktopImage(request, senderUrl);
  const defaultName = desktopImageFileName(request.name, imageData.url, imageData.mime);
  const options = {
    title: "Save image",
    buttonLabel: "Save",
    defaultPath: join(app.getPath("downloads"), defaultName),
    filters: desktopImageSaveFilters(defaultName, imageData.mime)
  };
  const selected = owner && !owner.isDestroyed()
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) {
    return { canceled: true };
  }

  await writeFile(selected.filePath, imageData.buffer);
  const saved = await stat(selected.filePath);
  return {
    canceled: false,
    filePath: selected.filePath,
    bytes: saved.size
  };
}

async function fetchDesktopImage(request: DesktopImageActionRequest, senderUrl: string): Promise<{ url: string; buffer: Buffer; mime: string | null }> {
  // When the renderer already obtained the bytes in its own auth context, write them directly, to
  // avoid the main process requesting the protected gateway media again.
  if (request?.data && request.data.byteLength > 0) {
    const buffer = Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength);
    const rawUrl = typeof request.url === "string" ? request.url.trim() : "";
    const mime = imageMimeFromContentType(request.mime ?? null)
      ?? imageMimeFromName(request.name)
      ?? (rawUrl ? imageMimeFromUrl(rawUrl) : null)
      ?? "image/png";
    return { url: rawUrl, buffer, mime };
  }

  const rawUrl = typeof request?.url === "string" ? request.url.trim() : "";
  if (!rawUrl) {
    throw new Error("image url is required");
  }

  // Gateway media is read directly from local disk: the final URL segment payload is a base64url of
  // the path relative to the media directory. The signing key is randomly generated by the gateway
  // process and is not persisted, so a signature-based fetch from the main process would 401;
  // reading the file directly is the most reliable.
  const localMediaFile = resolveLocalGatewayMediaFile(rawUrl);
  if (localMediaFile) {
    try {
      const buffer = await readFile(localMediaFile);
      const mime = imageMimeFromName(localMediaFile)
        ?? imageMimeFromContentType(request.mime ?? null)
        ?? "image/png";
      return { url: rawUrl, buffer, mime };
    } catch {
      // Fall back to a network request when the file is unreadable.
    }
  }

  const url = resolveDesktopImageUrl(rawUrl, senderUrl);
  const response = await fetchDesktopImageResponse(url);
  if (!response.ok) {
    throw new Error(`image download failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  const mime = imageMimeFromContentType(contentType) ?? imageMimeFromName(request.name) ?? imageMimeFromUrl(url);
  if (!mime) {
    throw new Error("image content type is not supported");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { url, buffer, mime };
}

function resolveAgentMediaDir(): string {
  const configPath = resolvePathValue(process.env.MEMMY_CONFIG ?? "~/.memmy/config.yaml");
  const dataDir = process.env.MEMMY_AGENT_DATA_DIR?.trim()
    ? resolvePathValue(process.env.MEMMY_AGENT_DATA_DIR)
    : dirname(configPath);
  return join(dataDir, "media");
}

function resolveLocalGatewayMediaFile(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://memmy.local").pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/^\/api\/media\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)$/u);
  const payload = match?.[1];
  if (!payload) {
    return null;
  }
  let rel: string;
  try {
    rel = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!rel) {
    return null;
  }
  const mediaRoot = resolve(resolveAgentMediaDir());
  const candidate = resolve(mediaRoot, rel);
  if (candidate !== mediaRoot && relative(mediaRoot, candidate).startsWith("..")) {
    return null;
  }
  return candidate;
}

async function fetchDesktopImageResponse(url: string): Promise<Response> {
  // data: URLs use built-in parsing and do not need a fetch.
  if (url.startsWith("data:")) {
    return fetch(url, { cache: "no-store" });
  }

  const parsedUrl = tryParseUrl(url);
  const needsGatewayAuth = parsedUrl ? isAgentGatewayUrl(parsedUrl) : false;
  if (!needsGatewayAuth) {
    return fetch(url, { cache: "no-store" });
  }

  // The agent gateway requires a Bearer JWT; the main process also reuses the bootstrap secret to
  // mint a token, refreshing once on a 401.
  const token = await ensureAgentGatewayToken();
  const send = async (bearer: string | null): Promise<Response> => fetch(url, {
    cache: "no-store",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined
  });
  let response = await send(token);
  if (response.status === 401) {
    const refreshed = await ensureAgentGatewayToken({ force: true });
    if (refreshed && refreshed !== token) {
      response = await send(refreshed);
    }
  }
  return response;
}

interface AgentGatewayTokenCache {
  token: string;
  expiresAtMs: number;
}

let cachedAgentGatewayToken: AgentGatewayTokenCache | null = null;
let inflightAgentGatewayTokenPromise: Promise<string | null> | null = null;

const AGENT_GATEWAY_TOKEN_REFRESH_SKEW_MS = 5_000;

function isAgentGatewayUrl(url: URL): boolean {
  const baseUrl = runtimeConfig?.agentGateway?.baseUrl;
  if (!baseUrl) {
    return false;
  }
  const gateway = tryParseUrl(baseUrl);
  if (!gateway) {
    return false;
  }
  return url.host === gateway.host && url.protocol === gateway.protocol;
}

async function ensureAgentGatewayToken(options: { force?: boolean } = {}): Promise<string | null> {
  const gateway = runtimeConfig?.agentGateway;
  if (!gateway?.baseUrl || !gateway.bootstrapSecret) {
    return null;
  }
  if (!options.force && cachedAgentGatewayToken && cachedAgentGatewayToken.expiresAtMs > Date.now() + AGENT_GATEWAY_TOKEN_REFRESH_SKEW_MS) {
    return cachedAgentGatewayToken.token;
  }
  if (inflightAgentGatewayTokenPromise) {
    return inflightAgentGatewayTokenPromise;
  }
  inflightAgentGatewayTokenPromise = (async () => {
    try {
      const bootstrapUrl = new URL("/webui/bootstrap", gateway.baseUrl).toString();
      const response = await fetch(bootstrapUrl, {
        cache: "no-store",
        headers: gateway.bootstrapSecret ? { "X-Memmy-Agent-Auth": gateway.bootstrapSecret } : undefined
      });
      if (!response.ok) {
        return null;
      }
      const body = await response.json() as { token?: unknown; expires_in?: unknown };
      const token = typeof body?.token === "string" ? body.token : null;
      const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : 0;
      if (!token) {
        return null;
      }
      cachedAgentGatewayToken = {
        token,
        expiresAtMs: Date.now() + Math.max(0, expiresIn) * 1000
      };
      return token;
    } catch {
      return null;
    } finally {
      inflightAgentGatewayTokenPromise = null;
    }
  })();
  return inflightAgentGatewayTokenPromise;
}

function resolveDesktopImageUrl(rawUrl: string, senderUrl: string): string {
  if (/^data:image\//iu.test(rawUrl)) {
    return rawUrl;
  }
  const explicit = tryParseUrl(rawUrl);
  if (explicit) {
    assertAllowedDesktopImageProtocol(explicit);
    return explicit.toString();
  }

  const base = rawUrl.startsWith("/")
    ? runtimeConfig?.agentGateway?.baseUrl ?? runtimeConfig?.baseUrl ?? safeRendererBaseUrl(senderUrl)
    : safeRendererBaseUrl(senderUrl) ?? runtimeConfig?.agentGateway?.baseUrl ?? runtimeConfig?.baseUrl;
  if (!base) {
    throw new Error("image url base is unavailable");
  }
  const resolved = new URL(rawUrl, base);
  assertAllowedDesktopImageProtocol(resolved);
  return resolved.toString();
}

function safeRendererBaseUrl(senderUrl: string): string | null {
  const parsed = tryParseUrl(senderUrl);
  if (!parsed || parsed.protocol === "file:") {
    return null;
  }
  return parsed.toString();
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function assertAllowedDesktopImageProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "data:") {
    throw new Error(`unsupported image protocol: ${url.protocol}`);
  }
}

function desktopImageFileName(name: string | undefined, url: string, mime: string | null): string {
  const fromName = sanitizeDesktopImageFileName(name);
  const fromUrl = sanitizeDesktopImageFileName(urlFilename(url));
  const base = fromName || fromUrl || "image";
  return extname(base) ? base : `${base}${imageExtensionForMime(mime)}`;
}

function sanitizeDesktopImageFileName(value: string | undefined): string {
  const raw = value?.split(/[?#]/u)[0]?.split(/[\\/]/u).pop()?.trim() ?? "";
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").replace(/\s+/gu, " ").slice(0, 120);
}

function urlFilename(value: string): string | undefined {
  try {
    return new URL(value).pathname.split("/").pop();
  } catch {
    return undefined;
  }
}

function imageMimeFromContentType(value: string | null): string | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("image/") ? mime : null;
}

function imageMimeFromName(value: string | undefined): string | null {
  const extension = extname(value?.split(/[?#]/u)[0] ?? "").toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

function imageMimeFromUrl(url: string): string | null {
  return imageMimeFromName(urlFilename(url));
}

function imageExtensionForMime(mime: string | null): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/png":
    default:
      return ".png";
  }
}

function desktopImageSaveFilters(name: string, mime: string | null): FileFilter[] {
  const extension = extname(name).replace(/^\./u, "") || imageExtensionForMime(mime).replace(/^\./u, "");
  const label = extension.toUpperCase();
  return [
    { name: `${label} Image`, extensions: [extension] },
    { name: "All Files", extensions: ["*"] }
  ];
}

/**
 * Prompts for a save path and copies the current Memory SQLite primary database.
 *
 * @param owner The window that triggered the export.
 * @returns The user cancellation or the export result.
 */
async function exportMemoryDatabase(owner: BrowserWindow | null): Promise<MemoryDatabaseExportResult> {
  const sourcePath = await resolveMemoryDatabasePathForExport();
  await access(sourcePath, fsConstants.R_OK);

  const options = {
    title: "Export memory.sqlite",
    buttonLabel: "Export",
    defaultPath: join(app.getPath("documents"), `memory-${formatExportTimestamp(new Date())}.sqlite`)
  };
  const selected = owner && !owner.isDestroyed()
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) {
    return { canceled: true };
  }

  await copyFile(sourcePath, selected.filePath);
  const copied = await stat(selected.filePath);
  return {
    canceled: false,
    exportPath: selected.filePath,
    bytes: copied.size
  };
}

/**
 * Opens the Electron log directory in the system file manager.
 *
 * @returns Resolves once opened; throws an error when the system refuses to open it.
 */
async function openLogsDirectory(): Promise<void> {
  const logsDirectory = resolveLogsDirectory();
  await mkdir(logsDirectory, { recursive: true });
  const openError = await shell.openPath(logsDirectory);
  if (openError) {
    throw new Error(openError);
  }
}

/**
 * Prompts for a save path and writes out the desktop diagnostics report.
 *
 * @param owner The window that triggered the export.
 * @returns The user cancellation or the export result.
 */
async function exportDiagnosticsReport(owner: BrowserWindow | null): Promise<DiagnosticsReportExportResult> {
  const report = buildDiagnosticsReport();
  const options = {
    title: "Export diagnostics report",
    buttonLabel: "Export",
    defaultPath: join(app.getPath("documents"), `memmy-diagnostics-${formatExportTimestamp(new Date())}.txt`),
    filters: [
      { name: "Text Report", extensions: ["txt"] },
      { name: "All Files", extensions: ["*"] }
    ]
  };
  const selected = owner && !owner.isDestroyed()
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) {
    return { canceled: true };
  }

  await writeFile(selected.filePath, report, "utf8");
  const exported = await stat(selected.filePath);
  return {
    canceled: false,
    exportPath: selected.filePath,
    bytes: exported.size
  };
}

/**
 * Generates the credential-free diagnostics report text.
 *
 * @returns The diagnostics report content, ready to be saved directly as a txt.
 */
function buildDiagnosticsReport(): string {
  const logsDirectory = resolveLogsDirectory();
  const configPath = resolvePathValue(process.env.MEMMY_CONFIG ?? "~/.memmy/config.yaml");
  const agentWorkspace = process.env.MEMMY_AGENT_WORKSPACE ?? join(homedir(), ".memmy", "workspace");
  const memoryDatabasePath = runtimeServices?.memory.databasePath ?? "<not-started>";
  const runtimeBaseUrl = runtimeConfig?.baseUrl ?? "<not-ready>";
  const agentGatewayBaseUrl = runtimeConfig?.agentGateway?.baseUrl ?? "<not-ready>";

  const lines = [
    "Memmy Diagnostics Report",
    "========================",
    "",
    "Generated At",
    `- ISO Time: ${new Date().toISOString()}`,
    "",
    "Application",
    `- Name: ${app.name}`,
    `- Version: ${resolveDesktopAppVersion()}`,
    `- Packaged: ${String(app.isPackaged)}`,
    `- Platform: ${process.platform}`,
    `- Arch: ${process.arch}`,
    "",
    "Runtime",
    `- Local API Base URL: ${runtimeBaseUrl}`,
    `- Local API Token: ${runtimeConfig ? "<redacted>" : "<not-ready>"}`,
    `- Agent Gateway Base URL: ${agentGatewayBaseUrl}`,
    `- Agent Gateway Bootstrap Secret: ${runtimeConfig?.agentGateway?.bootstrapSecret ? "<redacted>" : "<not-set>"}`,
    `- Local Backend: ${localBackend ? "ready" : "not-ready"}`,
    `- Packaged Runtime Services: ${runtimeServices ? "ready" : "not-started"}`,
    "",
    "Paths",
    `- User Data: ${app.getPath("userData")}`,
    `- Logs: ${logsDirectory}`,
    `- Config: ${configPath}`,
    `- Agent Workspace: ${agentWorkspace}`,
    `- Memory Database: ${memoryDatabasePath}`,
    "",
    "Notes",
    "- Secrets, local tokens, and bootstrap credentials are intentionally redacted."
  ];

  return `${lines.join("\n")}\n`;
}

/**
 * Resolves the desktop app log directory.
 *
 * @returns The current Electron app log directory.
 */
function resolveLogsDirectory(): string {
  return app.getPath("logs");
}

async function resolveMemoryDatabasePathForExport(): Promise<string> {
  if (runtimeServices?.memory.databasePath) {
    return runtimeServices.memory.databasePath;
  }

  const explicitPath = [
    process.env.MEMMY_MEMORY_DB_PATH,
    process.env.MEMMY_MEMOS_DB_PATH,
    process.env.MEMORY_SERVICE_DB,
    process.env.MEMMY_MEMORY_DB
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  if (explicitPath) {
    return resolvePathValue(explicitPath);
  }

  const configPath = resolvePathValue(process.env.MEMMY_CONFIG ?? "~/.memmy/config.yaml");
  const configuredPath = await readMemoryDatabasePathFromConfig(configPath);
  return configuredPath ? resolvePathValue(configuredPath) : join(homedir(), ".memmy", "memory-service", "memory.sqlite");
}

async function readMemoryDatabasePathFromConfig(configPath: string): Promise<string | null> {
  try {
    const parsed = YAML.parse(await readFile(configPath, "utf8"));
    const memmyMemory = recordValue(parsed)?.memmyMemory;
    const storage = recordValue(memmyMemory)?.storage;
    const sqlitePath = recordValue(storage)?.sqlitePath;
    return typeof sqlitePath === "string" && sqlitePath.trim().length > 0 ? sqlitePath.trim() : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function resolvePathValue(path: string): string {
  return resolve(path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function formatExportTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

/**
 * Opens a trusted external URL in the system default browser.
 *
 * @param rawUrl The URL passed in by the renderer or triggered by the page's window.open.
 * @returns Resolves once opened.
 */
/**
 * The allowlist of permitted macOS System Settings deep links: direct jumps to the permission
 * toggle panels (Full Disk Access / Automation).
 *
 * openExternalUrl only allows http(s) by default (normalizeHttpUrl rejects other schemes); the
 * iMessage channel needs a "one-click jump to System Settings", so we allow exactly these two
 * controlled deep links and do not open up arbitrary schemes.
 */
const MACOS_SETTINGS_DEEPLINKS = new Set<string>([
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
]);

async function openExternalUrl(rawUrl: string): Promise<void> {
  const trimmed = rawUrl.trim();
  if (MACOS_SETTINGS_DEEPLINKS.has(trimmed)) {
    await shell.openExternal(trimmed);
    return;
  }
  await shell.openExternal(normalizeHttpUrl(rawUrl));
}

/**
 * Opens a controlled mailto URL in the system default mail client.
 *
 * @param rawUrl The mailto URL passed in by the renderer.
 * @returns Resolves once opened.
 */
async function openMailtoUrl(rawUrl: string): Promise<void> {
  await shell.openExternal(normalizeMailtoUrl(rawUrl));
}

/**
 * Shows a "task done" system notification.
 *
 * Whether to show it and whether it has sound is decided by the renderer based on the user's toggle
 * and the window focus state; this function is only responsible for showing it when the system
 * supports notifications. `silent` controls whether the default alert sound plays.
 *
 * @param payload The notification title, body, and silent flag.
 */
function showTaskDoneNotification(payload: { title: string; body: string; silent: boolean }): void {
  showDesktopNotification(payload);
}

/**
 * Shows an "update available" notification.
 *
 * @param payload The notification title, body, and silent flag.
 */
function showUpdateAvailableNotification(payload: { title: string; body: string; silent: boolean }): void {
  showDesktopNotification(payload);
}

/**
 * Shows a desktop system notification.
 *
 * @param payload The notification title, body, and silent flag.
 */
function showDesktopNotification(payload: { title: string; body: string; silent: boolean }): void {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification(process.platform === "win32"
    ? { ...payload, silent: true }
    : payload);
  notification.show();
  if (process.platform === "win32" && !payload.silent) {
    shell.beep();
  }
}

/**
 * Normalizes and restricts an external URL to http(s).
 *
 * @param rawUrl The raw URL.
 * @returns The trimmed http(s) URL.
 */
function normalizeHttpUrl(rawUrl: string): string {
  const url = rawUrl.trim();

  if (!/^https?:\/\//i.test(url)) {
    throw new Error("rejected non-http url");
  }

  return url;
}
