import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

const windowsHost = process.platform === "win32";

/** Model POSIX metadata only inside the owned synthetic macOS state directory. */
export function mockMacConsentPermissions(consentFile: string): void {
  if (!windowsHost) return;
  const original = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
    const stat = original(file, options);
    const directory = path.dirname(consentFile);
    if (stat && process.platform === "darwin" && (String(file) === directory || path.dirname(String(file)) === directory)) {
      const mode = stat.isDirectory() ? 0o700 : 0o600;
      Object.assign(stat, {
        mode: typeof stat.mode === "bigint" ? (stat.mode & ~0o777n) | BigInt(mode) : (stat.mode & ~0o777) | mode,
        uid: process.getuid?.(),
      });
    }
    return stat;
  }) as typeof fs.lstatSync);
}
