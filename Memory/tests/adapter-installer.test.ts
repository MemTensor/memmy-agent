import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { installAgentAdapters } from "../src/cli/adapter-installer.js";
import type { InstalledRuntimePointer } from "../src/cli/runtime-installer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("thin HTTP agent adapters", () => {
  it("installs and configures OpenClaw and Hermes without shipping another Core", async () => {
    const root = tempRoot();
    const runtime = fixtureRuntime(root);
    mkdirSync(join(root, ".openclaw"), { recursive: true });
    mkdirSync(join(root, ".hermes"), { recursive: true });
    writeFileSync(join(root, ".openclaw", "openclaw.json"), "{\n  // keep user comments\n  \"plugins\": {}\n}\n");
    writeFileSync(join(root, ".hermes", "config.yaml"), "model: test-model\n");

    const installed = await installAgentAdapters({
      agents: ["openclaw", "hermes"], runtime, userHome: root, explicit: true, restartHosts: false
    });
    expect(installed.map((item) => item.installed)).toEqual([true, true]);
    const openClawConfig = readFileSync(join(root, ".openclaw", "openclaw.json"), "utf8");
    expect(openClawConfig).toContain("keep user comments");
    expect(openClawConfig).toContain('"memory": "memmy-memory"');
    expect(existsSync(join(root, ".openclaw", "plugins", "memmy-memory", "index.js"))).toBe(true);
    const hermes = parseYaml(readFileSync(join(root, ".hermes", "config.yaml"), "utf8")) as Record<string, any>;
    expect(hermes).toMatchObject({ model: "test-model", memory: { provider: "memmy" } });
    expect(existsSync(join(root, ".hermes", "plugins", "memmy", "memmy_provider", "__init__.py"))).toBe(true);
  });

  it("plans a DSH adapter install without invoking the host CLI", async () => {
    const root = tempRoot();
    const runtime = fixtureRuntime(root);
    mkdirSync(join(root, ".dsh"), { recursive: true });
    const [planned] = await installAgentAdapters({ agents: ["dsh"], runtime, userHome: root, explicit: true, dryRun: true });
    expect(planned).toMatchObject({ agent: "dsh", installed: true, configured: true, dryRun: true });
  });
});

function tempRoot(): string { const root = mkdtempSync(join(tmpdir(), "memmy-adapter-installer-")); roots.push(root); return root; }
function fixtureRuntime(root: string): InstalledRuntimePointer {
  const runtimeDir = join(root, "runtime");
  for (const agent of ["openclaw", "hermes", "dsh"]) mkdirSync(join(runtimeDir, "adapters", agent), { recursive: true });
  writeFileSync(join(runtimeDir, "adapters", "openclaw", "index.js"), "export default {};\n");
  mkdirSync(join(runtimeDir, "adapters", "hermes", "memmy_provider"), { recursive: true });
  writeFileSync(join(runtimeDir, "adapters", "hermes", "memmy_provider", "__init__.py"), "# fixture\n");
  writeFileSync(join(runtimeDir, "adapters", "dsh", "index.js"), "export const name = 'fixture';\n");
  return { version: "2.1.0", protocolVersion: 1, target: "test-x64", runtimeDir, entrypoint: join(runtimeDir, "index.js"), activatedAt: new Date().toISOString() };
}
