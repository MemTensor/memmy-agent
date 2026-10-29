import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { physicalRuntimeAsset } from "../mac/native-helper.js";

const REQUIRED_FILES = [
  "python.exe", "python313.dll", "python313.zip", "python313._pth",
  "_ctypes.pyd", "_sqlite3.pyd", "_hashlib.pyd", "sqlite3.dll",
  "libcrypto-3.dll", "libffi-8.dll", "vcruntime140.dll", "vcruntime140_1.dll",
] as const;

/** Windows does not ship Python. Use Memmy's private, isolated interpreter. */
export function resolveWindowsWeChatPython(options: { moduleFile?: string } = {}): {
  executable: string; args: string[];
} | null {
  const moduleFile = options.moduleFile ?? fileURLToPath(import.meta.url);
  const directory = path.join(path.dirname(physicalRuntimeAsset(moduleFile)), "python");
  try {
    if (!REQUIRED_FILES.every((name) => fs.lstatSync(path.join(directory, name)).isFile())) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8")) as {
      version?: unknown; arch?: unknown;
    };
    if (manifest.version !== "3.13.16" || manifest.arch !== "x64") return null;
    const paths = fs.readFileSync(path.join(directory, "python313._pth"), "utf8")
      .split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (paths.join("\n") !== "python313.zip\n.") return null;
    // Keep modules private, avoid installation writes, and match Node's UTF-8 protocol.
    return { executable: path.join(directory, "python.exe"), args: ["-I", "-B", "-X", "utf8"] };
  } catch {
    // A damaged installation must not select a random Python from PATH.
    return null;
  }
}
