import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isWindows11, resolveWindowsHistoryBinary, windowsApplicationCatalogCommand, windowsObserverCommand } from "../../../../src/tools/computer-history/win/win11.js";

const scopeHarness = fileURLToPath(new URL("./win11-observer-scope.ps1", import.meta.url));
const observerSource = fileURLToPath(new URL("../../../../src/tools/computer-history/win/win11-observer.ps1", import.meta.url));
// Windows must exercise the shipped PowerShell 5.1 runtime. Other hosts can
// opt into an isolated portable PowerShell 7 runtime for language semantics.
const scopePowerShell = process.platform === "win32" ? windowsApplicationCatalogCommand().binary : process.env.MEMMY_TEST_POWERSHELL;

const fixtureRoots: string[] = [];
afterEach(() => { for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function nativeFixture(root: string, arch = "amd64", machine = 0x8664): string {
  const binary = path.join(root, "windows", arch, "memmy-computer-history.exe");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const bytes = Buffer.alloc(256);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(0x20b, 88);
  bytes.write("MemmyWindowsHistoryRuntimeV1", 128);
  fs.writeFileSync(binary, bytes);
  return binary;
}

function assetFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-native-")); fixtureRoots.push(root); return root;
}

describe("Windows 11 Computer History platform gate", () => {
  it("requires the source-built native recorder and never falls back to the old polling script", () => {
    const assetRoot = assetFixture();
    expect(() => resolveWindowsHistoryBinary({ assetRoot, arch: "x64" })).toThrow("recorder is missing");
    const binary = nativeFixture(assetRoot);
    expect(resolveWindowsHistoryBinary({ assetRoot, arch: "x64" })).toBe(binary);
    expect(() => resolveWindowsHistoryBinary({ assetRoot, arch: "arm64" })).toThrow("recorder is missing");
    expect(() => resolveWindowsHistoryBinary({ assetRoot, arch: "ia32" })).toThrow("Unsupported");
    fs.writeFileSync(binary, "inert fixture");
    expect(() => resolveWindowsHistoryBinary({ assetRoot, arch: "x64" })).toThrow("invalid or incompatible");
  });

  it("requires an unpacked helper for packaged execution and rejects a different architecture", () => {
    const root = assetFixture();
    const packedRoot = path.join(root, "app.asar", "dist", "native-computer-history");
    nativeFixture(packedRoot);
    expect(() => resolveWindowsHistoryBinary({ assetRoot: packedRoot, arch: "x64" })).toThrow("recorder is missing");
    const unpackedRoot = packedRoot.replace("app.asar", "app.asar.unpacked");
    const binary = nativeFixture(unpackedRoot);
    expect(resolveWindowsHistoryBinary({ assetRoot: packedRoot, arch: "x64" })).toBe(binary);
    nativeFixture(unpackedRoot, "amd64", 0xaa64);
    expect(() => resolveWindowsHistoryBinary({ assetRoot: packedRoot, arch: "x64" })).toThrow("invalid or incompatible");
  });
  it("accepts Windows 11 builds while rejecting Windows 10 and other platforms", () => {
    expect(isWindows11("win32", "10.0.22000")).toBe(true);
    expect(isWindows11("win32", "10.0.22631")).toBe(true);
    expect(isWindows11("win32", "10.0.19045")).toBe(false);
    expect(isWindows11("darwin", "10.0.22631")).toBe(false);
  });

  it("keeps app catalog enumeration as a noninteractive PowerShell file", () => {
    const command = windowsApplicationCatalogCommand();
    expect(command.binary.toLowerCase()).toMatch(/windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/u);
    expect(command.args).toContain("-NonInteractive");
    expect(command.args).toContain("-STA");
    expect(command.args.at(-2)).toBe("-File");
    expect(command.args.at(-1)).toMatch(/win11-observer\.ps1$/u);
  });

  it("keeps the bounded Windows worker and content-free diagnostic protocol in the distributed asset", () => {
    const script = fs.readFileSync(new URL("../../../../src/tools/computer-history/win/win11-observer.ps1", import.meta.url), "utf8");
    expect(script).toContain("function InvokeHistorySample");
    expect(script).toContain("[int]$timeoutMs = 4000");
    expect(script).toContain("$worker.WaitForExit($timeoutMs)");
    expect(script).toContain("$worker.Kill()");
    expect(script).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(script).toContain("AssignProcessToJobObject");
    expect(script).toContain("[MemmyHistoryParentWatchdog]::Start($ParentProcessId, $ParentStartTimeTicks)");
    expect(script).not.toMatch(/Thread\.Abort\s*\(/u);
    const diagnostic = script.slice(script.indexOf("function RecorderDiagnostic"), script.indexOf("function UpdateObserverHealth"));
    expect(diagnostic).toContain("type = 'recorder.diagnostic'");
    expect(diagnostic).not.toMatch(/app|title|url|snapshot|text/iu);
  });

  it("keeps the Windows helper free of brittle browser-chrome scraping and defers URL and privacy to the Node layer", () => {
    const script = fs.readFileSync(new URL("../../../../src/tools/computer-history/win/win11-observer.ps1", import.meta.url), "utf8");
    // The helper must not key on a profile-button class, an Edge title format,
    // or an omnibox view class: those break on any browser UI redesign, locale
    // or theme. Those decisions moved to the durable Node layer.
    for (const brittle of ["nativeProfileButtonClasses", "ProfileButtonVerdict", "EdgeTitleProfile",
      "OmniboxViewViews", "function BrowserContext", "normalProfile"]) {
      expect(script).not.toContain(brittle);
    }
    // It only pre-filters a plainly private title so that window's tree never
    // leaves the helper; the real verdict and URL come from the Node layer.
    expect(script).toContain("function IsBlatantlyPrivateTitle");
    expect(script).toContain("if ($browser -and (IsBlatantlyPrivateTitle $title))");
    const sample = script.slice(script.indexOf("function CaptureWindowSample"), script.indexOf("function NormalizeWorkerSample"));
    expect(sample).not.toMatch(/\$event\.window\.url =/u);
    // Window titles are still read as Unicode so Edge's U+200B survives, and the
    // stale-foreground guard still protects the emitted tree.
    expect(script).toContain('[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(');
    expect(script).toContain("Window title was not read as Unicode");
    expect(script).toContain("if (-not (SampleStillForeground $workerSample))");
  });

  it("preserves zero, one and multiple app catalog rows as one flat JSON array", () => {
    const script = fs.readFileSync(new URL("../../../../src/tools/computer-history/win/win11-observer.ps1", import.meta.url), "utf8");
    const catalog = script.slice(script.indexOf("function ApplicationCatalogJson"), script.indexOf("if ($List)"));
    expect(catalog).toContain("$json.TrimStart().StartsWith('[')");
    expect(catalog).not.toContain("$apps.Count -eq 1");
    expect(script).toContain("foreach ($size in 0..2)");
  });

  it.runIf(Boolean(scopePowerShell))("executes the real supervisor with its typed script parameters without observing a desktop", async () => {
    const { stdout } = await promisify(execFile)(scopePowerShell!, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scopeHarness, "-ObserverPath", observerSource,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
    expect(JSON.parse(stdout.trim())).toMatchObject({ realSupervisor: true, sampleSwitchPreserved: true,
      fixtures: 8, events: 3, staleForegroundSuppressed: true, duplicateSuppressed: true, observerRecovery: true });
  });

  it.runIf(Boolean(scopePowerShell))("reproduces the Hashtable to SwitchParameter failure if the old supervisor variable returns", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-observer-scope-"));
    try {
      const source = fs.readFileSync(observerSource, "utf8");
      const supervisorStart = source.indexOf("$lastWindow =");
      expect(supervisorStart).toBeGreaterThan(0);
      const brokenSource = source.slice(0, supervisorStart) + source.slice(supervisorStart).replace(/\$workerSample\b/gu, "$sample");
      expect(brokenSource).not.toBe(source);
      const brokenPath = path.join(directory, "win11-observer.ps1");
      fs.writeFileSync(brokenPath, brokenSource);
      const result = await promisify(execFile)(scopePowerShell!, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scopeHarness, "-ObserverPath", brokenPath,
      ], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true }).then(
        () => { throw new Error("Broken observer unexpectedly passed"); },
        (error: Error & { stderr?: string }) => error,
      );
      expect(result.stderr).toContain("SwitchParameter");
      // 5.1 reports a Hashtable conversion; 7 attempts property binding. Both
      // must fail at the production assignment before the static name audit.
      expect(result.stderr).toContain("$sample = InvokeHistorySample");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("runs the source-built native recorder self-test without accessing a desktop", async () => {
    const command = windowsObserverCommand({ parentPid: 42, wechatConsentPath: "C:\\test\\consent.json" });
    expect(command.args).toEqual(["--observe", "--parent-pid=42", "--wechat-consent=C:\\test\\consent.json"]);
    expect(command.binary).toMatch(/memmy-computer-history\.exe$/u);
    const { stdout } = await promisify(execFile)(command.binary, ["--self-test"], {
      timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(JSON.parse(stdout.trim())).toMatchObject({ runtimeId: "MemmyWindowsHistoryRuntimeV1", pureSelfTest: true, desktopAccess: false });
  });

  it.runIf(process.platform === "win32" && process.env.MEMMY_TEST_WINDOWS_HISTORY_DESKTOP === "1")("validates legacy UIA catalog helper on an explicitly enabled synthetic desktop", async () => {
    const command = windowsApplicationCatalogCommand();
    const { stdout } = await promisify(execFile)(command.binary, [...command.args, "-SelfTest"], {
      timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const probe = JSON.parse(stdout.trim());
    expect(probe).toMatchObject({ platform: "Windows 11", uia: true, passwordRedacted: true,
      boundedWorker: true, observerRecovery: true, privacyFailClosed: true, catalogFlatArray: true });
  });
});
