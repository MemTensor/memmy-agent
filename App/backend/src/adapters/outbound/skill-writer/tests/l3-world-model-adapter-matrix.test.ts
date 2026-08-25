import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeSkillTarget } from "../claude-code/index.js";
import { createCodexSkillTarget } from "../codex/index.js";
import { createCursorSkillTarget } from "../cursor/index.js";
import { createDeepseekHarnessSkillTarget } from "../deepseek-harness/index.js";
import { createHermesSkillTarget } from "../hermes/index.js";
import { createOpenclawSkillTarget } from "../openclaw/index.js";
import { createOpencodeSkillTarget } from "../opencode/index.js";
import type { SkillTarget } from "../types.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("L3 World Model automatic adapter matrix", () => {
  it("atomically installs the shared Node lifecycle runtime in all six Node adapters", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-l3-adapter-matrix-"));
    const configPath = join(root, "memmy-config.yaml");
    writeFileSync(configPath, [
      "memmyMemory:",
      "  enabled: true",
      "  endpoint: http://127.0.0.1:8765",
      "  userId: matrix-user",
      ""
    ].join("\n"), "utf8");
    const runtimeAsset = await loadMemmyWorkspaceBridgeRuntimeAsset();
    const expectedHash = sha256(runtimeAsset);
    const cases = nodeAdapterCases(root, configPath);

    for (const testCase of cases) {
      mkdirSync(testCase.rootDirectory, { recursive: true });
      const target = testCase.create();
      if (!target.installPlugin || !target.uninstallPlugin) throw new Error(`${testCase.name} has no automatic adapter`);
      await target.installPlugin(target.targetId);
      expect(readFileSync(testCase.bridgePath, "utf8"), testCase.name).toBe(runtimeAsset);
      expect(sha256(readFileSync(testCase.bridgePath, "utf8")), testCase.name).toBe(expectedHash);
      expect(readFileSync(testCase.bridgePath, "utf8"), testCase.name).toContain("l3WorldModelProtocolVersion: 2");
      expect(listFiles(testCase.rootDirectory).some((path) => /outbox|boundary.*\.json|cursor.*\.json/iu.test(path)), testCase.name)
        .toBe(false);

      await target.uninstallPlugin(target.targetId);
      expect(existsSync(testCase.bridgePath), testCase.name).toBe(false);
    }
  });

  it("installs Hermes with the equivalent embedded Python protocol and no Node sidecar", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-l3-hermes-matrix-"));
    const configPath = join(root, "memmy-config.yaml");
    writeFileSync(configPath, [
      "memmyMemory:",
      "  enabled: true",
      "  endpoint: http://127.0.0.1:8765",
      "  userId: matrix-user",
      ""
    ].join("\n"), "utf8");
    const hermesRoot = join(root, "hermes");
    mkdirSync(hermesRoot, { recursive: true });
    const target = createHermesSkillTarget({ rootDirectory: hermesRoot, memmyConfigPath: configPath });
    if (!target.installPlugin || !target.uninstallPlugin) throw new Error("Hermes has no automatic adapter");
    await target.installPlugin(target.targetId);
    const providerPath = join(hermesRoot, "plugins", "memmy-memory", "__init__.py");
    const source = readFileSync(providerPath, "utf8");
    expect(source).toContain('"l3WorldModelProtocolVersion": 2');
    expect(source).not.toContain('"kind": "inventory"');
    expect(source).not.toContain("workspaceBridge");
    expect(listFiles(hermesRoot).some((path) => path.endsWith("memmy-workspace-bridge.mjs"))).toBe(false);
    expect(listFiles(hermesRoot).some((path) => /outbox|boundary.*\.json|cursor.*\.json/iu.test(path))).toBe(false);
    await target.uninstallPlugin(target.targetId);
    expect(existsSync(providerPath)).toBe(false);
  });
});

interface NodeAdapterCase {
  name: string;
  rootDirectory: string;
  bridgePath: string;
  create: () => SkillTarget;
}

function nodeAdapterCases(base: string, configPath: string): NodeAdapterCase[] {
  const codex = join(base, "codex");
  const cursor = join(base, "cursor");
  const claude = join(base, "claude");
  const opencode = join(base, "opencode");
  const openclaw = join(base, "openclaw");
  const deepseek = join(base, "deepseek");
  return [
    {
      name: "Codex",
      rootDirectory: codex,
      bridgePath: join(codex, "hooks", "memmy-workspace-bridge.mjs"),
      create: () => createCodexSkillTarget({
        rootDirectory: codex,
        memmyConfigPath: configPath,
        trustHooks: async () => undefined
      })
    },
    {
      name: "Cursor",
      rootDirectory: cursor,
      bridgePath: join(cursor, "hooks", "memmy-workspace-bridge.mjs"),
      create: () => createCursorSkillTarget({ rootDirectory: cursor, memmyConfigPath: configPath })
    },
    {
      name: "Claude Code",
      rootDirectory: claude,
      bridgePath: join(claude, "hooks", "memmy-workspace-bridge.mjs"),
      create: () => createClaudeCodeSkillTarget({ rootDirectory: claude, memmyConfigPath: configPath })
    },
    {
      name: "OpenCode",
      rootDirectory: opencode,
      bridgePath: join(opencode, "plugins", "memmy-workspace-bridge.mjs"),
      create: () => createOpencodeSkillTarget({ rootDirectory: opencode, memmyConfigPath: configPath })
    },
    {
      name: "OpenClaw",
      rootDirectory: openclaw,
      bridgePath: join(openclaw, "extensions", "memmy-memory", "memmy-workspace-bridge.mjs"),
      create: () => createOpenclawSkillTarget({
        rootDirectory: openclaw,
        configPath: join(openclaw, "openclaw.json"),
        workspaceDirectory: join(openclaw, "workspace"),
        memmyConfigPath: configPath
      })
    },
    {
      name: "DeepSeek Harness",
      rootDirectory: deepseek,
      bridgePath: join(deepseek, "profiles", "node_modules", "@memmy", "memmy-memory", "memmy-workspace-bridge.mjs"),
      create: () => createDeepseekHarnessSkillTarget({ rootDirectory: deepseek, memmyConfigPath: configPath })
    }
  ];
}

function listFiles(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(join(directory, entry.name), relativePath));
    else files.push(relativePath);
  }
  return files;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
