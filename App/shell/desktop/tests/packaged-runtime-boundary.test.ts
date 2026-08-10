import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));
const preloadSourcePath = fileURLToPath(new URL("../src/preload/preload.cts", import.meta.url));
const runtimeServicesPath = fileURLToPath(new URL("../src/main/runtime-services.ts", import.meta.url));
const devStartPath = fileURLToPath(new URL("../../../../scripts/dev-start.sh", import.meta.url));
const devMemorySupervisorPath = fileURLToPath(new URL("../../../../scripts/internal/shared/dev-memory-supervisor.mjs", import.meta.url));
const clearAllPath = fileURLToPath(new URL("../../../../scripts/clear-all.sh", import.meta.url));
const packageMacPath = fileURLToPath(new URL("../../../../scripts/package-mac.sh", import.meta.url));
const packageMacDmgPath = fileURLToPath(new URL("../../../../scripts/internal/mac/build-dmg.sh", import.meta.url));
const prepareEmbeddingModelPath = fileURLToPath(new URL("../../../../scripts/internal/shared/prepare-embedding-model.mjs", import.meta.url));
const signedMacArm64PackagePath = fileURLToPath(
  new URL("../../../../scripts/internal/mac/signed-arm64.sh", import.meta.url)
);
const packageWinPath = fileURLToPath(new URL("../../../../scripts/package-win.sh", import.meta.url));
const packageWinX64Path = fileURLToPath(new URL("../../../../scripts/internal/win/build-nsis.sh", import.meta.url));
const winUnsignedBuilderPath = fileURLToPath(new URL("../electron-builder.win.unsigned.yml", import.meta.url));
const winUnsignedInstallerIncludePath = fileURLToPath(new URL("../build/installer-win-unsigned.nsh", import.meta.url));
const desktopInterfacePath = fileURLToPath(new URL("../interface/src/index.ts", import.meta.url));
const localApiContractsPath = fileURLToPath(new URL("../../../../App/backend/local-api-contracts/src/index.ts", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));
const rootPackageLockPath = fileURLToPath(new URL("../../../../package-lock.json", import.meta.url));
const migrationsPackagePath = fileURLToPath(new URL("../../../../Migrations/package.json", import.meta.url));
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

  it("pins the in-process Playwright MCP runtime in the agent package", () => {
    const agentPackage = readJson<PackageJson>(agentPackagePath);
    const agentLock = readJson<any>(agentPackageLockPath);

    expect(agentPackage.dependencies).toMatchObject({
      "@playwright/mcp": "0.0.78",
      playwright: "1.62.0-alpha-1783623505000",
    });
    expect(agentLock.packages["node_modules/@playwright/mcp"].version).toBe(
      "0.0.78",
    );
    expect(agentLock.packages["node_modules/playwright"].version).toBe(
      "1.62.0-alpha-1783623505000",
    );
  });

  it("builds migrations as a private root workspace consumed by memmy-agent", () => {
    const rootPackage = readJson<PackageJson>(rootPackagePath);
    const rootLock = readJson<any>(rootPackageLockPath);
    const migrationsPackage = readJson<any>(migrationsPackagePath);
    const agentPackage = readJson<PackageJson>(agentPackagePath);
    const agentLock = readJson<any>(agentPackageLockPath);

    expect(rootPackage.workspaces).toContain("Migrations");
    expect(rootLock.packages.Migrations).toMatchObject({
      name: "@memmy/migrations",
      version: "0.0.0",
      dependencies: { "proper-lockfile": "^4.1.2" },
    });
    expect(rootLock.packages["node_modules/@memmy/migrations"]).toEqual({
      resolved: "Migrations",
      link: true,
    });
    expect(migrationsPackage).toMatchObject({
      name: "@memmy/migrations",
      version: "0.0.0",
      private: true,
      type: "module",
      files: ["dist/**/*"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    });
    expect(agentPackage.dependencies).toHaveProperty(
      "@memmy/migrations",
      "file:../../Migrations",
    );
    expect(agentLock.packages[""]?.dependencies).toHaveProperty(
      "@memmy/migrations",
      "file:../../Migrations",
    );
    expect(agentLock.packages["node_modules/@memmy/migrations"]).toEqual({
      resolved: "../../Migrations",
      link: true,
    });
    for (const scriptName of ["prebuild", "pretypecheck", "pretest"]) {
      expect(agentPackage.scripts?.[scriptName]).toBe(
        "npm run version:sync && npm --prefix ../../Migrations run build",
      );
    }
  });

  it("materializes the compiled migrations package in macOS and Windows runtimes", () => {
    const macSource = readFileSync(packageMacDmgPath, "utf8");
    const winSource = readFileSync(packageWinX64Path, "utf8");

    for (const source of [macSource, winSource]) {
      expect(source).toContain('MIGRATIONS_DIR="$ROOT_DIR/Migrations"');
      expect(source).toContain('MIGRATIONS_STAGING_DIR="$DESKTOP_DIR/dist/Migrations"');
      expect(source).toContain("install --workspace @memmy/migrations --include=dev");
      expect(source).toContain('cp "$MIGRATIONS_DIR/package.json" "$MIGRATIONS_STAGING_DIR/package.json"');
      expect(source).toContain('cp -R "$MIGRATIONS_DIR/dist" "$MIGRATIONS_STAGING_DIR/dist"');
      expect(source).toContain('RUNTIME_MIGRATIONS_DIR="$RUNTIME_DIR/memmy-agent/node_modules/@memmy/migrations"');
      expect(source).toContain('rm -rf "$RUNTIME_MIGRATIONS_DIR"');
      expect(source).toContain('mkdir -p "$RUNTIME_MIGRATIONS_DIR"');
      expect(source).toContain('cp "$MIGRATIONS_STAGING_DIR/package.json" "$RUNTIME_MIGRATIONS_DIR/package.json"');
      expect(source).toContain('cp -R "$MIGRATIONS_STAGING_DIR/dist" "$RUNTIME_MIGRATIONS_DIR/dist"');
      expect(source).toContain('if [ -L "$RUNTIME_MIGRATIONS_DIR" ]; then');
      expect(source).toContain('if [ ! -f "$RUNTIME_MIGRATIONS_DIR/dist/index.js" ]; then');
      expect(source).toContain('if [ -e "$MIGRATIONS_STAGING_DIR" ]; then');
      expect(source).toContain('import { runMigrations } from "@memmy/migrations";');
      expect(source).toContain(
        'if (typeof runMigrations !== "function") throw new Error("Migrations runtime export is unavailable")',
      );
      expect(source).toContain(
        '$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations/dist/index.js',
      );
      expect(source).toContain(
        '[ -L "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations" ]',
      );

      const stageIndex = source.indexOf(
        'cp "$MIGRATIONS_DIR/package.json" "$MIGRATIONS_STAGING_DIR/package.json"',
      );
      const runtimeInstallIndex = source.indexOf(
        source === macSource
          ? 'npm ci --prefix "$RUNTIME_DIR/memmy-agent"'
          : 'npm_ci_win_x64 "$RUNTIME_DIR/memmy-agent"',
      );
      const materializeIndex = source.indexOf('rm -rf "$RUNTIME_MIGRATIONS_DIR"');
      const cleanupIndex = source.indexOf('rm -rf "$MIGRATIONS_STAGING_DIR"', stageIndex + 1);
      const builderIndex = source.indexOf("npx electron-builder");
      expect(stageIndex).toBeGreaterThanOrEqual(0);
      expect(runtimeInstallIndex).toBeGreaterThan(stageIndex);
      expect(materializeIndex).toBeGreaterThan(runtimeInstallIndex);
      expect(cleanupIndex).toBeGreaterThan(materializeIndex);
      expect(builderIndex).toBeGreaterThan(cleanupIndex);
    }

    expect(macSource.indexOf('npm --prefix "$MIGRATIONS_DIR" run build')).toBeLessThan(
      macSource.indexOf('npm ci --prefix "$AGENT_DIR"'),
    );
    expect(winSource.indexOf('run build --prefix "$MIGRATIONS_DIR"')).toBeLessThan(
      winSource.indexOf('ci --prefix "$AGENT_DIR"'),
    );
  });

  it("unpacks the migrations runtime in every desktop package variant", () => {
    for (const configPath of [
      electronBuilderPath,
      unsignedElectronBuilderPath,
      winElectronBuilderPath,
      winUnsignedBuilderPath
    ]) {
      const config = parseYaml(readFileSync(configPath, "utf8")) as {
        asarUnpack?: string[];
      };
      expect(config.asarUnpack).toContain(
        "dist/runtime/memmy-agent/node_modules/@memmy/migrations/**"
      );
    }
  });

  it("bundles the local embedding model in every desktop package variant", () => {
    for (const configPath of [
      electronBuilderPath,
      unsignedElectronBuilderPath,
      winElectronBuilderPath,
      winUnsignedBuilderPath
    ]) {
      const config = parseYaml(readFileSync(configPath, "utf8")) as {
        extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>;
      };
      expect(config.extraResources).toContainEqual({
        from: "dist/embedding-models",
        to: "embedding-models",
        filter: ["**/*"]
      });
    }
  });

  it("excludes dependency root tests and docs from every desktop app archive", () => {
    for (const configPath of [
      electronBuilderPath,
      unsignedElectronBuilderPath,
      winElectronBuilderPath,
      winUnsignedBuilderPath
    ]) {
      const config = parseYaml(readFileSync(configPath, "utf8")) as {
        files?: string[];
      };
      const files = config.files ?? [];

      expect(files).toContain("dist/**/*");
      expect(files).toContain("!**/node_modules/*/{test,tests,__tests__,doc,docs,example,examples,coverage,.github}");
      expect(files).toContain("!**/node_modules/*/{test,tests,__tests__,doc,docs,example,examples,coverage,.github}/**/*");
      expect(files).toContain("!**/node_modules/@*/*/{test,tests,__tests__,doc,docs,example,examples,coverage,.github}");
      expect(files).toContain("!**/node_modules/@*/*/{test,tests,__tests__,doc,docs,example,examples,coverage,.github}/**/*");
      expect(files).toContain("!**/node_modules/**/*.{test,spec}.*");
      expect(files).toContain(
        "!**/node_modules/**/{README,README*.md,README*.mdown,README*.markdown,README*.rst,README*.txt,CHANGELOG,CHANGELOG*.md,CHANGELOG*.mdown,CHANGELOG*.markdown,CHANGELOG*.rst,CHANGELOG*.txt,CONTRIBUTING,CONTRIBUTING*.md,CONTRIBUTING*.mdown,CONTRIBUTING*.markdown,CONTRIBUTING*.rst,CONTRIBUTING*.txt,CODE_OF_CONDUCT,CODE_OF_CONDUCT*.md,CODE_OF_CONDUCT*.mdown,CODE_OF_CONDUCT*.markdown,CODE_OF_CONDUCT*.rst,CODE_OF_CONDUCT*.txt,SECURITY,SECURITY*.md,SECURITY*.mdown,SECURITY*.markdown,SECURITY*.rst,SECURITY*.txt}"
      );
      expect(files).not.toContain("!**/node_modules/**/{test,tests,__tests__,doc,docs,example,examples,coverage,.github}");
      expect(files).not.toContain("!**/node_modules/**/*.md");
    }
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

  it("unpacks ONNX Runtime native libraries next to their native bindings", () => {
    for (const configPath of [electronBuilderPath, unsignedElectronBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/onnxruntime-node/bin/napi-v3/darwin/**/*.dylib"');
    }
    for (const configPath of [winElectronBuilderPath, winUnsignedBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/onnxruntime-node/bin/napi-v3/win32/x64/**/*.dll"');
    }
  });

  it("unpacks Sharp libvips native libraries next to the Sharp native binding", () => {
    for (const configPath of [electronBuilderPath, unsignedElectronBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@img/sharp-libvips-darwin-*/lib/libvips*.dylib"');
    }
    for (const configPath of [winElectronBuilderPath, winUnsignedBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@img/sharp-win32-x64/lib/libvips*.dll"');
    }
  });

  it("unpacks Windows node-pty ConPTY runtime files for dynamic loading", () => {
    for (const configPath of [winElectronBuilderPath, winUnsignedBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/**"');
    }
  });

  it("unpacks macOS node-pty spawn helpers used by the native pty binding", () => {
    for (const configPath of [electronBuilderPath, unsignedElectronBuilderPath]) {
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain('- "**/@lydell/node-pty-darwin-*/prebuilds/darwin-*/spawn-helper"');
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

  it("persists gtag client_id into the shared ~/.memmy analytics-client-id file", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    expect(mainSource).toContain('import { persistSharedAnalyticsClientId } from "./analytics-client-id-store.js"');
    expect(mainSource).toContain("persistSharedAnalyticsClientId(clientId)");
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

  it("exports a consistent memory.sqlite snapshot through the desktop save dialog", () => {
    const source = readFileSync(mainSourcePath, "utf8");
    const exportSource = extractFunctionSource(source, "async function exportMemoryDatabase");

    expect(source).toContain('ipcMain.handle("memmy:export-memory-database"');
    expect(exportSource).toContain("dialog.showSaveDialog");
    expect(exportSource).toContain("await backupSqliteDatabase(sourcePath, selected.filePath)");
    expect(exportSource).not.toContain("await copyFile(sourcePath, selected.filePath)");
    expect(exportSource).toContain("memory-${formatExportTimestamp(new Date())}.sqlite");
    expect(exportSource).not.toContain("filters:");
    expect(exportSource).not.toContain("All Files");
    expect(source).toContain('import { backupSqliteDatabase } from "./sqlite-backup.js"');
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

  it("restarts managed Memory and only reconnects external Memory through the desktop bridge", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const runtimeSource = readFileSync(runtimeServicesPath, "utf8");

    expect(preloadSource).toContain("restartMemoryService(): Promise<DesktopMemoryServiceRestartResult>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:restart-memory-service")');
    expect(mainSource).toContain('ipcMain.handle("memmy:restart-memory-service"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:restart-memory-service")');
    expect(mainSource).toContain("await runtimeServices.restartMemory()");
    expect(mainSource).toContain("await reconnectExternalMemoryService(control)");
    expect(runtimeSource).toContain("restartManagedMemoryService");
    expect(runtimeSource).toContain("runtimeConfig.memoryOwnership === \"remote\"");
    expect(runtimeSource).toContain("reconnectExternalMemoryService");
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
    expect(source).toContain(
      "browserPreparation = startPackagedBrowserPreparation(",
    );
    expect(source).not.toContain("await preparePackagedBrowser(entries, runtimeConfig, options)");
    expect(source).toContain('[entries.agentEntry, "internal", "browser-prepare"]');
    expect(source.indexOf("browserPreparation = startPackagedBrowserPreparation")).toBeLessThan(
      source.indexOf("await ensureMemoryService"),
    );
    expect(source).toContain("browserPreparation?.stop()");
    expect(source).toContain("terminateProcessTreeSync(child)");
    expect(source).toContain('detached: process.platform !== "win32"');
    expect(source).toContain('process.kill(-pid, "SIGKILL")');
    expect(source).toContain('join(options.logDirectory, "browser-prepare.log")');
    expect(source).toContain('ELECTRON_RUN_AS_NODE: "1"');
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
    expect(source).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci");
    expect(source).toContain(
      '"$MEMMY_RUNTIME_NODE_PATH" dist/main.js internal browser-prepare',
    );
    expect(source).toContain("env -u ELECTRON_RUN_AS_NODE npm run dev -w @memmy/desktop");
    expect(source).toContain("node scripts/internal/shared/dev-memory-supervisor.mjs");
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
    expect(source).toContain('import { createConnection } from "@playwright/mcp"');
    expect(source).toContain('require.resolve("playwright-core/package.json")');
    expect(source).toContain("./dist/entrypoints/cli/commands.js");
    expect(source).toContain('"browser-prepare"');
    expect(source).not.toContain('fs.readFileSync("./dist/main.js", "utf8").includes("browser-prepare")');
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

    expect(source).toMatch(/bash "\$ROOT_DIR\/scripts\/internal\/mac\/build-dmg\.sh" \\\s+--arm64 \\/);
    expect(source).not.toContain("npm run package:mac -- --arm64");
  });

  it("routes Windows x64 package variants through one public win entrypoint", () => {
    const packageWinSource = readFileSync(packageWinPath, "utf8");
    const rootPackage = readJson<PackageJson>(rootPackagePath);
    const scripts = rootPackage.scripts ?? {};

    expect(packageWinSource).toContain("Usage: package-win.sh --version <version> --arch <x64> --edition <cn|intl> --sign <signed|unsigned>");
    expect(packageWinSource).toContain("--version is required. Example: --version 0.0.1");
    expect(packageWinSource).toContain('export MEMMY_DESKTOP_VERSION="$VERSION"');
    expect(packageWinSource).toContain("export MEMMY_ACCOUNT_CHANNEL=phone");
    expect(packageWinSource).toContain("export MEMMY_ACCOUNT_CHANNEL=email");
    expect(packageWinSource).toContain("export MEMMY_SKIP_CODESIGN=1");
    expect(packageWinSource).toContain("unset MEMMY_SKIP_CODESIGN");
    expect(packageWinSource).toContain('BASE_SCRIPT="$ROOT_DIR/scripts/internal/win/$SIGN-$ARCH.sh"');
    expect(packageWinSource).toContain('bash "$BASE_SCRIPT" "${PASSTHROUGH_ARGS[@]}"');

    expect(scripts["package:win:x64"]).toBe("bash scripts/package-win.sh --version $npm_package_version --arch x64 --edition cn --sign signed");
    expect(scripts["package:win:x64:unsigned"]).toBe("bash scripts/package-win.sh --version $npm_package_version --arch x64 --edition cn --sign unsigned");
    expect(scripts["package:win:x64:cn:signed"]).toBe("bash scripts/package-win.sh --version $npm_package_version --arch x64 --edition cn --sign signed");
    expect(scripts["package:win:x64:cn:unsigned"]).toBe("bash scripts/package-win.sh --version $npm_package_version --arch x64 --edition cn --sign unsigned");
    expect(scripts["package:win:x64:intl:signed"]).toBe("bash scripts/package-win.sh --version $npm_package_version --arch x64 --edition intl --sign signed");
    expect(scripts["package:win:x64:intl:unsigned"]).toBe("bash scripts/package-win.sh --version $npm_package_version --arch x64 --edition intl --sign unsigned");
  });

  it("validates the bundled browser runtime during Windows packaging", () => {
    const source = readFileSync(packageWinX64Path, "utf8");

    expect(source).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
    expect(source).toContain('import { createConnection } from "@playwright/mcp"');
    expect(source).toContain('require.resolve("playwright-core/package.json")');
    expect(source).toContain("./dist/entrypoints/cli/commands.js");
    expect(source).toContain('"browser-prepare"');
    expect(source).not.toContain('fs.readFileSync("./dist/main.js", "utf8").includes("browser-prepare")');
  });

  it("fails package preparation when required native runtime companion files are missing", () => {
    const macSource = readFileSync(packageMacDmgPath, "utf8");
    const winSource = readFileSync(packageWinX64Path, "utf8");

    expect(macSource).toContain("verify_mac_memory_native_artifacts");
    expect(macSource).toContain("verify_mac_agent_native_artifacts");
    expect(macSource).toContain("verify_packaged_mac_unpacked_artifacts");
    expect(macSource).toContain("libonnxruntime*.dylib");
    expect(macSource).toContain("sharp-libvips-darwin-$target_cpu/lib/libvips*.dylib");
    expect(macSource).toContain("node-pty-darwin-$target_cpu/prebuilds/darwin-$target_cpu");
    expect(macSource).toContain("app.asar.unpacked/dist/runtime");
    expect(macSource).toContain("spawn-helper");
    expect(winSource).toContain("verify_windows_onnxruntime_module");
    expect(winSource).toContain("verify_windows_sharp_module");
    expect(winSource).toContain("verify_windows_agent_native_artifacts");
    expect(winSource).toContain("verify_packaged_windows_unpacked_artifacts");
    expect(winSource).toContain('onnxruntime_dir="$(dirname "$onnxruntime_node")"');
    expect(winSource).toContain("onnxruntime.dll");
    expect(winSource).toContain("sharp-win32-x64/lib");
    expect(winSource).toContain("win-unpacked/resources/app.asar.unpacked/dist/runtime");
    expect(winSource).toContain("conpty/OpenConsole.exe");
    expect(winSource).toContain("sqlite-vec-windows-x64/vec0.*");
  });

  it("prepares and validates the bundled local embedding model during packaging", () => {
    const macSource = readFileSync(packageMacDmgPath, "utf8");
    const winSource = readFileSync(packageWinX64Path, "utf8");
    const prepareEmbeddingModelSource = readFileSync(prepareEmbeddingModelPath, "utf8");

    for (const source of [macSource, winSource]) {
      expect(source).toContain('EMBEDDING_MODELS_DIR="$DESKTOP_DIR/dist/embedding-models"');
      expect(source).toContain('EMBEDDING_MODEL_ID="${MEMMY_EMBEDDING_MODEL:-Xenova/all-MiniLM-L6-v2}"');
      expect(source).toContain('rm -rf "$EMBEDDING_MODELS_DIR"');
      expect(source).toContain('node "$ROOT_DIR/scripts/internal/shared/prepare-embedding-model.mjs" "$EMBEDDING_MODELS_DIR"');
      expect(source).toContain('$packaged_embedding_model/config.json');
      expect(source).toContain('$packaged_embedding_model/tokenizer.json');
      expect(source).toContain('$packaged_embedding_model/onnx/model_quantized.onnx');
      expect(source.indexOf("prepare-embedding-model.mjs")).toBeLessThan(
        source.indexOf("npx electron-builder")
      );
    }
    expect(prepareEmbeddingModelSource).toContain('const fallbackRemoteHost = "https://hf-mirror.com/";');
    expect(prepareEmbeddingModelSource).toContain("function resolveRemoteHosts()");
    expect(prepareEmbeddingModelSource).toContain("env.remoteHost = remoteHost");
  });

  it("prunes third-party package docs and tests from macOS runtime before packaging", () => {
    const source = readFileSync(packageMacDmgPath, "utf8");

    expect(source).toContain("prune_node_modules_non_runtime_files");
    expect(source).toContain('prune_node_modules_non_runtime_files "$RUNTIME_DIR"');
    expect(source).toContain('"$package_dir/tests"');
    expect(source).toContain('"$package_dir/docs"');
    expect(source).not.toContain("-name docs");
    expect(source).not.toContain("-name doc");
    expect(source).toContain('-iname "README*.md"');
    expect(source).toContain('-iname "README*.mdown"');
    expect(source).toContain('-iname "CHANGELOG*.md"');
    expect(source).toContain('-iname "SECURITY*.md"');
    expect(source).toContain('-iname "*.test.js"');
    expect(source).toContain('-iname "*.test.ts"');
    expect(source).toContain('! \\( \\');
    expect(source).toContain('-iname "LICENSE*"');
    expect(source).toContain('-iname "NOTICE*"');
    expect(source).toContain('rm -f "$RUNTIME_DIR/memmy-agent/dist/skills/README.md"');

    expect(source.indexOf('prune_node_modules_non_runtime_files "$RUNTIME_DIR"')).toBeLessThan(
      source.indexOf("npx electron-builder"),
    );
  });

  it("routes macOS package variants through one public mac entrypoint", () => {
    const packageMacSource = readFileSync(packageMacPath, "utf8");
    const rootPackage = readJson<PackageJson>(rootPackagePath);
    const scripts = rootPackage.scripts ?? {};

    expect(packageMacSource).toContain("Usage: package-mac.sh --version <version> --arch <arm64|x64> --edition <cn|intl> --sign <signed|unsigned>");
    expect(packageMacSource).toContain("--version is required. Example: --version 0.0.1");
    expect(packageMacSource).toContain('export MEMMY_DESKTOP_VERSION="$VERSION"');
    expect(packageMacSource).toContain("export MEMMY_ACCOUNT_CHANNEL=phone");
    expect(packageMacSource).toContain("export MEMMY_ACCOUNT_CHANNEL=email");
    expect(packageMacSource).toContain("export MEMMY_SKIP_CODESIGN=1");
    expect(packageMacSource).toContain("unset MEMMY_SKIP_CODESIGN");
    expect(packageMacSource).toContain('BASE_SCRIPT="$ROOT_DIR/scripts/internal/mac/$SIGN-$ARCH.sh"');
    expect(packageMacSource).toContain('bash "$BASE_SCRIPT" "${PASSTHROUGH_ARGS[@]}"');

    expect(scripts["package:mac:arm64:cn:signed"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch arm64 --edition cn --sign signed");
    expect(scripts["package:mac:arm64:cn:unsigned"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch arm64 --edition cn --sign unsigned");
    expect(scripts["package:mac:arm64:intl:signed"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch arm64 --edition intl --sign signed");
    expect(scripts["package:mac:arm64:intl:unsigned"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch arm64 --edition intl --sign unsigned");
    expect(scripts["package:mac:x64:cn:signed"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch x64 --edition cn --sign signed");
    expect(scripts["package:mac:x64:cn:unsigned"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch x64 --edition cn --sign unsigned");
    expect(scripts["package:mac:x64:intl:signed"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch x64 --edition intl --sign signed");
    expect(scripts["package:mac:x64:intl:unsigned"]).toBe("bash scripts/package-mac.sh --version $npm_package_version --arch x64 --edition intl --sign unsigned");
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

  it("points packaged Memory at the bundled local embedding model resources", () => {
    const source = readFileSync(runtimeServicesPath, "utf8");

    expect(source).toContain('MEMMY_EMBEDDING_MODEL_ROOT: join(options.resourcesPath, "embedding-models")');
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
