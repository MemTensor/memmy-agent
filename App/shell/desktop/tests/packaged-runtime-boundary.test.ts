import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));
const preloadSourcePath = fileURLToPath(new URL("../src/preload/preload.cts", import.meta.url));
const runtimeServicesPath = fileURLToPath(new URL("../src/main/runtime-services.ts", import.meta.url));
const devStartPath = fileURLToPath(new URL("../../../../scripts/dev-start.sh", import.meta.url));
const devMemorySupervisorPath = fileURLToPath(new URL("../../../../scripts/internal/dev-memory-supervisor.mjs", import.meta.url));
const clearAllPath = fileURLToPath(new URL("../../../../scripts/clear-all.sh", import.meta.url));
const packageMacDmgPath = fileURLToPath(new URL("../../../../scripts/internal/package-mac-dmg.sh", import.meta.url));
const signedMacArm64PackagePath = fileURLToPath(
  new URL("../../../../scripts/internal/package-mac-arm64-signed-base.sh", import.meta.url)
);
const packageWinX64Path = fileURLToPath(new URL("../../../../scripts/internal/package-win-x64.sh", import.meta.url));
const winX64CnUnsignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-cn-unsigned.sh", import.meta.url)
);
const winX64CnSignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-cn-signed.sh", import.meta.url)
);
const winX64IntlUnsignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-intl-unsigned.sh", import.meta.url)
);
const winX64IntlSignedPackagePath = fileURLToPath(
  new URL("../../../../scripts/package-win-x64-intl-signed.sh", import.meta.url)
);
const winUnsignedBuilderPath = fileURLToPath(new URL("../electron-builder.win.unsigned.yml", import.meta.url));
const winUnsignedInstallerIncludePath = fileURLToPath(new URL("../build/installer-win-unsigned.nsh", import.meta.url));
const desktopInterfacePath = fileURLToPath(new URL("../interface/src/index.ts", import.meta.url));
const localApiContractsPath = fileURLToPath(new URL("../../../../App/backend/local-api-contracts/src/index.ts", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));
const memoryPackagePath = fileURLToPath(new URL("../../../../Memory/package.json", import.meta.url));
const backendPackagePath = fileURLToPath(new URL("../../../../App/backend/package.json", import.meta.url));
const frontendPackagePath = fileURLToPath(new URL("../../../../App/frontend/desktop/package.json", import.meta.url));
const desktopPackagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const agentPackagePath = fileURLToPath(new URL("../../../../App/memmy-agent/package.json", import.meta.url));
const agentPackageLockPath = fileURLToPath(new URL("../../../../App/memmy-agent/package-lock.json", import.meta.url));
const electronBuilderPath = fileURLToPath(new URL("../electron-builder.yml", import.meta.url));
const unsignedElectronBuilderPath = fileURLToPath(new URL("../electron-builder.unsigned.yml", import.meta.url));
const macEntitlementsPath = fileURLToPath(new URL("../build/entitlements.mac.plist", import.meta.url));
const macEntitlementsInheritPath = fileURLToPath(new URL("../build/entitlements.mac.inherit.plist", import.meta.url));
const winElectronBuilderPath = fileURLToPath(new URL("../electron-builder.win.yml", import.meta.url));
const winUpdatePromptScriptPath = fileURLToPath(new URL("../build/MemmyUpdatePrompt.ps1", import.meta.url));
const legacyApplicationSupportDir = ["Application Support/Memmy", "+"].join("");
const legacyProductPattern = new RegExp([
  "Memmy\\+",
  ["Memmy", "Plus"].join(""),
  ["memmy", "plus"].join(""),
  "Application Support/Memmy\\+"
].join("|"));

interface PackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[];
}

