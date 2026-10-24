import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { WindowsApplicationIconReader } from "../../../../src/tools/computer-history/win/application-icon.js";

function png(): string {
  const bytes = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(64, 20);
  return bytes.toString("base64");
}

function requestedIds(args: string[]): string[] {
  const argument = args[args.indexOf("-IdsBase64") + 1];
  return JSON.parse(Buffer.from(argument!, "base64").toString("utf8")) as string[];
}

describe("Windows Computer History application icons", () => {
  it.runIf(process.platform === "win32")("resolves sharp Squirrel shortcut icons and preserves alpha with real Windows PowerShell and Shell APIs", async () => {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const harness = fileURLToPath(new URL("./application-icon-shortcuts.ps1", import.meta.url));
    const source = fileURLToPath(new URL("../../../../src/tools/computer-history/win/app-icon.ps1", import.meta.url));
    const { stdout } = await promisify(execFile)(powershell, [
      "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", harness, "-HelperPath", source,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
    expect(JSON.parse(stdout.trim())).toMatchObject({
      sameNameIco: true, sameNameExe: true, differentNameIco: true, highResolutionFrame: true,
      onePixelDetail: true, transparentPixels: true, semitransparentPixels: true, smallFrameFallback: true,
      directExeHighResolution: true,
    });
  }, 25_000);

  it("coalesces timeline and picker requests, validates PNGs, and caches successes", async () => {
    const run = vi.fn(async (_binary: string, args: string[], _options: unknown) => {
      const ids = requestedIds(args);
      expect(ids).toEqual(["win32.explorer", "win32.chrome", "win32.missing"]);
      return { stdout: JSON.stringify({
        "win32.explorer": png(),
        "win32.chrome": png(),
        "win32.missing": null,
      }) };
    });
    const reader = new WindowsApplicationIconReader({ platform: "win32", script: "C:\\app-icon.ps1", run });
    const [explorer, chrome, duplicate, missing] = await Promise.all([
      reader.iconFor("win32.explorer"), reader.iconFor("win32.chrome"),
      reader.iconFor("win32.explorer"), reader.iconFor("win32.missing"),
    ]);
    expect(explorer).toBe(`data:image/png;base64,${png()}`);
    expect(chrome).toBe(`data:image/png;base64,${png()}`);
    expect(duplicate).toBe(explorer);
    expect(missing).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      "-NoProfile", "-NonInteractive", "-STA", "-File", "C:\\app-icon.ps1",
    ]));
    expect(run.mock.calls[0]![2]).toMatchObject({ timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    await reader.iconFor("win32.chrome");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never passes a path or malformed id to PowerShell", async () => {
    const run = vi.fn(async () => ({ stdout: "{}" }));
    const reader = new WindowsApplicationIconReader({ platform: "win32", run });
    for (const id of ["C:\\Windows\\explorer.exe", "win32.chrome;Remove-Item", "win32.", "com.apple.Notes",
      "win32.applicationframehost", `win32.${"a".repeat(129)}`]) {
      expect(await reader.iconFor(id)).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
    const mac = new WindowsApplicationIconReader({ platform: "darwin", run });
    expect(await mac.iconFor("win32.chrome")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts every process id shape already emitted by the Windows catalog", async () => {
    const run = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: JSON.stringify(Object.fromEntries(requestedIds(args).map((id) => [id, png()]))),
    }));
    const reader = new WindowsApplicationIconReader({ platform: "win32", run });
    const ids = ["win32._helper", "win32.-helper", "win32..helper"];
    const icons = await Promise.all(ids.map((id) => reader.iconFor(id)));
    expect(icons).toHaveLength(ids.length);
    expect(icons.every((icon) => icon?.startsWith("data:image/png;base64,"))).toBe(true);
    expect(requestedIds(run.mock.calls[0]![1])).toEqual(ids);
  });

  it("bounds invocation count and lets a failed or missing icon retry", async () => {
    const run = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: JSON.stringify(Object.fromEntries(requestedIds(args).map((id) => [id, png()]))),
    }));
    const reader = new WindowsApplicationIconReader({ platform: "win32", run });
    const icons = await Promise.all(Array.from({ length: 49 }, (_, index) => reader.iconFor(`win32.app${index}`)));
    expect(icons.every((icon) => icon?.startsWith("data:image/png;base64,"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(requestedIds(run.mock.calls[0]![1])).toHaveLength(48);
    expect(requestedIds(run.mock.calls[1]![1])).toHaveLength(1);

    const failing = vi.fn().mockRejectedValueOnce(new Error("PowerShell unavailable"))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ "win32.chrome": png() }) });
    const recovery = new WindowsApplicationIconReader({ platform: "win32", run: failing });
    expect(await recovery.iconFor("win32.chrome")).toBeNull();
    expect(await recovery.iconFor("win32.chrome")).toBe(`data:image/png;base64,${png()}`);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("keeps icon resolution local and releases the Shell icon handle", () => {
    const script = fs.readFileSync(fileURLToPath(new URL("../../../../src/tools/computer-history/win/app-icon.ps1", import.meta.url)), "utf8");
    expect(script).toContain("Get-Process");
    expect(script).toContain("GetFolderPath('StartMenu')");
    expect(script).toContain("GetFolderPath('CommonStartMenu')");
    expect(script).toContain("SHGetFileInfoW");
    expect(script).toContain("SHDefExtractIconW");
    expect(script).toContain("DestroyIcon(handle)");
    expect(script).toContain("if (extracted != IntPtr.Zero) DestroyIcon(extracted)");
    expect(script).toContain("$source.Count -ne 1");
    expect(script).toContain("$runningCandidates.ContainsKey($id)");
    expect(script).toContain("[IO.Path]::IsPathRooted($expanded)");
    expect(script).toContain(String.raw`$expanded -notmatch '^[A-Za-z]:[\\/]'`);
  });
});
