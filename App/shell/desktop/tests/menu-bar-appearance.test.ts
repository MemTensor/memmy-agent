import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")("ignores transient appearance changes and retires pending checks on unwatch/rebind", () => {
  const temp = mkdtempSync(join(tmpdir(), "memmy-menu-bar-appearance-"));
  try {
    const include = join(dirname(dirname(realpathSync(process.execPath))), "include", "node");
    const binary = join(temp, "appearance-test");
    execFileSync("xcrun", [
      "--sdk", "macosx", "clang++", "-std=c++17", "-fobjc-arc", "-mmacosx-version-min=12.0",
      "-undefined", "dynamic_lookup", `-I${include}`, "-framework", "AppKit", "-framework", "CoreServices",
      fileURLToPath(new URL("./fixtures/menu-bar-appearance.mm", import.meta.url)), "-o", binary,
    ]);
    expect(() => execFileSync(binary, { timeout: 10_000 })).not.toThrow();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
