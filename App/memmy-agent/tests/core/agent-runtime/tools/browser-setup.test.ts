import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfigPath } from "../../../../src/config/loader.js";
import {
  PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_VERSION,
  configurePlaywrightBrowsersPath,
  getBrowserPreparationStatePath,
  getPlaywrightBrowsersPath,
  prepareManagedChromium,
  readBrowserPreparationState,
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
  const spawnProcess = vi.fn(() => {
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "browser", "utf8");
    return {
      completion: Promise.resolve({ code: 0, signal: null }),
      stop: vi.fn(async () => undefined),
    };
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
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({
          PLAYWRIGHT_BROWSERS_PATH: path.dirname(executablePath),
        }),
      }),
      expect.objectContaining({
        onOutput: expect.any(Function),
      }),
    );
    const installEnv = spawnProcess.mock.calls[0][2].env;
    for (const key of downloadHostEnvKeys) {
      expect(installEnv).not.toHaveProperty(key);
    }
  });

  it("persists preparation state while installing and after completion", async () => {
    const { executablePath, spawnProcess } = setupFakePackages();
    let finishInstall!: (result: { code: number; signal: null }) => void;
    spawnProcess.mockImplementationOnce(() => ({
      completion: new Promise((resolve) => {
        finishInstall = resolve;
      }),
      stop: vi.fn(async () => undefined),
    }));

    const preparation = prepareManagedChromium(true);

    expect(getBrowserPreparationStatePath()).toBe(
      path.join(path.dirname(getPlaywrightBrowsersPath()), "browser-preparation-state.json"),
    );
    await vi.waitFor(() => {
      expect(readBrowserPreparationState()).toMatchObject({
        status: "preparing",
        progressPercent: 0,
      });
    });
    const preparing = readBrowserPreparationState();
    expect(preparing?.startedAt).toEqual(expect.any(String));
    expect(preparing?.lastProgressAt).toBe(preparing?.startedAt);

    const observer = spawnProcess.mock.calls[0][3];
    observer.onOutput("Downloading Chrome for Testing from https://cdn.example/chrome.zip\n");
    observer.onOutput("|■■■■■■■■ | 1");
    observer.onOutput("0% of 191.9 MiB\n");
    await vi.waitFor(() => {
      expect(readBrowserPreparationState()).toMatchObject({
        status: "preparing",
        progressPercent: 10,
      });
    });
    const progressed = readBrowserPreparationState();
    await new Promise((resolve) => setTimeout(resolve, 5));
    observer.onOutput(
      "Downloading Chrome for Testing from https://alternate.example/chrome.zip\n",
    );
    expect(readBrowserPreparationState()?.lastProgressAt).toBe(
      progressed?.lastProgressAt,
    );

    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "browser", "utf8");
    finishInstall({ code: 0, signal: null });

    await expect(preparation).resolves.toEqual({
      status: "ready",
      executablePath,
    });
    expect(readBrowserPreparationState()).toMatchObject({
      status: "ready",
      executablePath,
    });
  });

  it("persists an unavailable state after installation fails", async () => {
    const { spawnProcess } = setupFakePackages();
    spawnProcess.mockReturnValueOnce({
      completion: Promise.resolve({ code: 7, signal: null }),
      stop: vi.fn(async () => undefined),
    });

    await expect(prepareManagedChromium(true)).resolves.toEqual({
      status: "unavailable",
      error: "Playwright install exited with code 7",
    });
    expect(readBrowserPreparationState()).toMatchObject({
      status: "unavailable",
      error: "Playwright install exited with code 7",
    });
  });

  it("stops installation after two minutes without download progress", async () => {
    const { spawnProcess } = setupFakePackages();
    const stop = vi.fn(async () => undefined);
    spawnProcess.mockReturnValueOnce({
      completion: new Promise(() => undefined),
      stop,
    });

    await expect(prepareManagedChromium(true, {
      idleTimeoutMs: 10,
      totalTimeoutMs: 1_000,
    })).resolves.toEqual({
      status: "unavailable",
      error: "浏览器组件下载无进度，准备失败",
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(readBrowserPreparationState()).toMatchObject({
      status: "unavailable",
      error: "浏览器组件下载无进度，准备失败",
    });
    spawnProcess.mock.calls[0][3].onOutput(
      "Downloading Chrome from https://cdn.example/chrome.zip\n|■■■■■■■■ | 10% of 191.9 MiB\n",
    );
    expect(readBrowserPreparationState()).toMatchObject({
      status: "unavailable",
      error: "浏览器组件下载无进度，准备失败",
    });
  });

  it("stops installation after the total preparation deadline", async () => {
    const { spawnProcess } = setupFakePackages();
    const stop = vi.fn(async () => undefined);
    spawnProcess.mockReturnValueOnce({
      completion: new Promise(() => undefined),
      stop,
    });

    await expect(prepareManagedChromium(true, {
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 10,
    })).resolves.toEqual({
      status: "unavailable",
      error: "浏览器组件下载超时，准备失败",
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns unavailable for package version drift or failed installation", async () => {
    setupFakePackages({ playwrightVersion: "0.0.0" });
    const mismatch = await prepareManagedChromium(true);
    expect(mismatch.status).toBe("unavailable");
    expect(mismatch.error).toContain("version mismatch");

    setBrowserSetupRuntimeForTest(null);
    const { spawnProcess } = setupFakePackages();
    spawnProcess.mockReturnValueOnce({
      completion: Promise.resolve({ code: 7, signal: null }),
      stop: vi.fn(async () => undefined),
    });
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
