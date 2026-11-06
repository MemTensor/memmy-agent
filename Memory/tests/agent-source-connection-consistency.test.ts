import YAML from "yaml";
import * as fsPromises from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createCodexSkillTarget } from "../src/agent-source/integration/codex/index.js";
import { createWorkbuddySkillTarget } from "../src/agent-source/integration/workbuddy/index.js";
import { createSkillTargetRegistry } from "../src/agent-source/integration/target-registry.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";
import { Repositories } from "../src/storage/repositories.js";
import { agentSkillConnectionKey } from "../src/storage/imported-skill.js";
import { withLegacyImportedSkillWriter } from "./fixtures/legacy-imported-skill-writer.js";

import { createClaudeCodeSkillTarget } from "../src/agent-source/integration/claude-code/index.js";
import { createCursorSkillTarget } from "../src/agent-source/integration/cursor/index.js";
import { createOpencodeSkillTarget } from "../src/agent-source/integration/opencode/index.js";
import { createOpenclawSkillTarget } from "../src/agent-source/integration/openclaw/index.js";
import { createHermesSkillTarget } from "../src/agent-source/integration/hermes/index.js";
import { createDeepseekHarnessSkillTarget } from "../src/agent-source/integration/deepseek-harness/index.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>()
}));

const isolatedUser = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const { join } = await import("node:path");
  return { home: mkdtempSync(join(tmpdir(), "pr780-connection-user-")) };
});

// Every production import, including shared-skill discovery and installation-id
// creation, sees the synthetic user. Agent-specific overrides and process HOME are also isolated.
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => isolatedUser.home
}));

beforeEach(() => {
  for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, isolatedUser.home);
  for (const [name, directory] of Object.entries({ CODEX_HOME: ".codex", CLAUDE_CONFIG_DIR: ".claude", XDG_CONFIG_HOME: ".config", HERMES_HOME: ".hermes", OPENCLAW_STATE_DIR: ".openclaw" })) vi.stubEnv(name, join(isolatedUser.home, directory));

  rmSync(isolatedUser.home, { recursive: true, force: true });
  mkdirSync(isolatedUser.home, { recursive: true });
  vi.stubEnv("MEMMY_HOME", join(isolatedUser.home, ".memmy"));
  vi.stubEnv("MEMMY_CONFIG", join(isolatedUser.home, ".memmy", "config.yaml"));
  vi.stubEnv("MEMMY_MEMORY_HOME", join(isolatedUser.home, ".memmy", "memory-service"));
  vi.stubEnv("MEMMY_APP_DATABASE", join(isolatedUser.home, ".memmy", "app.sqlite"));
});
afterAll(() => rmSync(isolatedUser.home, { recursive: true, force: true }));

const fixture = createMemoryServiceFixture();
const executors: ReturnType<typeof createAgentSourceExecutor>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const executor of executors.splice(0)) await executor.dispose();
  await fixture.cleanup();
  vi.unstubAllEnvs();
});

function harness(kind: "skill" | "plugin", legacySource?: "codex" | "claude_code" | "opencode" | "openclaw" | "hermes") {
  const root = fixture.createTestRoot("pr780-connection-consistency-");
  const sourceId = legacySource ?? (kind === "plugin" ? "codex" : "workbuddy");
  const agentRoot = join(root, `.${sourceId}`);
  const configPath = join(root, "config.yaml");
  const statePath = join(root, "agent-sources.json");
  mkdirSync(join(agentRoot, "skills", "deploy-helper"), { recursive: true });
  writeFileSync(join(agentRoot, "skills", "deploy-helper", "SKILL.md"), "---\nname: deploy-helper\ndescription: Verify a deployment.\n---\nDeployment guide.\n");
  writeFileSync(configPath, JSON.stringify({ memmyMemory: { agentAccess: {
    autoScanKnownAgents: false, autoInjectSkill: false, watchFileChanges: false, scanPermission: "scan_only"
  } } }));
  const inputs: string[] = [];
  const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(inputs) });
  const target = sourceId === "workbuddy" ? createWorkbuddySkillTarget({ rootDirectory: agentRoot })
    : sourceId === "hermes" ? createHermesSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath })
    : sourceId === "claude_code" ? createClaudeCodeSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath })
    : sourceId === "opencode" ? createOpencodeSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath })
    : sourceId === "openclaw" ? createOpenclawSkillTarget({ rootDirectory: agentRoot, workspaceDirectory: join(agentRoot, "workspace"), memmyConfigPath: configPath })
    : createCodexSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath, trustHooks: async () => {} });
  const executorOptions: Parameters<typeof createAgentSourceExecutor>[0] = {
    service, configPath, statePath, scheduledScanIntervalMs: 10,
    resolveAgentSkillRoot: () => agentRoot,
    sourceRegistry: createSourceRegistry([{
      descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: agentRoot },
      detect: async () => true, async *scan() {}
    }]),
    integrationRegistry: createSkillTargetRegistry([target])
  };
  const executor = createAgentSourceExecutor(executorOptions);
  executors.push(executor);
  const restartExecutor = async () => {
    await executor.dispose();
    executors.splice(executors.indexOf(executor), 1);
    const restarted = createAgentSourceExecutor(executorOptions);
    executors.push(restarted);
    return restarted;
  };
  const scan = async (scanExecutor = executor) => {
    await scanExecutor.startScan({ sourceId });
    await vi.waitFor(() => expect(scanExecutor.scanStatus().running).toBe(false), { timeout: 10_000 });
    expect(scanExecutor.scanStatus().error).toBeNull();
    return db.db.prepare("SELECT status, memory_value FROM memories WHERE json_extract(properties_json, '$.internal_info.source_skill_id') = 'deploy-helper'").get() as { status: string; memory_value: string };
  };
  const status = async () => (await executor.list()).sources.find((source) => source.sourceId === sourceId)!.status;
  return { root, agentRoot, sourceId, statePath, configPath, db, service, target, executor, scan, status, inputs, restartExecutor };
}

