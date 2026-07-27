import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfigPath } from "../../../../src/config/loader.js";
import {
  PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_VERSION,
  configurePlaywrightBrowsersPath,
  getPlaywrightBrowsersPath,
  prepareManagedChromium,
  resolveManagedPlaywrightPaths,
  setBrowserSetupRuntimeForTest,
} from "../../../../src/core/agent-runtime/tools/browser-setup.js";

const roots: string[] = [];
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const downloadHostKeys = [
  "PLAYWRIGHT_DOWNLOAD_HOST",
  "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST",
  "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST",
  "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST",
] as const;
const downloadHostEnvKeys = downloadHostKeys.flatMap((key) => [
  key,
  `npm_config_${key.toLowerCase()}`,
  `npm_package_config_${key.toLowerCase()}`,
]);
const originalDownloadHosts = Object.fromEntries(
  downloadHostEnvKeys.map((key) => [key, process.env[key]]),
);

function setupFakePackages(
  {
    playwrightVersion = PLAYWRIGHT_VERSION,
    mcpVersion = PLAYWRIGHT_MCP_VERSION,
  }: {
    playwrightVersion?: string;
    mcpVersion?: string;
  } = {},
): {
  root: string;
  executablePath: string;
  playwrightCli: string;
  spawnProcess: ReturnType<typeof vi.fn>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-setup-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const playwrightRoot = path.join(root, "node_modules", "playwright");
  const mcpRoot = path.join(root, "node_modules", "@playwright", "mcp");
  fs.mkdirSync(playwrightRoot, { recursive: true });
  fs.mkdirSync(mcpRoot, { recursive: true });
  fs.writeFileSync(
    path.join(playwrightRoot, "package.json"),
    JSON.stringify({ name: "playwright", version: playwrightVersion }),
  );
  fs.writeFileSync(
    path.join(mcpRoot, "package.json"),
    JSON.stringify({ name: "@playwright/mcp", version: mcpVersion }),
  );
  const playwrightCli = path.join(playwrightRoot, "cli.js");
  fs.writeFileSync(playwrightCli, "// fake cli\n", "utf8");
  const executablePath = path.join(dataDir, "mcp", "playwright", "browsers", "chromium");
  process.env.MEMMY_AGENT_DATA_DIR = dataDir;
  setConfigPath(path.join(root, "config.yaml"));
  const spawnProcess = vi.fn(async () => {
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "browser", "utf8");
    return { code: 0, signal: null };
  });
  setBrowserSetupRuntimeForTest({
    execPath: "/runtime/node",
    resolvePackage: (specifier) => {
      if (specifier === "playwright/package.json") {
        return path.join(playwrightRoot, "package.json");
      }
      if (specifier === "@playwright/mcp/package.json") {
        return path.join(mcpRoot, "package.json");
      }
      throw new Error(`unexpected package: ${specifier}`);
    },
    importPlaywright: async () => ({
      chromium: { executablePath: () => executablePath },
    }) as any,
    spawnProcess,
  });
  return { root, executablePath, playwrightCli, spawnProcess };
}

afterEach(() => {
  setBrowserSetupRuntimeForTest(null);
  setConfigPath(null);
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  if (originalBrowsersPath == null) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
  for (const key of downloadHostEnvKeys) {
    const original = originalDownloadHosts[key];
    if (original == null) delete process.env[key];
    else process.env[key] = original;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("managed Chromium setup", () => {
  it("uses a deterministic cache below the Memmy data directory", () => {
    const { root } = setupFakePackages();

    expect(getPlaywrightBrowsersPath()).toBe(
      path.join(root, "data", "mcp", "playwright", "browsers"),
    );
    expect(configurePlaywrightBrowsersPath()).toBe(getPlaywrightBrowsersPath());
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(getPlaywrightBrowsersPath());
  });

  it("validates the pinned packages and derives the application Playwright CLI", () => {
    const { playwrightCli } = setupFakePackages();

    expect(resolveManagedPlaywrightPaths()).toEqual({
      playwrightRoot: path.dirname(playwrightCli),
      playwrightCli,
    });
  });

  it("does not spawn an installer when the executable already exists", async () => {
    const { executablePath, spawnProcess } = setupFakePackages();
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "browser", "utf8");

    await expect(prepareManagedChromium(true)).resolves.toEqual({
      status: "ready",
      executablePath,
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("runs only the pinned CLI install command when Chromium is missing", async () => {
    const { executablePath, playwrightCli, spawnProcess } = setupFakePackages();
    for (const key of downloadHostEnvKeys) process.env[key] = "https://untrusted.invalid";

    await expect(prepareManagedChromium(true)).resolves.toEqual({
      status: "ready",
      executablePath,
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/runtime/node",
      [playwrightCli, "install", "chromium"],
      expect.objectContaining({
        shell: false,
        stdio: "inherit",
        env: expect.objectContaining({
          PLAYWRIGHT_BROWSERS_PATH: path.dirname(executablePath),
        }),
      }),
    );
    const installEnv = spawnProcess.mock.calls[0][2].env;
    for (const key of downloadHostEnvKeys) {
      expect(installEnv).not.toHaveProperty(key);
    }
  });

  it("returns unavailable for package version drift or failed installation", async () => {
    setupFakePackages({ playwrightVersion: "0.0.0" });
    const mismatch = await prepareManagedChromium(true);
    expect(mismatch.status).toBe("unavailable");
    expect(mismatch.error).toContain("version mismatch");

    setBrowserSetupRuntimeForTest(null);
    const { spawnProcess } = setupFakePackages();
    spawnProcess.mockResolvedValueOnce({ code: 7, signal: null });
    const failed = await prepareManagedChromium(true);
    expect(failed).toEqual({
      status: "unavailable",
      error: "Playwright install exited with code 7",
    });
  });

  it("does nothing when the browser capability is disabled", async () => {
    const resolvePackage = vi.fn(() => {
      throw new Error("must not resolve");
    });
    setBrowserSetupRuntimeForTest({ resolvePackage });

    await expect(prepareManagedChromium(false)).resolves.toEqual({
      status: "disabled",
    });
    expect(resolvePackage).not.toHaveBeenCalled();
  });
});
