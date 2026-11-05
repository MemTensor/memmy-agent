import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSIST_COMMAND_ENV, assistRunnable } from "../assist/recipes.js";

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
});
