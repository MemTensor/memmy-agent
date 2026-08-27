import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getDataDir } from "../../../config/paths.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.78";
export const PLAYWRIGHT_VERSION = "1.62.0-alpha-1783623505000";
export const BROWSER_PREPARATION_IDLE_TIMEOUT_MS = 120_000;
export const BROWSER_PREPARATION_TOTAL_TIMEOUT_MS = 900_000;
export const BROWSER_PREPARATION_ATTEMPT_ID_ENV =
  "MEMMY_BROWSER_PREPARATION_ATTEMPT_ID";

export type BrowserPrepareStatus = "ready" | "disabled" | "unavailable";

export type BrowserPrepareResult = {
  status: BrowserPrepareStatus;
  executablePath?: string;
  error?: string;
};

export type BrowserPreparationState = {
  status: "preparing" | "ready" | "unavailable";
  updatedAt: string;
  attemptId?: string;
  startedAt?: string;
  lastProgressAt?: string;
  progressPercent?: number;
  executablePath?: string;
  error?: string;
};

type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type BrowserInstallTask = {
  completion: Promise<SpawnResult>;
  stop: () => Promise<void>;
};

type BrowserInstallObserver = {
  onOutput: (chunk: string) => void;
};

type BrowserSetupRuntime = {
  existsSync: typeof fs.existsSync;
  readFileSync: typeof fs.readFileSync;
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
    observer: BrowserInstallObserver,
  ) => BrowserInstallTask;
  resolvePackage: (specifier: string) => string;
  importPlaywright: () => Promise<typeof import("playwright")>;
  execPath: string;
};

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  observer: BrowserInstallObserver,
): BrowserInstallTask {
  const child = spawn(command, args, options);
  const forwardOutput = (
    stream: NodeJS.ReadableStream | null,
    target: NodeJS.WritableStream,
  ): void => {
    stream?.on("data", (chunk) => {
      const text = String(chunk);
      observer.onOutput(text);
      try {
        target.write(text);
      } catch {
        // The state file remains authoritative if the parent log pipe closes.
      }
    });
  };
  forwardOutput(child.stdout, process.stdout);
  forwardOutput(child.stderr, process.stderr);
  const completion = new Promise<SpawnResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    completion,
    stop: async () => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 5_000);
        timer.unref?.();
        void completion.then(finish, finish);
      });
    },
  };
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

export function getBrowserPreparationStatePath(): string {
  return path.join(path.dirname(getPlaywrightBrowsersPath()), "browser-preparation-state.json");
}

