export * from "./core/computer-history-api.js";
import { getComputerHistoryDemoService as macService } from "./mac/computer-history-api.js";
import { getWindowsComputerHistoryService } from "./win/computer-history-api.js";
export function getComputerHistoryDemoService() { return process.platform === "win32" ? getWindowsComputerHistoryService() : macService(); }
