import os from "node:os";
import { isWindows11 } from "./win/win11.js";

/** Windows support is limited to Windows 11's signed-in desktop session. */
export function isComputerHistorySupported(): boolean {
  return process.platform === "darwin" || isWindows11();
}

/** Personal WeChat History is available on Apple silicon macOS and Windows 11. */
export function isPersonalWeChatHistorySupported(
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
): boolean {
  if (platform === "darwin" && arch === "arm64") return true;
  return isWindows11(platform, release);
}
