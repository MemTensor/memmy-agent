import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { getWorkspacePath, getWorkspaceStatePath } from "../../../src/config/paths.js";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { ToolLoader } from "../../../src/core/agent-runtime/tools/loader.js";
import { syncRuntimeWorkspaceTemplates } from "../../../src/entrypoints/cli/commands.js";
import { resolveStartupMigrationTarget } from "../../../src/entrypoints/cli/startup-migrations.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "managed-state-"))); roots.push(root);
  const home = path.join(root, "runtime"); fs.mkdirSync(home);
  const workspace = path.join(root, "unapproved-project");
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1"); vi.stubEnv("MEMMY_AGENT_DATA_DIR", home);
  return { root, home, workspace };
}
it("managed templates, session and memory state never create the unapproved project directory", () => {
  const { home, workspace } = fixture();
  const config = new Config({ agents: { defaults: { workspace } }, memmyMemory: { enabled: false } });
  expect(getWorkspacePath(workspace)).toBe(workspace);
  expect(syncRuntimeWorkspaceTemplates(config)).toBe(workspace);
  expect(fs.existsSync(workspace)).toBe(false);
  fs.mkdirSync(workspace);
  const loop = new AgentLoop({ config, workspace, provider: { getDefaultModel: () => "test-model" } });
  expect(loop.workspace).toBe(workspace);
  expect(loop.sessions.root).toBe(path.join(home, "workspace", "sessions"));
  expect(loop.context.memory.workspace).toBe(path.join(home, "workspace"));
  expect(loop.tools.get("read_file")).toHaveProperty("workspace", workspace);
  expect(fs.readdirSync(workspace)).toEqual([]);
});
it("managed bootstrap context and plugin discovery cannot read project-controlled files", () => {
  const { workspace, home } = fixture(); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "UNAPPROVED_PROJECT_SECRET");
  const context = new ContextBuilder({ workspace });
  expect(context.loadBootstrapFiles()).not.toContain("UNAPPROVED_PROJECT_SECRET");
  expect(context.skills.workspace).toBe(path.join(home, "workspace"));
  const read = vi.spyOn(fs, "readdirSync");
  expect(new ToolLoader({ workspace }).discoverPlugins()).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});
it("managed migrations target private state and require an explicit Host data directory", () => {
  const { workspace, home } = fixture();
  const config = path.join(home, "config.json");
  fs.writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace } } }));
  const env = { AGENT_MANAGED_EXECUTION_REQUIRED: "1", MEMMY_AGENT_DATA_DIR: home, HOME: home };
  const target = resolveStartupMigrationTarget({ config, workspace }, env);
  expect(target.agentWorkspace).toBe(path.join(home, "workspace"));
  expect(fs.existsSync(workspace)).toBe(false);
  expect(() => resolveStartupMigrationTarget({ config, workspace }, { ...env, MEMMY_AGENT_DATA_DIR: "" })).toThrow("data directory is required");
  vi.stubEnv("MEMMY_AGENT_DATA_DIR", "");
  expect(() => getWorkspaceStatePath(workspace)).toThrow("data directory is required");
});