describe("Memory disconnection keeps failed integration cleanup retryable", () => {
  it.each((["skill", "plugin"] as const).flatMap(kind => [false, true].map(notificationFails => ({ kind, notificationFails }))))(
    "attempts $kind disconnection when saving cleanup state fails, notificationFails=$notificationFails", async ({ kind, notificationFails }) => {
      const h = harness(kind);
      await h.executor.mutateConnection(h.sourceId, kind, "POST");
      await h.scan();
      const previousState = readFileSync(h.statePath, "utf8");
      rmSync(h.statePath);
      mkdirSync(h.statePath);
      const cleanup = vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall");
      const reconcile = vi.spyOn(h.service, "reconcileAgentSkills");
      const notificationError = new Error("fixture disconnect notification failed");
      if (notificationFails) reconcile.mockImplementationOnce(() => { throw notificationError; });

      const failure = await h.executor.mutateConnection(h.sourceId, kind, "DELETE").catch(error => error as Error);
      expect.soft(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ connectionState: "disconnected" }));
      expect(cleanup).not.toHaveBeenCalled();
      expect(await h.target.isInstalled(h.sourceId)).toBe(true);
      if (notificationFails) {
        expect.soft(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([expect.any(Error), notificationError]);
        expect((failure as Error).message).toContain((failure as AggregateError).errors[0].message);
        expect((failure as Error).message).toContain(notificationError.message);
        expect((failure as Error).message).not.toContain("Skill sharing is stopped");
        expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
      } else {
        expect.soft((failure as Error).message).toContain("Skill sharing is stopped");
        expect((failure as Error).cause).toBeInstanceOf(Error);
        expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      }

      rmSync(h.statePath, { recursive: true });
      writeFileSync(h.statePath, previousState);
      const restarted = await h.restartExecutor();
      await restarted.mutateConnection(h.sourceId, kind, "DELETE");
      expect((await restarted.list()).sources[0]?.status).toBe("not_connected");
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      expect(h.inputs).toEqual([]);
    }
  );

  it.each((["skill", "plugin"] as const).flatMap(kind => [false, true].map(partial => ({ kind, partial }))))(
    "keeps $kind sharing stopped after cleanup fails, partial=$partial", async ({ kind, partial }) => {
      const h = harness(kind);
      await h.executor.mutateConnection(h.sourceId, kind, "POST"); await h.scan();
      const remove = kind === "plugin" ? h.target.uninstallPlugin!.bind(h.target) : h.target.uninstall.bind(h.target);
      const cleanup = vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall");
      cleanup.mockImplementationOnce(async () => {
        if (partial) await remove(h.sourceId);
        throw new Error("fixture cleanup failure");
      });
      const failure = await h.executor.mutateConnection(h.sourceId, kind, "DELETE").catch(error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect.soft((failure as Error).message).toContain("Skill sharing is stopped");
      expect((failure as Error).message).toContain("fixture cleanup failure");
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      const persisted = JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId];
      expect.soft(persisted).toMatchObject({
        status: kind === "plugin" ? "plugin_installed" : "skill_installed", autoInjectSuppressed: true
      });
      expect.soft(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
      expect((await h.scan()).memory_value).toBe("");

      const restarted = await h.restartExecutor();
      expect.soft((await restarted.list()).sources.find(source => source.sourceId === h.sourceId)?.status)
        .toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
      writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
        autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission: "scan_and_write_skill"
      } } }));
      const install = vi.spyOn(h.target, kind === "plugin" ? "installPlugin" : "install");
      const read = vi.spyOn(h.target, "isInstalled");
      restarted.startAutomation();
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      expect(install).not.toHaveBeenCalled();
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      await restarted.mutateConnection(h.sourceId, kind, "DELETE");
      expect((await restarted.list()).sources.find(source => source.sourceId === h.sourceId)?.status).toBe("not_connected");
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId].autoInjectSuppressed).toBe(true);
      await restarted.mutateConnection(h.sourceId, kind, "POST");
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
      expect((await h.scan(restarted)).status).toBe("activated");
      expect(h.inputs).toEqual([]);
    }
  );
});

describe("connection fixture isolation", () => {
  it("isolates shared skills and installation identity under the fixture home", async () => {
    // Fail before starting an executor if this suite loses its filesystem isolation.
    expect(homedir()).toBe(isolatedUser.home);
    expect(process.env.MEMMY_HOME).toBe(join(isolatedUser.home, ".memmy"));
    const sharedPath = join(isolatedUser.home, ".agents", "skills", "isolated-shared", "SKILL.md");
    mkdirSync(join(sharedPath, ".."), { recursive: true });
    writeFileSync(sharedPath, "---\nname: isolated-shared\ndescription: Fixture shared skill.\n---\nFixture-only shared instructions.\n");
    const h = harness("plugin");
    await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    await h.scan();
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE json_extract(properties_json, '$.internal_info.source_skill_path') = ?").get(sharedPath)).toMatchObject({ count: 1 });
    expect(existsSync(join(isolatedUser.home, ".memmy", "installation-id"))).toBe(true);
  });
});

