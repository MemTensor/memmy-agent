/** Hook command helpers. */
import { accessSync, constants, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { resolveHermesHomeDirectory } from "../agent-paths.js";

/** Runtime inputs used to resolve a safe Node executable for agent hooks. */
export interface NodeExecutableRuntime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  hermesHomeDirectory: string;
  isExecutableFile(candidate: string): boolean;
}

/** Creates a shell command that runs a hook script with Node, never Electron. */
export function createNodeHookCommand(
  hookScriptPath: string,
  runtime: NodeExecutableRuntime = defaultNodeExecutableRuntime()
): string {
  return `${shellQuote(resolveNodeExecutable(runtime), runtime.platform)} ${shellQuote(hookScriptPath, runtime.platform)}`;
}

/** Resolves Node without ever selecting a packaged desktop application host. */
export function resolveNodeExecutable(runtime: NodeExecutableRuntime = defaultNodeExecutableRuntime()): string {
  const nodeName = runtime.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    runtime.env.MEMMY_HOOK_NODE,
    runtime.env.NODE,
    runtime.execPath,
    join(runtime.hermesHomeDirectory, "node", "bin", nodeName),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "node"
  ];
  return candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.length > 0 &&
      isSafeNodeCandidate(candidate, nodeName, runtime.isExecutableFile)
  ) ?? "node";
}

function defaultNodeExecutableRuntime(): NodeExecutableRuntime {
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    hermesHomeDirectory: resolveHermesHomeDirectory(),
    isExecutableFile
  };
}

function isSafeNodeCandidate(
  candidate: string,
  nodeName: string,
  isExecutable: (candidate: string) => boolean
): boolean {
  if (isPackagedApplicationExecutable(candidate)) {
    return false;
  }

  if (basename(candidate).toLowerCase() !== nodeName.toLowerCase()) {
    return false;
  }

  return candidate === nodeName || !isAbsolute(candidate) || isExecutable(candidate);
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isPackagedApplicationExecutable(value: string): boolean {
  const name = basename(value).toLowerCase();
  return name.includes("electron") || /\.app[\\/]contents[\\/]macos[\\/]/i.test(value);
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    // cmd.exe treats single quotes as literal characters and PowerShell parses
    // them as string expressions, so the POSIX form never executes on Windows.
    if (!/[\s"\\/]/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
