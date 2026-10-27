import { beforeEach, describe, expect, it, vi } from "vitest";
import { posix, win32 } from "node:path";
import { resolveCodexExecutable } from "../codex-executable.js";

const fixture = vi.hoisted(() => ({
  files: new Map<string, { directory?: boolean; executable?: boolean; modified?: number }>(),
  links: new Map<string, string>()
}));
vi.mock("node:fs", () => ({
  constants: { F_OK: 0, X_OK: 1 },
  accessSync(file: string, mode: number) {
    const entry = fixture.files.get(file);
    if (!entry || (mode === 1 && entry.executable === false)) throw new Error("not accessible");
  },
  statSync(file: string) {
    const entry = fixture.files.get(file);
    if (!entry) throw new Error("missing");
    return { isFile: () => !entry.directory, mtimeMs: entry.modified ?? 0 };
  },
  realpathSync(file: string) { return fixture.links.get(file) ?? file; },
  readdirSync(directory: string) {
    const paths = directory.includes("\\") ? win32 : posix;
    return [...fixture.files].filter(([file]) => paths.dirname(file) === directory)
      .map(([file, entry]) => ({ name: paths.basename(file), isDirectory: () => Boolean(entry.directory) }));
  }
}));
beforeEach(() => { fixture.files.clear(); fixture.links.clear(); });
const file = (name: string) => { fixture.files.set(name, {}); return name; };
const mac = { codexHomeDirectory: "/data/codex", homeDirectory: "/Users/test", platform: "darwin" as const, architecture: "arm64", environment: {} };
const windows = { codexHomeDirectory: "H:\\codex-home", homeDirectory: "C:\\Users\\Test", platform: "win32" as const, architecture: "x64", environment: {} };

describe("Codex executable discovery", () => {
  it.each(["ChatGPT.app", "Codex.app"])("finds %s in a user's Applications despite an empty GUI PATH", (app) => {
    const executable = file(`/Users/test/Applications/${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`);
    expect(resolveCodexExecutable(mac)).toBe(executable);
  });
  it.each(["codex", "bin/codex", "codex-cli/bin/codex"])("supports the macOS bundle entry point %s", (entry) => {
    const executable = file(`/Applications/Codex.app/Contents/Resources/${entry}`);
    expect(resolveCodexExecutable(mac)).toBe(executable);
  });
  it("skips a broken desktop symlink and finds a working CLI", () => {
    fixture.links.set("/Applications/ChatGPT.app/Contents/Resources/codex", "/removed/codex");
    const executable = file("/opt/homebrew/bin/codex");
    expect(resolveCodexExecutable(mac)).toBe(executable);
  });
  it("preserves plugin app-server discovery with a custom CODEX_HOME", () => {
    const executable = file("H:\\codex-home\\plugins\\.plugin-appserver\\codex.exe");
    expect(resolveCodexExecutable(windows)).toBe(executable);
  });
  it("finds a Windows executable with spaces via case-insensitive Path", () => {
    const executable = file("D:\\Developer Tools\\codex.exe");
    expect(resolveCodexExecutable({ ...windows, environment: { Path: '"D:\\Developer Tools"' } })).toBe(executable);
  });
  it("finds the newest runnable Windows desktop cache and rechecks after an update", () => {
    const root = "C:\\Users\\Test\\AppData\\Local\\OpenAI\\Codex\\bin";
    for (const [name, modified] of [["old", 1], ["new", 2], ["incomplete", 3]] as const) {
      fixture.files.set(`${root}\\${name}`, { directory: true, modified });
    }
    file(`${root}\\old\\codex.exe`);
    const newest = file(`${root}\\new\\codex.exe`);
    expect(resolveCodexExecutable(windows)).toBe(newest);
    fixture.files.delete(newest);
    expect(resolveCodexExecutable(windows)).toBe(`${root}\\old\\codex.exe`);
  });
  it("honors a relocated Windows LocalAppData", () => {
    const executable = file("E:\\User Data\\OpenAI\\Codex\\bin\\codex.exe");
    expect(resolveCodexExecutable({ ...windows, environment: { LOCALAPPDATA: "E:\\User Data" } })).toBe(executable);
  });
  it("finds a standalone Windows desktop installation", () => {
    const executable = file("C:\\Users\\Test\\AppData\\Local\\Programs\\Codex\\resources\\codex.exe");
    expect(resolveCodexExecutable(windows)).toBe(executable);
  });
  it.each(["bin", "codex"])("resolves a Windows npm shim to the native %s layout without cmd.exe", (directory) => {
    const bin = "C:\\Users\\Test\\AppData\\Roaming\\npm";
    file(`${bin}\\codex.cmd`);
    const executable = file(`${bin}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\${directory}\\codex.exe`);
    expect(resolveCodexExecutable(windows)).toBe(executable);
  });
  it.each(["x64", "arm64"])("supports the Windows npm optional %s package", (architecture) => {
    const prefix = "D:\\npm";
    const cpu = architecture === "arm64" ? "aarch64" : "x86_64";
    const executable = file(`${prefix}\\node_modules\\@openai\\codex-win32-${architecture}\\vendor\\${cpu}-pc-windows-msvc\\bin\\codex.exe`);
    expect(resolveCodexExecutable({ ...windows, architecture, environment: { PATH: prefix } })).toBe(executable);
  });
  it("resolves a macOS npm symlink to its native CLI without requiring node in PATH", () => {
    const root = "/opt/npm/lib/node_modules/@openai/codex";
    fixture.links.set("/opt/npm/bin/codex", `${root}/bin/codex.js`);
    const executable = file("/opt/npm/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
    expect(resolveCodexExecutable({ ...mac, environment: { PATH: "/opt/npm/bin" } })).toBe(executable);
  });
  it.each([mac, windows])("supports an explicit custom installation on $platform", (options) => {
    const executable = file(options.platform === "win32" ? "F:\\Custom Codex\\codex.exe" : "/Volumes/Tools/Codex/codex");
    expect(resolveCodexExecutable({ ...options, environment: { MEMMY_CODEX_EXECUTABLE: executable } })).toBe(executable);
  });
  it("supports CODEX_CLI_PATH and gives the Memmy-specific setting precedence", () => {
    file("/other/codex");
    const executable = file("/chosen/codex");
    expect(resolveCodexExecutable({ ...mac, environment: { CODEX_CLI_PATH: "/other/codex", MEMMY_CODEX_EXECUTABLE: executable } })).toBe(executable);
  });
  it("fails an invalid explicit setting instead of silently choosing another installation", () => {
    file("/opt/homebrew/bin/codex");
    expect(() => resolveCodexExecutable({ ...mac, executable: "/missing/codex" })).toThrow("configured Codex executable is unavailable");
  });
  it("rejects directories, non-executable files, relative PATH entries and an empty PATH", () => {
    fixture.files.set("/Applications/ChatGPT.app/Contents/Resources/codex", { directory: true });
    fixture.files.set("/opt/homebrew/bin/codex", { executable: false });
    file("codex"); file("tools/codex");
    expect(() => resolveCodexExecutable({ ...mac, environment: { PATH: ":tools:" } })).toThrow("MEMMY_CODEX_EXECUTABLE");
  });
  it("reports missing npm native binaries rather than attempting to spawn a .cmd shim", () => {
    file("C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd");
    expect(() => resolveCodexExecutable(windows)).toThrow("Codex CLI executable could not be located");
  });
});