describe("Memory connection failure consistency", () => {
  it.each(["skill", "plugin"] as const)("retains the disconnect retry action when %s notification fails", async (kind) => {
    const h = harness(kind);
    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    expect((await h.scan()).status).toBe("activated");
    const cleanup = vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall");
    const notificationError = new Error("fixture connection notification failed");
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw notificationError; });

    await expect(h.executor.mutateConnection(h.sourceId, kind, "DELETE")).rejects.toBe(notificationError);
    expect(cleanup).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId].autoInjectSuppressed).toBe(true);
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    expect((await h.scan()).status).toBe("activated");

    const restarted = await h.restartExecutor();
    expect((await restarted.list()).sources[0]?.status).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    await restarted.mutateConnection(h.sourceId, kind, "DELETE");
    expect((await restarted.list()).sources[0]?.status).toBe("not_connected");
    expect((await h.scan(restarted)).memory_value).toBe("");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect(h.inputs).toEqual([]);
  });

  it.each(["skill", "plugin"] as const)("rolls back a new %s installation when connecting fails", async (kind) => {
    const h = harness(kind);
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture connection notification failed"); });

    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("notification failed");
    expect(await h.status()).toBe("not_connected");
    expect(await h.target.isInstalled(h.sourceId)).toBe(false);
    expect((await h.scan()).memory_value).toBe("");

    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect((await h.scan()).status).toBe("activated");
    expect(h.inputs).toEqual([]);
  });

  it("keeps disconnect fail-closed and retryable when the state was applied before its response failed", async () => {
    const h = harness("plugin");
    await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    await h.scan();
    const reconcile = h.service.reconcileAgentSkills.bind(h.service);
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce((request) => {
      reconcile(request);
      throw new Error("fixture response was lost");
    });

    await expect(h.executor.mutateConnection(h.sourceId, "plugin", "DELETE")).rejects.toThrow("response was lost");
    expect(await h.status()).toBe("plugin_installed");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect((await h.scan()).memory_value).toBe("");
    await h.executor.mutateConnection(h.sourceId, "plugin", "DELETE");
    expect(await h.status()).toBe("not_connected");
  });

  it.each(["skill", "plugin"] as const)("preserves an existing %s integration after a failed repeated connection", async (kind) => {
    const h = harness(kind);
    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    await h.scan();
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture connection notification failed"); });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("notification failed");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect((await h.scan()).status).toBe("activated");
    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
  });
});


describe("Memory fresh connection acknowledgement failures", () => {
  it.each(["skill", "plugin"] as const)("compensates an applied %s connection before rollback", async (kind) => {
    const h = harness(kind);
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    const reconcile = h.service.reconcileAgentSkills.bind(h.service);
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce((request) => {
      reconcile(request);
      throw new Error("fixture connect response lost");
    });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("connect response lost");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect(await h.status()).toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    expect((await h.scan()).status).toBe("activated");
  });

  it.each(["skill", "plugin"] as const)("keeps a %s removable when both acknowledgements fail", async (kind) => {
    const h = harness(kind);
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    const reconcile = h.service.reconcileAgentSkills.bind(h.service);
    vi.spyOn(h.service, "reconcileAgentSkills")
      .mockImplementationOnce((request) => {
        reconcile(request);
        throw new Error("fixture connect response lost");
      })
      .mockImplementationOnce(() => { throw new Error("fixture compensation unavailable"); });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("connection result is uncertain");
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect((await h.scan()).status).toBe("activated");
    await h.executor.mutateConnection(h.sourceId, kind, "DELETE");
    expect(await h.status()).toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
  });
});


const pluginPresenceCases = [
  ["codex", createCodexSkillTarget, "hooks/memmy-memory-resume-hook.mjs", "hooks.json"],
  ["claude_code", createClaudeCodeSkillTarget, "hooks/memmy-memory-resume-hook.mjs", "settings.json"],
  ["cursor", createCursorSkillTarget, "hooks/memmy-memory-resume-hook.mjs", "hooks.json"],
  ["opencode", createOpencodeSkillTarget, "plugins/memmy-memory.js", "opencode.json"],
  ["openclaw", createOpenclawSkillTarget, "extensions/memmy-memory/index.mjs", "openclaw.json"],
  ["hermes", createHermesSkillTarget, "plugins/memmy-memory/plugin.yaml", "config.yaml"],
  ["deepseek_harness", createDeepseekHarnessSkillTarget, "profiles/node_modules/@memmy/memmy-memory/index.mjs", "cordis.patch.yml"]
] as const;

describe("Memory official plugin presence", () => {
  it.each(pluginPresenceCases)("%s distinguishes old plugins from unrelated configuration", async (_id, createTarget, pluginPath, configFile) => {
    const rootDirectory = fixture.createTestRoot("pr780-memory-plugin-presence-");
    const target = createTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.json") });
    writeFileSync(join(rootDirectory, configFile), "{}");
    expect(await target.isPluginInstalled?.()).toBe(false);
    const filePath = join(rootDirectory, pluginPath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, "old Memmy plugin version");
    expect(await target.isPluginInstalled?.()).toBe(true);
  });

  it.each(pluginPresenceCases)("%s propagates unreadable paths before changing an integration", async (_id, createTarget, pluginPath) => {
    const rootDirectory = fixture.createTestRoot("pr780-memory-plugin-permission-");
    const directory = join(rootDirectory, pluginPath, "..");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(rootDirectory, pluginPath), "old plugin");
    chmodSync(directory, 0);
    try {
      const target = createTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.json") });
      await expect(target.isPluginInstalled?.()).rejects.toMatchObject({ code: "EACCES" });
    } finally { chmodSync(directory, 0o700); }
  });
});


