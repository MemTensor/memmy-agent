import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDeepseekHarnessSourceAdapter } from "../../../../Memory/src/agent-source/adapters/deepseek-harness/adapter.js";
import { createSourceRegistry } from "../../../../Memory/src/agent-source/adapters/source-registry.js";
import { createDeepseekHarnessSkillTarget as createMemoryTarget } from "../../../../Memory/src/agent-source/integration/deepseek-harness/target.js";
import { createAgentSourceExecutor } from "../../../../Memory/src/agent-source/runtime.js";
import type { MemoryService } from "../../../../Memory/src/service/memory-service.js";
import { createDeepseekHarnessSkillTarget as createDesktopTarget } from "../adapters/outbound/skill-writer/deepseek-harness/target.js";

it("reports desktop DSH installs and reinstalls in the standalone Memory source list", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "memmy-dsh-install-"));
  vi.stubEnv("DSH_HOME", rootDirectory);
  vi.stubEnv("MEMMY_HOME", join(rootDirectory, "memmy-home"));
  const memmyConfigPath = join(rootDirectory, "config.yaml");
  const deps = { rootDirectory, memmyConfigPath };
  const desktop = createDesktopTarget(deps);
  const memory = createAgentSourceExecutor({
    service: {} as MemoryService,
    configPath: memmyConfigPath,
    sourceRegistry: createSourceRegistry([createDeepseekHarnessSourceAdapter(deps)])
  });
  async function status() {
    const { sources } = await memory.list();
    return sources[0].status;
  }

  try {
    expect(await status()).toBe("not_connected");
    await desktop.installPlugin!("deepseek_harness");
    expect(await status()).toBe("plugin_installed");
    expect(await createMemoryTarget(deps).isInstalledHookCurrent!()).toBe(true);

    // Existing installs have a config but predate the integrity field.
    const config = join(rootDirectory, "profiles/node_modules/@memmy/memmy-memory/memmy-memory-config.json");
    const legacy = JSON.parse(await readFile(config, "utf8"));
    delete legacy.bridge_integrity;
    await writeFile(config, JSON.stringify(legacy));
    expect(await status()).toBe("plugin_installed");

    await desktop.uninstallPlugin!("deepseek_harness");
    expect(await status()).toBe("not_connected");
    await desktop.installPlugin!("deepseek_harness");
    expect(await status()).toBe("plugin_installed");
  } finally {
    await memory.dispose();
    vi.unstubAllEnvs();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
