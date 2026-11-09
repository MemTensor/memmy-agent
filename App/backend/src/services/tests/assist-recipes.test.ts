import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptersDirectory } from "../assist/adapters.js";
import {
  ASSIST_COMMAND_ENV,
  assistAgentName,
  assistRecipe,
  assistRunnable,
  defaultQwenWorkAppDirs,
  qwenWorkEngine
} from "../assist/recipes.js";

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
  /** 一个临时 home：把适配器目录与真实的 ~/.memmy 隔开。 */
  function tempHome(): string {
    const root = mkdtempSync(join(tmpdir(), "memmy-assist-home-"));
    roots.push(root);
    return root;
  }

  /** 造一个「适配器已装好」的 home。 */
  function homeWithAdapter(bin: string): string {
    const root = tempHome();
    const binDir = join(adaptersDirectory(root), "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, bin), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, bin), 0o755);
    return root;
  }

  it("treats Claude Code and Codex as usable once their adapter is there", () => {
    // 适配器自带引擎（各自依赖 claude / codex 的可执行包），不需要 PATH 上有 claude / codex：
    // 只装了 Claude App 或 Codex App 的人命令行上并没有这两个命令。
    expect(assistRunnable("claude_code", { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv, {
      home: homeWithAdapter("claude-agent-acp")
    })).toBe(true);
    expect(assistRunnable("codex", { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv, {
      home: homeWithAdapter("codex-acp")
    })).toBe(true);
  });

  it("treats Claude Code and Codex as usable when npm and node are there to install the adapter", () => {
    const bin = binWith("npm", "node");
    const env = { PATH: bin } as NodeJS.ProcessEnv;
    expect(assistRunnable("claude_code", env, { home: tempHome() })).toBe(true);
    expect(assistRunnable("codex", env, { home: tempHome() })).toBe(true);
  });

  it("still needs the pi command itself, because its adapter drives pi", () => {
    expect(assistRunnable("pi", { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv, { home: tempHome() })).toBe(false);
    expect(assistRunnable("pi", { PATH: binWith("pi") } as NodeJS.ProcessEnv, { home: tempHome() })).toBe(true);
  });

  it("finds QwenWork's engine inside its app bundle", () => {
    // 引擎既不在 PATH 上也不在常见命令目录里，只在应用包里；按 PATH 找会一直说它不可用。
    const root = mkdtempSync(join(tmpdir(), "memmy-assist-qwenwork-"));
    roots.push(root);
    const bundle = join(root, "QwenWorkCN.app");
    const bin = join(bundle, "Contents", "Resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "qoderclicn"), "#!/bin/sh\n");
    chmodSync(join(bin, "qoderclicn"), 0o755);

    const env = { PATH: binWith() } as NodeJS.ProcessEnv;
    expect(qwenWorkEngine(env, [bundle])).toBe(join(bin, "qoderclicn"));
    expect(assistRunnable("qwenwork", env, { qwenWorkAppDirs: [bundle] })).toBe(true);
    // 没有这个应用包时不能凭空说它能用。
    expect(assistRunnable("qwenwork", env, { qwenWorkAppDirs: [join(root, "NotThere.app")] })).toBe(false);
  });

  it("checks the agent's own command line for agents with native ACP", () => {
    expect(assistRunnable("cursor", { PATH: binWith("cursor-agent") } as NodeJS.ProcessEnv)).toBe(true);
    expect(assistRunnable("memmy", { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv)).toBe(true);
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

  it("does not guess where QwenWork lives on Windows", () => {
    // Windows 上的安装位置与包内层级都没核实过：宁可给空列表让它退回 PATH 上找 qoderclicn，
    // 也不要指一个错的目录（失败原因会说不清楚）。
    expect(defaultQwenWorkAppDirs("win32")).toEqual([]);
    expect(defaultQwenWorkAppDirs("darwin")).toContain("/Applications/QwenWorkCN.app");
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
