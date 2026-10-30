import { RecordingSessionService } from "./session-service.js";
import { WindowsTaskRecordingDriver } from "./windows-driver.js";
import { MacTaskRecordingDriver } from "./macos-driver.js";
import { getComputerHistoryDemoService } from "../computer-history/computer-history-api.js";
import { MEMMY_COMPUTER_USE_MCP_SERVER } from "../../config/computer-use-server.js";
let service: RecordingSessionService | null = null;
export function getRecordingSessionService(): RecordingSessionService {
  return service ??= new RecordingSessionService({ driver: process.platform === "darwin" ? new MacTaskRecordingDriver() : new WindowsTaskRecordingDriver(),
    supported: process.platform === "win32" || process.platform === "darwin", platform: process.platform === "darwin" ? "macos" : "windows",
    historyBusy: () => getComputerHistoryDemoService().recorderBusy });
}
export async function shutdownRecordingService(): Promise<void> { if (service) await service.shutdown(); }
export function markRecordingOcu(sessionKey: string | null | undefined, runId: string | null | undefined, tool: string, status: "started" | "finished" | "failed" | "unknown"): void {
  const isComputerUse = tool.startsWith(`mcp_${MEMMY_COMPUTER_USE_MCP_SERVER}_`)
    || tool.startsWith("mcp_open_computer_use_");
  if (service && (runId || sessionKey?.startsWith("websocket:")) && isComputerUse) {
    service.markOcu(sessionKey?.slice("websocket:".length) ?? "", tool, status, runId);
  }
}
