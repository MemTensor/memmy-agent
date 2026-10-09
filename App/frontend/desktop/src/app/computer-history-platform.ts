/** History records macOS activity. Require the desktop host's platform, not the browser's OS. */
export function isComputerHistorySupported(
  platform = typeof window === "undefined" ? undefined : window.memmy?.platform,
): boolean {
  return platform === "darwin";
}
