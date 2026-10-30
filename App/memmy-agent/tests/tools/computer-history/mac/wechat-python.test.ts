import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMacWeChatPython } from "../../../../src/tools/computer-history/mac/wechat-python.js";

const temporaries: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaries.length) fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
});

/** Build a bundled-interpreter layout and return the resolver's module file. */
function bundle(options: {
  manifest?: Record<string, unknown> | null;
  executable?: boolean;
  moduleSubdir?: string; // place the module under app.asar while python lands in app.asar.unpacked
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-python-"));
  temporaries.push(root);
  const moduleDirectory = path.join(root, options.moduleSubdir ?? "");
  const pythonDirectory = path.join(
    (options.moduleSubdir ?? "").includes("app.asar")
      ? path.join(root, options.moduleSubdir!.replace("app.asar", "app.asar.unpacked"))
      : moduleDirectory,
    "wechat", "python",
  );
  fs.mkdirSync(path.join(pythonDirectory, "bin"), { recursive: true });
  if (options.manifest !== null) {
    fs.writeFileSync(path.join(pythonDirectory, "runtime.json"),
      JSON.stringify(options.manifest ?? { version: "3.13.16", arch: "arm64", build: "20261013" }));
  }
  if (options.executable !== false) {
    const real = path.join(pythonDirectory, "bin", "python3.13");
    fs.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("python3.13", path.join(pythonDirectory, "bin", "python3"));
  }
  fs.mkdirSync(moduleDirectory, { recursive: true });
  return path.join(moduleDirectory, "wechat-python.js");
}

describe("WeChat macOS bundled interpreter", () => {
  it("resolves the bundled python3 when the manifest and executable are present", () => {
    const moduleFile = bundle();
    const resolved = resolveMacWeChatPython({ moduleFile });
    expect(resolved).toBe(path.join(path.dirname(moduleFile), "wechat", "python", "bin", "python3"));
    expect(fs.statSync(resolved!).isFile()).toBe(true);
  });

  it("reads the interpreter from app.asar.unpacked when the module is inside app.asar", () => {
    const moduleFile = bundle({ moduleSubdir: path.join("app.asar", "dist", "tools", "computer-history", "mac") });
    const resolved = resolveMacWeChatPython({ moduleFile });
    expect(resolved).toContain(path.join("app.asar.unpacked", "dist"));
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it("returns null when the bundle is missing, damaged, or built for another target", () => {
    expect(resolveMacWeChatPython({ moduleFile: bundle({ manifest: null }) })).toBeNull();
    expect(resolveMacWeChatPython({ moduleFile: bundle({ manifest: { version: "3.12.0", arch: "arm64" } }) })).toBeNull();
    expect(resolveMacWeChatPython({ moduleFile: bundle({ manifest: { version: "3.13.16", arch: "x64" } }) })).toBeNull();
    expect(resolveMacWeChatPython({ moduleFile: bundle({ executable: false }) })).toBeNull();
  });

  it("returns null when executable access is denied", () => {
    const moduleFile = bundle();
    const binary = path.join(path.dirname(moduleFile), "wechat", "python", "bin", "python3");
    const access = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture executable access denied"), { code: "EACCES" });
    });
    expect(resolveMacWeChatPython({ moduleFile })).toBeNull();
    expect(access).toHaveBeenCalledWith(binary, fs.constants.X_OK);
  });

  // Windows does not implement POSIX execute bits; the denial path above is
  // still exercised on every host, and macOS checks the real filesystem mode.
  it.skipIf(process.platform === "win32")("returns null when python3 exists but is not executable", () => {
    const moduleFile = bundle({ executable: false });
    const binary = path.join(path.dirname(moduleFile), "wechat", "python", "bin", "python3");
    fs.writeFileSync(binary, "", { mode: 0o644 });
    expect(resolveMacWeChatPython({ moduleFile })).toBeNull();
  });
});
