import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWindowsDataMigrationConsistency,
  recordWindowsDataLayoutAfterBoot,
  resolveWindowsDataLayout
} from "../src/main/windows-data-layout.js";

describe("Windows desktop data layout", () => {
  it("keeps packaged system-drive data outside the installation directory", () => {
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: "C:\\Users\\lee\\AppData\\Local\\Programs\\Memmy\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee"
    })).toEqual({
      userDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
      runtimeHomePath: "C:\\Users\\lee\\.memmy",
      updatesPath: "C:\\Users\\lee\\.memmy\\updates",
      pointerPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy\\data-root.txt",
      migrationStatePath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\data-migration\\state.json",
      installationRecordPath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\data-layout\\last-install.json",
      legacyInstallDataPath: "C:\\Users\\lee\\AppData\\Local\\Programs\\Memmy\\data"
    });
  });

  it("uses MemmyData on the packaged non-system installation drive", () => {
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: "E:\\Apps\\Memmy\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee"
    })).toEqual({
      userDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
      runtimeHomePath: "E:\\MemmyData\\.memmy",
      updatesPath: "E:\\MemmyData\\updates",
      pointerPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy\\data-root.txt",
      migrationStatePath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\data-migration\\state.json",
      installationRecordPath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\data-layout\\last-install.json",
      legacyInstallDataPath: "E:\\Apps\\Memmy\\data"
    });
  });

  it("keeps the literal C-drive rule even when Windows reports another system drive", () => {
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: "C:\\Apps\\Memmy\\Memmy.exe",
      appDataPath: "D:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "D:\\Users\\lee\\AppData\\Local",
      homeDirectory: "D:\\Users\\lee"
    })?.runtimeHomePath).toBe("D:\\Users\\lee\\.memmy");
  });

  it("does not apply the NSIS installation-drive rule to macOS or Windows Store", () => {
    expect(resolveWindowsDataLayout({
      platform: "darwin",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: "/Applications/Memmy.app/Contents/MacOS/Memmy",
      appDataPath: "/Users/lee/Library/Application Support",
      localAppDataPath: "",
      homeDirectory: "/Users/lee"
    })).toBeNull();

    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: true,
      executablePath: "C:\\Program Files\\WindowsApps\\Memmy\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee"
    })?.runtimeHomePath).toBe("C:\\Users\\lee\\.memmy");
  });

  it.runIf(process.platform === "win32")(
    "exposes migration consistency only for categories copied by the active transaction",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-layout-consistency-"));
      try {
        const layout = resolveWindowsDataLayout({
          platform: "win32",
          isPackaged: true,
          isWindowsStore: false,
          executablePath: join(root, "new-install", "Memmy.exe"),
          appDataPath: join(root, "roaming"),
          localAppDataPath: join(root, "local"),
          homeDirectory: join(root, "Users", "tester")
        });
        expect(layout).not.toBeNull();
        if (!layout) return;
        await mkdir(win32.dirname(layout.migrationStatePath), { recursive: true });
        await writeFile(layout.migrationStatePath, JSON.stringify({
          phase: "awaiting-app-verification",
          targetUserDataPath: layout.userDataPath,
          targetRuntimeHomePath: layout.runtimeHomePath,
          accountSourceAuthority: "current-install-authority",
          runtimeSourceAuthority: "current-install-authority",
          categorySourcesShareGeneration: true
        }), "utf8");

        await expect(readWindowsDataMigrationConsistency(layout)).resolves.toEqual({
          accountSourceIsAuthoritative: true,
          runtimeSourceWasMigrated: true,
          categorySourcesShareGeneration: true
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "records the verified external layout generation after a successful boot",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-layout-record-"));
      try {
        const layout = resolveWindowsDataLayout({
          platform: "win32",
          isPackaged: true,
          isWindowsStore: false,
          executablePath: join(root, "new-install", "Memmy.exe"),
          appDataPath: join(root, "roaming"),
          localAppDataPath: join(root, "local"),
          homeDirectory: join(root, "Users", "tester")
        });
        expect(layout).not.toBeNull();
        if (!layout) return;

        await recordWindowsDataLayoutAfterBoot(layout, "1.1.0");
        expect(JSON.parse(await readFile(layout.installationRecordPath, "utf8"))).toMatchObject({
          schemaVersion: 1,
          dataLayoutGeneration: "external-v1",
          installDir: win32.dirname(layout.legacyInstallDataPath),
          userDataPath: layout.userDataPath,
          runtimeHomePath: layout.runtimeHomePath,
          appVersion: "1.1.0"
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
