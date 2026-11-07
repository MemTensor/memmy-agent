import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepseekHarnessSkillTarget } from "../src/agent-source/integration/deepseek-harness/target.js";

let rootDirectory: string | undefined;

afterEach(async () => {
  if (rootDirectory) await rm(rootDirectory, { recursive: true, force: true });
  rootDirectory = undefined;
});

describe("DeepSeek Harness target configuration", () => {
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
