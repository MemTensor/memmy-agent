import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSIST_COMMAND_ENV, assistAgentName, assistRecipe, assistRunnable } from "../assist/recipes.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一个只放了给定命令的 PATH 目录：其余命令都找不到。 */
function binWith(...commands: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-bin-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const command of commands) {
    const file = join(bin, command);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return bin;
}

/**
 * 执行方候选只放能运行的 Agent。常见目录（Homebrew、~/.local/bin 等）也会被查，
 * 所以这里用这台电脑上不可能存在的命令名来覆盖配方，验证判断依据而不是本机装了什么。
 */
describe("assistRunnable", () => {
  it("checks the agent's own command line for agents that need an adapter", () => {
    const env = { PATH: binWith("claude") } as NodeJS.ProcessEnv;
    // Claude Code 看 claude 本体：适配器可以授权后再装，本体在就能跑。
    expect(assistRunnable("claude_code", env)).toBe(true);
    expect(assistRunnable("memmy", env)).toBe(true);
  });

  it("uses the override command when one is set", () => {
    const bin = binWith("pi-from-override-xyz");
    expect(assistRunnable("pi", {
      PATH: bin,
      [ASSIST_COMMAND_ENV("pi")]: "pi-from-override-xyz --acp"
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(assistRunnable("pi", {
      PATH: bin,
      [ASSIST_COMMAND_ENV("pi")]: "pi-missing-command-xyz"
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("never lists an agent Memmy has no recipe for", () => {
    expect(assistRunnable("added-qoder-82ef827e", { PATH: binWith("qoder") } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("never offers WorkBuddy, even when its old command line is on PATH", () => {
    // WorkBuddy 2026-11-05 下线：`codebuddy` 拉起的是另外安装的 CodeBuddy 命令行，不是 WorkBuddy 自己。
    const env = { PATH: binWith("codebuddy") } as NodeJS.ProcessEnv;
    expect(assistRunnable("workbuddy", env)).toBe(false);
    expect(assistRecipe("workbuddy", env)).toBeNull();
    // 以前带着它执行过的记录仍然按名字显示，不会露出标识。
    expect(assistAgentName("workbuddy")).toBe("WorkBuddy");
  });

  /** 一个 --version 输出给定版本的 dsh。 */
  function dshWithVersion(version: string): string {
    const bin = binWith("dsh");
    writeFileSync(join(bin, "dsh"), `#!/bin/sh\necho "${version}"\n`);
    return bin;
  }

  it("needs a DeepSeek Harness desktop app or a dsh that supports acp", () => {
    const old = { PATH: dshWithVersion("0.1.0-rc.6") } as NodeJS.ProcessEnv;
    // 0.1.x 没有 acp profile：不能当作可执行方，否则用户选了它总是失败。
    expect(assistRunnable("deepseek_harness", old, { appDirs: [] })).toBe(false);

    const fresh = { PATH: dshWithVersion("0.2.1-rc.5") } as NodeJS.ProcessEnv;
    expect(assistRunnable("deepseek_harness", fresh, { appDirs: [] })).toBe(true);
  });

  it("accepts DeepSeek Harness when only its desktop app is installed", () => {
    // 只装了桌面版、没有 dsh 命令行：应当算可运行（入口用桌面版自带的引擎）。
    const root = mkdtempSync(join(tmpdir(), "memmy-assist-app-"));
    roots.push(root);
    const bundle = join(root, "DeepSeek Harness.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "MacOS", "DeepSeek Harness"), "#!/bin/sh\n");
    writeFileSync(join(bundle, "Contents", "Resources", "app.asar"), "fake asar");

    const env = { PATH: binWith() } as NodeJS.ProcessEnv;
    expect(assistRunnable("deepseek_harness", env, { appDirs: [bundle] })).toBe(true);
  });
});
