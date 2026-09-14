import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export type WindowsStoreUpdateCommand =
  | "identity"
  | "check"
  | "download-silent"
  | "download-user"
  | "stage-store-update-finalizer"
  | "startup-status"
  | "startup-enable"
  | "startup-disable";

export type WindowsStoreStartupTaskState =
  | "disabled"
  | "disabled-by-user"
  | "disabled-by-policy"
  | "enabled";

export type WindowsStoreUpdateState =
  | "pending"
  | "downloading"
  | "deploying"
  | "completed"
  | "canceled"
  | "error-low-battery"
  | "error-wifi-recommended"
  | "error-wifi-required"
  | "not-allowed"
  | "other-error";

export interface WindowsStoreUpdateCheckResult {
  type: "check";
  available: boolean;
  updateCount: number;
  canSilentlyDownload: boolean;
  mandatory: boolean;
  currentPackageVersion: string;
  currentPackageFullName: string;
}

export interface WindowsStorePackageIdentityResult {
  type: "identity";
  aumid: string;
  packageFamilyName: string;
  currentPackageVersion: string;
  currentPackageFullName: string;
}

export interface WindowsStoreUpdateProgress {
  type: "progress";
  state: WindowsStoreUpdateState;
  transferredBytes: number;
  totalBytes: number;
  percent: number;
}

export interface WindowsStoreUpdateActionResult {
  type: "result";
  state: WindowsStoreUpdateState;
  packages: Array<{
    family: string;
    state: WindowsStoreUpdateState;
    transferredBytes: number;
    totalBytes: number;
  }>;
}

export interface WindowsStoreStartupTaskResult {
  type: "startup-task";
  taskId: string;
  state: WindowsStoreStartupTaskState;
}

export interface WindowsStoreFinalizerStagedResult {
  type: "finalizer-staged";
  attemptId: string;
  path: string;
  externalReadyPath: string;
  installerReadyPath: string;
  resultPath: string;
  logPath: string;
  size: number;
  sha256: string;
}

export type WindowsStoreUpdateResult =
  | WindowsStorePackageIdentityResult
  | WindowsStoreUpdateCheckResult
  | WindowsStoreUpdateActionResult
  | WindowsStoreStartupTaskResult
  | WindowsStoreFinalizerStagedResult;

export interface RunWindowsStoreUpdateOptions {
  resourcesPath: string;
  command: WindowsStoreUpdateCommand;
  ownerWindowHandle?: string;
  packageFamilyName?: string;
  attemptId?: string;
  onProgress?: (progress: WindowsStoreUpdateProgress) => void;
}

export interface StageWindowsStoreUpdateFinalizerOptions {
  resourcesPath: string;
  packageFamilyName: string;
  attemptId: string;
}

export type WindowsStoreHelperMessage =
  | WindowsStoreUpdateResult
  | WindowsStoreUpdateProgress
  | { type: "error"; hresult: number; message: string };

