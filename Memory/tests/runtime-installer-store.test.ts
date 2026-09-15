import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyBundledMemoryRuntime } from "../src/cli/bundled-runtime-copy.js";
import { currentInstalledRuntime, installMemoryRuntime, runtimeTarget } from "../src/cli/runtime-installer.js";

const faults = vi.hoisted(() => ({
  encryptedCopy: false,
  corruptFile: "",
  beforeRead: undefined as ((path: string) => Promise<void> | undefined) | undefined,
  afterRead: undefined as ((path: string) => void) | undefined,
  beforeReadDirectory: undefined as ((path: string) => Promise<void> | undefined) | undefined
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    cp: vi.fn(async (...args: Parameters<typeof original.cp>) => {
      if (faults.encryptedCopy) throw Object.assign(new Error("UNKNOWN: encrypted copyfile"), { code: "UNKNOWN", errno: -4094 });
      return original.cp(...args);
    }),
    readdir: vi.fn(async (...args: Parameters<typeof original.readdir>) => {
      await faults.beforeReadDirectory?.(String(args[0]));
      return original.readdir(...args);
    })
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    createReadStream: vi.fn((...args: Parameters<typeof original.createReadStream>) => {
      const path = String(args[0]);
      const wait = faults.beforeRead?.(path);
      const source = original.createReadStream(...args);
      let stream: NodeJS.ReadableStream = source;
      if (wait) {
        const delayed = new Transform({
          transform(chunk, _encoding, callback) {
            wait.then(() => callback(null, chunk), callback);
          }
        });
        source.once("error", (error) => delayed.destroy(error));
        delayed.once("close", () => source.destroy());
        stream = source.pipe(delayed);
      }
      stream.once("end", () => faults.afterRead?.(path));
      return stream;
    }),
    createWriteStream: vi.fn((...args: Parameters<typeof original.createWriteStream>) => {
      const stream = original.createWriteStream(...args);
      if (faults.corruptFile && basename(String(args[0])) === faults.corruptFile) {
        stream.once("close", () => original.appendFileSync(args[0], "corrupted fixture"));
      }
      return stream;
    })
  };
});
// These copy/rollback fixtures simulate Windows on every test host. Exercise the
// actual Windows handle protocol separately, without loading a Windows .node here.
vi.mock("../src/cli/windows-store-install-lock.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/cli/windows-store-install-lock.js")>();
  return {
    ...original,
    acquireWindowsStoreInstallLock: async (path: string) => {
      const { open, unlink } = await import("node:fs/promises");
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`);
      return { release: async () => { await handle.close(); await unlink(path); } };
    }
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
  faults.beforeRead = undefined;
  faults.afterRead = undefined;
  faults.beforeReadDirectory = undefined;
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
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("Store bundled Memory runtime installation", () => {
  it("limits the whole tree to eight files, including staged byte verification", async () => {
    const source = join(root, "WindowsApps", "parallel-copy");
    const destination = join(root, "staged-copy");
    const files = new Map<string, Buffer>();
    for (let directory = 0; directory < 4; directory++) {
      for (let file = 0; file < 3; file++) {
        const path = join(`directory-${directory}`, `file-${file}.bin`);
        const bytes = Buffer.from([directory, file, 0, 128, 255]);
        mkdirSync(join(source, `directory-${directory}`), { recursive: true });
        writeFileSync(join(source, path), bytes);
        files.set(path, bytes);
      }
    }
    const verification = gate();
    const activeFiles = new Set<string>();
    const verifying: string[] = [];
    let maximumActive = 0;
    faults.beforeRead = (path) => {
      if (path.startsWith(source + sep)) {
        activeFiles.add(relative(source, path));
        maximumActive = Math.max(maximumActive, activeFiles.size);
      } else if (path.startsWith(destination + sep)) {
        verifying.push(relative(destination, path));
        return verification.promise;
      }
    };
    faults.afterRead = (path) => {
      if (path.startsWith(destination + sep)) activeFiles.delete(relative(destination, path));
    };
    const copying = copyBundledMemoryRuntime(source, destination);
    try {
      await vi.waitFor(() => expect(verifying).toHaveLength(8));
      expect(activeFiles.size).toBe(8);
      expect(new Set(verifying.map((path) => path.split(sep)[0])).size).toBeGreaterThan(1);
    } finally {
      verification.release();
      await copying;
    }
    expect(maximumActive).toBe(8);
    expect(activeFiles.size).toBe(0);
    expect(verifying).toHaveLength(files.size);
    for (const [path, bytes] of files) expect(readFileSync(join(destination, path))).toEqual(bytes);
  });

  it("waits for started writes when directory traversal fails", async () => {
    const source = join(root, "WindowsApps", "traversal-failure");
    const destination = join(root, "staged-copy");
    mkdirSync(join(source, "z-unreadable"), { recursive: true });
    writeFileSync(join(source, "a-slow.bin"), "pending runtime bytes");
    const pendingRead = gate();
    let traversalFailed = false;
    let completed = false;
    faults.beforeRead = (path) => path === join(source, "a-slow.bin") ? pendingRead.promise : undefined;
    faults.beforeReadDirectory = async (path) => {
      if (path === join(source, "z-unreadable")) {
        traversalFailed = true;
        throw new Error("fixture directory traversal failed");
      }
    };
    const copying = copyBundledMemoryRuntime(source, destination).then(
      () => { completed = true; return undefined; },
      (error: unknown) => { completed = true; return error; }
    );
    try {
      await vi.waitFor(() => expect(traversalFailed).toBe(true));
      expect(completed).toBe(false);
    } finally {
      pendingRead.release();
    }
    expect(await copying).toMatchObject({ message: "fixture directory traversal failed" });
    expect(readFileSync(join(destination, "a-slow.bin"), "utf8")).toBe("pending runtime bytes");
  });

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

  it("keeps staging and its lock until started writes drain after another file fails verification", async () => {
    await install(fixture(false, "2.1.1"));
    const before = (await currentInstalledRuntime(home))!;
    const serviceHome = join(home, "memory-service");
    const pointerPath = join(serviceHome, "current.json");
    const installationPath = join(serviceHome, "installation.json");
    const launcherPath = join(home, "bin", "memmy-memory-service.cjs");
    const databasePath = join(serviceHome, "memory.sqlite");
    writeFileSync(databasePath, "existing user database fixture");
    const snapshots = [pointerPath, installationPath, launcherPath, before.entrypoint, databasePath]
      .map((path) => [path, readFileSync(path)] as const);
    const source = fixture(true);
    const slowSource = join(source, "slow.bin");
    writeFileSync(slowSource, "in-flight runtime bytes");
    const pendingRead = gate();
    let slowStarted = false;
    let corruptVerificationFinished = false;
    let completed = false;
    faults.corruptFile = "native.node";
    faults.beforeRead = (path) => {
      if (path === slowSource) {
        slowStarted = true;
        return pendingRead.promise;
      }
    };
    faults.afterRead = (path) => {
      if (path.startsWith(serviceHome + sep) && basename(path) === "native.node") {
        corruptVerificationFinished = true;
      }
    };
    const installing = install(source).then(
      () => { completed = true; return undefined; },
      (error: unknown) => { completed = true; return error; }
    );
    try {
      await vi.waitFor(() => {
        expect(slowStarted).toBe(true);
        expect(corruptVerificationFinished).toBe(true);
      });
      // Let verification's async iterator reject before checking that cleanup
      // has remained blocked by the other file's still-open stream.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(existsSync(join(serviceHome, "install.lock"))).toBe(true);
      const staging = readdirSync(join(serviceHome, "runtime")).filter((name) => name.startsWith(".staging-"));
      expect(staging).toHaveLength(1);
      expect(existsSync(join(serviceHome, "runtime", staging[0]!, "unpacked", "slow.bin"))).toBe(true);
      for (const [path, bytes] of snapshots) expect(readFileSync(path)).toEqual(bytes);
    } finally {
      pendingRead.release();
      await installing;
    }
    expect(await installing).toMatchObject({ message: expect.stringContaining("Store runtime copy verification failed") });
    for (const [path, bytes] of snapshots) expect(readFileSync(path)).toEqual(bytes);
    expectNoStaging();
  });
});
