import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  currentInstalledRuntime,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  installMemoryRuntime,
  runtimeTarget,
  stopInstalledMemoryService,
  userServiceRestartCommand
} from "../src/cli/runtime-installer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Memory runtime installer", () => {
  it("maps all supported release targets", () => {
    expect(runtimeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(runtimeTarget("darwin", "x64")).toBe("darwin-x64");
    expect(runtimeTarget("linux", "arm64")).toBe("linux-arm64");
    expect(runtimeTarget("linux", "x64")).toBe("linux-x64");
    expect(runtimeTarget("win32", "arm64")).toBe("windows-arm64");
    expect(runtimeTarget("win32", "x64")).toBe("windows-x64");
    expect(() => runtimeTarget("freebsd", "x64")).toThrow("unsupported platform");
  });

  it("maps service restarts to each user service manager", () => {
    expect(userServiceRestartCommand("darwin", 501)).toEqual({
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/com.memtensor.memmy-memory"]
    });
    expect(userServiceRestartCommand("linux")).toEqual({
      command: "systemctl",
      args: ["--user", "restart", "memmy-memory.service"]
    });
    expect(userServiceRestartCommand("win32")).toMatchObject({
      command: "powershell.exe"
    });
  });

  it("compares stable and prerelease versions", () => {
    expect(compareVersions("2.1.0", "2.0.9")).toBe(1);
    expect(compareVersions("2.1.0", "2.1.0")).toBe(0);
    expect(compareVersions("2.1.0-beta.1", "2.1.0")).toBe(-1);
  });

  it("plans a service-only install without downloading or mutating disk", async () => {
    const home = tempRoot();
    const result = await installMemoryRuntime({ home, dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, home });
    expect(await currentInstalledRuntime(home)).toBeUndefined();
  });

  it("installs and atomically activates a verified local runtime", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const fixture = createRuntimeArchive(root, "2.1.0");
    const result = await installMemoryRuntime({
      home,
      version: "2.1.0",
      runtimeAsset: fixture.archive,
      runtimeSha256: fixture.sha256,
      skipServiceRegistration: true,
      skipHealthCheck: true,
      agents: ["openclaw", "hermes"]
    });
    expect(result).toMatchObject({ ok: true, version: "2.1.0", target: fixture.target });
    const pointer = await currentInstalledRuntime(home);
    expect(pointer?.version).toBe("2.1.0");
    expect(readFileSync(pointer!.entrypoint, "utf8")).toContain("runtime fixture");
    const launcher = readFileSync(join(home, "bin", "memmy-memory-service.cjs"), "utf8");
    expect(launcher).toContain(`MEMMY_HOME: ${JSON.stringify(home)}`);
    expect(launcher).toContain(`MEMMY_CONFIG: ${JSON.stringify(join(home, "config.yaml"))}`);
    expect(launcher).toContain("MEMMY_EMBEDDING_MODEL_ROOT");
    expect(JSON.parse(readFileSync(join(home, "memory-service", "installation.json"), "utf8"))).toMatchObject({
      agents: ["openclaw", "hermes"]
    });
  });

  it("activates the unpacked offline runtime bundled with Desktop", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    const result = await installMemoryRuntime({
      home,
      runtimeDirectory,
      skipServiceRegistration: true,
      skipHealthCheck: true
    });
    expect(result).toMatchObject({ ok: true, version: "2.1.0" });
    const pointer = await currentInstalledRuntime(home);
    expect(pointer?.runtimeDir).not.toBe(runtimeDirectory);
    expect(readFileSync(pointer!.entrypoint, "utf8")).toContain("runtime fixture");
  });

  it("keeps the original runtime executable when another installer reuses the same version", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    await installMemoryRuntime({
      home,
      runtimeDirectory,
      nodeExecutable: "/original/node",
      skipServiceRegistration: true,
      skipHealthCheck: true
    });

    const reused = await installMemoryRuntime({
      home,
      runtimeDirectory,
      nodeExecutable: "/desktop/electron",
      preferInstalledCompatible: true,
      skipServiceRegistration: true,
      skipHealthCheck: true
    });

    expect(reused).toMatchObject({ reused: true, runtimeExecutable: "/original/node" });
    const launcher = readFileSync(join(home, "bin", process.platform === "win32" ? "memmy-memory-service.cmd" : "memmy-memory-service"), "utf8");
    expect(launcher).toContain("/original/node");
    expect(launcher).not.toContain("/desktop/electron");
  });

  it("rejects checksum failures without activating the staged runtime", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const fixture = createRuntimeArchive(root, "2.1.0");
    await expect(installMemoryRuntime({
      home,
      runtimeAsset: fixture.archive,
      runtimeSha256: "f".repeat(64),
      skipServiceRegistration: true,
      skipHealthCheck: true
    })).rejects.toThrow("checksum mismatch");
    expect(await currentInstalledRuntime(home)).toBeUndefined();
  });

  it("waits for a migration-delayed health response instead of failing at 15 seconds", async () => {
    expect(DEFAULT_HEALTH_CHECK_TIMEOUT_MS).toBe(120_000);
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    vi.useFakeTimers();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const startedAt = Date.now();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      resolveStarted();
      const ready = Date.now() - startedAt >= 16_000;
      return {
        ok: true,
        json: async () => ready
          ? { ok: true, protocolVersion: 1, serviceVersion: "2.1.0" }
          : { ok: true, protocolVersion: 1, serviceVersion: "old" },
      } as Response;
    });

    try {
      const install = installMemoryRuntime({
        home,
        runtimeDirectory,
        endpoint: "http://127.0.0.1:18960",
        skipServiceRegistration: true,
      });
      await started;
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(install).resolves.toMatchObject({ ok: true, version: "2.1.0" });
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("caps retry backoff at the activation health deadline", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    vi.useFakeTimers();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      resolveStarted();
      return {
        ok: true,
        json: async () => ({ ok: true, protocolVersion: 1, serviceVersion: "old" })
      } as Response;
    });

    try {
      const install = installMemoryRuntime({
        home,
        runtimeDirectory,
        endpoint: "http://127.0.0.1:18960",
        skipServiceRegistration: true,
        healthCheckTimeoutMs: 1
      });
      await started;
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(install).rejects.toThrow("activation health check");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("restores the previous runtime when the bounded activation health timeout expires", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const previousDirectory = createRuntimeDirectory(root, "2.0.0");
    await installMemoryRuntime({
      home,
      runtimeDirectory: previousDirectory,
      skipServiceRegistration: true,
      skipHealthCheck: true
    });
    const nextDirectory = createRuntimeDirectory(root, "2.1.0");
    vi.useFakeTimers();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      resolveStarted();
      return {
        ok: true,
        json: async () => ({ ok: true, protocolVersion: 1, serviceVersion: "old" })
      } as Response;
    });

    try {
      const install = installMemoryRuntime({
        home,
        runtimeDirectory: nextDirectory,
        endpoint: "http://127.0.0.1:18960",
        skipServiceRegistration: true,
        healthCheckTimeoutMs: 1_000
      });
      await started;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(install).rejects.toThrow("activation health check");
      expect((await currentInstalledRuntime(home))?.version).toBe("2.0.0");
      expect(JSON.parse(readFileSync(join(home, "memory-service", "installation.json"), "utf8"))).toMatchObject({
        serviceVersion: "2.0.0"
      });
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("cleans first-install launchers and metadata when activation health times out", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const runtimeDirectory = createRuntimeDirectory(root, "2.1.0");
    const launcherName = process.platform === "win32"
      ? "memmy-memory-service.cmd"
      : "memmy-memory-service";
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", launcherName), "stale launcher");
    writeFileSync(join(home, "bin", "memmy-memory-service.cjs"), "stale script");
    mkdirSync(join(home, "memory-service"), { recursive: true });
    writeFileSync(join(home, "memory-service", "installation.json"), JSON.stringify({
      serviceVersion: "stale"
    }));
    writeFileSync(join(home, "memory-service", "runtime.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:18960"
    }));
    vi.useFakeTimers();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      resolveStarted();
      return {
        ok: true,
        json: async () => ({ ok: true, protocolVersion: 1, serviceVersion: "old" })
      } as Response;
    });

    try {
      const install = installMemoryRuntime({
        home,
        runtimeDirectory,
        endpoint: "http://127.0.0.1:18960",
        skipServiceRegistration: true,
        healthCheckTimeoutMs: 1_000
      });
      await started;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(install).rejects.toThrow("activation health check");
      expect(await currentInstalledRuntime(home)).toBeUndefined();
      expect(existsSync(join(home, "bin", launcherName))).toBe(false);
      expect(existsSync(join(home, "bin", "memmy-memory-service.cjs"))).toBe(false);
      expect(existsSync(join(home, "memory-service", "installation.json"))).toBe(false);
      expect(existsSync(join(home, "memory-service", "runtime.json"))).toBe(false);
      expect(existsSync(join(home, "memory-service", "runtime", "2.1.0", runtimeTarget(process.platform, process.arch)))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid activation health timeout (%s)",
    async (healthCheckTimeoutMs) => {
      await expect(installMemoryRuntime({
        home: tempRoot(),
        dryRun: true,
        healthCheckTimeoutMs
      })).rejects.toThrow("healthCheckTimeoutMs must be a positive integer");
    }
  );

  it("never replaces a newer installed version with an older one", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, "memory-service"), { recursive: true });
    writeFileSync(join(home, "memory-service", "current.json"), JSON.stringify({
      version: "3.0.0",
      protocolVersion: 1,
      target: runtimeTarget(process.platform, process.arch),
      runtimeDir: join(home, "runtime-3"),
      entrypoint: join(home, "runtime-3", "index.js"),
      activatedAt: new Date().toISOString()
    }));
    await expect(installMemoryRuntime({ home, version: "2.1.0", dryRun: true }))
      .rejects.toThrow("refusing to downgrade");
  });

  it("stops a running Memory process even when no user service is registered", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const configPath = join(home, "config.yaml");
    mkdirSync(join(home, "memory-service"), { recursive: true });
    writeFileSync(configPath, [
      "memmyMemory:",
      "  storage:",
      "    mode: local",
      "    backend: sqlite",
      `    sqlitePath: ${JSON.stringify(join(home, "memory-service", "memory.sqlite"))}`,
      "    token: service-token",
      ""
    ].join("\n"));

    let shutdownRequests = 0;
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer service-token");
      if (request.method === "GET" && request.url === "/api/v1/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/admin/shutdown") {
        shutdownRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        response.once("finish", () => server.close());
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    writeFileSync(join(home, "memory-service", "runtime.json"), JSON.stringify({
      pid: 12345,
      endpoint: `http://127.0.0.1:${address.port}`,
      configPath
    }));
    let managerStops = 0;

    await expect(stopInstalledMemoryService(home, {
      stopUserService: () => { managerStops += 1; }
    })).resolves.toMatchObject({ ok: true, action: "stop", pid: 12345 });

    expect(managerStops).toBe(1);
    expect(shutdownRequests).toBe(1);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-runtime-installer-"));
  roots.push(root);
  return root;
}

function createRuntimeArchive(root: string, version: string): { archive: string; sha256: string; target: string } {
  const target = runtimeTarget(process.platform, process.arch);
  const stage = createRuntimeDirectory(root, version);
  const archive = join(root, `memmy-memory-runtime-${version}-${target}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "failed to create runtime fixture");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return { archive, sha256, target };
}

function createRuntimeDirectory(root: string, version: string): string {
  const target = runtimeTarget(process.platform, process.arch);
  const stage = join(root, `runtime-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(stage, "dist", "src", "server"), { recursive: true });
  writeFileSync(join(stage, "dist", "src", "server", "index.js"), "// runtime fixture\n");
  writeFileSync(join(stage, "memory-runtime.json"), `${JSON.stringify({ version, protocolVersion: 1, target })}\n`);
  return stage;
}
