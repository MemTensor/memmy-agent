import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

const nativeWindows = process.platform === "win32";

/** Model owner-only POSIX metadata for a private Mac fixture on an NTFS host.
 * Process-platform mocks cannot change NTFS mode bits or provide getuid().
 * Windows ACL/consent tests keep the real Windows path; only simulated POSIX
 * reads under this fixture root use these metadata. Contents and links are real.
 */
export function privatePosixFixtureMetadata(root: string): void {
  if (!nativeWindows) return;
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((file, options) => {
    const stat = lstat(file, options);
    if (!stat) return stat;
    const relative = path.relative(root, String(file));
    if (process.platform !== "win32" && relative !== ".."
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      // Every state file in these fixtures is created with mode 0600/0700.
      return Object.assign(stat, {
        mode: typeof stat.mode === "bigint" ? stat.mode & ~0o077n : stat.mode & ~0o077,
        uid: process.getuid?.(),
      });
    }
    return stat;
  }) as typeof fs.lstatSync);
}
