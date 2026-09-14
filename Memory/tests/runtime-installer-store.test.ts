import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentInstalledRuntime, installMemoryRuntime, runtimeTarget } from "../src/cli/runtime-installer.js";

const faults = vi.hoisted(() => ({ encryptedCopy: false, corruptFile: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    cp: vi.fn(async (...args: Parameters<typeof original.cp>) => {
      if (faults.encryptedCopy) throw Object.assign(new Error("UNKNOWN: encrypted copyfile"), { code: "UNKNOWN", errno: -4094 });
      return original.cp(...args);
    })
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    createWriteStream: vi.fn((...args: Parameters<typeof original.createWriteStream>) => {
      const stream = original.createWriteStream(...args);
      if (faults.corruptFile && basename(String(args[0])) === faults.corruptFile) {
        stream.once("close", () => original.appendFileSync(args[0], "corrupted fixture"));
      }
      return stream;
    })
  };
});

let root: string;
let home: string;
const realProcess = process;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memmy-store-runtime-copy-"));
  home = join(root, "用户 home");
  faults.encryptedCopy = false;
  faults.corruptFile = "";
  vi.clearAllMocks();
  vi.stubGlobal("process", { ...realProcess, platform: "win32" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const fixture = (store: boolean, version = "2.1.2") => {
  const runtime = join(root, store ? "WindowsApps" : "Programs", `Memmy-${version}`, "resources", "memory-runtime");
  mkdirSync(join(runtime, "dist", "src", "server"), { recursive: true });
  mkdirSync(join(runtime, "empty-directory"), { recursive: true });
  writeFileSync(join(runtime, "dist", "src", "server", "index.js"), "// runtime fixture\n");
  writeFileSync(join(runtime, "native.node"), Buffer.from([0, 1, 128, 255]));
  writeFileSync(join(runtime, "memory-runtime.json"), JSON.stringify({
    version, protocolVersion: 1, target: runtimeTarget(process.platform, process.arch)
  }));
  return runtime;
};
const install = (runtimeDirectory: string) => installMemoryRuntime({
  home, runtimeDirectory, skipServiceRegistration: true, skipHealthCheck: true
});
const expectNoStaging = () => {
  expect(readdirSync(join(home, "memory-service", "runtime")).filter((name) => name.startsWith("."))).toEqual([]);
  expect(existsSync(join(home, "memory-service", "install.lock"))).toBe(false);
};

describe("Store bundled Memory runtime installation", () => {
  it("activates WindowsApps files without calling the encrypted metadata copy API", async () => {
    const runtime = fixture(true);
    faults.encryptedCopy = true;
    await expect(install(runtime)).resolves.toMatchObject({ ok: true, version: "2.1.2" });
    expect(cp).not.toHaveBeenCalled();
    const pointer = (await currentInstalledRuntime(home))!;
    expect(readFileSync(pointer.entrypoint, "utf8")).toBe("// runtime fixture\n");
    expect(readFileSync(join(pointer.runtimeDir, "native.node"))).toEqual(Buffer.from([0, 1, 128, 255]));
    expect(readdirSync(join(pointer.runtimeDir, "empty-directory"))).toEqual([]);
    expectNoStaging();
  });

  it("keeps ordinary NSIS directory copies on the existing path", async () => {
    const runtime = fixture(false);
    await expect(install(runtime)).resolves.toMatchObject({ ok: true });
    expect(cp).toHaveBeenCalledWith(runtime, expect.any(String), { recursive: true });
  });

  it("does not hide ordinary-directory copy failures behind a Store fallback", async () => {
    const runtime = fixture(false);
    faults.encryptedCopy = true;
    await expect(install(runtime)).rejects.toThrow("UNKNOWN: encrypted copyfile");
    expect(await currentInstalledRuntime(home)).toBeUndefined();
    expectNoStaging();
  });

  it.each(["darwin", "linux"] as const)("keeps %s copying unchanged even for a directory named WindowsApps", async (platform) => {
    vi.stubGlobal("process", { ...realProcess, platform });
    const runtime = fixture(true);
    await expect(install(runtime)).resolves.toMatchObject({ ok: true });
    expect(cp).toHaveBeenCalledOnce();
  });

  it("rejects corrupted staged bytes before first activation and allows retry", async () => {
    const runtime = fixture(true);
    faults.corruptFile = "native.node";
    await expect(install(runtime)).rejects.toThrow("Store runtime copy verification failed");
    expect(await currentInstalledRuntime(home)).toBeUndefined();
    expectNoStaging();
    faults.corruptFile = "";
    await expect(install(runtime)).resolves.toMatchObject({ ok: true });
    expectNoStaging();
  });

  it("keeps the previous runtime, launchers and database when the Store copy fails verification", async () => {
    await install(fixture(false, "2.1.1"));
    const before = await currentInstalledRuntime(home);
    const pointerPath = join(home, "memory-service", "current.json");
    const launcherPath = join(home, "bin", "memmy-memory-service.cjs");
    const databasePath = join(home, "memory-service", "memory.sqlite");
    writeFileSync(databasePath, "existing user database fixture");
    const previousPointer = readFileSync(pointerPath);
    const previousLauncher = readFileSync(launcherPath);
    faults.corruptFile = "native.node";
    await expect(install(fixture(true))).rejects.toThrow("Store runtime copy verification failed");
    expect(readFileSync(pointerPath)).toEqual(previousPointer);
    expect(readFileSync(launcherPath)).toEqual(previousLauncher);
    expect(readFileSync(databasePath, "utf8")).toBe("existing user database fixture");
    expect(existsSync(before!.entrypoint)).toBe(true);
    expectNoStaging();
  });
});
