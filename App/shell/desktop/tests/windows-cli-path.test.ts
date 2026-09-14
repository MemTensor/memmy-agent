import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_USER_PATH_LOCATION,
  ensureWindowsCliDirectoryOnPath,
  installPackagedWindowsCliTools,
  mergeWindowsUserPath,
  resolveCliInstallStrategy,
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

  it("selects the Windows packaged strategy without changing macOS or development mode", () => {
    expect(resolveCliInstallStrategy("win32", true, false)).toBe("packaged-windows");
    expect(resolveCliInstallStrategy("win32", false, false)).toBe("posix");
    expect(resolveCliInstallStrategy("win32", true, true)).toBe("posix");
    expect(resolveCliInstallStrategy("darwin", true, false)).toBe("posix");
    expect(resolveCliInstallStrategy("linux", true, false)).toBe("posix");
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
