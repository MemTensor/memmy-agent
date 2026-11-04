import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildWindowsConverter(destination) {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
  if (!installation) throw new Error("Building the Windows renderer requires Visual Studio C++ Build Tools");
  const source = fileURLToPath(new URL("../native/windows-convert.cpp", import.meta.url));
  const manifest = fileURLToPath(new URL("../native/windows-convert.manifest", import.meta.url));
  const bootstrap = join(installation, "Common7/Tools/VsDevCmd.bat");
  const output = resolve(destination, "memmy-office-convert.exe");
  for (const file of [source, manifest, bootstrap, output]) if (/[\r\n"%!^&|<>]/.test(file)) throw new Error("Unsupported build path");
  const temporary = await mkdtemp(join(tmpdir(), "office-native-build-"));
  try {
    execFileSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c",
      `"call "${bootstrap}" -no_logo -arch=${process.arch === "arm64" ? "arm64" : "x64"} && cl.exe /nologo /O2 /EHsc /MT /W4 /DUNICODE /D_UNICODE /Fe:"${output}" "${source}" /link /STACK:8388608 /MANIFEST:EMBED /MANIFESTINPUT:"${manifest}""`],
      { cwd: temporary, stdio: "inherit", windowsVerbatimArguments: true });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
