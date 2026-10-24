import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  load,
  resolveEnv,
  prepare,
  heavyMain,
  heavyImports,
  migrate,
} = vi.hoisted(() => ({
  load: vi.fn(),
  resolveEnv: vi.fn(),
  prepare: vi.fn(),
  heavyMain: vi.fn(),
  heavyImports: vi.fn(),
  migrate: vi.fn(),
}));
vi.mock("../../../src/load-env.js", () => ({}));
vi.mock("../../../src/config/loader.js", () => ({
  loadConfig: load,
  resolveConfigEnvVars: resolveEnv,
  getConfigPath: () => "/missing/browser-preparation-config.yaml",
}));
vi.mock("../../../src/core/agent-runtime/tools/browser-setup.js", () => ({
  prepareManagedChromium: prepare,
}));
vi.mock("../../../src/entrypoints/cli/commands.js", () => {
  heavyImports();
  return { main: heavyMain };
});
vi.mock("../../../src/entrypoints/cli/startup-migration-command.js", () => ({
  runStartupMigrationCommand: migrate,
}));
import { runBrowserPreparationCommand } from "../../../src/entrypoints/cli/browser-preparation-command.js";

const argv = ["node", "main.js", "internal", "browser-prepare"];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  load.mockReturnValue({ tools: { browser: { enabled: false } } });
  resolveEnv.mockImplementation((config) => config);
  prepare.mockResolvedValue({ status: "disabled" });
  process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("lightweight desktop browser preparation entrypoint", () => {
  it("production main bypasses Agent services and migrations", async () => {
    process.argv = argv;
    vi.resetModules();
    await import("../../../src/main.js");
    expect(prepare).toHaveBeenCalledWith(false);
    expect(console.log).toHaveBeenCalledWith("disabled");
    expect(process.exitCode).toBe(0);
    expect(heavyImports).not.toHaveBeenCalled();
    expect(heavyMain).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it.each([
    ["node", "main.js", "internal"],
    ["node", "main.js", "internal", "browser-prepare", "--extra"],
    ["node", "main.js", "internal", "unknown"],
  ])("rejects unsupported internal arguments before loading config: %j", async (...args) => {
    process.argv = args;
    vi.resetModules();
    await import("../../../src/main.js");
    expect(console.error).toHaveBeenCalledWith("unavailable");
    expect(process.exitCode).toBe(2);
    expect(load).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(heavyImports).not.toHaveBeenCalled();
  });

  it.each(["ready", "disabled"])("preserves %s status and resolves environment settings", async (status) => {
    const config = { tools: { browser: { enabled: false } } };
    const resolved = { tools: { browser: { enabled: true } } };
    load.mockReturnValue(config);
    resolveEnv.mockReturnValue(resolved);
    prepare.mockResolvedValue({ status });
    await expect(runBrowserPreparationCommand(argv)).resolves.toBe(true);
    expect(load).toHaveBeenCalledWith(null);
    expect(resolveEnv).toHaveBeenCalledWith(config);
    expect(prepare).toHaveBeenCalledWith(true);
    expect(console.log).toHaveBeenCalledWith(status);
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("preserves preparation failure output and exit code", async () => {
    prepare.mockResolvedValue({ status: "unavailable", error: "browser install failed" });
    await expect(runBrowserPreparationCommand(argv)).resolves.toBe(true);
    expect(console.log).toHaveBeenCalledWith("unavailable");
    expect(console.error).toHaveBeenCalledWith("browser install failed");
    expect(process.exitCode).toBe(1);
  });

  it("reports invalid config without starting preparation", async () => {
    load.mockImplementation(() => { throw new Error("invalid config"); });
    await expect(runBrowserPreparationCommand(argv)).resolves.toBe(true);
    expect(console.log).toHaveBeenCalledWith("unavailable");
    expect(console.error).toHaveBeenCalledWith("invalid config");
    expect(prepare).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("reports rejected preparation without leaking the rejection", async () => {
    prepare.mockRejectedValue("setup rejected");
    await expect(runBrowserPreparationCommand(argv)).resolves.toBe(true);
    expect(console.log).toHaveBeenCalledWith("unavailable");
    expect(console.error).toHaveBeenCalledWith("setup rejected");
    expect(process.exitCode).toBe(1);
  });

  it("leaves unrelated commands to the full CLI", async () => {
    await expect(runBrowserPreparationCommand(["node", "main.js", "gateway"])).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});