describe("legacy CLI-only connection failure preservation", () => {
  const legacyCases = [
    ["codex", "AGENTS.md"], ["claude_code", "CLAUDE.md"],
    ["opencode", "AGENTS.md"], ["openclaw", "workspace/AGENTS.md"]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(legacyCases)(`preserves %s legacy CLI instructions when ${kind} connection notification fails`, async (sourceId, instructionsPath) => {
      const h = harness(kind, sourceId);
      const filePath = join(h.agentRoot, instructionsPath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "User instructions.\n<!-- memmy-memory cli : start -->\nExisting Memmy CLI integration.\n<!-- memmy-memory cli : end -->\n");
      expect(await h.target.isInstalled(sourceId)).toBe(false);
      h.service.reconcileAgentSkills({ sourceAgentId: sourceId, connectionState: "connected", complete: false, skills: [] });
      vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture notification failed"); });
      await expect(h.executor.mutateConnection(sourceId, kind, "POST")).rejects.toThrow("notification failed");
      expect(h.service.agentSkillConnectionState(sourceId)).toBe("connected");
      expect(await h.target.isInstalled(sourceId)).toBe(true);
      expect(await h.status()).toBe("plugin_installed");
      expect(await h.target.isPluginInstalled?.()).toBe(false);
      expect((await h.scan()).status).toBe("activated");
    });
  }
});


