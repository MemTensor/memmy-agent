import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWindowsDataMigrationConsistency,
  readWindowsCurrentInstallAuthority,
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

    const storeUserDataPath = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy";
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: true,
      executablePath: "C:\\Program Files\\WindowsApps\\Memtensor.Memmy_1.1.2.0_x64__eyack96k521x2\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee",
      storeUserDataPath
    })).toMatchObject({
      userDataPath: storeUserDataPath,
      runtimeHomePath: "C:\\Users\\lee\\.memmy",
      pointerPath: `${storeUserDataPath}\\data-root.txt`
    });
  });

  it("keeps Store runtime in USERPROFILE even with an old non-system-drive selection", () => {
    const storeUserDataPath = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy";
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: true,
      executablePath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee",
      storeUserDataPath,
      storeRuntimeHomePath: "D:\\MemmyData\\.memmy"
    })).toMatchObject({
      userDataPath: storeUserDataPath,
      runtimeHomePath: "C:\\Users\\lee\\.memmy",
      pointerPath: `${storeUserDataPath}\\data-root.txt`
    });
  });

  it("ignores old runtime override values for both Store and NSIS", () => {
    const storeUserDataPath = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy";
    const storeOptions = {
      platform: "win32" as const,
      isPackaged: true,
      isWindowsStore: true,
      executablePath: "E:\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee",
      storeUserDataPath
    };
    expect(resolveWindowsDataLayout({
      ...storeOptions,
      storeRuntimeHomePath: "D:\\"
    })?.runtimeHomePath).toBe("C:\\Users\\lee\\.memmy");
    expect(resolveWindowsDataLayout({
      ...storeOptions,
      storeRuntimeHomePath: "E:\\WindowsApps\\Memmy\\.memmy"
    })?.runtimeHomePath).toBe("C:\\Users\\lee\\.memmy");

    expect(resolveWindowsDataLayout({
      ...storeOptions,
      isWindowsStore: false,
      executablePath: "C:\\Applications\\Memmy\\Memmy.exe",
      storeRuntimeHomePath: "D:\\MemmyData\\.memmy"
    })?.runtimeHomePath).toBe("C:\\Users\\lee\\.memmy");
  });

  it.each([
    "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy",
    "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy"
  ])("uses the explicit corporate Store LocalState userData path: %s", (storeUserDataPath) => {
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: true,
      executablePath: "C:\\Program Files\\WindowsApps\\Memmy\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee",
      storeUserDataPath
    })?.userDataPath).toBe(storeUserDataPath);
  });

  it("fails closed when a Store layout has no absolute explicit userData path", () => {
    const baseOptions = {
      platform: "win32" as const,
      isPackaged: true,
      isWindowsStore: true,
      executablePath: "C:\\Program Files\\WindowsApps\\Memmy\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee"
    };

    expect(() => resolveWindowsDataLayout(baseOptions)).toThrow("storeUserDataPath");
    expect(() => resolveWindowsDataLayout({
      ...baseOptions,
      storeUserDataPath: "LocalState\\Memmy"
    })).toThrow("absolute");
    expect(() => resolveWindowsDataLayout({
      ...baseOptions,
      storeUserDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy"
    })).toThrow("Packages\\<PFN>\\LocalState\\Memmy");
  });

  it("ignores Store-only input for NSIS and keeps the existing roaming userData rule", () => {
    expect(resolveWindowsDataLayout({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: "C:\\Apps\\Memmy\\Memmy.exe",
      appDataPath: "C:\\Users\\lee\\AppData\\Roaming",
      localAppDataPath: "C:\\Users\\lee\\AppData\\Local",
      homeDirectory: "C:\\Users\\lee",
      storeUserDataPath: "C:\\should-not-be-used"
    })?.userDataPath).toBe("C:\\Users\\lee\\AppData\\Roaming\\Memmy");
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
        const pointerBytes = await readFile(layout.pointerPath);
        expect([...pointerBytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
        expect(pointerBytes.subarray(2).toString("utf16le")).toBe(`${layout.runtimeHomePath}\r\n`);
        expect(JSON.parse(await readFile(layout.installationRecordPath, "utf8"))).toMatchObject({
          schemaVersion: 1,
          dataLayoutGeneration: "external-v1",
          installationOwner: "nsis",
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

  it.runIf(process.platform === "win32")(
    "binds Store transition authority to the running EXE, last-install record, and data-root pointer",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-layout-authority-"));
      try {
        const executablePath = join(root, "应用 安装", "Memmy", "Memmy.exe");
        const layout = resolveWindowsDataLayout({
          platform: "win32",
          isPackaged: true,
          isWindowsStore: false,
          executablePath,
          appDataPath: join(root, "roaming"),
          localAppDataPath: join(root, "local"),
          homeDirectory: join(root, "Users", "tester")
        });
        expect(layout).not.toBeNull();
        if (!layout) return;

        await recordWindowsDataLayoutAfterBoot(layout, "1.1.1");
        await mkdir(win32.dirname(layout.pointerPath), { recursive: true });
        await writeFile(layout.pointerPath, Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(`${layout.runtimeHomePath}\r\n`, "utf16le")
        ]));

        await expect(readWindowsCurrentInstallAuthority(
          layout,
          executablePath,
          "1.1.1"
        )).resolves.toMatchObject({
          installDirectory: win32.dirname(executablePath),
          userDataPath: layout.userDataPath,
          runtimeHomePath: layout.runtimeHomePath,
          appVersion: "1.1.1"
        });

        await writeFile(layout.pointerPath, "D:\\Unexpected\\.memmy\r\n", "utf8");
        await expect(readWindowsCurrentInstallAuthority(
          layout,
          executablePath,
          "1.1.1"
        )).rejects.toThrow("data-root pointer");
        await expect(readWindowsCurrentInstallAuthority(
          layout,
          join(root, "other", "Memmy.exe"),
          "1.1.1"
        )).rejects.toThrow("current-install authority");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "writes the Store pointer without creating or overwriting the NSIS installation authority",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-layout-record-"));
      try {
        const userDataPath = join(
          root,
          "LocalAppData",
          "Packages",
          "Memtensor.MemmyAgent_eyack96k521x2",
          "LocalState",
          "Memmy"
        );
        const installationRecordPath = join(root, "LocalAppData", "Memmy", "data-layout", "last-install.json");
        const layout = {
          userDataPath,
          runtimeHomePath: "D:\\MemmyData\\.memmy",
          updatesPath: "C:\\Users\\lee\\.memmy\\updates",
          pointerPath: join(userDataPath, "data-root.txt"),
          migrationStatePath: join(root, "LocalAppData", "Memmy", "data-migration", "state.json"),
          installationRecordPath,
          legacyInstallDataPath: "C:\\Program Files\\WindowsApps\\Memmy\\app\\data"
        };

        await recordWindowsDataLayoutAfterBoot(layout, "1.1.2", {
          writeInstallationAuthority: false
        });
        await expect(readFile(installationRecordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        const pointerBytes = await readFile(layout.pointerPath);
        expect(pointerBytes.subarray(2).toString("utf16le")).toBe("D:\\MemmyData\\.memmy\r\n");

        await mkdir(win32.dirname(installationRecordPath), { recursive: true });
        await writeFile(installationRecordPath, "preserve-current-nsis-authority", "utf8");
        await recordWindowsDataLayoutAfterBoot(layout, "1.1.2", {
          writeInstallationAuthority: false
        });
        await expect(readFile(installationRecordPath, "utf8"))
          .resolves.toBe("preserve-current-nsis-authority");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("keeps the production Store startup from writing the NSIS-only authority", async () => {
    const source = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    expect(source).toContain("{ writeInstallationAuthority: !isWindowsStoreApp() }");
  });
});
