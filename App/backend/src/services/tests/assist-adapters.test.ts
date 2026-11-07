import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("keeps adapters beside the rest of the assist state", () => {
    expect(adaptersDirectory("/tmp/example-home")).toBe("/tmp/example-home/assist/adapters");
  });
});