describe("Hermes legacy instruction connection failures", () => {
  const legacyInstructions = [
    ["AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["SOUL.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(legacyInstructions)(`preserves Hermes %s %s when ${kind} notification fails`, async (fileName, marker, endMarker) => {
      const h = harness(kind, "hermes");
      writeFileSync(join(h.agentRoot, fileName), `User instructions.\n${marker}\nExisting Memmy CLI integration.\n${endMarker}\n`);
      expect(await h.target.isInstalled("hermes")).toBe(false);
      h.service.reconcileAgentSkills({ sourceAgentId: "hermes", connectionState: "connected", complete: false, skills: [] });
      vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture notification failed"); });
      await expect(h.executor.mutateConnection("hermes", kind, "POST")).rejects.toThrow("notification failed");
      expect(h.service.agentSkillConnectionState("hermes")).toBe("connected");
      expect(await h.target.isInstalled("hermes")).toBe(true);
      expect(await h.target.isPluginInstalled?.()).toBe(false);
      expect(await h.status()).toBe("plugin_installed");
      expect((await h.scan()).status).toBe("activated");
      expect(h.inputs).toEqual([]);
    });
  }
});


describe("legacy connection deletion completes the disk and scan lifecycle", () => {
  const instructionCases = [
    ["opencode", "AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["opencode", "AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["openclaw", "workspace/AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["openclaw", "workspace/AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["hermes", "AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["hermes", "AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["hermes", "SOUL.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["hermes", "SOUL.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(instructionCases)(`removes %s %s %s through ${kind} deletion`, async (sourceId, fileName, marker, endMarker) => {
      const h = harness(kind, sourceId);
      const filePath = join(h.agentRoot, fileName);
      mkdirSync(join(filePath, ".."), { recursive: true });
      const block = `${marker}\nExisting Memmy integration.\n${endMarker}\n`;
      writeFileSync(filePath, `User instructions before.\n${block}${block}User instructions after.\n`);
      const nativeConfigPath = join(h.agentRoot, sourceId === "hermes" ? "config.yaml" : sourceId === "openclaw" ? "openclaw.json" : "opencode.json");
      writeFileSync(nativeConfigPath, JSON.stringify({ unrelated: { retained: true } }));
      h.service.reconcileAgentSkills({ sourceAgentId: sourceId, connectionState: "connected", complete: false, skills: [] });
      expect(await h.status()).toBe("plugin_installed");
      expect((await h.scan()).status).toBe("activated");
      await h.executor.mutateConnection(sourceId, kind, "DELETE");
      expect(await h.status()).toBe("not_connected");
      expect(readFileSync(filePath, "utf8")).toBe("User instructions before.\nUser instructions after.\n");
      expect(YAML.parse(readFileSync(nativeConfigPath, "utf8"))).toMatchObject({ unrelated: { retained: true } });
      expect(h.service.agentSkillConnectionState(sourceId)).toBe("disconnected");
      expect((await h.scan()).memory_value).toBe("");
      await h.executor.mutateConnection(sourceId, kind, "DELETE");
      expect(await h.status()).toBe("not_connected");
      expect(readFileSync(filePath, "utf8")).toBe("User instructions before.\nUser instructions after.\n");
      expect(h.inputs).toEqual([]);
    });
  }
});


describe("uncertain connection disk state is persisted independently of authorization", () => {
  it.each([["skill", undefined, "skill_installed"], ["plugin", undefined, "plugin_installed"], ["skill", "codex", "plugin_installed"]] as const)("persists retained %s %s installation without reconnecting its source", async (kind, source, expectedStatus) => {
    const h = harness(kind, source);
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    vi.spyOn(h.service, "reconcileAgentSkills")
      .mockImplementationOnce(() => { throw new Error("fixture Memory connection unavailable"); })
      .mockImplementationOnce(() => { throw new Error("fixture Memory compensation unavailable"); });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("connection result is uncertain");
    expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId].status).toBe(expectedStatus);
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect(await h.status()).toBe(expectedStatus);
    expect((await h.scan()).memory_value).toBe("");
    const restarted = await h.restartExecutor();
    expect((await restarted.list()).sources.find((candidate) => candidate.sourceId === h.sourceId)?.status).toBe(expectedStatus);
    expect((await h.scan(restarted)).memory_value).toBe("");
    await restarted.mutateConnection(h.sourceId, kind === "skill" && source === "codex" ? "plugin" : kind, "DELETE");
    expect((await restarted.list()).sources.find((candidate) => candidate.sourceId === h.sourceId)?.status).toBe("not_connected");
  });
});


describe("Memory targets directly remove legacy instructions", () => {
  const targets = [
    ["opencode", createOpencodeSkillTarget, ["AGENTS.md"]],
    ["openclaw", createOpenclawSkillTarget, ["workspace/AGENTS.md"]],
    ["hermes", createHermesSkillTarget, ["SOUL.md", "AGENTS.md"]]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(targets)(`removes duplicate LF and CRLF blocks from %s through ${kind}`, async (sourceId, createTarget, files) => {
      const rootDirectory = fixture.createTestRoot("pr780-memory-direct-uninstall-");
      const target = sourceId === "openclaw"
        ? createOpenclawSkillTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.json"), workspaceDirectory: join(rootDirectory, "workspace") })
        : createTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.json") });
      for (const fileName of files) {
        const filePath = join(rootDirectory, fileName);
        mkdirSync(join(filePath, ".."), { recursive: true });
        const old = "<!-- memmy-memory cli : start -->\nold CLI\n<!-- memmy-memory cli : end -->\n";
        const current = "<!-- memmy:start v=1 -->\ncurrent instructions\n<!-- memmy:end v=1 -->\n";
        writeFileSync(filePath, `User before.\n${old}${old.replaceAll("\n", "\r\n")}${current}${current.replaceAll("\n", "\r\n")}User after.\n`);
      }
      const remove = () => kind === "plugin" ? target.uninstallPlugin!(sourceId) : target.uninstall(sourceId);
      await remove();
      await remove();
      for (const fileName of files) expect(readFileSync(join(rootDirectory, fileName), "utf8")).toBe("User before.\nUser after.\n");
      expect(await target.isInstalled(sourceId)).toBe(false);
      expect(await target.isLegacySkillInstalled?.()).toBe(false);
    });
  }
});

describe("legacy disconnection survives an uncertain physical reinstall", () => {
  it.each(["skill", "plugin"] as const)("keeps legacy %s sharing disabled after reinstall failure and restart without a connection KV", async (kind) => {
    const h = harness(kind);
    writeFileSync(h.statePath, JSON.stringify({ version: 2, sources: { [h.sourceId]: {
      status: "not_connected", autoInjectSuppressed: true, messageCount: 0, lastScannedAt: null, latestSeenAt: null
    } } }));
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBeUndefined();
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toMatchObject({ count: 0 });
    vi.spyOn(h.service, "reconcileAgentSkills")
      .mockImplementationOnce(() => { throw new Error("fixture connection unavailable"); })
      .mockImplementationOnce(() => { throw new Error("fixture compensation unavailable"); });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("connection result is uncertain");
    const persisted = JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId];
    expect(persisted).toMatchObject({ status: kind === "plugin" ? "plugin_installed" : "skill_installed", autoInjectSuppressed: true });
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBeUndefined();
    const restarted = await h.restartExecutor();
    expect((await h.scan(restarted))).toMatchObject({ status: "archived", memory_value: "" });
    const row = h.db.db.prepare("SELECT properties_json FROM memories WHERE json_extract(properties_json, '$.internal_info.source_skill_id') = 'deploy-helper'").get() as { properties_json: string };
    expect(JSON.parse(row.properties_json).internal_info.archive_reason).toBe("disconnected");
    await restarted.mutateConnection(h.sourceId, kind, "POST");
    expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId].autoInjectSuppressed).toBeUndefined();
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    expect((await h.scan(restarted)).status).toBe("activated");
    expect(h.inputs).toEqual([]);
  });

  it.each(["skill", "plugin"] as const)("honors an authoritative connected KV over a stale legacy %s suppression flag", async (kind) => {
    const h = harness(kind);
    writeFileSync(h.statePath, JSON.stringify({ version: 2, sources: { [h.sourceId]: {
      status: kind === "plugin" ? "plugin_installed" : "skill_installed",
      autoInjectSuppressed: true, messageCount: 0, lastScannedAt: null, latestSeenAt: null
    } } }));
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "connected", complete: false, skills: [] });
    expect((await h.scan()).status).toBe("activated");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    expect(h.inputs).toEqual([]);
  });
});


describe("Memory final disconnect persistence", () => {
  it.each(["skill", "plugin"] as const)("retains %s cleanup state in memory after final persistence failure", async kind => {
    const h = harness(kind); await h.executor.mutateConnection(h.sourceId, kind, "POST");
    const remove = (kind === "plugin" ? h.target.uninstallPlugin! : h.target.uninstall).bind(h.target);
    vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall").mockImplementationOnce(async id => {
      await remove(id); rmSync(h.statePath); mkdirSync(h.statePath);
    });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "DELETE")).rejects.toThrow("Skill sharing is stopped. Cleanup state could not be saved. Retry removal.");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    rmSync(h.statePath, { recursive: true });
    await h.executor.mutateConnection(h.sourceId, kind, "DELETE");
    expect(await h.status()).toBe("not_connected");
  });
});


