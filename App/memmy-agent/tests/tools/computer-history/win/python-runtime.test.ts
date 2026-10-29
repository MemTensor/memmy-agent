import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveWindowsWeChatPython } from "../../../../src/tools/computer-history/win/python-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-python-"));
  roots.push(root);
  const relative = path.join("dist", "tools", "computer-history", "win");
  const directory = path.join(root, "普通用户 程序", "app.asar.unpacked", relative, "python");
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["python.exe", "python313.dll", "python313.zip", "_ctypes.pyd", "_sqlite3.pyd",
    "_hashlib.pyd", "sqlite3.dll", "libcrypto-3.dll", "libffi-8.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
    fs.writeFileSync(path.join(directory, name), "fixture");
  }
  fs.writeFileSync(path.join(directory, "python313._pth"), "python313.zip\r\n.\r\n#import site\r\n");
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: "3.13.16", arch: "x64" }));
  return { directory, moduleFile: path.join(root, "普通用户 程序", "app.asar", relative, "python-runtime.js") };
}

it("selects the unpacked private interpreter with isolated arguments in a Unicode install path", () => {
  const { directory, moduleFile } = fixture();
  expect(resolveWindowsWeChatPython({ moduleFile })).toEqual({
    executable: path.join(directory, "python.exe"), args: ["-I", "-B", "-X", "utf8"],
  });
});

it("fails before connection when the interpreter or a required native dependency is missing", () => {
  const { directory, moduleFile } = fixture();
  fs.rmSync(path.join(directory, "_ctypes.pyd"));
  expect(resolveWindowsWeChatPython({ moduleFile })).toBeNull();
  // Even a system launcher cannot repair an incomplete packaged dependency chain.
  fs.writeFileSync(path.join(path.dirname(directory), "py.exe"), "unrelated launcher");
  expect(resolveWindowsWeChatPython({ moduleFile })).toBeNull();
});

it("refuses foreign runtimes, symlink dependencies and nonisolated module search paths", () => {
  const { directory, moduleFile } = fixture();
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: "3.13.16", arch: "arm64" }));
  expect(resolveWindowsWeChatPython({ moduleFile })).toBeNull();
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: "3.13.16", arch: "x64" }));
  fs.writeFileSync(path.join(directory, "python313._pth"), "python313.zip\n.\nimport site\n");
  expect(resolveWindowsWeChatPython({ moduleFile })).toBeNull();
  fs.writeFileSync(path.join(directory, "python313._pth"), "python313.zip\n.\n");
  // Creating a Windows symlink would require privileges on ordinary test machines.
  if (process.platform !== "win32") {
    fs.rmSync(path.join(directory, "python.exe"));
    fs.symlinkSync(path.join(directory, "python313.dll"), path.join(directory, "python.exe"));
    expect(resolveWindowsWeChatPython({ moduleFile })).toBeNull();
  }
});
