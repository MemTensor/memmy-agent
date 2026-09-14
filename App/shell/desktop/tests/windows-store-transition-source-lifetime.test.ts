import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWindowsStoreTransitionSourceLease,
  establishWindowsStoreTransitionSourceLifetime,
  resolveWindowsStoreTransitionCleanupActivePipeName,
  resolveWindowsStoreTransitionSourceLeasePipeName,
  tryAcquireWindowsStoreTransitionSourceLease,
  type WindowsStoreTransitionSourceLease
} from "../src/main/windows-store-transition-source-lifetime.js";

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) {
      child.stdin.end("exit\n");
      await once(child, "exit");
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("Windows Store transition source lifetime lease", () => {
  it("repairs the native broker before holding the NSIS lifetime and releases it only at will-quit", async () => {
    const mainSource = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const barrierIndex = mainSource.indexOf("if (await applyWindowsStoreTransitionSourceBarrier())");
    const brokerIndex = mainSource.indexOf("await ensureCurrentWindowsStoreLegacyCleanupBroker();");
    const storePreparationIndex = mainSource.indexOf("runCurrentWindowsStoreTransitionPreReady();", mainSource.indexOf("app.requestSingleInstanceLock()"));

    expect(barrierIndex).toBeGreaterThan(-1);
    expect(brokerIndex).toBeGreaterThan(-1);
    expect(brokerIndex).toBeLessThan(barrierIndex);
    expect(storePreparationIndex).toBeLessThan(barrierIndex);
    expect(mainSource).toContain("windowsStoreTransitionSourceLease = result.lease;");
    expect(mainSource).toContain("resourcesPath: process.resourcesPath");
    expect(mainSource).toContain("boot:store-transition-source-orphan-recovered");
    expect(mainSource).toMatch(/app\.on\("will-quit", \(\) => \{[\s\S]*sourceLease\?\.release\(\)/u);
  });

  it("uses one stable per-user named pipe and rejects a second holder until release", async () => {
    const statePath = await createStatePath();
    const pipeName = resolveWindowsStoreTransitionSourceLeasePipeName(statePath);
    expect(resolveWindowsStoreTransitionSourceLeasePipeName(statePath.toUpperCase()))
      .toBe(resolveWindowsStoreTransitionSourceLeasePipeName(statePath.toLowerCase()));
    expect(pipeName).toMatch(/^\\\\\.\\pipe\\LOCAL\\memmy-store-transition-source-[0-9a-f]{64}$/u);

    const first = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(first).not.toBeNull();
    try {
      await expect(tryAcquireWindowsStoreTransitionSourceLease(statePath)).resolves.toBeNull();
    } finally {
      await first?.release();
    }

    const afterRelease = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(afterRelease).not.toBeNull();
    await afterRelease?.release();
  });

  it("uses the native helper's locale-independent digest for Unicode profile paths", () => {
    expect(resolveWindowsStoreTransitionSourceLeasePipeName(
      "C:\\Users\\ÄLEE\\AppData\\Local\\Memmy\\store-transition\\active.json"
    )).toBe(
      "\\\\.\\pipe\\LOCAL\\memmy-store-transition-source-" +
      "c39d2fad67926a639d12332da49710b64407f8f406a840652485c39905095b46"
    );
  });

  it("is automatically released by Windows when the holder process exits", async () => {
    const statePath = await createStatePath();
    const child = spawnLeaseHolder(statePath);
    childProcesses.push(child);
    await waitForChildReady(child);

    await expect(tryAcquireWindowsStoreTransitionSourceLease(statePath)).resolves.toBeNull();
    child.stdin.end("exit\n");
    await once(child, "exit");
    childProcesses.splice(childProcesses.indexOf(child), 1);

    const lease = await acquireWindowsStoreTransitionSourceLease({
      statePath,
      timeoutMs: 2_000,
      retryIntervalMs: 20
    });
    await lease.release();
  });

  it("refuses a source lease while the native broker owns the destructive-cleanup marker", async () => {
    const statePath = await createStatePath();
    const activePipe = resolveWindowsStoreTransitionCleanupActivePipeName(statePath);
    expect(activePipe).toBe(`${resolveWindowsStoreTransitionSourceLeasePipeName(statePath)}-cleanup-active`);
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(activePipe, resolve);
    });
    try {
      await expect(tryAcquireWindowsStoreTransitionSourceLease(statePath)).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    const lease = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it("keeps the cleanup guard for the full NSIS source lifetime", async () => {
    const statePath = await createStatePath();
    const result = await establishWindowsStoreTransitionSourceLifetime({
      ...createBarrierOptions(),
      statePath
    }, {
      resolveBarrier: async () => ({ action: "allow-source" })
    });
    expect(result.action).toBe("hold-source");
    if (result.action !== "hold-source") return;

    const cleanupActivePipe = resolveWindowsStoreTransitionCleanupActivePipeName(statePath);
    await expect(tryListen(cleanupActivePipe)).resolves.toBe("EADDRINUSE");
    await result.lease.release();
    await expect(tryListen(cleanupActivePipe)).resolves.toBe("listening");
  });

  it("acquires before reading the barrier and holds only an allowed source", async () => {
    const actions: string[] = [];
    let released = false;
    const lease: WindowsStoreTransitionSourceLease = {
      pipeName: "\\\\.\\pipe\\test-source-lifetime",
      release: async () => {
        released = true;
      }
    };
    const result = await establishWindowsStoreTransitionSourceLifetime(createBarrierOptions(), {
      tryAcquireLease: async () => {
        actions.push("acquire");
        return lease;
      },
      resolveBarrier: async () => {
        actions.push("barrier");
        return { action: "allow-source" };
      }
    });

    expect(actions).toEqual(["acquire", "barrier"]);
    expect(result).toEqual({ action: "hold-source", lease, barrierAction: "allow-source" });
    expect(released).toBe(false);
    await lease.release();
  });

  it("fails closed when the lease is unavailable even without an explicit journal block", async () => {
    let barrierCalls = 0;
    const result = await establishWindowsStoreTransitionSourceLifetime(createBarrierOptions(), {
      tryAcquireLease: async () => null,
      resolveBarrier: async () => {
        barrierCalls += 1;
        return { action: "no-transition" };
      }
    });

    expect(result).toEqual({
      action: "block-source",
      reason: "lease-unavailable"
    });
    expect(barrierCalls).toBe(0);
  });

  it("keeps the lease after orphan recovery and preserves recovery diagnostics", async () => {
    let released = false;
    const lease: WindowsStoreTransitionSourceLease = {
      pipeName: "\\\\.\\pipe\\test-source-lifetime",
      release: async () => {
        released = true;
      }
    };
    const result = await establishWindowsStoreTransitionSourceLifetime(createBarrierOptions(), {
      tryAcquireLease: async () => lease,
      resolveBarrier: async () => ({
        action: "orphan-recovered",
        phase: "app-verified",
        archivedStatePath: "C:\\archive\\active.json"
      })
    });

    expect(result).toEqual({
      action: "hold-source",
      lease,
      barrierAction: "orphan-recovered",
      recoveredPhase: "app-verified",
      archivedStatePath: "C:\\archive\\active.json"
    });
    expect(released).toBe(false);
    await lease.release();
  });

  it("releases an acquired lease before returning an explicit journal block", async () => {
    const actions: string[] = [];
    const result = await establishWindowsStoreTransitionSourceLifetime(createBarrierOptions(), {
      tryAcquireLease: async () => ({
        pipeName: "\\\\.\\pipe\\test-source-lifetime",
        release: async () => {
          actions.push("release");
        }
      }),
      resolveBarrier: async () => {
        actions.push("barrier");
        return { action: "block-source", phase: "package-registered" };
      }
    });

    expect(actions).toEqual(["barrier", "release"]);
    expect(result).toEqual({
      action: "block-source",
      reason: "journal",
      phase: "package-registered"
    });
  });

  it("releases an acquired lease when package query or orphan recovery fails", async () => {
    const actions: string[] = [];
    const failure = new Error("package query failed");
    await expect(establishWindowsStoreTransitionSourceLifetime(createBarrierOptions(), {
      tryAcquireLease: async () => ({
        pipeName: "\\\\.\\pipe\\test-source-lifetime",
        release: async () => {
          actions.push("release");
        }
      }),
      resolveBarrier: async () => {
        throw failure;
      }
    })).rejects.toBe(failure);
    expect(actions).toEqual(["release"]);
  });
});

const createStatePath = async (): Promise<string> => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-source-lifetime-"));
  temporaryDirectories.push(root);
  return win32.join(root, "LocalAppData", "Memmy", "store-transition", "active.json");
};

const tryListen = async (pipeName: string): Promise<"listening" | string> => {
  const server = createServer((socket) => socket.destroy());
  const result = await new Promise<"listening" | string>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
    server.once("listening", () => resolve("listening"));
    server.listen(pipeName);
  });
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
  return result;
};

const createBarrierOptions = () => ({
  platform: "win32" as const,
  isPackaged: true,
  isWindowsStore: false,
  executablePath: "D:\\Memmy\\Memmy.exe",
  statePath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-transition\\active.json"
});

const spawnLeaseHolder = (statePath: string): ChildProcessWithoutNullStreams => {
  const moduleUrl = new URL(
    "../src/main/windows-store-transition-source-lifetime.ts",
    import.meta.url
  ).href;
  const script = `
    import { tryAcquireWindowsStoreTransitionSourceLease } from ${JSON.stringify(moduleUrl)};
    const lease = await tryAcquireWindowsStoreTransitionSourceLease(process.env.MEMMY_TEST_STATE_PATH);
    if (!lease) throw new Error("child could not acquire source lifetime lease");
    process.stdout.write("ready\\n");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(0));
  `;
  return spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: win32.resolve("."),
    env: { ...process.env, MEMMY_TEST_STATE_PATH: statePath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
};

const waitForChildReady = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`lease holder did not become ready: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes("ready\n")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`lease holder exited before ready (${String(code)}): ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
};
