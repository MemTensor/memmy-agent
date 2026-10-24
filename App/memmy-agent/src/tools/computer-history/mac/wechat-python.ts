import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { physicalRuntimeAsset } from "./native-helper.js";

const PYTHON_VERSION = "3.13.16";

/**
 * macOS ships no Python a clean Mac can use without triggering Apple's developer
 * tools install, so the WeChat reader runs Memmy's own bundled interpreter. This
 * mirrors the Windows embedded Python and removes the former Xcode/CLT dependency.
 */
export function resolveMacWeChatPython(options: { moduleFile?: string } = {}): string | null {
  const moduleFile = options.moduleFile ?? fileURLToPath(import.meta.url);
  const directory = physicalRuntimeAsset(path.join(path.dirname(moduleFile), "wechat", "python"));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8")) as {
      version?: unknown; arch?: unknown;
    };
    if (manifest.version !== PYTHON_VERSION || manifest.arch !== "arm64") return null;
    const executable = path.join(directory, "bin", "python3");
    // bin/python3 is a symlink to python3.13; follow it and require a real file.
    if (!fs.statSync(executable).isFile()) return null;
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch {
    // A missing or damaged bundle must not fall back to a random system Python.
    return null;
  }
}
