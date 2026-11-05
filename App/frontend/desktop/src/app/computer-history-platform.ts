/** Require the desktop host's platform, not the browser's OS. */
export function isComputerHistorySupported(
  platform = typeof window === "undefined" ? undefined : window.memmy?.platform,
  release = typeof window === "undefined" ? undefined : window.memmy?.osRelease,
): boolean {
  return platform === "darwin" || platform === "win32";
}
