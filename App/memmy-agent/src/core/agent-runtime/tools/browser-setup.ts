import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getDataDir } from "../../../config/paths.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.78";
export const PLAYWRIGHT_VERSION = "1.62.0-alpha-1783623505000";

export type BrowserPrepareStatus = "ready" | "disabled" | "unavailable";

export type BrowserPrepareResult = {
  status: BrowserPrepareStatus;
  executablePath?: string;
  error?: string;
};

type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type BrowserSetupRuntime = {
  existsSync: typeof fs.existsSync;
  readFileSync: typeof fs.readFileSync;
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => Promise<SpawnResult>;
  resolvePackage: (specifier: string) => string;
  importPlaywright: () => Promise<typeof import("playwright")>;
  execPath: string;
};

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const defaultRuntime: BrowserSetupRuntime = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  spawnProcess: defaultSpawnProcess,
  resolvePackage: (specifier) => createRequire(import.meta.url).resolve(specifier),
  importPlaywright: () => import("playwright"),
  execPath: process.execPath,
};

let runtimeOverride: Partial<BrowserSetupRuntime> | null = null;

export function setBrowserSetupRuntimeForTest(
  runtime: Partial<BrowserSetupRuntime> | null,
): void {
  runtimeOverride = runtime;
}

function setupRuntime(): BrowserSetupRuntime {
  return { ...defaultRuntime, ...(runtimeOverride ?? {}) };
}

export function getPlaywrightBrowsersPath(): string {
  return path.join(getDataDir(), "mcp", "playwright", "browsers");
}

export function configurePlaywrightBrowsersPath(): string {
  const browsersPath = getPlaywrightBrowsersPath();
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return browsersPath;
}

function packageInfo(
  packageName: string,
  expectedVersion: string,
  runtime: BrowserSetupRuntime,
): { packagePath: string; root: string } {
  const packagePath = runtime.resolvePackage(`${packageName}/package.json`);
  const parsed = JSON.parse(String(runtime.readFileSync(packagePath, "utf8")));
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `${packageName} version mismatch: expected ${expectedVersion}, got ${String(parsed.version)}`,
    );
  }
  return { packagePath, root: path.dirname(packagePath) };
}

export function resolveManagedPlaywrightPaths(): {
  playwrightRoot: string;
  playwrightCli: string;
} {
  const runtime = setupRuntime();
  packageInfo("@playwright/mcp", PLAYWRIGHT_MCP_VERSION, runtime);
  const playwright = packageInfo("playwright", PLAYWRIGHT_VERSION, runtime);
  const playwrightCli = path.join(playwright.root, "cli.js");
  if (!runtime.existsSync(playwrightCli)) {
    throw new Error("application Playwright CLI is missing");
  }
  return { playwrightRoot: playwright.root, playwrightCli };
}

export async function resolveManagedChromium(): Promise<{
  chromium: typeof import("playwright").chromium;
  executablePath: string;
}> {
  configurePlaywrightBrowsersPath();
  resolveManagedPlaywrightPaths();
  const playwright = await setupRuntime().importPlaywright();
  const executablePath = playwright.chromium.executablePath();
  return { chromium: playwright.chromium, executablePath };
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

function managedInstallEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersPath(),
  };
  for (const key of [
    "PLAYWRIGHT_DOWNLOAD_HOST",
    "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST",
    "PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST",
    "PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST",
  ]) {
    delete env[key];
    delete env[`npm_config_${key.toLowerCase()}`];
    delete env[`npm_package_config_${key.toLowerCase()}`];
  }
  return env;
}

export async function prepareManagedChromium(
  enabled: boolean,
): Promise<BrowserPrepareResult> {
  if (!enabled) return { status: "disabled" };
  const runtime = setupRuntime();
  try {
    configurePlaywrightBrowsersPath();
    const { playwrightCli } = resolveManagedPlaywrightPaths();
    let resolved = await resolveManagedChromium();
    if (runtime.existsSync(resolved.executablePath)) {
      return { status: "ready", executablePath: resolved.executablePath };
    }
    fs.mkdirSync(getPlaywrightBrowsersPath(), { recursive: true });
    const result = await runtime.spawnProcess(
      runtime.execPath,
      [playwrightCli, "install", "chromium"],
      {
        shell: false,
        stdio: "inherit",
        env: managedInstallEnvironment(),
      },
    );
    if (result.code !== 0) {
      return {
        status: "unavailable",
        error: `Playwright install exited with code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}`,
      };
    }
    resolved = await resolveManagedChromium();
    if (!runtime.existsSync(resolved.executablePath)) {
      return {
        status: "unavailable",
        error: "Chromium executable is missing after Playwright install",
      };
    }
    return { status: "ready", executablePath: resolved.executablePath };
  } catch (error) {
    return { status: "unavailable", error: summarizeError(error) };
  }
}
