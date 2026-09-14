import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { runCommand } from "../../../../Memory/src/cli/commands.js";
import { runtimeTarget } from "../../../../Memory/src/cli/runtime-installer.js";
import { MEMORY_PROTOCOL_VERSION, MEMORY_SERVICE_VERSION } from "../../../../Memory/src/version.js";
import { bundledMemoryInstallArguments, preparePackagedRuntimeConfig } from "../src/main/runtime-services.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundled Memory installation", () => {
  it.each([false, true])("installs without importing legacy plugins when a Memmy config preexisted: %s", async (configPreexisted) => {
    const root = await mkdtemp(join(tmpdir(), "memmy-bundled-install-"));
    roots.push(root);
    const runtimeDirectory = join(root, "bundle");
    const entrypoint = join("dist", "src", "server", "index.js");
    await mkdir(join(runtimeDirectory, "dist", "src", "server"), { recursive: true });
    await writeFile(join(runtimeDirectory, entrypoint), "// Synthetic runtime; never executed.\n");
    await writeFile(join(runtimeDirectory, "memory-runtime.json"), JSON.stringify({
      version: MEMORY_SERVICE_VERSION,
      protocolVersion: MEMORY_PROTOCOL_VERSION,
      target: runtimeTarget(process.platform, process.arch),
      entrypoint
    }));

    // A fresh Desktop prepares config defaults before invoking the installer.
    const runtimeConfig = await preparePackagedRuntimeConfig({
      env: { MEMMY_HOME: join(root, "memmy") },
      fillMissingAgentSecret: false
    });
    const existingData = "existing Memmy database must not be opened by installation";
    if (configPreexisted) await writeFile(runtimeConfig.memoryDatabasePath, existingData);
    const configBefore = await readFile(runtimeConfig.configPath, "utf8");
    const legacyFiles: Array<[string, string]> = [];
    for (const agent of ["openclaw", "hermes"]) {
      const legacyDirectory = join(root, `.${agent}`, "memos-plugin");
      await mkdir(join(legacyDirectory, "data"), { recursive: true });
      legacyFiles.push(
        [join(legacyDirectory, "config.yaml"), `llm:\n  model: legacy-${agent}\n`],
        [join(legacyDirectory, "data", "memos.db"), "unreadable legacy database"]
      );
    }
    await Promise.all(legacyFiles.map(([path, content]) => writeFile(path, content)));

    const result = await runCommand({
      argv: [
        ...bundledMemoryInstallArguments(runtimeDirectory, runtimeConfig, configPreexisted, process.execPath),
        "--legacy-root", root,
        // Exercise installation without registering or launching an OS service.
        "--skip-service-registration",
        "--skip-health-check"
      ]
    });

    expect(result).toMatchObject({ ok: true, command: "install", serviceOnly: true });
    expect(result).not.toHaveProperty("migration");
    const installed = JSON.parse(await readFile(join(root, "memmy", "memory-service", "current.json"), "utf8"));
    expect(installed.version).toBe(MEMORY_SERVICE_VERSION);
    expect(await readFile(installed.entrypoint, "utf8")).toBe("// Synthetic runtime; never executed.\n");
    const configAfter = YAML.parse(await readFile(runtimeConfig.configPath, "utf8"));
    expect(configAfter).toMatchObject(YAML.parse(configBefore));
    expect(configAfter.memmyMemory).not.toHaveProperty("migratedFrom");
    if (configPreexisted) {
      expect(await readFile(runtimeConfig.memoryDatabasePath, "utf8")).toBe(existingData);
    } else {
      await expect(readFile(runtimeConfig.memoryDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [path, content] of legacyFiles) expect(await readFile(path, "utf8")).toBe(content);
  });
});
