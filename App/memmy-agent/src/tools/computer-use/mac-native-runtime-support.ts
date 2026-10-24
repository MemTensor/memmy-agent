import os from "node:os";

/** Memmy's optional native Use/History helper is built for macOS 14 (Darwin 23). */
export function isMacNativeRuntimeSupported(platform = process.platform, darwinRelease = os.release()): boolean {
  if (platform !== "darwin") return true;
  const major = Number(darwinRelease.match(/^(\d+)\./u)?.[1]);
  return Number.isInteger(major) && major >= 23;
}