describe("Memory automatic installation authority boundaries", () => {
  it.each(["root", "install", "install_failure", "authority_failure"])("fails closed at %s without implicit reconnect", async boundary => {
    const h = harness("plugin", "opencode");
    const disconnect = () => h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, complete: false, connectionState: "disconnected", skills: [] });
    const install = h.target.installPlugin!.bind(h.target);
    const wrote = vi.spyOn(h.target, "installPlugin").mockImplementation(async id => {
      await install(id);
      if (boundary.startsWith("install")) disconnect();
      if (boundary === "install_failure") throw new Error("fixture partial installation failed");
      if (boundary === "authority_failure") vi.spyOn(h.service, "agentSkillConnectionState").mockImplementation(() => { throw new Error("fixture authority unavailable"); });
    });
    if (boundary === "root") {
      const root = h.target.resolveRootDirectory.bind(h.target);
      vi.spyOn(h.target, "resolveRootDirectory").mockImplementation(async () => { disconnect(); return root(); });
    }
    await expect(h.executor.mutateConnection(h.sourceId, "plugin", "POST", "auto_inject")).rejects.toThrow();
    expect(await h.target.isInstalled(h.sourceId)).toBe(false);
    if (boundary === "root") expect(wrote).not.toHaveBeenCalled();
    if (boundary !== "authority_failure") expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
  });

  it("does not replace a newer explicit reconnect during compensation", async () => {
    const h = harness("plugin", "opencode");
    const install = h.target.installPlugin!.bind(h.target);
    vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
      await install(id);
      h.service.reconcileAgentSkills({ sourceAgentId: id, complete: false, connectionState: "disconnected", skills: [] });
    });
    const remove = h.target.uninstallPlugin!.bind(h.target);
    vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
      h.service.reconcileAgentSkills({ sourceAgentId: id, complete: false, connectionState: "connected", skills: [] });
      await remove(id);
    });
    await expect(h.executor.mutateConnection(h.sourceId, "plugin", "POST", "auto_inject")).rejects.toThrow();
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    await h.executor.mutateConnection(h.sourceId, "plugin", "POST", "auto_inject");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId].autoInjectSuppressed).toBeUndefined();
  });

  it.each([false, true])("blocks timer hook refresh after remote disconnect, oldHook=%s", async oldHook => {
    const h = harness("plugin", "opencode");
    if (oldHook) await h.target.installPlugin!(h.sourceId);
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, complete: false, connectionState: "disconnected", skills: [] });
    // No imported rows exist: authority is independent of library history.
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toMatchObject({ n: 0 });
    writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: { autoInjectSkill: !oldHook, autoScanKnownAgents: false, watchFileChanges: false, scanPermission: "scan_and_write_skill" } } }));
    const install = vi.spyOn(h.target, "installPlugin");
    const read = vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
    const restarted = await h.restartExecutor();
    restarted.startAutomation();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(install).not.toHaveBeenCalled();
    if (oldHook) expect(read).toHaveBeenCalled();
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    await restarted.mutateConnection(h.sourceId, "plugin", "POST");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
  });
});


it.each(["remote", "local_notification_failure", "final_save_failure"])("compensates %s disconnect while automatic final state is being persisted", async mode => {
  const h = harness("plugin", "opencode");
  const rename = fsPromises.rename;
  let disconnected = false;
  vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    if (!disconnected && to === h.statePath && JSON.parse(readFileSync(from, "utf8")).sources.opencode?.status === "plugin_installed") {
      disconnected = true;
      if (mode !== "local_notification_failure") h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, complete: false, connectionState: "disconnected", skills: [] });
      else {
        vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture disconnect notification failed"); });
        await expect(h.executor.mutateConnection(h.sourceId, "plugin", "DELETE")).rejects.toThrow("notification failed");
      }
      if (mode === "final_save_failure") throw new Error("fixture final automatic save failed");
    }
    return rename(from, to);
  });
  await expect(h.executor.mutateConnection(h.sourceId, "plugin", "POST", "auto_inject")).rejects.toThrow();
  expect(disconnected).toBe(true);
  expect(await h.target.isInstalled(h.sourceId)).toBe(false);
  expect(h.service.agentSkillConnectionState(h.sourceId)).toBe(mode !== "local_notification_failure" ? "disconnected" : undefined);
});


it.each(["skill", "plugin"] as const)("preserves pending local %s disconnection after automatic refresh compensation", async kind => {
  const h = harness(kind, kind === "plugin" ? "opencode" : undefined);
  await h.executor.mutateConnection(h.sourceId, kind, "POST");
  expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
  const refresh = () => h.executor.mutateConnection(h.sourceId, kind, "POST", "auto_inject");
  const installPlugin = h.target.installPlugin?.bind(h.target);
  const installSkill = h.target.install.bind(h.target);
  const disconnectDuringRefresh = async () => {
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture disconnect notification failed"); });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "DELETE")).rejects.toThrow("notification failed");
  };
  const wrote = kind === "plugin"
    ? vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
      await installPlugin!(id);
      await disconnectDuringRefresh();
    })
    : vi.spyOn(h.target, "install").mockImplementationOnce(async manifest => {
      await installSkill(manifest);
      await disconnectDuringRefresh();
    });

  await expect(refresh()).rejects.toThrow("installed files removed");
  expect(await h.target.isInstalled(h.sourceId)).toBe(false);
  expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
  expect.soft(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId]).toMatchObject({
    status: kind === "plugin" ? "plugin_installed" : "skill_installed", autoInjectSuppressed: true
  });
  await expect.soft(refresh()).rejects.toThrow("pending cleanup");
  expect.soft(wrote).toHaveBeenCalledTimes(1);

  const restarted = await h.restartExecutor();
  expect.soft((await restarted.list()).sources[0]?.status).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
  await expect.soft(restarted.mutateConnection(h.sourceId, kind, "POST", "auto_inject")).rejects.toThrow("pending cleanup");
  await restarted.mutateConnection(h.sourceId, kind, "DELETE");
  expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
  expect((await restarted.list()).sources[0]?.status).toBe("not_connected");
  await restarted.mutateConnection(h.sourceId, kind, "POST");
  expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
  expect(await h.target.isInstalled(h.sourceId)).toBe(true);
});