export async function runWindowsStoreUpdate(
  options: RunWindowsStoreUpdateOptions
): Promise<WindowsStoreUpdateResult> {
  const helperPath = join(options.resourcesPath, "native", "MemmyStoreUpdate.exe");
  const args: string[] = [options.command];
  if (options.ownerWindowHandle) {
    args.push("--hwnd", options.ownerWindowHandle);
  }
  if (options.command === "stage-store-update-finalizer") {
    if (!options.packageFamilyName || !options.attemptId) {
      throw new Error("Microsoft Store finalizer staging requires package identity and an attempt ID");
    }
    args.push(
      "--package-family-name", options.packageFamilyName,
      "--attempt-id", options.attemptId
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr: string[] = [];
    let result: WindowsStoreUpdateResult | null = null;
    let helperError: Error | null = null;
    let settled = false;
    const timeoutMs = options.command.startsWith("download-")
      ? 30 * 60_000
      : options.command === "identity" ? 15_000 : 30_000;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Microsoft Store ${options.command} helper timed out after ${timeoutMs}ms`));
      try { child.kill(); } catch { /* Rejection must not wait for a stuck helper to exit. */ }
    }, timeoutMs);
    timer.unref?.();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const message = parseWindowsStoreHelperMessage(line);
        if (message.type === "progress") {
          options.onProgress?.(message);
          return;
        }
        if (message.type === "error") {
          helperError = new Error(`Microsoft Store update failed (${formatHresult(message.hresult)}): ${message.message}`);
          return;
        }
        result = message;
      } catch (error) {
        helperError = error instanceof Error ? error : new Error(String(error));
      }
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      if (helperError) {
        fail(helperError);
        return;
      }
      if (code !== 0 || !result) {
        fail(new Error(
          `Microsoft Store update helper exited with code ${code ?? "unknown"}${stderr.length > 0 ? `: ${stderr.join("").trim()}` : ""}`
        ));
        return;
      }
      settled = true;
      clearTimeout(timer);
      lines.close();
      resolve(result);
    });
  });
}

export async function stageWindowsStoreUpdateFinalizer(
  options: StageWindowsStoreUpdateFinalizerOptions
): Promise<WindowsStoreFinalizerStagedResult> {
  const result = await runWindowsStoreUpdate({
    ...options,
    command: "stage-store-update-finalizer"
  });
  if (result.type !== "finalizer-staged") {
    throw new Error(`Microsoft Store update helper returned ${result.type} for finalizer staging`);
  }
  return result;
}

export function nativeWindowHandleToDecimal(handle: Buffer): string {
  if (handle.length >= 8) {
    return handle.readBigUInt64LE(0).toString(10);
  }
  if (handle.length >= 4) {
    return String(handle.readUInt32LE(0));
  }
  throw new Error("Electron returned an invalid native window handle");
}

export function parseWindowsStoreHelperMessage(line: string): WindowsStoreHelperMessage {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.type === "identity") {
    if (typeof value.aumid !== "string" ||
        typeof value.packageFamilyName !== "string" ||
        typeof value.currentPackageVersion !== "string" ||
        typeof value.currentPackageFullName !== "string") {
      throw new Error("Microsoft Store update helper returned an invalid package identity");
    }
    return {
      type: "identity",
      aumid: value.aumid,
      packageFamilyName: value.packageFamilyName,
      currentPackageVersion: value.currentPackageVersion,
      currentPackageFullName: value.currentPackageFullName
    };
  }
  if (value.type === "check") {
    if (typeof value.available !== "boolean" ||
        typeof value.updateCount !== "number" ||
        typeof value.canSilentlyDownload !== "boolean" ||
        typeof value.mandatory !== "boolean" ||
        typeof value.currentPackageVersion !== "string" ||
        typeof value.currentPackageFullName !== "string") {
      throw new Error("Microsoft Store update helper returned an invalid check result");
    }
    return {
      type: "check",
      available: value.available,
      updateCount: value.updateCount,
      canSilentlyDownload: value.canSilentlyDownload,
      mandatory: value.mandatory,
      currentPackageVersion: value.currentPackageVersion,
      currentPackageFullName: value.currentPackageFullName
    };
  }
  if (value.type === "startup-task") {
    if (typeof value.taskId !== "string" || !isWindowsStoreStartupTaskState(value.state)) {
      throw new Error("Microsoft Store update helper returned an invalid StartupTask result");
    }
    return {
      type: "startup-task",
      taskId: value.taskId,
      state: value.state
    };
  }
  if (value.type === "finalizer-staged") {
    if (typeof value.attemptId !== "string" || value.attemptId.length === 0 ||
        typeof value.path !== "string" || value.path.length === 0 ||
        typeof value.externalReadyPath !== "string" || value.externalReadyPath.length === 0 ||
        typeof value.installerReadyPath !== "string" || value.installerReadyPath.length === 0 ||
        typeof value.resultPath !== "string" || value.resultPath.length === 0 ||
        typeof value.logPath !== "string" || value.logPath.length === 0 ||
        typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0 ||
        typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(value.sha256)) {
      throw new Error("Microsoft Store update helper returned an invalid finalizer staging result");
    }
    return {
      type: "finalizer-staged",
      attemptId: value.attemptId,
      path: value.path,
      externalReadyPath: value.externalReadyPath,
      installerReadyPath: value.installerReadyPath,
      resultPath: value.resultPath,
      logPath: value.logPath,
      size: value.size,
      sha256: value.sha256.toLowerCase()
    };
  }
  if (value.type === "progress") {
    if (!isWindowsStoreUpdateState(value.state) ||
        typeof value.transferredBytes !== "number" ||
        typeof value.totalBytes !== "number" ||
        typeof value.percent !== "number") {
      throw new Error("Microsoft Store update helper returned invalid progress");
    }
    return {
      type: "progress",
      state: value.state,
      transferredBytes: value.transferredBytes,
      totalBytes: value.totalBytes,
      percent: value.percent
    };
  }
  if (value.type === "result") {
    if (!isWindowsStoreUpdateState(value.state) || !Array.isArray(value.packages)) {
      throw new Error("Microsoft Store update helper returned an invalid operation result");
    }
    return {
      type: "result",
      state: value.state,
      packages: value.packages.flatMap((candidate) => {
        if (!isRecord(candidate) ||
            typeof candidate.family !== "string" ||
            !isWindowsStoreUpdateState(candidate.state) ||
            typeof candidate.transferredBytes !== "number" ||
            typeof candidate.totalBytes !== "number") {
          return [];
        }
        return [{
          family: candidate.family,
          state: candidate.state,
          transferredBytes: candidate.transferredBytes,
          totalBytes: candidate.totalBytes
        }];
      })
    };
  }
  if (value.type === "error" && typeof value.hresult === "number" && typeof value.message === "string") {
    return { type: "error", hresult: value.hresult, message: value.message };
  }
  throw new Error("Microsoft Store update helper returned an unknown message");
}

function isWindowsStoreUpdateState(value: unknown): value is WindowsStoreUpdateState {
  return value === "pending" ||
    value === "downloading" ||
    value === "deploying" ||
    value === "completed" ||
    value === "canceled" ||
    value === "error-low-battery" ||
    value === "error-wifi-recommended" ||
    value === "error-wifi-required" ||
    value === "not-allowed" ||
    value === "other-error";
}

function isWindowsStoreStartupTaskState(value: unknown): value is WindowsStoreStartupTaskState {
  return value === "disabled" ||
    value === "disabled-by-user" ||
    value === "disabled-by-policy" ||
    value === "enabled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatHresult(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
