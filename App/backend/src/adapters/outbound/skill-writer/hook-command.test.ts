import { describe, expect, it } from "vitest";
import { resolveNodeExecutable, type NodeExecutableRuntime } from "./hook-command.js";

const HOME = "/Users/test";

describe("resolveNodeExecutable", () => {
  it.each([
    "/Applications/Memmy.app/Contents/MacOS/Memmy",
    "/Volumes/Memmy Installer/Memmy.app/Contents/MacOS/Memmy",
    "/Applications/Electron.app/Contents/MacOS/Electron",
    "/applications/MEMMY.APP/contents/macos/Memmy"
  ])("rejects a packaged app host from process.execPath: %s", (execPath) => {
    expect(resolveNodeExecutable(runtime({ execPath, executable: [execPath, "/opt/homebrew/bin/node"] })))
      .toBe("/opt/homebrew/bin/node");
  });

  it("rejects packaged app hosts supplied through environment overrides", () => {
    const appHost = "/Applications/Memmy.app/Contents/MacOS/Memmy";
    expect(resolveNodeExecutable(runtime({
      env: { MEMMY_HOOK_NODE: appHost, NODE: "/usr/local/bin/node" },
      executable: [appHost, "/usr/local/bin/node"]
    }))).toBe("/usr/local/bin/node");
  });

  it("rejects a branded non-Node process executable", () => {
    const execPath = "/usr/local/bin/memmy";
    expect(resolveNodeExecutable(runtime({ execPath, executable: [execPath, "/opt/homebrew/bin/node"] })))
      .toBe("/opt/homebrew/bin/node");
  });

  it("preserves override, process, known-path, and PATH fallback precedence", () => {
    expect(resolveNodeExecutable(runtime({
      env: { MEMMY_HOOK_NODE: "/custom/bin/node" },
      execPath: "/runtime/bin/node",
      executable: ["/custom/bin/node", "/runtime/bin/node"]
    }))).toBe("/custom/bin/node");

    expect(resolveNodeExecutable(runtime({
      execPath: "/runtime/bin/node",
      executable: ["/runtime/bin/node", "/opt/homebrew/bin/node"]
    }))).toBe("/runtime/bin/node");

    expect(resolveNodeExecutable(runtime({
      execPath: "/Applications/Memmy.app/Contents/MacOS/Memmy",
      executable: ["/usr/local/bin/node"]
    }))).toBe("/usr/local/bin/node");

    expect(resolveNodeExecutable(runtime())).toBe("node");
  });

  it("skips absolute candidates that exist but are not executable files", () => {
    expect(resolveNodeExecutable(runtime({
      env: { MEMMY_HOOK_NODE: "/custom/bin/node" },
      executable: ["/opt/homebrew/bin/node"]
    }))).toBe("/opt/homebrew/bin/node");
  });
});

function runtime(overrides: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  executable?: string[];
} = {}): NodeExecutableRuntime {
  const executable = new Set(overrides.executable ?? []);
  return {
    platform: "darwin",
    env: overrides.env ?? {},
    execPath: overrides.execPath ?? "/missing/runtime/node",
    hermesHomeDirectory: HOME,
    isExecutableFile: (candidate) => executable.has(candidate)
  };
}
