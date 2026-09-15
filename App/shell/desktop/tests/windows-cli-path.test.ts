import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_USER_PATH_LOCATION,
  ensureWindowsCliDirectoryOnPath,
  findConflictingWindowsStoreCliPath,
  installPackagedWindowsCliTools,
  installPackagedWindowsStoreCliTools,
  mergeWindowsUserPath,
  resolveCliInstallStrategy,
  resolvePackagedWindowsStoreCliDirectory,
  type WindowsUserPathAccess
} from "../src/main/windows-cli-path.js";

describe("Windows packaged CLI installation", () => {
  it("installs the two packaged .cmd launchers without extensionless files", async () => {
    const resourcesPath = "C:\\Program Files\\Memmy\\resources";
    const memoryCli = win32.join(resourcesPath, "cli", "memmy-memory.cmd");
    const memmyCli = win32.join(resourcesPath, "cli", "memmy.cmd");
    const packagedFiles = new Set([memoryCli, memmyCli]);
    const ensureUserPath = vi.fn(async () => true);

    const result = await installPackagedWindowsCliTools(resourcesPath, {
      accessFile: async (path) => {
        if (!packagedFiles.has(path)) {
          throw new Error(`unexpected packaged path: ${path}`);
        }
      },
      ensureUserPath
    });

    expect(ensureUserPath).toHaveBeenCalledOnce();
    expect(ensureUserPath).toHaveBeenCalledWith(win32.join(resourcesPath, "cli"));
    expect(result).toEqual({
      ok: true,
      binDirectory: win32.join(resourcesPath, "cli"),
      installed: [
        { name: "memmy-memory", source: memoryCli, target: memoryCli },
        { name: "memmy", source: memmyCli, target: memmyCli }
      ],
      pathUpdated: true,
      profilePaths: [WINDOWS_USER_PATH_LOCATION]
    });
  });

  it("supports a packaged CLI path on drive D with spaces and Chinese characters", async () => {
    const resourcesPath = "D:\\应用 安装\\记忆助手\\resources";
    const accessed: string[] = [];

    const result = await installPackagedWindowsCliTools(resourcesPath, {
      accessFile: async (path) => {
        accessed.push(path);
      },
      ensureUserPath: async () => false
    });

    expect(accessed).toEqual([
      "D:\\应用 安装\\记忆助手\\resources\\cli\\memmy-memory.cmd",
      "D:\\应用 安装\\记忆助手\\resources\\cli\\memmy.cmd"
    ]);
    expect(result.installed.map((entry) => entry.target)).toEqual(accessed);
    expect(result.pathUpdated).toBe(false);
  });

  it.each(["memmy-memory.cmd", "memmy.cmd"])(
    "returns a clear error when %s is missing",
    async (missingName) => {
      const resourcesPath = "C:\\Memmy\\resources";
      const missingPath = win32.join(resourcesPath, "cli", missingName);

      await expect(installPackagedWindowsCliTools(resourcesPath, {
        accessFile: async (path) => {
          if (path === missingPath) {
            const error = new Error("missing") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
        },
        ensureUserPath: async () => false
      })).rejects.toThrow(`Packaged Windows CLI launcher is missing or unreadable: ${missingPath}`);
    }
  );

  it("selects distinct NSIS and Store packaged strategies without changing other platforms", () => {
    expect(resolveCliInstallStrategy("win32", true, false)).toBe("packaged-windows");
    expect(resolveCliInstallStrategy("win32", false, false)).toBe("posix");
    expect(resolveCliInstallStrategy("win32", false, true)).toBe("posix");
    expect(resolveCliInstallStrategy("win32", true, true)).toBe("packaged-windows-store");
    expect(resolveCliInstallStrategy("darwin", true, false)).toBe("posix");
    expect(resolveCliInstallStrategy("linux", true, false)).toBe("posix");
  });

  it("registers Store launchers only from the stable package LocalState CLI directory", async () => {
    const storeUserDataPath = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy";
    const binDirectory = `${storeUserDataPath}\\cli`;
    const accessed: string[] = [];
    const ensureUserPath = vi.fn(async () => true);

    const result = await installPackagedWindowsStoreCliTools(storeUserDataPath, {
      accessFile: async (path) => {
        accessed.push(path);
      },
      ensureUserPath
    });

    expect(resolvePackagedWindowsStoreCliDirectory(storeUserDataPath)).toBe(binDirectory);
    expect(accessed).toEqual([
      `${binDirectory}\\memmy-memory.cmd`,
      `${binDirectory}\\memmy.cmd`
    ]);
    expect(ensureUserPath).toHaveBeenCalledWith(binDirectory);
    expect(result).toEqual({
      ok: true,
      binDirectory,
      installed: [
        { name: "memmy-memory", source: `${binDirectory}\\memmy-memory.cmd`, target: `${binDirectory}\\memmy-memory.cmd` },
        { name: "memmy", source: `${binDirectory}\\memmy.cmd`, target: `${binDirectory}\\memmy.cmd` }
      ],
      pathUpdated: true,
      profilePaths: [WINDOWS_USER_PATH_LOCATION]
    });
    expect(result.binDirectory.toLowerCase()).not.toContain("\\windowsapps\\");
  });

  it.each([
    "Memtensor.Memmy_eyack96k521x2",
    "Memtensor.MemmyAgent_eyack96k521x2"
  ])("keeps the %s Store CLI directory stable across package versions", (packageFamilyName) => {
    const storeUserDataPath = `C:\\Users\\lee\\AppData\\Local\\Packages\\${packageFamilyName}\\LocalState\\Memmy`;

    expect(resolvePackagedWindowsStoreCliDirectory(storeUserDataPath)).toBe(`${storeUserDataPath}\\cli`);
  });

  it("rejects versioned WindowsApps and non-LocalState Store CLI roots", () => {
    expect(() => resolvePackagedWindowsStoreCliDirectory(
      "C:\\Program Files\\WindowsApps\\Memtensor.Memmy_1.1.2.0_x64__eyack96k521x2\\resources"
    )).toThrow("WindowsApps");
    expect(() => resolvePackagedWindowsStoreCliDirectory(
      "C:\\Users\\lee\\AppData\\Roaming\\Memmy"
    )).toThrow("LocalState\\Memmy");
    expect(() => resolvePackagedWindowsStoreCliDirectory("LocalState\\Memmy")).toThrow("absolute");
  });
});

describe("Windows user PATH registration", () => {
  it("writes the CLI directory when the user PATH is empty", async () => {
    const fixture = createPathFixture("", "");

    await expect(ensureWindowsCliDirectoryOnPath("C:\\Memmy\\resources\\cli", fixture.access)).resolves.toBe(true);

    expect(fixture.userPath()).toBe("C:\\Memmy\\resources\\cli");
    expect(fixture.processPath()).toBe("C:\\Memmy\\resources\\cli");
    expect(fixture.writes).toEqual(["C:\\Memmy\\resources\\cli"]);
    expect(fixture.broadcastEnvironmentChange).toHaveBeenCalledOnce();
  });

  it("preserves every unrelated PATH segment and percent-variable expression", () => {
    expect(mergeWindowsUserPath(
      "%SystemRoot%\\System32;D:\\工具;C:\\Other Bin",
      "D:\\应用 安装\\记忆助手\\resources\\cli"
    )).toEqual({
      value: "%SystemRoot%\\System32;D:\\工具;C:\\Other Bin;D:\\应用 安装\\记忆助手\\resources\\cli",
      changed: true
    });
  });

  it("does not rewrite or duplicate an equivalent segment with different case and a trailing slash", async () => {
    const existing = "C:\\Tools;c:\\program files\\memmy\\resources\\cli\\;D:\\Bin";
    const fixture = createPathFixture(existing, existing);

    await expect(ensureWindowsCliDirectoryOnPath(
      "C:\\Program Files\\Memmy\\resources\\cli",
      fixture.access
    )).resolves.toBe(false);

    expect(fixture.userPath()).toBe(existing);
    expect(fixture.writes).toEqual([]);
    expect(fixture.broadcastEnvironmentChange).toHaveBeenCalledOnce();
  });

  it("collapses duplicate equivalent segments and remains idempotent on a repeated click", async () => {
    const fixture = createPathFixture(
      "C:\\Tools;D:\\Memmy\\resources\\cli;d:\\memmy\\resources\\cli\\;%LOCALAPPDATA%\\Programs",
      "C:\\Tools"
    );
    const cliDirectory = "D:\\Memmy\\resources\\cli";

    await expect(ensureWindowsCliDirectoryOnPath(cliDirectory, fixture.access)).resolves.toBe(true);
    await expect(ensureWindowsCliDirectoryOnPath(cliDirectory, fixture.access)).resolves.toBe(false);

    expect(fixture.userPath()).toBe("C:\\Tools;D:\\Memmy\\resources\\cli;%LOCALAPPDATA%\\Programs");
    expect(fixture.writes).toEqual([
      "C:\\Tools;D:\\Memmy\\resources\\cli;%LOCALAPPDATA%\\Programs"
    ]);
    expect(fixture.broadcastEnvironmentChange).toHaveBeenCalledTimes(2);
    expect(equivalentSegmentCount(fixture.userPath(), cliDirectory)).toBe(1);
    expect(equivalentSegmentCount(fixture.processPath(), cliDirectory)).toBe(1);
  });

  it("reports a broadcast failure clearly and retries the notification without rewriting PATH", async () => {
    const fixture = createPathFixture("C:\\Tools", "C:\\Tools");
    const cliDirectory = "D:\\Memmy\\resources\\cli";
    fixture.broadcastEnvironmentChange.mockRejectedValueOnce(new Error("timed out"));

    await expect(ensureWindowsCliDirectoryOnPath(cliDirectory, fixture.access)).rejects.toThrow(
      "Windows user PATH was updated, but the Environment change notification failed"
    );
    expect(fixture.writes).toEqual(["C:\\Tools;D:\\Memmy\\resources\\cli"]);

    await expect(ensureWindowsCliDirectoryOnPath(cliDirectory, fixture.access)).resolves.toBe(false);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.broadcastEnvironmentChange).toHaveBeenCalledTimes(2);
  });

  it("rejects registering the CN and Intl Store CLI directories at the same time", async () => {
    const cnCli = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy\\cli";
    const intlCli = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy\\cli";
    const fixture = createPathFixture(`C:\\Tools;${cnCli}`, `C:\\Tools;${cnCli}`);

    expect(findConflictingWindowsStoreCliPath(fixture.userPath(), intlCli)).toBe(cnCli);
    await expect(ensureWindowsCliDirectoryOnPath(intlCli, fixture.access)).rejects.toThrow(
      `Another Memmy Microsoft Store CLI is already registered in PATH: ${cnCli}`
    );
    expect(fixture.writes).toEqual([]);
    expect(fixture.broadcastEnvironmentChange).not.toHaveBeenCalled();
  });

  it("does not treat the same Store CLI directory or an NSIS CLI directory as a Store conflict", async () => {
    const storeCli = "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy\\cli";
    const existing = `C:\\Tools;${storeCli.toLocaleLowerCase("en-US")}\\`;
    const fixture = createPathFixture(existing, existing);

    expect(findConflictingWindowsStoreCliPath(existing, storeCli)).toBeNull();
    expect(findConflictingWindowsStoreCliPath(
      "C:\\Program Files\\Memmy\\resources\\cli",
      "D:\\Memmy\\resources\\cli"
    )).toBeNull();
    await expect(ensureWindowsCliDirectoryOnPath(storeCli, fixture.access)).resolves.toBe(false);
  });
});

function createPathFixture(initialUserPath: string, initialProcessPath: string): {
  access: WindowsUserPathAccess;
  broadcastEnvironmentChange: ReturnType<typeof vi.fn>;
  processPath: () => string;
  userPath: () => string;
  writes: string[];
} {
  let userPath = initialUserPath;
  let processPath = initialProcessPath;
  const writes: string[] = [];
  const broadcastEnvironmentChange = vi.fn(async () => undefined);
  return {
    access: {
      readUserPath: async () => userPath,
      writeUserPath: async (value) => {
        writes.push(value);
        userPath = value;
      },
      broadcastEnvironmentChange,
      readProcessPath: () => processPath,
      writeProcessPath: (value) => {
        processPath = value;
      }
    },
    broadcastEnvironmentChange,
    processPath: () => processPath,
    userPath: () => userPath,
    writes
  };
}

function equivalentSegmentCount(pathValue: string, expected: string): number {
  const normalizedExpected = normalizePathSegment(expected);
  return pathValue.split(";").filter((segment) => normalizePathSegment(segment) === normalizedExpected).length;
}

function normalizePathSegment(value: string): string {
  return value.trim().replace(/[\\/]+$/u, "").replaceAll("/", "\\").toLocaleLowerCase("en-US");
}
