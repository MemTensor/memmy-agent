import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { ProjectStore } from "../../../src/entrypoints/frontend-bridge/projects.js";
import {
  listTerminalSessions,
  resolveTerminalTarget,
  type TerminalTargetDependencies,
} from "../../../src/entrypoints/cli/commands.js";

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const originalConfig = process.env.MEMMY_CONFIG;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const roots: string[] = [];

function makeLoop(): {
  root: string;
  workspace: string;
  loop: AgentLoop;
  dependencies: TerminalTargetDependencies;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-terminal-target-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const loop = new AgentLoop({
    config: new Config({
      fileMemory: { enabled: false },
      memmyMemory: { enabled: false },
    }),
    provider: {
      generation: { maxTokens: 128 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(),
    },
    workspace,
    sessionDir: path.join(workspace, "sessions"),
    model: "test-model",
  });
  const canonicalWorkspace = fs.realpathSync(workspace);
  const projectStore = new ProjectStore();
  loop.projectStore = projectStore;
  return {
    root,
    workspace: canonicalWorkspace,
    loop,
    dependencies: {
      sessions: loop.sessions,
      projectStore,
      workspace: canonicalWorkspace,
      hasUsableDefaultModel: () => loop.resolveTurnModelSelection({}) !== null,
    },
  };
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  if (originalConfig == null) delete process.env.MEMMY_CONFIG;
  else process.env.MEMMY_CONFIG = originalConfig;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile == null) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("terminal target resolution", () => {
  it("creates cli:direct as a fixed standalone session by default", () => {
    const { dependencies, loop, workspace } = makeLoop();
    const target = resolveTerminalTarget(dependencies);
    expect(target).toMatchObject({
      sessionId: "cli:direct",
      target: "standalone",
      projectId: null,
      cwd: workspace,
    });
    expect(loop.sessions.loadSession("cli:direct")?.metadata).toMatchObject({
      webui: true,
      webuiProjectId: null,
      webuiWorkspaceCwd: workspace,
    });
  });

  it("creates new standalone sessions and resumes them only by full cli session ID", () => {
    const { dependencies } = makeLoop();
    const created = resolveTerminalTarget(dependencies, { standalone: true });
    expect(created.sessionId).toMatch(/^cli:[0-9a-f-]{36}$/);
    expect(resolveTerminalTarget(dependencies, { sessionId: created.sessionId })).toEqual(created);
    expect(() => resolveTerminalTarget(dependencies, { sessionId: "telegram:123" }))
      .toThrow("--session only accepts");
    expect(() => resolveTerminalTarget(dependencies, {
      sessionId: created.sessionId,
      standalone: true,
    })).toThrow("mutually exclusive");
  });

  it("directs an unconfigured terminal session to the interactive wizard", () => {
    const { dependencies } = makeLoop();
    dependencies.hasUsableDefaultModel = () => false;

    expect(() => resolveTerminalTarget(dependencies, { standalone: true })).toThrow(
      "No usable default model is configured. Run `memmy onboard --wizard` first.",
    );
  });

  it("accepts project paths, reuses the registered canonical root, and fixes each binding", () => {
    const { root, dependencies } = makeLoop();
    const projectPath = path.join(root, "code", "memmy");
    fs.mkdirSync(projectPath, { recursive: true });
    const first = resolveTerminalTarget(dependencies, {
      project: path.relative(root, projectPath),
      invocationCwd: root,
    });
    const second = resolveTerminalTarget(dependencies, { project: projectPath });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.projectId).toBe(second.projectId);
    expect(first).toMatchObject({
      target: "project",
      projectName: "memmy",
      cwd: fs.realpathSync(projectPath),
    });
    expect(resolveTerminalTarget(dependencies, { sessionId: first.sessionId })).toEqual(first);
  });

  it("expands Windows project paths with USERPROFILE when HOME is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-terminal-target-home-"));
    roots.push(root);
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const dependencies = {
      sessions: { get: vi.fn(() => null), save: vi.fn() } as any,
      projectStore: new ProjectStore(),
      workspace,
      hasUsableDefaultModel: () => true,
    } satisfies TerminalTargetDependencies;
    const projectPath = path.join(root, "profile-project");
    fs.mkdirSync(projectPath, { recursive: true });
    delete process.env.HOME;
    process.env.USERPROFILE = root;

    const target = resolveTerminalTarget(dependencies, { project: "~\\profile-project" });

    expect(target.cwd).toBe(fs.realpathSync(projectPath));
  });

  it("does not expose non-cli projected sessions through session listing", () => {
    const { dependencies, loop, workspace } = makeLoop();
    resolveTerminalTarget(dependencies);
    const im = loop.sessions.getOrCreate("telegram:123");
    im.metadata.webui = true;
    im.metadata.webuiProjectId = null;
    im.metadata.webuiWorkspaceCwd = workspace;
    loop.sessions.save(im);

    vi.spyOn(AgentLoop, "fromConfig").mockReturnValue(loop);
    const rows = listTerminalSessions();
    expect(rows.map((row) => row.sessionId)).toEqual(["cli:direct"]);
  });
});