it.each(["initial_persist", "uninstall", "final_persist"].flatMap(boundary =>
  ["failed_disconnect", "reconnect"].map(action => ({ boundary, action }))))(
  "preserves a newer local $action during Memory compensation $boundary", async ({ boundary, action }) => {
    const h = harness("plugin", "opencode");
    await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    let allowed = true;
    const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
      autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
    } } }));
    savePermission("scan_and_write_skill");
    vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
    let intervened = false;
    const intervene = async () => {
      intervened = true;
      if (action === "failed_disconnect") {
        vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture disconnect notification failed"); });
        await expect(h.executor.mutateConnection(h.sourceId, "plugin", "DELETE")).rejects.toThrow("notification failed");
      } else await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    };
    const install = h.target.installPlugin!.bind(h.target);
    vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
      await install(id);
      allowed = false;
      savePermission("none");
    });
    const remove = h.target.uninstallPlugin!.bind(h.target);
    vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
      if (boundary === "uninstall") await intervene();
      await remove(id);
    });
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (!allowed && !intervened && to === h.statePath && boundary !== "uninstall") {
        const source = JSON.parse(readFileSync(from, "utf8")).sources[h.sourceId];
        if (source.autoInjectSuppressed && source.status === (boundary === "initial_persist" ? "plugin_installed" : "not_connected")) await intervene();
      }
      return rename(from, to);
    });

    h.executor.startAutomation();
    await vi.waitFor(() => expect(intervened).toBe(true));
    // Disposal awaits the active automation, including its compensation saves.
    const restarted = await h.restartExecutor();
    expect(await h.target.isInstalled(h.sourceId)).toBe(action === "reconnect");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    const persisted = JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId];
    expect.soft(persisted.status).toBe("plugin_installed");
    expect.soft(persisted.autoInjectSuppressed).toBe(action === "failed_disconnect" ? true : undefined);
    allowed = true;
    savePermission("scan_and_write_skill");
    if (action === "failed_disconnect") {
      expect.soft((await restarted.list()).sources[0]?.status).toBe("plugin_installed");
      await expect.soft(restarted.mutateConnection(h.sourceId, "plugin", "POST", "auto_inject")).rejects.toThrow("pending cleanup");
      await restarted.mutateConnection(h.sourceId, "plugin", "DELETE");
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    } else {
      await restarted.mutateConnection(h.sourceId, "plugin", "POST", "auto_inject");
      expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    }
  }
);


describe("shared connection authority includes local removal intent", () => {
  it.each(["skill", "plugin"] as const)("exports a pending %s disconnect over stale connected authority after restart", async kind => {
    const h = harness(kind, kind === "plugin" ? "opencode" : undefined);
    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    vi.spyOn(h.service, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture notification failed"); });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "DELETE")).rejects.toThrow("notification failed");
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    await expect.soft(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "disconnected" });
    const restarted = await h.restartExecutor();
    await expect(restarted.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "disconnected" });
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    await restarted.mutateConnection(h.sourceId, kind, "DELETE");
    await restarted.mutateConnection(h.sourceId, kind, "POST");
    await expect(restarted.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "connected" });
  });

  it.each(["not_connected", "skill_installed", "plugin_installed"] as const)("exports legacy %s suppression without rows or KV and preserves reconnect precedence", async status => {
    const h = harness("plugin", "opencode");
    writeFileSync(h.statePath, JSON.stringify({ version: 2, sources: {
      [h.sourceId]: { status, autoInjectSuppressed: true, messageCount: 0, lastScannedAt: null, latestSeenAt: null }
    } }));
    const before = readFileSync(h.statePath, "utf8");
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toMatchObject({ n: 0 });
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBeUndefined();
    await expect.soft(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "disconnected" });
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBeUndefined();
    expect(readFileSync(h.statePath, "utf8")).toBe(before);
    h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, complete: false, connectionState: "connected", skills: [] });
    await expect(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: status === "not_connected" ? "connected" : "disconnected" });
  });

  it("fails the authority query when persisted local state cannot be read", async () => {
    const h = harness("plugin", "opencode");
    writeFileSync(h.statePath, "{invalid state");
    await expect(h.executor.connectionState(h.sourceId)).rejects.toThrow();
    expect(h.service.agentSkillConnectionState(h.sourceId)).toBeUndefined();
  });

  it.each(["skill", "plugin"] as const)("honors a newer committed $kind reconnect when local state persistence fails after a failed disconnect", async kind => {
    const h = harness(kind, kind === "plugin" ? "opencode" : undefined);
    await h.executor.mutateConnection(h.sourceId, kind, "POST");
    vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall")
      .mockRejectedValueOnce(new Error("fixture uninstall failed"));
    await expect(h.executor.mutateConnection(h.sourceId, kind, "DELETE")).rejects.toThrow("Integration cleanup failed");
    await expect(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "disconnected" });

    const rename = fsPromises.rename;
    let failedStateSave = false;
    const renameSpy = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (!failedStateSave && to === h.statePath) {
        failedStateSave = true;
        throw new Error("fixture state save failed after reconnect");
      }
      return rename(from, to);
    });
    await expect(h.executor.mutateConnection(h.sourceId, kind, "POST")).rejects.toThrow("fixture state save failed after reconnect");
    renameSpy.mockRestore();

    const event = h.service.agentSkillConnectionEvent(h.sourceId)!;
    expect(event).toMatchObject({ state: "connected", kind });
    await expect(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({
      connectionState: "connected",
      connectionEvent: event
    });
    const restarted = await h.restartExecutor();
    await expect(restarted.connectionState(h.sourceId)).resolves.toMatchObject({
      connectionState: "connected",
      connectionEvent: event
    });
  });

  it("clears stale pending-removal status in list() once another runtime finishes uninstall and records a newer disconnect", async () => {
    const h = harness("plugin", "opencode");
    await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    const realUninstall = h.target.uninstallPlugin!.bind(h.target);
    vi.spyOn(h.target, "uninstallPlugin").mockRejectedValueOnce(new Error("fixture viewer uninstall failed"));
    await expect(h.executor.mutateConnection(h.sourceId, "plugin", "DELETE")).rejects.toThrow("Integration cleanup failed");
    expect((await h.executor.list()).sources[0]?.status).toBe("plugin_installed");

    // Simulate Desktop App completing physical removal + committing newer disconnected event
    await realUninstall(h.sourceId);
    h.service.reconcileAgentSkills({
      sourceAgentId: h.sourceId,
      complete: false,
      connectionState: "disconnected",
      connectionKind: "plugin",
      skills: []
    });
    expect((await h.executor.list()).sources[0]?.status).toBe("not_connected");

    // Subsequent Desktop App reconnect must not be overridden by Viewer's stale local suppression
    await h.target.installPlugin!(h.sourceId);
    h.service.reconcileAgentSkills({
      sourceAgentId: h.sourceId,
      complete: false,
      connectionState: "connected",
      connectionKind: "plugin",
      skills: []
    });
    await expect(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "connected" });
  });
});