export function readBrowserPreparationState(): BrowserPreparationState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getBrowserPreparationStatePath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!["preparing", "ready", "unavailable"].includes(parsed.status)) return null;
    if (typeof parsed.updatedAt !== "string") return null;
    return {
      status: parsed.status,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.attemptId === "string" ? { attemptId: parsed.attemptId } : {}),
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.lastProgressAt === "string"
        ? { lastProgressAt: parsed.lastProgressAt }
        : {}),
      ...(typeof parsed.progressPercent === "number"
        && Number.isFinite(parsed.progressPercent)
        ? { progressPercent: parsed.progressPercent }
        : {}),
      ...(typeof parsed.executablePath === "string"
        ? { executablePath: parsed.executablePath }
        : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
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

function writeBrowserPreparationState(
  state: Omit<BrowserPreparationState, "updatedAt">,
): void {
  const statePath = getBrowserPreparationStatePath();
  const directory = path.dirname(statePath);
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(temporaryPath, statePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function recordBrowserPreparationState(
  state: Omit<BrowserPreparationState, "updatedAt">,
): void {
  try {
    writeBrowserPreparationState(state);
  } catch {
    // Preparation must remain usable even when a read-only or damaged data directory
    // prevents the optional status file from being updated.
  }
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

export type BrowserPreparationOptions = {
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
};

function preparationFailure(
  error: string,
  state: Partial<Omit<BrowserPreparationState, "status" | "updatedAt" | "error">> = {},
): BrowserPrepareResult {
  const unavailable = { status: "unavailable", error } as const;
  recordBrowserPreparationState({ ...state, ...unavailable });
  return unavailable;
}

export async function prepareManagedChromium(
  enabled: boolean,
  options: BrowserPreparationOptions = {},
): Promise<BrowserPrepareResult> {
  if (!enabled) return { status: "disabled" };
  const runtime = setupRuntime();
  const attemptId = process.env[BROWSER_PREPARATION_ATTEMPT_ID_ENV]?.trim() || undefined;
  try {
    configurePlaywrightBrowsersPath();
    const { playwrightCli } = resolveManagedPlaywrightPaths();
    let resolved = await resolveManagedChromium();
    if (runtime.existsSync(resolved.executablePath)) {
      recordBrowserPreparationState({
        status: "ready",
        ...(attemptId ? { attemptId } : {}),
        executablePath: resolved.executablePath,
      });
      return { status: "ready", executablePath: resolved.executablePath };
    }
    const startedAt = new Date().toISOString();
    let lastProgressAt = startedAt;
    let progressPercent = 0;
    recordBrowserPreparationState({
      status: "preparing",
      ...(attemptId ? { attemptId } : {}),
      startedAt,
      lastProgressAt,
      progressPercent,
    });
    fs.mkdirSync(getPlaywrightBrowsersPath(), { recursive: true });
    const idleTimeoutMs = options.idleTimeoutMs
      ?? BROWSER_PREPARATION_IDLE_TIMEOUT_MS;
    const totalTimeoutMs = options.totalTimeoutMs
      ?? BROWSER_PREPARATION_TOTAL_TIMEOUT_MS;
    let installTask: BrowserInstallTask | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;
    let timeoutError: string | null = null;
    let acceptingProgress = true;
    let outputBuffer = "";
    let currentArtifactKey: string | null = null;
    let currentArtifactProgress = 0;
    let resolveTimeout!: (result: SpawnResult) => void;
    const timeout = new Promise<SpawnResult>((resolve) => {
      resolveTimeout = resolve;
    });
    const expire = (error: string): void => {
      if (timeoutError) return;
      timeoutError = error;
      acceptingProgress = false;
      resolveTimeout({ code: null, signal: null });
    };
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => expire("浏览器组件下载无进度，准备失败"),
        idleTimeoutMs,
      );
    };
    const recordProgressLine = (line: string): void => {
      let progressed = false;
      const artifactMatch = line.match(/Downloading (.+?) from https?:\/\/\S+/);
      const artifactKey = artifactMatch?.[1]?.trim() || null;
      if (artifactKey && artifactKey !== currentArtifactKey) {
        currentArtifactKey = artifactKey;
        currentArtifactProgress = 0;
        progressPercent = 0;
        progressed = true;
      }
      for (const match of line.matchAll(/(\d{1,3})%\s+of\b/g)) {
        const nextProgress = Math.max(0, Math.min(100, Number(match[1])));
        if (nextProgress <= currentArtifactProgress) continue;
        currentArtifactProgress = nextProgress;
        progressPercent = nextProgress;
        progressed = true;
      }
      if (!progressed) return;
      lastProgressAt = new Date().toISOString();
      recordBrowserPreparationState({
        status: "preparing",
        ...(attemptId ? { attemptId } : {}),
        startedAt,
        lastProgressAt,
        progressPercent,
      });
      resetIdleTimer();
    };
    const onOutput = (chunk: string): void => {
      if (!acceptingProgress) return;
      outputBuffer += chunk;
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) recordProgressLine(line);
    };
    installTask = runtime.spawnProcess(
      runtime.execPath,
      [playwrightCli, "install", "chromium"],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: managedInstallEnvironment(),
      },
      { onOutput },
    );
    resetIdleTimer();
    totalTimer = setTimeout(
      () => expire("浏览器组件下载超时，准备失败"),
      totalTimeoutMs,
    );
    let result: SpawnResult;
    try {
      result = await Promise.race([installTask.completion, timeout]);
    } finally {
      acceptingProgress = false;
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
    }
    if (timeoutError) {
      await installTask.stop();
      return preparationFailure(timeoutError, {
        ...(attemptId ? { attemptId } : {}),
        startedAt,
        lastProgressAt,
        progressPercent,
      });
    }
    if (result.code !== 0) {
      return preparationFailure(
        `Playwright install exited with code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}`,
        {
          ...(attemptId ? { attemptId } : {}),
          startedAt,
          lastProgressAt,
          progressPercent,
        },
      );
    }
    resolved = await resolveManagedChromium();
    if (!runtime.existsSync(resolved.executablePath)) {
      return preparationFailure(
        "Chromium executable is missing after Playwright install",
        {
          ...(attemptId ? { attemptId } : {}),
          startedAt,
          lastProgressAt,
          progressPercent,
        },
      );
    }
    recordBrowserPreparationState({
      status: "ready",
      ...(attemptId ? { attemptId } : {}),
      executablePath: resolved.executablePath,
    });
    return { status: "ready", executablePath: resolved.executablePath };
  } catch (error) {
    return preparationFailure(
      summarizeError(error),
      attemptId ? { attemptId } : {},
    );
  }
}
