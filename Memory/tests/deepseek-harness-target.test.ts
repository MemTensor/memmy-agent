import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepseekHarnessSkillTarget } from "../src/agent-source/integration/deepseek-harness/target.js";
import * as runtimeLoader from "../src/agent-source/integration/workspace-bridge/runtime-loader.js";

let rootDirectory: string | undefined;

afterEach(async () => {
  if (rootDirectory) await rm(rootDirectory, { recursive: true, force: true });
  rootDirectory = undefined;
});

describe("DeepSeek Harness target configuration", () => {
  it("keeps the installed entry point when loading the replacement bridge fails", async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "memmy-dsh-target-"));
    const pluginDirectory = join(rootDirectory, "profiles/node_modules/@memmy/memmy-memory");
    await mkdir(pluginDirectory, { recursive: true });
    const entryPath = join(pluginDirectory, "index.mjs");
    const previousEntry = "export const name = 'previous-plugin';";
    await writeFile(entryPath, previousEntry);
    const unavailableBridge = vi.spyOn(runtimeLoader, "loadMemmyWorkspaceBridgeRuntimeAsset")
      .mockRejectedValueOnce(new Error("bridge unavailable"));
    try {
      const target = createDeepseekHarnessSkillTarget({
        rootDirectory,
        memmyConfigPath: join(rootDirectory, "config.yaml")
      });
      await expect(target.installPlugin!("deepseek_harness")).rejects.toThrow("bridge unavailable");
      await expect(readFile(entryPath, "utf8")).resolves.toBe(previousEntry);
    } finally {
      unavailableBridge.mockRestore();
    }
  });

  it("rejects malformed plugin config and accepts a structurally valid legacy config", async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "memmy-dsh-target-"));
    await mkdir(join(rootDirectory, "profiles"), { recursive: true });
    const target = createDeepseekHarnessSkillTarget({
      rootDirectory,
      memmyConfigPath: join(rootDirectory, "config.yaml")
    });
    await target.installPlugin!("deepseek_harness");
    const configPath = join(rootDirectory, "profiles/node_modules/@memmy/memmy-memory/memmy-memory-config.json");
    const installed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await expect(target.isInstalledHookCurrent!()).resolves.toBe(true);

    const legacy = {
      memmy_config_path: installed.memmy_config_path,
      endpoint: installed.endpoint,
      token: installed.token
    };
    await writeFile(configPath, JSON.stringify(legacy));
    await expect(target.isInstalledHookCurrent!()).resolves.toBe(true);

    for (const malformed of ["{}", "[]", "null", "not-json"]) {
      await writeFile(configPath, malformed);
      await expect(target.isInstalledHookCurrent!()).resolves.toBe(false);
    }
    await writeFile(configPath, JSON.stringify({ ...legacy, endpoint: "" }));
    await expect(target.isInstalledHookCurrent!()).resolves.toBe(false);
    await writeFile(configPath, JSON.stringify({ ...legacy, token: 7 }));
    await expect(target.isInstalledHookCurrent!()).resolves.toBe(false);
    await writeFile(configPath, JSON.stringify({ ...legacy, workspaceHostId: 7 }));
    await expect(target.isInstalledHookCurrent!()).resolves.toBe(false);
    await writeFile(configPath, JSON.stringify({ ...legacy, bridge_integrity: "1:not-a-digest" }));
    await expect(target.isInstalledHookCurrent!()).resolves.toBe(false);
  });
});
