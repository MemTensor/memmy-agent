import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { historyNativeCommand } from "./native-helper.js";
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
  const command = await historyNativeCommand(fileURLToPath(new URL("./human-recorder.swift", import.meta.url)));
  const args = [...command.args, "--permissions"];
  if (request) args.push(request === "accessibility" ? "--request-accessibility" : "--request-input-monitoring");
  const { stdout } = await execute(command.binary, args,
    { timeout: 60_000, ...(command.env ? { env: command.env } : {}) });
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
  // The user explicitly clicked Enable. Register the native app in the relevant
  // TCC list first, then open settings if the grant still needs a manual toggle.
  if (mode === "request") return readHistoryPermissions(permission);
  const status = await readHistoryPermissions(permission);
  if (status.supported && !status[permission] && !await macPermissionSettingsGuide.show("computer-history", permission, true)) {
    throw new Error("Could not open macOS Privacy & Security settings");
  }
  return status;
}
