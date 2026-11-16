import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterFor, adaptersDirectory, ensureAdapter, installedAdapterPath } from "../assist/adapters.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-adapters-"));
  roots.push(root);
  return root;
}

/** 造一个「已经装好」的适配器：node_modules/.bin 里有那个文件就算。 */
function installFake(homeDirectory: string, bin: string): string {
  const binDir = join(adaptersDirectory(homeDirectory), "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, bin);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  return path;
}

/**
 * 造一个真实 npm 的布局：`.bin/<名字>` 是指向包内 `dist/index.js` 的软链接，
 * 目标文件的可执行位由 `mode` 决定。缺执行位正是线上踩到的那次失败。
 */
function installLinked(homeDirectory: string, bin: string, mode: number): { bin: string; target: string } {
  const root = adaptersDirectory(homeDirectory);
  const packageDir = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist");
  mkdirSync(packageDir, { recursive: true });
  const target = join(packageDir, "index.js");
  writeFileSync(target, "#!/usr/bin/env node\n");
  chmodSync(target, mode);
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, bin);
  symlinkSync(join("..", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"), link);
  return { bin: link, target };
}

describe("assist adapters", () => {
  it("only the three agents that lack native ACP need an adapter", () => {
    expect(adapterFor("claude_code")?.bin).toBe("claude-agent-acp");
    expect(adapterFor("codex")?.bin).toBe("codex-acp");
    expect(adapterFor("pi")?.bin).toBe("pi-acp");
    // 原生支持 ACP 的六个不需要适配器：多装一层只会多一个会坏的地方。
    for (const sourceId of ["cursor", "opencode", "openclaw", "hermes", "qwenwork", "deepseek_harness"]) {
      expect(adapterFor(sourceId)).toBeNull();
    }
  });

  it("reuses an adapter that is already there instead of installing again", async () => {
    const root = home();
    const bin = installFake(root, "claude-agent-acp");
    let announced = false;

    const result = await ensureAdapter("claude_code", {
      home: root,
      onInstalling: () => { announced = true; }
    });

    expect(result).toEqual({ executable: bin, installed: false });
    // 已经装好就不该再打扰界面。
    expect(announced).toBe(false);
    expect(installedAdapterPath(adapterFor("claude_code")!, root)).toBe(bin);
  });

  it("gives back the executable bit when npm left the target without it", async () => {
    // 线上就是这样失败的：`.bin` 里的软链接在，但它指向的 dist/index.js 是 -rw-r--r--，
    // spawn 直接 EACCES，界面写「无法启动这个 Agent」。同一次安装只是补个执行位，不该重装。
    if (process.platform === "win32") return;
    const root = home();
    const { bin, target } = installLinked(root, "claude-agent-acp", 0o644);
    let announced = false;

    const result = await ensureAdapter("claude_code", {
      home: root,
      onInstalling: () => { announced = true; }
    });

    expect(result).toEqual({ executable: bin, installed: false });
    expect(announced).toBe(false);
    // 补的是软链接指向的真实文件，不是链接本身。
    expect(statSync(target).mode & 0o111).not.toBe(0);
  });

  it("says plainly that it cannot install when there is no npm on this machine", async () => {
    const root = home();
    const result = await ensureAdapter("claude_code", { home: root, env: { PATH: "" } });

    // 装不上也要有一句人能读懂的原因：对方点完允许却一直等不到结果是最坏的情况。
    expect(result?.executable).toBeNull();
    expect(result?.failure).toContain("没有 npm");
  });

  it("does nothing for an agent with native ACP", async () => {
    expect(await ensureAdapter("cursor", { home: home() })).toBeNull();
  });

  it("installs once when several executions need the same adapter at the same time", async () => {
    const root = home();
    let announced = 0;
    // 不同排查的请求会同时执行：两个人恰好都选了这个 Agent 时，不能装两次到同一个 node_modules。
    const installs = [0, 1, 2].map(() => ensureAdapter("codex", {
      home: root,
      env: { PATH: "" },
      onInstalling: () => { announced += 1; }
    }));
    const results = await Promise.all(installs);

    // 三份拿到的必须是同一个结论，而不是各装一遍。
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    // 只让界面看到一次「准备运行组件」。
    expect(announced).toBe(1);
  });

  it("keeps adapters beside the rest of the assist state", () => {
    expect(adaptersDirectory("/tmp/example-home")).toBe("/tmp/example-home/assist/adapters");
  });
});