describe("desktop packaged runtime boundaries", () => {
  it("keeps Memory runtime dependencies owned by the Memory workspace", () => {
    const rootPackage = readJson<PackageJson>(rootPackagePath);
    const memoryPackage = readJson<PackageJson>(memoryPackagePath);
    const backendPackage = readJson<PackageJson>(backendPackagePath);
    const frontendPackage = readJson<PackageJson>(frontendPackagePath);
    const desktopPackage = readJson<PackageJson>(desktopPackagePath);

    expect(rootPackage.workspaces).toContain("Memory");
    expect(rootPackage.bin).toBeUndefined();
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("@huggingface/transformers");
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("yaml");
    expect(rootPackage.dependencies ?? {}).not.toHaveProperty("zod");
    expect(rootPackage.devDependencies ?? {}).not.toHaveProperty("@types/better-sqlite3");
    expect(memoryPackage).toMatchObject({
      name: "@memmy/memory",
      bin: { "memmy-memory": "./dist/src/cli/index.js" }
    });
    expect(memoryPackage.dependencies).toMatchObject({
      "@huggingface/transformers": expect.any(String),
      "better-sqlite3": expect.any(String),
      "sqlite-vec": "0.1.9",
      yaml: expect.any(String)
    });
    expect(memoryPackage.dependencies ?? {}).not.toHaveProperty("zod");
    expect(backendPackage.dependencies).toHaveProperty("zod");
    expect(backendPackage.dependencies).toHaveProperty("sqlite-vec", "0.1.9");
    expect(frontendPackage.dependencies).toHaveProperty("zod");
    expect(desktopPackage.dependencies).toHaveProperty("yaml");
    expect(desktopPackage.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
    expect(desktopPackage.dependencies ?? {}).not.toHaveProperty("zod");
  });

  it("unpacks the sqlite-vec native extension in every desktop package variant", () => {
    for (const configPath of [
      electronBuilderPath,
      unsignedElectronBuilderPath,
      winElectronBuilderPath,
      winUnsignedBuilderPath
    ]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/node_modules/sqlite-vec-*/vec0.*"');
    }
  });

  it("keeps the desktop main process on the shared Memmy identity and config path", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain('app.setName("Memmy");');
    expect(source).toContain('app.setPath("userData", join(app.getPath("appData"), desktopUserDataDirectoryName(edition)));');
    expect(source).toMatch(/runtimeServices = app\.isPackaged\s*\?\s*await startPackagedRuntimeServices\(/);
    expect(source).toContain("memmyConfigPath: process.env.MEMMY_CONFIG");
    expect(source).not.toContain("startDesktopRuntimeServices");
  });

  it("omits empty agent gateway bootstrap secrets in development runtime config", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const contractsSource = readFileSync(localApiContractsPath, "utf8");

    expect(contractsSource).toContain("bootstrapSecret: z.string().min(1).optional()");
    expect(mainSource).toContain("if (agentGateway.bootstrapSecret) {");
    expect(mainSource).toContain("agentGatewayConfig.bootstrapSecret = agentGateway.bootstrapSecret;");
    expect(mainSource).not.toContain("bootstrapSecret: agentGateway.bootstrapSecret");
  });

  it("surfaces packaged startup failures through a log file and dialog", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("writePackagedStartupLog");
    expect(source).toContain('"startup.log"');
    expect(source).toContain('"boot:start"');
    expect(source).toContain('"boot:ready"');
    expect(source).toContain("boot:error");
    expect(source).toContain("showPackagedStartupError(error)");
    expect(source).toContain("dialog.showErrorBox");
    expect(source).toContain("Memmy 启动失败");
  });

  it("hides the default in-window menu bar outside macOS", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("hideInWindowMenuBar(targetMainWindow)");
    expect(source).toContain('process.platform === "darwin"');
    expect(source).toContain("targetWindow.setMenu(null)");
  });

  it("wires the settings menu bar icon toggle to a native macOS Tray", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const interfaceSource = readFileSync(desktopInterfacePath, "utf8");
    const signedBuilderConfig = readFileSync(electronBuilderPath, "utf8");
    const unsignedBuilderConfig = readFileSync(unsignedElectronBuilderPath, "utf8");

    expect(interfaceSource).toContain("export interface DesktopMenuBarIconResult");
    expect(preloadSource).toContain("setMenuBarIcon(enabled: boolean): Promise<DesktopMenuBarIconResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:set-menu-bar-icon", enabled)');
    expect(mainSource).toContain("let menuBarTray: Tray | null = null");
    expect(mainSource).toContain('if (process.platform === "darwin")');
    expect(mainSource).toContain("syncMenuBarTray(resolveMenuBarIconEnabled())");
    expect(mainSource).toContain('ipcMain.handle("memmy:set-menu-bar-icon"');
    expect(mainSource).toContain("function isNativeTraySupported()");
    expect(mainSource).toContain('process.platform === "darwin" || process.platform === "win32"');
    expect(mainSource).toContain("new Tray(trayImage, MENU_BAR_TRAY_GUID)");
    expect(mainSource).toContain('join(process.resourcesPath, "MenuBarIconTemplate.png")');
    expect(mainSource).toContain('resolve(import.meta.dirname, "../../build/MenuBarIconTemplate.png")');
    expect(mainSource).toContain("setTemplateImage(true)");
    expect(mainSource).toContain("destroyMenuBarTray()");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:set-menu-bar-icon")');
    expect(mainSource).not.toContain("MenuBarFallbackIcon.png");
    expect(mainSource).not.toContain("syncMenuBarFallbackWindow");
    expect(signedBuilderConfig).toContain("MenuBarIconTemplate.png");
    expect(signedBuilderConfig).toContain("MenuBarIconTemplate@2x.png");
    expect(signedBuilderConfig).not.toContain("MenuBarFallbackIcon.png");
    expect(unsignedBuilderConfig).toContain("MenuBarIconTemplate.png");
    expect(unsignedBuilderConfig).toContain("MenuBarIconTemplate@2x.png");
    expect(unsignedBuilderConfig).not.toContain("MenuBarFallbackIcon.png");
  });

  it("keeps unsigned Windows uninstallers from failing NSIS CRC self-checks", () => {
    const builderConfig = readFileSync(winUnsignedBuilderPath, "utf8");
    const includeSource = readFileSync(winUnsignedInstallerIncludePath, "utf8");

    expect(builderConfig).toContain("include: build/installer-win-unsigned.nsh");
    expect(includeSource).toContain("!ifdef BUILD_UNINSTALLER");
    expect(includeSource).toContain("CRCCheck off");
  });

  it("adds packaged Windows CLI launchers to the user PATH", () => {
    const signedBuilderConfig = readFileSync(winElectronBuilderPath, "utf8");
    const unsignedBuilderConfig = readFileSync(winUnsignedBuilderPath, "utf8");
    const includeSource = readFileSync(winUnsignedInstallerIncludePath, "utf8");
    const updatePromptSource = readFileSync(winUpdatePromptScriptPath, "utf8");

    expect(signedBuilderConfig).toContain("include: build/installer-win-unsigned.nsh");
    expect(unsignedBuilderConfig).toContain("include: build/installer-win-unsigned.nsh");
    expect(signedBuilderConfig).toContain("allowElevation: false");
    expect(unsignedBuilderConfig).toContain("allowElevation: false");
    expect(signedBuilderConfig).toContain("allowToChangeInstallationDirectory: true");
    expect(unsignedBuilderConfig).toContain("allowToChangeInstallationDirectory: true");
    expect(signedBuilderConfig).toContain("createDesktopShortcut: false");
    expect(unsignedBuilderConfig).toContain("createDesktopShortcut: false");
    expect(signedBuilderConfig).toContain("createStartMenuShortcut: true");
    expect(unsignedBuilderConfig).toContain("createStartMenuShortcut: true");
    expect(includeSource).toContain("!macro customInstall");
    expect(includeSource).toContain("Call MemmyAddCliToUserPath");
    expect(includeSource).toContain("Call MemmyInstallLaunchProxy");
    expect(includeSource).toContain("!insertmacro MemmyPointShortcutsToLaunchProxy");
    expect(includeSource).toContain("!macro customUnInstall");
    expect(includeSource).toContain("Call un.MemmyRemoveCliFromUserPath");
    expect(includeSource).toContain("Call un.MemmyRemoveLaunchProxy");
    expect(includeSource).not.toContain("Call un.MemmyPointShortcutsToInstalledApp");
    expect(includeSource).toContain('StrCpy $0 "$INSTDIR\\resources\\cli"');
    expect(includeSource).toContain('IfFileExists "$0\\memmy.cmd"');
    expect(includeSource).toContain('IfFileExists "$0\\memmy-memory.cmd"');
    expect(includeSource).toContain('ReadRegStr $1 HKCU "Environment" "Path"');
    expect(includeSource).toContain('WriteRegExpandStr HKCU "Environment" "Path"');
    expect(includeSource).toContain("MEMMY_WM_SETTINGCHANGE");
    expect(includeSource).toContain("!macro customInstallMode");
    expect(includeSource).toContain('StrCpy $isForceCurrentInstall "1"');
    expect(includeSource).toContain('StrCpy $0 "$LOCALAPPDATA\\Memmy\\launcher"');
    expect(includeSource).toContain('File /oname=Memmy.ico "${BUILD_RESOURCES_DIR}\\icon.ico"');
    expect(includeSource).toContain('File /oname=MemmyUpdatePrompt.ps1 "${BUILD_RESOURCES_DIR}\\MemmyUpdatePrompt.ps1"');
    expect(includeSource).toContain('FileOpen $1 "$0\\MemmyLauncher.vbs" w');
    expect(includeSource).toContain('promptPath = $\\"$0\\MemmyUpdatePrompt.ps1$\\"');
    expect(includeSource).toContain("WindowsPowerShell\\v1.0\\powershell.exe");
    expect(includeSource).toContain('promptMarkerPath = markerPath & $\\".prompt$\\"');
    expect(includeSource).toContain("If fso.FolderExists(lockPath) And fso.FileExists(promptMarkerPath) Then");
    expect(includeSource).toContain("If fso.FileExists(powerShellPath) And fso.FileExists(promptPath) Then");
    expect(includeSource).toContain("If fso.FolderExists(lockPath) Or Not fso.FileExists(appExe) Then");
    expect(includeSource).toContain("WScript.Quit 0");
    expect(includeSource).toContain("update-prompt-language.txt");
    expect(includeSource).toContain("prepared-required-update.json");
    expect(includeSource).toContain("-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File");
    expect(includeSource).toContain("-LockPath");
    expect(includeSource).toContain("-AppExe");
    expect(includeSource).toContain("-LanguagePath");
    expect(includeSource).not.toContain("shell.Popup");
    expect(includeSource).not.toContain("ChrW(&H6B63)");
    expect(includeSource).not.toContain("Please open Memmy again in a moment.");
    expect(includeSource).toContain('appExe = $\\"$INSTDIR\\${PRODUCT_FILENAME}.exe$\\"');
    expect(includeSource).toContain('StrCpy $3 "$newStartMenuLink"');
    expect(includeSource).toContain('CreateShortCut "$3" "$SYSDIR\\wscript.exe"');
    expect(includeSource).toContain('Push "no-desktop-shortcut"');
    expect(includeSource).toContain('StrCmp $keepShortcuts "false" memmy_point_new_desktop_shortcut');
    expect(includeSource).toContain("StrCmp $oldDesktopLink $newDesktopLink memmy_point_existing_new_desktop_shortcut");
    expect(includeSource).toContain('Rename "$oldDesktopLink" "$newDesktopLink"');
    expect(includeSource).toContain('StrCpy $3 "$newDesktopLink"');
    expect(includeSource).toContain('StrCpy $4 "1"');
    expect(includeSource).toContain('StrCmp $4 "1" 0 memmy_point_no_shortcut_refresh');
    expect(includeSource).toContain("Shell32::SHChangeNotify");
    expect(includeSource).not.toContain("WinShell::SetLnkAUMI");
    expect(includeSource).not.toContain("Function un.MemmyPointShortcutsToInstalledApp");
    expect(includeSource).not.toContain("MemmyPointExistingShortcutToInstalledApp");
    expect(includeSource).not.toContain('CreateShortCut "${SHORTCUT_PATH}" "$INSTDIR\\${PRODUCT_FILENAME}.exe"');
    expect(includeSource).toContain('StrCpy $R0 "$CMDLINE"');
    expect(includeSource).toContain('StrCpy $R1 "keep-shortcuts"');
    expect(includeSource).toContain("un_memmy_keep_shortcuts_loop:");
    expect(includeSource).toContain("un_memmy_keep_launch_proxy:");
    expect(includeSource).toContain("un_memmy_remove_launch_proxy:");
    expect(includeSource).not.toContain("${if} ${isKeepShortcuts}");
    expect(includeSource).not.toContain("_isKeepShortcuts");
    expect(includeSource).not.toContain("StdUtils::TestParameter");
    expect(includeSource).toContain('ReadRegStr $0 SHELL_CONTEXT "Software\\${APP_GUID}" "ShortcutName"');
    expect(includeSource).toContain('Delete "$DESKTOP\\$0.lnk"');
    expect(includeSource).toContain('Delete "$DESKTOP\\${SHORTCUT_NAME}.lnk"');
    expect(includeSource).toContain('RMDir /r "$LOCALAPPDATA\\Memmy\\launcher"');
    expect(includeSource.indexOf('StrCpy $R1 "keep-shortcuts"')).toBeLessThan(
      includeSource.indexOf('RMDir /r "$LOCALAPPDATA\\Memmy\\launcher"')
    );
    expect(includeSource).not.toContain("MsgBox");
    expect(includeSource).not.toContain("MessageBox MB_OK|MB_ICONINFORMATION");
    expect(includeSource).not.toContain("Memmy 将安装到当前用户目录");
    expect(updatePromptSource).toContain("function Resolve-MemmyPromptLanguage");
    expect(updatePromptSource).toContain("function Test-MemmyUpdatePromptDone");
    expect(updatePromptSource).toContain("function Get-MemmyAppProcessIds");
    expect(updatePromptSource).toContain("function Test-MemmyAppOpenedAfterPrompt");
    expect(updatePromptSource).toContain("function Enter-MemmyUpdatePromptSingleton");
    expect(updatePromptSource).toContain("function Exit-MemmyUpdatePromptSingleton");
    expect(updatePromptSource).toContain("System.Threading.Mutex");
    expect(updatePromptSource).toContain(".WaitOne(0)");
    expect(updatePromptSource).toContain("ReleaseMutex");
    expect(updatePromptSource).toContain("$InitialAppProcessIds");
    expect(updatePromptSource).toContain("$PromptMarkerPath");
    expect(updatePromptSource).toContain("System.Windows.MessageBox");
    expect(updatePromptSource).toContain("Stop-Process");
    expect(updatePromptSource).toContain("Start-Sleep -Milliseconds 500");
    expect(updatePromptSource).toContain("0x6B63");
    expect(updatePromptSource).not.toContain("Start-Sleep -Seconds 30");
    expect(updatePromptSource).not.toContain("System.Windows.Forms");
    expect(updatePromptSource).not.toContain("DispatcherTimer");
    expect(updatePromptSource).not.toContain("CornerRadius");
  });

  it("exports memory.sqlite through the desktop save dialog", () => {
    const source = readFileSync(mainSourcePath, "utf8");
    const exportSource = extractFunctionSource(source, "async function exportMemoryDatabase");

    expect(source).toContain('ipcMain.handle("memmy:export-memory-database"');
    expect(exportSource).toContain("dialog.showSaveDialog");
    expect(exportSource).toContain("await copyFile(sourcePath, selected.filePath)");
    expect(exportSource).toContain("memory-${formatExportTimestamp(new Date())}.sqlite");
    expect(exportSource).not.toContain("filters:");
    expect(exportSource).not.toContain("All Files");
    expect(source).toContain('join(homedir(), ".memmy", "memory-service", "memory.sqlite")');
  });

  it("saves and copies generated images through native desktop APIs", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const interfaceSource = readFileSync(desktopInterfacePath, "utf8");

    expect(interfaceSource).toContain("export interface DesktopImageActionRequest");
    expect(interfaceSource).toContain("export type DesktopImageSaveResult");
    expect(preloadSource).toContain("copyImageToClipboard(request: DesktopImageActionRequest): Promise<void>;");
    expect(preloadSource).toContain("saveImage(request: DesktopImageActionRequest): Promise<DesktopImageSaveResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:copy-image-to-clipboard", request)');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:save-image", request)');
    expect(mainSource).toContain('ipcMain.handle("memmy:copy-image-to-clipboard"');
    expect(mainSource).toContain('ipcMain.handle("memmy:save-image"');
    // Handles expect.
    expect(mainSource).toContain("if (request?.data && request.data.byteLength > 0)");
    expect(mainSource).toContain("Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength)");
    // Handles expect.
    expect(mainSource).toContain("function resolveLocalGatewayMediaFile");
    expect(mainSource).toContain('pathname.match(/^\\/api\\/media\\/[A-Za-z0-9_-]+\\/([A-Za-z0-9_-]+)$/u)');
    expect(mainSource).toContain('Buffer.from(payload, "base64url").toString("utf8")');
    expect(mainSource).toContain('join(dataDir, "media")');
    expect(mainSource).toContain("const buffer = await readFile(localMediaFile)");
    expect(mainSource).toContain("nativeImage.createFromBuffer(imageData.buffer)");
    expect(mainSource).toContain("clipboard.writeImage(image)");
    expect(mainSource).toContain("dialog.showSaveDialog(owner, options)");
    expect(mainSource).toContain("await writeFile(selected.filePath, imageData.buffer)");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:copy-image-to-clipboard")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:save-image")');
    // Handles expect.
    expect(mainSource).toContain("async function ensureAgentGatewayToken");
    expect(mainSource).toContain('new URL("/webui/bootstrap", gateway.baseUrl)');
    expect(mainSource).toContain('"X-Memmy-Agent-Auth": gateway.bootstrapSecret');
    expect(mainSource).toContain("Authorization: `Bearer ${bearer}`");
    expect(mainSource).toContain("if (response.status === 401)");
  });

  it("installs memmy-memory into ~/.local/bin through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const packageSource = normalizeLineEndings(readFileSync(packageMacDmgPath, "utf8"));

    expect(preloadSource).toContain("installCliTools(): Promise<unknown>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:install-cli-tools")');
    expect(mainSource).toContain('ipcMain.handle("memmy:install-cli-tools"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:install-cli-tools")');
    expect(mainSource).toContain("async function installCliTools");
    expect(mainSource).toContain('join(homedir(), ".local", "bin")');
    expect(mainSource).toContain('{ name: "memmy-memory", source: join(cliDirectory, "memmy-memory") }');
    expect(mainSource).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(packageSource).toContain("Default prefix:\n  ~/.local/bin");
    expect(packageSource).toContain('PREFIX="$HOME/.local/bin"');
    expect(packageSource).not.toContain("/usr/local/bin when writable");
  });

  it("restarts the Memory process through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const runtimeSource = readFileSync(runtimeServicesPath, "utf8");

    expect(preloadSource).toContain("restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:restart-memory-service")');
    expect(mainSource).toContain('ipcMain.handle("memmy:restart-memory-service"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:restart-memory-service")');
    expect(mainSource).toContain("await runtimeServices.restartMemory()");
    expect(runtimeSource).toContain("restartManagedMemoryService");
    expect(runtimeSource).toContain("/api/v1/admin/shutdown");
  });

  it("keeps packaged agent CLI installation on memmy only", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const packageSource = readFileSync(packageMacDmgPath, "utf8");
    const windowsPackageSource = readFileSync(packageWinX64Path, "utf8");
    const agentPackage = readJson<PackageJson>(agentPackagePath);
    const agentPackageLock = readJson<{ packages?: Record<string, PackageJson> }>(agentPackageLockPath);

    expect(agentPackage.bin).toEqual({ memmy: "./dist/main.js" });
    expect(agentPackageLock.packages?.[""]?.bin).toEqual({ memmy: "dist/main.js" });
    expect(mainSource).toContain('const memmyCli = join(cliDirectory, "memmy")');
    expect(mainSource).toContain('await Promise.all([access(memoryCli), access(memmyCli)])');
    expect(mainSource).toContain('installSymlink(memmyCli, join(binDirectory, "memmy"))');
    expect(mainSource).not.toContain(['join(cliDirectory, "', 'memmy-agent', '")'].join(""));
    expect(mainSource).not.toContain(['join(binDirectory, "', 'memmy-agent', '")'].join(""));
    expect(packageSource).toContain('create_cli_launcher "$CLI_BIN_DIR/memmy"');
    expect(packageSource).not.toContain(['create_cli_launcher "$CLI_BIN_DIR/', 'memmy-agent', '"'].join(""));
    expect(packageSource).not.toContain(['ln -sf "$SCRIPT_DIR/', 'memmy-agent', '"'].join(""));
    expect(windowsPackageSource).toContain('create_windows_cli_launcher "$CLI_BIN_DIR/memmy.cmd"');
    expect(windowsPackageSource).toContain('for %%I in ("%RESOURCES_DIR%\\..") do set "APP_DIR=%%~fI"');
    expect(windowsPackageSource).toContain('set "APP_EXEC=%APP_DIR%\\Memmy.exe"');
    expect(windowsPackageSource).not.toContain('set "APP_EXEC=%RESOURCES_DIR%\\Memmy.exe"');
    expect(windowsPackageSource).not.toContain(['create_windows_cli_launcher "$CLI_BIN_DIR/', 'memmy-agent', '.cmd"'].join(""));
  });

  it("wires developer diagnostics buttons through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");

    expect(preloadSource).toContain("openLogsDirectory(): Promise<void>;");
    expect(preloadSource).toContain("exportDiagnosticsReport(): Promise<DiagnosticsReportExportResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:open-logs-directory")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:export-diagnostics-report")');
    expect(mainSource).toContain('ipcMain.handle("memmy:open-logs-directory"');
    expect(mainSource).toContain('ipcMain.handle("memmy:export-diagnostics-report"');
    expect(mainSource).toContain("async function openLogsDirectory()");
    expect(mainSource).toContain("async function exportDiagnosticsReport");
    expect(mainSource).toContain("await shell.openPath(logsDirectory)");
    expect(mainSource).toContain("buildDiagnosticsReport()");
    expect(mainSource).toContain("await writeFile(selected.filePath, report, \"utf8\")");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:open-logs-directory")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:export-diagnostics-report")');
  });

  it("exposes app version and update checks through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const runtimeServicesSource = readFileSync(runtimeServicesPath, "utf8");
    const interfaceSource = readFileSync(desktopInterfacePath, "utf8");
    const windowsPreparedUpdateSource = extractFunctionSource(mainSource, "async function waitForWindowsPreparedRequiredUpdateBeforeBoot");

    expect(interfaceSource).toContain("export interface DesktopAppInfo");
    expect(interfaceSource).toContain("export interface DesktopUpdateCheckResult");
    expect(interfaceSource).toContain("export interface DesktopUpdateInstallResult");
    expect(mainSource).toContain("resolveCloudServiceBaseUrl(process.env.MEMMY_CLOUD_SERVICE)");
    expect(mainSource).toContain('const UPDATE_MANIFEST_PATH = "/api/memmy/desktop/latest"');
    expect(mainSource).toContain("const DEFAULT_UPDATE_MANIFEST_URL = `${UPDATE_MANIFEST_BASE_URL}${UPDATE_MANIFEST_PATH}`");
    expect(mainSource).not.toContain("MEMMY_UPDATE_MANIFEST_URL");
    expect(mainSource).toContain("await installPreparedRequiredUpdateBeforeBoot()");
    expect(mainSource).toContain("startRequiredUpdateBackgroundChecks()");
    expect(mainSource).toContain("function startRequiredUpdateBackgroundChecks()");
    expect(mainSource).toContain("async function installPreparedRequiredUpdateBeforeBoot()");
    expect(mainSource).toContain("async function prepareRequiredUpdateAfterBoot()");
    expect(mainSource).toContain('url.searchParams.set("platformType", resolveCurrentDesktopPlatformType())');
    expect(mainSource).toContain("REQUIRED_UPDATE_BACKGROUND_FIRST_CHECK_DELAY_MS");
    expect(mainSource).toContain("REQUIRED_UPDATE_BACKGROUND_CHECK_INTERVAL_MS");
    expect(mainSource).toContain("requiredUpdateBackgroundFirstCheckTimer");
    expect(mainSource).toContain("setTimeout(() => {");
    expect(mainSource).toContain("clearTimeout(requiredUpdateBackgroundFirstCheckTimer)");
    expect(mainSource).toContain("isRequiredUpdateBackgroundCheckRunning");
    expect(mainSource).toContain("clearTimeout(requiredUpdateBackgroundCheckTimer)");
    expect(mainSource).toContain("prepared-required-update.json");
    expect(mainSource).toContain("async function resolvePreparedUpdatePackagePath");
    expect(mainSource).toContain("async function writePreparedRequiredUpdate");
    expect(mainSource).toContain("async function clearPreparedRequiredUpdate");
    expect(mainSource).toContain("function isRequiredUpdate(update: DesktopUpdateCheckResult)");
    expect(mainSource).toContain("function isManagedBackgroundUpdate(update: DesktopUpdateCheckResult)");
    expect(mainSource).toContain('update.updateMode === "silent" || isRequiredUpdate(update)');
    expect(mainSource).toContain("preparedManagedBackgroundUpdateVersion");
    expect(mainSource).toContain("await hasPreparedRequiredUpdate(update)");
    expect(mainSource).toContain("const preparedFilePath = update.preparedUpdatePath ?? (await downloadUpdate(update, { openInstaller: false })).filePath");
    expect(mainSource).toContain("await writePreparedRequiredUpdate(update, preparedFilePath)");
    expect(mainSource).toContain("async function installPreparedRequiredUpdateOnQuit");
    expect(mainSource).toContain("await installPreparedRequiredUpdateOnQuit()");
    expect(mainSource).toContain("openAfterInstall: false");
    expect(mainSource).not.toContain('openAfterInstall: process.platform === "win32"');
    expect(mainSource).toContain("function resolvePreparedRequiredUpdateLockPath");
    expect(mainSource).toContain("async function waitForPreparedRequiredUpdateLock");
    expect(mainSource).toContain("async function waitForWindowsPreparedRequiredUpdateBeforeBoot");
    expect(mainSource).toContain('boot:prepared-required-update waiting-for-lock win32');
    expect(mainSource).toContain("async function reopenInstalledAppAfterPreparedUpdate");
    expect(mainSource).toContain("WINDOWS_PREPARED_UPDATE_RELAUNCH_DELAY_MS");
    expect(mainSource).toContain("const opener = spawn(process.execPath");
    expect(mainSource).toContain("boot:prepared-required-update waiting-for-lock");
    expect(mainSource).toContain("async function showWindowsUpdateInProgressMessage");
    expect(mainSource).toContain("await showWindowsUpdateInProgressMessage()");
    expect(mainSource).toContain("type WindowsUpdatePromptLanguage");
    expect(mainSource).toContain('const WINDOWS_UPDATE_PROMPT_LANGUAGE_FILE = "update-prompt-language.txt"');
    expect(mainSource).toContain("function resolveWindowsUpdatePromptMarkerPath");
    expect(mainSource).toContain("async function writeWindowsUpdatePromptMarker");
    expect(mainSource).toContain("async function clearWindowsUpdatePromptMarker");
    expect(mainSource).toContain("existsSync(resolveWindowsUpdatePromptMarkerPath())");
    expect(mainSource).toContain("function resolveInstalledWindowsUpdatePromptScriptPath");
    expect(mainSource).toContain("function resolveWindowsPowerShellPath");
    expect(mainSource).toContain("startWindowsUpdatePromptProcess");
    expect(mainSource).toContain('join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")');
    expect(mainSource).toContain("function resolveWindowsUpdatePromptLanguageFromAppSettings");
    expect(mainSource).toContain('language === "zh-CN" || language === "en-US"');
    expect(mainSource).toContain('resolveCurrentDesktopEdition() === "intl" ? "en-US" : "zh-CN"');
    expect(mainSource).toContain("await writeWindowsUpdatePromptLanguage(resolveWindowsUpdatePromptLanguageFromAppSettings())");
    expect(mainSource).toContain("await writeWindowsUpdatePromptMarker()");
    expect(mainSource).toContain("showUpdatePrompt: shouldShowWindowsUpdatePromptForPreparedUpdate(update)");
    expect(mainSource).toContain("showUpdatePrompt: preparedUpdate.showUpdatePrompt === true");
    expect(mainSource).toContain("function shouldShowWindowsUpdatePromptForPreparedUpdate");
    expect(mainSource).toContain('update.updateMode === "silent" && !isRequiredUpdate(update)');
    expect(mainSource).toContain("options.showUpdatePrompt");
    expect(mainSource).toContain("await clearWindowsUpdatePromptMarker().catch(() => undefined)");
    expect(mainSource).toContain('$promptMarkerPath = "$MarkerPath.prompt"');
    expect(mainSource).not.toContain("WINDOWS_UPDATE_IN_PROGRESS_PROMPTS");
    expect(mainSource).not.toContain("Memmy 正在更新");
    expect(mainSource).toContain("boot:prepared-required-update win32");
    expect(mainSource).toContain("async function waitForPreparedRequiredUpdateLockStart");
    expect(windowsPreparedUpdateSource).toContain("openBackgroundUpdateInstaller(safeFilePath");
    expect(mainSource).toContain("$arguments = @('/S', '--updated', '/currentuser', ('/D=' + $appDir))");
    expect(mainSource).not.toContain("app reopened before install; deferring update");
    expect(mainSource).toContain("app processes still running before install; waiting");
    expect(mainSource).toContain("function hideMacDockForPreparedUpdateInstall");
    expect(mainSource).toContain("app.dock?.hide()");
    expect(mainSource).toContain("isManagedUpdateInstallerRunning");
    expect(mainSource).toContain("async function openBackgroundUpdateInstaller");
    expect(mainSource).toContain('ipcMain.handle("memmy:get-app-info"');
    expect(mainSource).toContain('ipcMain.handle("memmy:check-for-updates"');
    expect(mainSource).toContain('ipcMain.handle("memmy:download-update"');
    expect(mainSource).toContain('ipcMain.handle("memmy:open-update-installer"');
    expect(mainSource).toContain('ipcMain.handle("memmy:notify-update-available"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:get-app-info")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:check-for-updates")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:download-update")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:open-update-installer")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:notify-update-available")');
    expect(mainSource).toContain("app.getVersion()");
    expect(mainSource).toContain("function resolveDesktopAppVersion()");
    expect(mainSource).toContain("electronAppVersion !== process.versions.electron");
    expect(mainSource).toContain("function resolveDesktopPackageVersion()");
    expect(mainSource).toContain("resolveUpdateDownloadUrl");
    expect(mainSource).toContain("readManifestString(manifest, \"minSupportedVersion\")");
    expect(mainSource).toContain("const updateMode = readUpdateMode(manifest)");
    expect(mainSource).toContain('url.searchParams.set("platformType", resolveCurrentDesktopPlatformType())');
    expect(mainSource).toContain('url.searchParams.set("version", resolveDesktopAppVersion())');
    expect(mainSource).toContain("function readUpdateEnvelopeManifest");
    expect(mainSource).toContain('value.code !== 0');
    expect(mainSource).toContain('readManifestRecord(value, "data") ?? {}');
    expect(mainSource).toContain("async function downloadUpdate");
    expect(mainSource).toContain("function resolveUpdatesDirectory()");
    expect(mainSource).toContain('join(app.getPath("userData"), "updates")');
    expect(mainSource).toContain("function resolveDownloadedUpdatePath");
    expect(mainSource).toContain("shouldInstallMacDmgUpdateInBackground(safeFilePath)");
    expect(mainSource).toContain("function resolveMacUpdateDestinationAppPath()");
    expect(mainSource).toContain('const installedMemmyAppPath = "/Applications/Memmy.app"');
    expect(mainSource).toContain('join("/Applications", basename(currentAppPath))');
    expect(mainSource).toContain("async function installMacDmgUpdateInBackground");
    expect(mainSource).toContain("async function stageMacDmgUpdatePackage");
    expect(mainSource).toContain("function resolveStagedMacUpdateAppPath");
    expect(mainSource).toContain("function createMacDmgUpdateStageScript");
    expect(mainSource).toContain("await stageMacDmgUpdatePackage(filePath)");
    expect(mainSource).toContain("using staged Memmy app");
    expect(mainSource).toContain("STAGED_APP_PATH");
    expect(mainSource).toContain("function shouldInstallWindowsUpdateInBackground");
    expect(mainSource).toContain("async function installWindowsUpdateInBackground");
    expect(mainSource).toContain("launch-win-update-${Date.now()}.vbs");
    expect(mainSource).toContain("install-win-update-${Date.now()}.ps1");
    expect(mainSource).toContain('const helper = spawn("wscript.exe"');
    expect(mainSource).toContain("function createWindowsUpdateLauncherScript");
    expect(mainSource).toContain("$arguments = @('/S', '--updated', '/currentuser', ('/D=' + $appDir))");
    expect(mainSource).toContain("CURRENT_APP_PID");
    expect(mainSource).toContain("OPEN_AFTER_INSTALL");
    expect(mainSource).toContain('while /bin/kill -0 "$CURRENT_APP_PID"');
    expect(mainSource).toContain("terminating leftover Memmy runtime processes");
    expect(mainSource).toContain("-WindowStyle Hidden");
    expect(mainSource).not.toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command");
    expect(mainSource).not.toContain("install-win-update-${Date.now()}.cmd");
    expect(mainSource).not.toContain('spawn(process.env.ComSpec ?? "cmd.exe"');
    expect(mainSource).not.toContain("findstr /R");
    expect(mainSource).not.toContain("for _ in {1..120}");
    expect(mainSource).not.toContain("for /L %%i in (1,1,120)");
    expect(mainSource).toContain('spawn("/bin/zsh"');
    expect(mainSource).toContain("/usr/bin/hdiutil attach");
    expect(mainSource).toContain('/usr/bin/open -n "$DEST_APP_PATH"');
    expect(mainSource).toContain("await shell.openPath(safeFilePath)");
    expect(mainSource).toContain("function shouldQuitForManualUpdateInstall");
    expect(mainSource).toContain("function scheduleQuitForManualUpdateInstall");
    expect(mainSource).toContain("if (shouldInstallWindowsUpdateInBackground(safeFilePath))");
    expect(mainSource).toContain("const result = await installWindowsUpdateInBackground(safeFilePath)");
    expect(mainSource).toContain("UPDATE_INSTALL_QUIT_DELAY_MS");
    expect(mainSource).toContain("UPDATE_INSTALL_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("WINDOWS_UPDATE_INSTALL_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS");
    expect(mainSource).toContain("const forceExitDelayMs = process.platform === \"win32\" ? WINDOWS_UPDATE_INSTALL_FORCE_EXIT_DELAY_MS : UPDATE_INSTALL_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("APP_QUIT_CLEANUP_FORCE_EXIT_DELAY_MS");
    expect(mainSource).toContain("APP_QUIT_ANALYTICS_GRACE_MS");
    expect(mainSource).toContain("const APP_QUIT_ANALYTICS_GRACE_MS = 150;");
    expect(mainSource).toContain("sendAppExitEventBeforeQuit()");
    expect(mainSource).toContain("Promise.race([exitEvent, delay(APP_QUIT_ANALYTICS_GRACE_MS)])");
    expect(mainSource).toContain("armQuitCleanupForceExitTimer()");
    expect(mainSource).toContain("clearQuitCleanupForceExitTimer()");
    expect(mainSource).toContain("hideAppShellForQuit()");
    expect(mainSource).toContain("function hideAppShellForQuit()");
    expect(mainSource).toContain("BrowserWindow.getAllWindows()");
    expect(mainSource).toContain("quit cleanup timed out; forcing app exit");
    expect(mainSource).toContain("quit:cleanup-failed");
    expect(mainSource).toContain("app.exit(0)");
    expect(mainSource).toContain("async function cleanupBeforeQuit()");
    expect(mainSource).toContain("event.preventDefault()");
    expect(mainSource).toContain("await services?.close()");
    expect(mainSource).toContain("app.quit()");
    expect(runtimeServicesSource).toContain("STOP_MANAGED_CHILD_GRACE_MS");
    expect(runtimeServicesSource).toContain("sleep(STOP_MANAGED_CHILD_GRACE_MS)");
    expect(interfaceSource).toContain("export type DesktopUpdateMode");
    expect(interfaceSource).toContain("export interface DesktopUpdateDownloadOptions");
    expect(interfaceSource).toContain("minSupportedVersion?: string");
    expect(interfaceSource).toContain("updateMode?: DesktopUpdateMode");
    expect(interfaceSource).toContain("force?: boolean");
    expect(interfaceSource).toContain("preparedUpdatePath?: string");
    expect(interfaceSource).toContain("willQuit?: boolean");
    expect(interfaceSource).toContain("background?: boolean");
    expect(preloadSource).toContain("getAppInfo(): Promise<DesktopAppInfo>;");
    expect(preloadSource).toContain("checkForUpdates(): Promise<DesktopUpdateCheckResult>;");
    expect(preloadSource).toContain("downloadUpdate(update: DesktopUpdateCheckResult, options?: DesktopUpdateDownloadOptions): Promise<DesktopUpdateInstallResult>;");
    expect(preloadSource).toContain("openUpdateInstaller(filePath: string): Promise<DesktopUpdateInstallResult>;");
    expect(preloadSource).toContain("notifyUpdateAvailable(payload: { title: string; body: string; silent: boolean }): Promise<void>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:get-app-info")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:check-for-updates")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:download-update", update, options)');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:open-update-installer", filePath)');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:notify-update-available", payload)');
  });

  it("declares macOS microphone usage and exposes microphone permission bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const electronBuilderSource = readFileSync(electronBuilderPath, "utf8");
    const macEntitlementsSource = readFileSync(macEntitlementsPath, "utf8");
    const macEntitlementsInheritSource = readFileSync(macEntitlementsInheritPath, "utf8");

    expect(electronBuilderSource).toContain("NSMicrophoneUsageDescription");
    expect(electronBuilderSource).toContain("entitlements: build/entitlements.mac.plist");
    expect(electronBuilderSource).toContain("entitlementsInherit: build/entitlements.mac.inherit.plist");
    expect(macEntitlementsSource).toContain("com.apple.security.device.audio-input");
    expect(macEntitlementsInheritSource).toContain("com.apple.security.device.audio-input");
    expect(mainSource).toContain('ipcMain.handle("memmy:get-microphone-access-status"');
    expect(mainSource).toContain('ipcMain.handle("memmy:request-microphone-access"');
    expect(preloadSource).toContain("getMicrophoneAccessStatus(): Promise<MicrophoneAccessStatus>;");
    expect(preloadSource).toContain("requestMicrophoneAccess(): Promise<MicrophoneAccessStatus>;");
  });

  it("uses the Memmy mascot icon for packaged app artifacts", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const macBuilderSource = readFileSync(electronBuilderPath, "utf8");
    const unsignedMacBuilderSource = readFileSync(unsignedElectronBuilderPath, "utf8");
    const winBuilderSource = readFileSync(winElectronBuilderPath, "utf8");
    const unsignedWinBuilderSource = readFileSync(winUnsignedBuilderPath, "utf8");

    expect(macBuilderSource).toContain("icon: build/icon.icns");
    expect(unsignedMacBuilderSource).toContain("icon: build/icon.icns");
    expect(winBuilderSource).toContain("icon: build/icon.ico");
    expect(unsignedWinBuilderSource).toContain("icon: build/icon.ico");
    expect(winBuilderSource).toContain("from: build/icon.ico");
    expect(winBuilderSource).toContain("to: icon.ico");
    expect(unsignedWinBuilderSource).toContain("from: build/icon.ico");
    expect(unsignedWinBuilderSource).toContain("to: icon.ico");
    expect(mainSource).toContain('const WINDOWS_APP_USER_MODEL_ID = "cn.memtensor.memmy";');
    expect(mainSource).toContain("app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);");
    expect(mainSource).toContain('join(process.resourcesPath, "icon.ico")');
    expect(mainSource).toContain("resolveWindowsTaskbarIconPath()");
    expect(mainSource).toContain("function resolveWindowsTrayImage()");
    expect(mainSource).toContain('resolve(import.meta.dirname, "../../build/icon.ico")');
    expect(mainSource).toContain("syncMenuBarTray(true);");
  });

  it("keeps runtime-services packaged-only and out of Electron userData", () => {
    const source = readFileSync(runtimeServicesPath, "utf8");

    expect(source).toContain("startPackagedRuntimeServices");
    expect(source).toContain('env.MEMMY_CONFIG ?? join(memmyHome, "config.yaml")');
    expect(source).toContain('env.MEMMY_AGENT_WORKSPACE ?? configuredWorkspace ?? defaultWorkspace');
    expect(source).toContain("syncBundledAgentSkills");
    expect(source).toContain('join(dirname(options.agentEntry), "skills")');
    expect(source).toContain('join(options.agentWorkspace, "skills")');
    expect(source).toContain("copyDirectoryContents");
    expect(source).toContain("await readdir(sourceDirectory, { withFileTypes: true })");
    expect(source).toContain("await writeFile(targetPath, await readFile(sourcePath))");
    expect(source).not.toContain("startDesktopRuntimeServices");
    expect(source).not.toContain("DesktopRuntimeServices");
    expect(source).not.toContain("StartDesktopRuntimeServicesOptions");
    expect(source).not.toContain("userDataPath");
    expect(source).not.toContain("mainDir");
    expect(source).not.toContain("getFreePort");
    expect(source).not.toContain(legacyApplicationSupportDir);
    expect(source).not.toContain("dist/src/server/index.js");
    expect(source).not.toContain("App/memmy-agent/dist/main.js");
  });

  it("exports shared config and workspace paths from dev-start", () => {
    const source = readFileSync(devStartPath, "utf8");
    const supervisorSource = readFileSync(devMemorySupervisorPath, "utf8");
    const nativeRebuildIndex = source.indexOf("npm rebuild better-sqlite3");
    const electronRuntimeCheckIndex = source.indexOf("ensure_electron_runtime", nativeRebuildIndex);
    const desktopLaunchIndex = source.indexOf("npm run dev -w @memmy/desktop", electronRuntimeCheckIndex);

    expect(source).toContain('MEMORY_CLI_ENTRY="$ROOT_DIR/Memory/dist/src/cli/index.js"');
    expect(source).toContain('MEMMY_CONFIG_PATH="${MEMMY_CONFIG:-$HOME/.memmy/config.yaml}"');
    expect(source).toContain('MEMMY_WORKSPACE_DIR="${MEMMY_WORKSPACE:-$HOME/.memmy/workspace}"');
    expect(source).toContain('MEMMY_BIN_DIR="$HOME/.local/bin"');
    expect(source).toContain('export MEMMY_CONFIG="$MEMMY_CONFIG_PATH"');
    expect(source).toContain('export MEMMY_AGENT_WORKSPACE="$MEMMY_WORKSPACE_DIR"');
    expect(source).toContain('runtime_node_dir="$(cd "$(dirname "$MEMMY_RUNTIME_NODE_PATH")" && pwd)"');
    expect(source).toContain('export PATH="$runtime_node_dir:$PATH"');
    expect(source).not.toContain('MEMMY_BIN_DIR="$HOME/.memmy/bin"');
    expect(source).not.toContain('"bash -lc ');
    expect(source.match(/"bash -c /g)).toHaveLength(5);
    expect(source).toContain('const Database = require("better-sqlite3")');
    expect(source).toContain("npm run dev -w @memmy/desktop");
    expect(source).toContain("env -u ELECTRON_RUN_AS_NODE npm run dev -w @memmy/desktop");
    expect(source).toContain("node scripts/internal/dev-memory-supervisor.mjs");
    expect(supervisorSource).toContain('["run", "memory:dev"]');
    expect(supervisorSource).toContain("Memory dev process stopped");
    expect(source).toContain('pgrep -f "/Memmy.app/Contents/MacOS/Memmy"');
    expect(source.match(/lsof -tiTCP:18997/g)).toHaveLength(2);
    expect(source.match(/lsof -tiTCP:18999/g)).toHaveLength(2);
    expect(nativeRebuildIndex).toBeGreaterThanOrEqual(0);
    expect(electronRuntimeCheckIndex).toBeGreaterThan(nativeRebuildIndex);
    expect(desktopLaunchIndex).toBeGreaterThan(electronRuntimeCheckIndex);
  });

  it("clears persisted Memmy environment and legacy CLI links during full uninstall", () => {
    const source = readFileSync(clearAllPath, "utf8");

    expect(source).toContain("launchctl unsetenv");
    expect(source).toContain("^(MEMMY_|MEMORY_SERVICE_)");
    expect(source).toContain('"$HOME/.zshenv"');
    expect(source).toContain('"$HOME/.bash_profile"');
    expect(source).toContain('"/usr/local/bin/memmy-memory"');
    expect(source).toContain("# Memmy CLI PATH");
    expect(source).toContain("Fully quit and reopen Codex");
  });

  it("keeps packaged CLI launchers on Memmy.app and ~/.memmy/config.yaml", () => {
    const source = readFileSync(packageMacDmgPath, "utf8");

    expect(source).toContain('APP_EXEC="\\$MACOS_DIR/Memmy"');
    expect(source).toContain('DEFAULT_CONFIG="\\$HOME/.memmy/config.yaml"');
    expect(source).toContain('APP_PATH="/Applications/Memmy.app"');
    expect(source).not.toMatch(legacyProductPattern);
    expect(source).not.toContain("agent/config.yaml");
    expect(source).not.toContain("memory-service/config.yaml");
  });

  it("packages Memory from its own workspace with an Electron-rebuilt sqlite addon", () => {
    const source = readFileSync(packageMacDmgPath, "utf8");

    expect(source).toContain('MEMORY_DIR="$ROOT_DIR/Memory"');
    expect(source).toContain("create_memory_runtime_manifest");
    expect(source).toContain("write_desktop_edition_manifest");
    expect(source).toContain('"signing": "$package_signing"');
    expect(source).toContain("npm run build -w @memmy/memory");
    expect(source).toContain("npm install --workspace @memmy/frontend-desktop --no-package-lock");
    expect(source).toContain('npm ci --prefix "$AGENT_DIR"');
    expect(source).not.toContain('npm install --prefix "$AGENT_DIR"');
    expect(source).not.toContain('if [ ! -x "$AGENT_DIR/node_modules/.bin/tsc" ]');
    expect(source).toContain('cp -R "$MEMORY_DIR/dist/src" "$RUNTIME_DIR/memory/src"');
    expect(source).toContain('npm ci --prefix "$RUNTIME_DIR/memory" --omit=dev --os=darwin --cpu="$TARGET_CPU"');
    expect(source).toContain("node_modules/.bin/electron-rebuild");
    expect(source).toContain('-m "$RUNTIME_DIR/memory"');
    expect(source).not.toContain('cp -R "$ROOT_DIR/dist/src" "$RUNTIME_DIR/memory/src"');
  });

  it("builds signed arm64 DMGs through the shared mac packaging script", () => {
    const source = readFileSync(signedMacArm64PackagePath, "utf8");

    expect(source).toMatch(/bash "\$ROOT_DIR\/scripts\/internal\/package-mac-dmg\.sh" \\\s+--arm64 \\/);
    expect(source).not.toContain("npm run package:mac -- --arm64");
  });

  it("builds Windows x64 editions through one shared packaging script", () => {
    const wrappers = [
      [readFileSync(winX64CnUnsignedPackagePath, "utf8"), "phone", "cn", true],
      [readFileSync(winX64CnSignedPackagePath, "utf8"), "phone", "cn", false],
      [readFileSync(winX64IntlUnsignedPackagePath, "utf8"), "email", "intl", true],
      [readFileSync(winX64IntlSignedPackagePath, "utf8"), "email", "intl", false]
    ] as const;

    for (const [source, accountChannel, edition, unsigned] of wrappers) {
      expect(source).toContain(`export MEMMY_ACCOUNT_CHANNEL=${accountChannel}`);
      expect(source).toContain(`export MEMMY_APP_EDITION=${edition}`);
      expect(source).toContain('scripts/internal/package-win-x64.sh');
      if (unsigned) {
        expect(source).toContain("export MEMMY_SKIP_CODESIGN=1");
      } else {
        expect(source).toContain("unset MEMMY_SKIP_CODESIGN");
      }
    }
  });

  it("sets an explicit edition in macOS package wrappers", () => {
    for (const [name, accountChannel, edition] of [
      ["cn-unsigned", "phone", "cn"],
      ["cn-signed", "phone", "cn"],
      ["intl-unsigned", "email", "intl"],
      ["intl-signed", "email", "intl"]
    ] as const) {
      const path = fileURLToPath(new URL(`../../../../scripts/package-mac-arm64-${name}.sh`, import.meta.url));
      const source = readFileSync(path, "utf8");

      expect(source).toContain(`export MEMMY_ACCOUNT_CHANNEL=${accountChannel}`);
      expect(source).toContain(`export MEMMY_APP_EDITION=${edition}`);
    }
  });

  it("supports Windows signing through PFX files and SimplySign certificate store thumbprints", () => {
    const source = readFileSync(packageWinX64Path, "utf8");
    const builderConfig = readFileSync(winElectronBuilderPath, "utf8");

    expect(source).toContain("WIN_CSC_LINK");
    expect(source).toContain("WIN_CSC_KEY_PASSWORD");
    expect(source).toContain("WIN_CSC_SHA1");
    expect(source).toContain("WIN_CSC_SUBJECT_NAME");
    expect(source).toContain("WIN_CSC_TIMESTAMP_SERVER");
    expect(source).toContain("--config.win.signtoolOptions.certificateSha1=");
    expect(source).toContain("--config.win.signtoolOptions.certificateSubjectName=");
    expect(source).toContain("--config.win.signtoolOptions.rfc3161TimeStampServer=");
    expect(source).toContain('if [ "${#WINDOWS_SIGNING_BUILDER_ARGS[@]}" -gt 0 ]; then');
    expect(source).toContain('BUILDER_ARGS+=("${WINDOWS_SIGNING_BUILDER_ARGS[@]}")');
    expect(builderConfig).toContain("signingHashAlgorithms:");
    expect(builderConfig).toContain("- sha256");
  });

  it("reads Windows package versions through Node-readable paths", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("to_node_readable_path");
    expect(source).toContain("cygpath -w");
    expect(source).toContain('DESKTOP_VERSION="${MEMMY_DESKTOP_VERSION:-$(read_package_version "$DESKTOP_DIR/package.json")}"');
    expect(source).toContain(
      'electron_version="${MEMMY_ELECTRON_VERSION:-$(read_package_version "$DESKTOP_DIR/node_modules/electron/package.json")}"'
    );
    expect(source).not.toContain("require('$DESKTOP_DIR/package.json')");
    expect(source).not.toContain("require('$DESKTOP_DIR/node_modules/electron/package.json')");
  });

  it("runs npm lifecycle scripts through bash during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("configure_npm_script_shell");
    expect(source).toContain("npm_with_configured_script_shell");
    expect(source).toContain('npm --script-shell "$npm_config_script_shell" "$@"');
    expect(source).toContain("npm_config_script_shell");
    expect(source).toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(source).toContain("MEMMY_NPM_SCRIPT_SHELL");
    expect(source).toContain("command -v bash");
  });

  it("gates electron-builder uninstaller desktop refresh during keep-shortcuts updates", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("patch_electron_builder_nsis_refresh");
    expect(source).toContain("app-builder-lib/templates/nsis/uninstaller.nsh");
    expect(source).toContain("refresh the desktop after shortcuts were actually removed");
    expect(source).toContain('source.includes(marker)');
    expect(source).toContain('source.replace(original, replacement)');
    expect(source).toContain('patch_electron_builder_nsis_refresh');
    expect(source.indexOf("patch_electron_builder_nsis_refresh")).toBeLessThan(
      source.indexOf('npx electron-builder "${BUILDER_ARGS[@]}" --win nsis --x64')
    );
  });

  it("reuses the installed Electron dist during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("resolve_electron_dist");
    expect(source).toContain("node_modules/electron/dist/electron.exe");
    expect(source).toContain('to_node_readable_path "$electron_dist"');
    expect(source).toContain('BUILDER_ARGS+=(--config.electronDist="$ELECTRON_DIST")');
  });

  it("retries flaky native prebuild downloads during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("run_with_retries");
    expect(source).toContain("run_with_retries 3 ../.bin/prebuild-install");
    expect(source).toContain("install_better_sqlite3_prebuild_with_download_fallback");
    expect(source).toContain("--verbose 2>&1");
    expect(source).toContain("Invoke-WebRequest");
    expect(source).toContain('prebuild_file="prebuilds/$(basename "$prebuild_url")"');
  });

  it("keeps Windows packaging from mutating memmy-agent dependency locks", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain('npm_with_configured_script_shell ci --prefix "$AGENT_DIR"');
    expect(source).not.toContain('npm install --prefix "$AGENT_DIR"');
    expect(source).not.toContain('if [ ! -d "$AGENT_DIR/node_modules" ]');
  });

  it("writes Windows package edition identity and tagged installer names", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("write_desktop_edition_manifest");
    expect(source).toContain("desktop-edition.json");
    expect(source).toContain('"signing": "$PACKAGE_SIGNING"');
    expect(source).toContain('FINAL_EXE="$DESKTOP_DIR/release/Memmy-$DESKTOP_VERSION-win32-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING.exe"');
    expect(source).toContain('ARTIFACT_NAME="Memmy-$DESKTOP_VERSION-win32-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING.\\${ext}"');
    expect(source).toContain('BUILDER_ARGS+=(--config.extraMetadata.version="$DESKTOP_VERSION")');
    expect(source).toContain('npx electron-builder "${BUILDER_ARGS[@]}" --win nsis --x64 "$@" --config.artifactName="$ARTIFACT_NAME"');
    expect(source).not.toContain("use_final_artifact_name");
    expect(source).not.toContain("mv -f");
  });

  it("bundles the repo-root .env so packaged apps can resolve MEMMY_CLOUD_SERVICE", () => {
    const configs = [
      readFileSync(electronBuilderPath, "utf8"),
      readFileSync(unsignedElectronBuilderPath, "utf8"),
      readFileSync(winElectronBuilderPath, "utf8"),
      readFileSync(winUnsignedBuilderPath, "utf8")
    ];

    for (const config of configs) {
      expect(config).toContain("from: ../../../.env");
      expect(config).toContain("to: .env");
    }
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function extractFunctionSource(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextSection = source.indexOf("\n/**", start + declaration.length);
  expect(nextSection).toBeGreaterThan(start);
  return source.slice(start, nextSection);
}