describe("cold clear-memory retains legacy connection authority", () => {
  it.each((["file", "deleted manual"] as const).flatMap(evidence =>
    [false, true].map(reconnected => ({ evidence, reconnected }))))(
    "preserves $evidence evidence with explicitReconnect=$reconnected across clear and restart", async ({ evidence, reconnected }) => {
      const h = harness("skill");
      const repos = new Repositories(h.db.db);
      const namespace = { source: h.sourceId, profileId: "default", userId: "cold-clear-user" };
      const id = withLegacyImportedSkillWriter(h.service, () => h.service.addMemory({
        namespace, source: h.sourceId, layer: "Skill", title: "deploy-helper", content: "Synthetic deployment guide.",
        ...(evidence === "file" ? { sourceAgentId: h.sourceId, sourceSkillId: "deploy-helper",
          sourceSkillPath: join(h.agentRoot, "skills/deploy-helper/SKILL.md") } : { turnId: "legacy-tool-turn" })
      })).id;
      const row = repos.memories.getIncludingDeleted(id)!;
      repos.memories.updateMaintenance({ ...row, status: evidence === "file" ? "archived" : "deleted",
        properties: { ...row.properties, internal_info: { ...row.properties.internal_info, source_state: "disconnected" } } });
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBeUndefined();
      if (reconnected) repos.runtime.setKv(agentSkillConnectionKey(h.sourceId), "connected");
      const expected = reconnected ? "connected" : "disconnected";
      expect(await h.executor.connectionState(h.sourceId)).toEqual({ connectionState: expected });
      await h.executor.clearAllData();
      expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
      const restarted = await h.restartExecutor();
      expect(await restarted.connectionState(h.sourceId)).toEqual({ connectionState: expected });
      writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
        autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission: "scan_and_write_skill"
      } } }));
      if (reconnected) {
        await restarted.mutateConnection(h.sourceId, "skill", "POST", "auto_inject");
      } else {
        await expect(restarted.mutateConnection(h.sourceId, "skill", "POST", "auto_inject")).rejects.toThrow("blocked");
        expect(await h.target.isInstalled(h.sourceId)).toBe(false);
        expect(await h.scan(restarted)).toMatchObject({ status: "archived", memory_value: "" });
        await restarted.mutateConnection(h.sourceId, "skill", "POST");
      }
      expect(await h.target.isInstalled(h.sourceId)).toBe(true);
      expect((await h.scan(restarted)).status).toBe("activated");
      expect(h.service.agentSkillConnectionState(h.sourceId)).toBe("connected");
    }
  );
});


it("keeps unique explicit connection events across scans and clear without manufacturing observations", async () => {
  const h = harness("plugin", "opencode");
  await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
  const first = h.service.agentSkillConnectionEvent(h.sourceId)!;
  expect(first).toMatchObject({ state: "connected", kind: "plugin" });
  h.service.reconcileAgentSkills({ sourceAgentId: h.sourceId, complete: false, disconnected: true, skills: [] });
  expect(h.service.agentSkillConnectionEvent(h.sourceId)).toEqual(first);
  await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
  const second = h.service.agentSkillConnectionEvent(h.sourceId)!;
  expect(second.id).not.toBe(first.id);
  expect(second).toMatchObject({ state: "connected", kind: "plugin" });
  await h.executor.clearAllData();
  expect(h.service.agentSkillConnectionEvent(h.sourceId)).toEqual(second);
  await expect(h.executor.connectionState(h.sourceId)).resolves.toMatchObject({ connectionEvent: second });
  await h.executor.mutateConnection(h.sourceId, "plugin", "DELETE");
  expect(h.service.agentSkillConnectionEvent(h.sourceId)).toMatchObject({ state: "disconnected", kind: "plugin" });
});
