import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMemmyDataRootEnvironment,
  assertMemmyDataRootWritable,
  resolveMemmyDataRoot
} from "../src/main/memmy-data-root.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Memmy data root", () => {
  it("keeps an explicit MEMMY_HOME override", () => {
    expect(resolveMemmyDataRoot({
      platform: "win32",
      homeDirectory: "C:\\Users\\lee",
      executablePath: "D:\\Apps\\Memmy\\Memmy.exe",
      isPackaged: true,
      env: { MEMMY_HOME: "E:\\MemmyCustom" },
      directoryExists: () => false
    })).toBe("E:\\MemmyCustom");
  });

  it("keeps macOS on ~/.memmy", () => {
    expect(resolveMemmyDataRoot({
      platform: "darwin",
      homeDirectory: "/Users/lee",
      executablePath: "/Applications/Memmy.app/Contents/MacOS/Memmy",
      isPackaged: true,
      env: {},
      directoryExists: () => false
    })).toBe("/Users/lee/.memmy");
  });

  it("prefers the existing Windows user directory", () => {
    expect(resolveMemmyDataRoot({
      platform: "win32",
      homeDirectory: "C:\\Users\\lee",
      executablePath: "D:\\Apps\\Memmy\\Memmy.exe",
      isPackaged: true,
      env: { SystemDrive: "C:" },
      directoryExists: (path) => path === "C:\\Users\\lee\\.memmy"
    })).toBe("C:\\Users\\lee\\.memmy");
  });

  it.each([true, false])(
    "uses the non-system installation drive (target exists: %s)",
    (targetExists) => {
      expect(resolveMemmyDataRoot({
        platform: "win32",
        homeDirectory: "C:\\Users\\lee",
        executablePath: "D:\\Apps\\Memmy\\Memmy.exe",
        isPackaged: true,
        env: { SystemDrive: "C:" },
        directoryExists: (path) => targetExists && path === "D:\\MemmyData\\.memmy"
      })).toBe("D:\\MemmyData\\.memmy");
    }
  );

  it("uses the user directory for a system-drive or development launch", () => {
    for (const input of [
      { executablePath: "C:\\Program Files\\Memmy\\Memmy.exe", isPackaged: true },
      { executablePath: "D:\\repo\\node.exe", isPackaged: false }
    ]) {
      expect(resolveMemmyDataRoot({
        platform: "win32",
        homeDirectory: "C:\\Users\\lee",
        ...input,
        env: { SystemDrive: "C:" },
        directoryExists: () => false
      })).toBe("C:\\Users\\lee\\.memmy");
    }
  });

  it("exports every root-derived compatibility path", () => {
    const env: Record<string, string | undefined> = {};
    applyMemmyDataRootEnvironment("D:\\MemmyData\\.memmy", env, "win32");

    expect(env).toEqual({
      MEMMY_HOME: "D:\\MemmyData\\.memmy",
      MEMMY_CONFIG: "D:\\MemmyData\\.memmy\\config.yaml",
      MEMMY_RUNTIME_CONFIG_PATH: "D:\\MemmyData\\.memmy\\runtime.json",
      MEMMY_AGENT_DATA_DIR: "D:\\MemmyData\\.memmy",
      MEMMY_AGENT_SESSION_DAG_DIR: "D:\\MemmyData\\.memmy\\session-dag"
    });
  });

  it("creates and verifies the selected root without leaving a probe file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "memmy-data-root-"));
    tempRoots.push(parent);
    const dataRoot = join(parent, "nested", ".memmy");

    await assertMemmyDataRootWritable(dataRoot);

    await expect(readdir(dataRoot)).resolves.toEqual([]);
  });

  it("reports the selected root when it is not writable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "memmy-data-root-"));
    tempRoots.push(parent);
    const blockingFile = join(parent, "blocked");
    const dataRoot = join(blockingFile, ".memmy");
    await mkdir(parent, { recursive: true });
    await writeFile(blockingFile, "not a directory", "utf8");

    await expect(assertMemmyDataRootWritable(dataRoot))
      .rejects.toThrow(`Memmy data directory is not writable: ${dataRoot}`);
  });
});
