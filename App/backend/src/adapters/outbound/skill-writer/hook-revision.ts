/** Hook revision module. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderMemmyResumeHookScript, type MemmyResumeHookMode } from "./templates/memmy-resume-hook.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "./workspace-bridge/runtime-loader.js";

export const HOOK_REVISION_FIELD = "hook_revision";

const currentRevisionByKey = new Map<string, Promise<string>>();

/** Fingerprint of the hook script and workspace bridge this package would install. */
export function hookRevision(script: string, bridge: string): string {
  return createHash("sha256").update(script).update("\0").update(bridge).digest("hex");
}

/** Returns the cached fingerprint for one agent hook bundle. */
export function currentMemmyHookRevision(source: string, mode: MemmyResumeHookMode): Promise<string> {
  const key = `${mode}\0${source}`;
  const cached = currentRevisionByKey.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const script = renderMemmyResumeHookScript({ source, mode });
    const bridge = await loadMemmyWorkspaceBridgeRuntimeAsset();
    return hookRevision(script, bridge);
  })().catch((error: unknown) => {
    currentRevisionByKey.delete(key);
    throw error;
  });
  currentRevisionByKey.set(key, pending);
  return pending;
}

/** Config field written beside an installed hook. */
export async function memmyHookRevisionField(
  source: string,
  mode: MemmyResumeHookMode
): Promise<Record<string, string>> {
  return { [HOOK_REVISION_FIELD]: await currentMemmyHookRevision(source, mode) };
}

export interface InstalledMemmyHookPaths {
  source: string;
  mode: MemmyResumeHookMode;
  hookScriptPath: string;
  bridgePath: string;
  configPath: string;
}

/**
 * An installed hook is current when both files exist and the stored fingerprint
 * matches the bundle in this process. A missing fingerprint is an older install.
 */
export async function isInstalledMemmyHookCurrent(input: InstalledMemmyHookPaths): Promise<boolean> {
  const [script, bridge, configText] = await Promise.all([
    readOptionalText(input.hookScriptPath),
    readOptionalText(input.bridgePath),
    readOptionalText(input.configPath)
  ]);
  if (!script.trim() || !bridge.trim()) return false;
  const stored = readStoredHookRevision(configText);
  if (!stored) return false;
  return stored === await currentMemmyHookRevision(input.source, input.mode);
}

function readStoredHookRevision(configText: string): string | null {
  if (!configText.trim()) return null;
  try {
    const parsed = JSON.parse(configText) as unknown;
    if (!isRecord(parsed)) return null;
    const value = parsed[HOOK_REVISION_FIELD];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
