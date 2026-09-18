import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureNativeHistoryHelper } from "./native-helper.js";
import { macPermissionSettingsGuide } from "../../computer-use/mac-permission-settings.js";

export type HistoryPermission = "accessibility" | "inputMonitoring";
export interface HistoryPermissions {
  supported: boolean;
  accessibility: boolean;
  inputMonitoring: boolean;
}
const execute = promisify(execFile);

/** Use the recorder's own native identity, without installing an event tap. */
export async function readHistoryPermissions(request?: HistoryPermission): Promise<HistoryPermissions> {
  if (process.platform !== "darwin") return { supported: false, accessibility: false, inputMonitoring: false };
  const binary = await ensureNativeHistoryHelper(fileURLToPath(new URL("./human-recorder.swift", import.meta.url)), "human-history-recorder");
  const args = ["--permissions"];
  if (request) args.push(request === "accessibility" ? "--request-accessibility" : "--request-input-monitoring");
  const { stdout } = await execute(binary, args, { timeout: 60_000 });
  const result: unknown = JSON.parse(stdout);
  if (!result || typeof result !== "object" || !("accessibility" in result) || !("inputMonitoring" in result)
    || typeof result.accessibility !== "boolean" || typeof result.inputMonitoring !== "boolean") {
    throw new Error("Invalid Computer History permission response");
  }
  return { supported: true, accessibility: result.accessibility, inputMonitoring: result.inputMonitoring };
}

export async function openHistoryPermission(
  permission: HistoryPermission,
  mode: "request" | "settings" = "settings",
): Promise<HistoryPermissions> {
  // Settings navigation probes permissions without triggering a native prompt.
  // Native authorization remains available only when explicitly requested.
  if (mode === "request") return readHistoryPermissions(permission);
  const status = await readHistoryPermissions();
  if (status.supported && !await macPermissionSettingsGuide.show("computer-history", permission, true)) {
    throw new Error("Could not open macOS Privacy & Security settings");
  }
  return status;
}
