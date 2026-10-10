/** The Computer History recorder and its product surface are macOS-only. */
export function isComputerHistorySupported(): boolean {
  return process.platform === "darwin";
}
