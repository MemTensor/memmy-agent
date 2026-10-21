// Keep existing imports and defaults while the business service is shared across platforms.
export * from "../core/computer-history-api.js";
import { ComputerHistoryDemoService as SharedService, ComputerHistoryApiError } from "../core/computer-history-api.js";
import fs from "node:fs";
import { ApplicationIconReader } from "./application-icon.js";
import { readHistoryPermissions, openHistoryPermission } from "./permissions.js";
import { computerHistoryPermissionError } from "../../computer-use/mac-permission-settings.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { collectorGate } from "../core/collector-gate.js";

export class ComputerHistoryDemoService extends SharedService {
  constructor(input: ConstructorParameters<typeof SharedService>[0] = {}) {
    const recorderScript = input.recorderScript ?? fileURLToPath(new URL("./record-human-history.js", import.meta.url));
    const icons = new ApplicationIconReader();
    super({ ...input, recorderScript, platformDriver: input.platformDriver ?? {
      launch: ({ title, eventsFile, observationSettingsFile }) => {
        if (!fs.existsSync(recorderScript)) throw new ComputerHistoryApiError(503, "recorder script is unavailable");
        const release = collectorGate.acquire("history");
        try {
          const child = spawn(process.execPath, [
            recorderScript, "--title", title, "--out", eventsFile, "--no-screenshots", "--capture-search-text", "--capture-text",
            "--observation-settings", observationSettingsFile,
          ], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
          // The legacy wrapper exits after its native helper has stopped.
          // Its lifecycle permits rotation at exit, before stdout pipe close.
          child.once("exit", release);
          child.once("close", release);
          child.once("error", () => { if (!child.pid) release(); });
          return child;
        } catch (error) { release(); throw error; }
      },
      readPermissions: readHistoryPermissions,
      openPermission: openHistoryPermission,
      permissionError: (message) => {
        const permission = computerHistoryPermissionError(message);
        return permission === "accessibility" || permission === "inputMonitoring" ? permission : null;
      },
      iconFor: (applicationId) => icons.iconFor(applicationId),
    } });
  }
}

let defaultService: ComputerHistoryDemoService | null = null;
export function getComputerHistoryDemoService(): ComputerHistoryDemoService {
  return defaultService ??= new ComputerHistoryDemoService();
}
