import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../../../../src/config/schema.js";
import { Tool } from "../../../../src/core/agent-runtime/tools/base.js";
import { ToolContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { CronTool } from "../../../../src/core/agent-runtime/tools/cron.js";
import { EditFileTool, ListDirTool, ReadFileTool, WriteFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
import { ImageGenerationTool, ImageGenerationToolConfig } from "../../../../src/core/agent-runtime/tools/image-generation.js";
import { SKIP_MODULES, ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";
import { MCPPromptWrapper, MCPResourceWrapper, MCPToolWrapper } from "../../../../src/core/agent-runtime/tools/mcp.js";
import { MessageTool } from "../../../../src/core/agent-runtime/tools/message.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";
import { FindFilesTool, GrepTool } from "../../../../src/core/agent-runtime/tools/search.js";
import { ExecTool, ExecToolConfig } from "../../../../src/core/agent-runtime/tools/shell.js";
import { SpawnTool } from "../../../../src/core/agent-runtime/tools/spawn.js";
import { WebFetchTool, WebSearchTool, WebToolsConfig } from "../../../../src/core/agent-runtime/tools/web.js";
import { BUILTIN_SKILLS_DIR } from "../../../../src/core/agent-runtime/skills.js";

class MinimalTool extends Tool {
  get name(): string {
    return "test_minimal";
  }

  get description(): string {
    return "A test tool";
  }

  get parameters() {
    return { type: "object", properties: {} };
  }

  async execute(): Promise<string> {
    return "ok";
  }
}

class HiddenTool extends MinimalTool {
  static override pluginDiscoverable = false;
}

function mockConfig(overrides: Record<string, any> = {}) {
  return {
    exec: new ExecToolConfig({
      enable: true,
      timeout: 60,
      sandbox: "",
      pathAppend: "",
      allowedEnvKeys: [],
      allowPatterns: [],
      denyPatterns: [],
    }),
    web: new WebToolsConfig({ enable: true, search: {}, fetch: {}, proxy: null, userAgent: null }),
    imageGeneration: new ImageGenerationToolConfig({ enabled: false }),
    restrictToWorkspace: false,
    ...overrides,
  };
}

describe("Tool defaults", () => {
  it("returns null for the default config class", () => {
    expect(MinimalTool.configCls()).toBeNull();
  });

  it("uses an empty default config key", () => {
    expect(MinimalTool.configKey).toBe("");
  });

  it("is enabled by default", () => {
    expect(MinimalTool.enabled(null)).toBe(true);
  });

  it("creates a default tool instance", () => {
    const tool = MinimalTool.create(null);
    expect(tool).toBeInstanceOf(MinimalTool);
    expect(tool.name).toBe("test_minimal");
  });

  it("is plugin discoverable by default", () => {
    expect(MinimalTool.pluginDiscoverable).toBe(true);
  });
});

describe("ToolContext", () => {
  it("exposes the required context fields", () => {
    const subagentManager = { spawn: () => null };
    const cronService = {};
    const execSessionManager = {};
    const providerSnapshotLoader = () => ({});
    const ctx = new ToolContext({
      config: {},
      workspace: "/tmp",
      bus: {},
      subagentManager,
      cronService,
      fileStateStore: {},
      execSessionManager,
      providerSnapshotLoader,
    });

    expect(ctx.config).toEqual({});
    expect(ctx.workspace).toBe("/tmp");
    expect(ctx.bus).toBeDefined();
    expect(ctx.subagentManager).toBe(subagentManager);
    expect(ctx.cronService).toBe(cronService);
    expect(ctx.fileStateStore).toBeDefined();
    expect(ctx.execSessionManager).toBe(execSessionManager);
    expect(ctx.providerSnapshotLoader).toBe(providerSnapshotLoader);
  });

  it("applies ToolContext defaults", () => {
    const ctx = new ToolContext({ config: null, workspace: "/tmp" });
    expect(ctx.bus).toBeUndefined();
    expect(ctx.subagentManager).toBeUndefined();
    expect(ctx.cronService).toBeUndefined();
    expect(ctx.providerSnapshotLoader).toBeNull();
    expect(ctx.timezone).toBe("UTC");
  });
});

describe("ToolLoader discovery", () => {
  it("skips infrastructure modules", () => {
    expect([...SKIP_MODULES]).toEqual(
      expect.arrayContaining([
        "base",
        "schema",
        "registry",
        "context",
        "loader",
        "config",
        "file-state",
        "sandbox",
        "mcp",
        "index",
      ]),
    );
  });

  it("finds concrete builtin tools", () => {
    const classNames = new Set(new ToolLoader().discover().map((cls) => cls.name));
    expect([...classNames]).toEqual(
      expect.arrayContaining([
        "ApplyPatchTool",
        "ExecTool",
        "MessageTool",
        "SpawnTool",
        "WriteStdinTool",
      ]),
    );
  });

  it("excludes abstract and MCP wrapper classes", () => {
    const classNames = new Set(new ToolLoader().discover().map((cls) => cls.name));
    expect(classNames).not.toContain("FsTool");
    expect(classNames).not.toContain("SearchTool");
    expect(classNames).not.toContain("MCPToolWrapper");
    expect(classNames).not.toContain("MCPResourceWrapper");
    expect(classNames).not.toContain("MCPPromptWrapper");
  });

  it("skips private and undiscoverable classes", () => {
    const discovered = new ToolLoader({ testClasses: [MinimalTool, HiddenTool] }).discover();
    expect(discovered).toEqual([MinimalTool]);
    for (const cls of new ToolLoader().discover()) expect(cls.name.startsWith("_")).toBe(false);
  });
});

describe("Filesystem tool create", () => {
  it("builds filesystem tools from context", () => {
    const tool = ReadFileTool.create(new ToolContext({ config: mockConfig(), workspace: "/tmp/test" })) as ReadFileTool;
    expect(tool).toBeInstanceOf(ReadFileTool);
    expect(tool.workspace).toBe(path.resolve("/tmp/test"));
  });

  it("leaves filesystem and search tools unrestricted by default", () => {
    const ctx = new ToolContext({ config: mockConfig(), workspace: "/tmp/test" });

    expect((ReadFileTool.create(ctx) as ReadFileTool).allowedDir).toBeNull();
    expect((WriteFileTool.create(ctx) as WriteFileTool).allowedDir).toBeNull();
    expect((EditFileTool.create(ctx) as EditFileTool).allowedDir).toBeNull();
    expect((ListDirTool.create(ctx) as ListDirTool).allowedDir).toBeNull();
    expect((FindFilesTool.create(ctx) as FindFilesTool).allowedDir).toBeNull();
    expect((GrepTool.create(ctx) as GrepTool).allowedDir).toBeNull();
  });

  it("allows generated read_file tools to read builtin skill files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-tool-loader-"));
    try {
      const tool = ReadFileTool.create(new ToolContext({ config: mockConfig(), workspace: root })) as ReadFileTool;
      const result = await tool.execute({ path: path.resolve("src/skills/tmux/SKILL.md"), limit: 8 });

      expect(String(result)).toContain("tmux Skill");
      expect(String(result)).not.toContain("outside workspace");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects restrictToWorkspace for filesystem tools", () => {
    const config = mockConfig({ restrictToWorkspace: true });
    const ctx = new ToolContext({ config, workspace: "/tmp/test" });
    const tools = [
      ReadFileTool.create(ctx) as ReadFileTool,
      WriteFileTool.create(ctx) as WriteFileTool,
      EditFileTool.create(ctx) as EditFileTool,
      ListDirTool.create(ctx) as ListDirTool,
      FindFilesTool.create(ctx) as FindFilesTool,
      GrepTool.create(ctx) as GrepTool,
    ];

    for (const tool of tools) {
      expect(tool.allowedDir).toBe(path.resolve("/tmp/test"));
      expect(tool.extraAllowedDirs).toContain(BUILTIN_SKILLS_DIR);
    }
  });

  it("keeps sandboxed filesystem tools bound to the workspace", () => {
    const config = mockConfig({ exec: new ExecToolConfig({ sandbox: "bwrap" }) });
    const ctx = new ToolContext({ config, workspace: "/tmp/test" });
    const tools = [
      ReadFileTool.create(ctx) as ReadFileTool,
      WriteFileTool.create(ctx) as WriteFileTool,
      EditFileTool.create(ctx) as EditFileTool,
      ListDirTool.create(ctx) as ListDirTool,
      FindFilesTool.create(ctx) as FindFilesTool,
      GrepTool.create(ctx) as GrepTool,
    ];

    for (const tool of tools) {
      expect(tool.allowedDir).toBe(path.resolve("/tmp/test"));
      expect(tool.extraAllowedDirs).toContain(BUILTIN_SKILLS_DIR);
    }
  });
});

describe("Message, spawn, and cron tools", () => {
  it("creates MessageTool from context", () => {
    expect(MessageTool.create(new ToolContext({ config: mockConfig(), workspace: "/tmp", bus: {} }))).toBeInstanceOf(MessageTool);
  });

  it("creates SpawnTool from context", () => {
    const manager = { spawn: () => null };
    const tool = SpawnTool.create(new ToolContext({ config: mockConfig(), workspace: "/tmp", subagentManager: manager })) as SpawnTool;
    expect(tool).toBeInstanceOf(SpawnTool);
    expect(tool.manager).toBe(manager);
  });

  it("disables CronTool without a cron service", () => {
    expect(CronTool.enabled(new ToolContext({ config: mockConfig(), workspace: "/tmp", cronService: null }))).toBe(false);
  });

  it("enables CronTool when a cron service exists", () => {
    expect(CronTool.enabled(new ToolContext({ config: mockConfig(), workspace: "/tmp", cronService: {} }))).toBe(true);
  });

  it("creates CronTool with the context timezone", () => {
    const tool = CronTool.create(new ToolContext({ config: mockConfig(), workspace: "/tmp", cronService: {}, timezone: "Asia/Shanghai" })) as CronTool;
    expect(tool).toBeInstanceOf(CronTool);
    expect((tool as any).defaultTimezone).toBe("Asia/Shanghai");
  });
});

describe("Exec, web, and image tools", () => {
  it("exposes ExecTool config metadata", () => {
    expect(ExecTool.configCls()).toBe(ExecToolConfig);
    expect(ExecTool.configKey).toBe("exec");
  });

  it("enables and disables ExecTool from config", () => {
    const config = mockConfig();
    const ctx = new ToolContext({ config, workspace: "/tmp" });
    expect(ExecTool.enabled(ctx)).toBe(true);
    config.exec.enable = false;
    expect(ExecTool.enabled(ctx)).toBe(false);
  });

  it("creates ExecTool from context config", () => {
    const config = mockConfig({ exec: new ExecToolConfig({ timeout: 120, sandbox: "", pathAppend: "/opt/bin" }) });
    const tool = ExecTool.create(new ToolContext({ config, workspace: "/tmp" })) as ExecTool;
    expect(tool).toBeInstanceOf(ExecTool);
    expect(tool.timeout).toBe(120);
    expect(tool.pathAppend).toBe("/opt/bin");
  });

  it("exposes web tool config metadata", () => {
    expect(WebSearchTool.configKey).toBe("web");
    expect(WebSearchTool.configCls()).toBe(WebToolsConfig);
    expect(WebFetchTool.configKey).toBe("web");
    expect(WebFetchTool.configCls()).toBe(WebToolsConfig);
  });

  it("enables and disables web tools from config", () => {
    const config = mockConfig();
    const ctx = new ToolContext({ config, workspace: "/tmp" });
    expect(WebSearchTool.enabled(ctx)).toBe(true);
    expect(WebFetchTool.enabled(ctx)).toBe(true);
    config.web.enable = false;
    expect(WebSearchTool.enabled(ctx)).toBe(false);
    expect(WebFetchTool.enabled(ctx)).toBe(false);
  });

  it("creates WebSearchTool from web config", () => {
    const config = mockConfig({ web: new WebToolsConfig({ search: { provider: "brave" }, proxy: "http://proxy", userAgent: "agent" }) });
    const tool = WebSearchTool.create(new ToolContext({ config, workspace: "/tmp" })) as WebSearchTool;
    expect(tool).toBeInstanceOf(WebSearchTool);
    expect(tool.config.provider).toBe("brave");
    expect(tool.proxy).toBe("http://proxy");
    expect(tool.userAgent).toBe("agent");
  });

  it("creates WebFetchTool from web config", () => {
    const config = mockConfig({ web: new WebToolsConfig({ fetch: { maxChars: 1234 }, proxy: "http://proxy", userAgent: "agent" }) });
    const tool = WebFetchTool.create(new ToolContext({ config, workspace: "/tmp" })) as WebFetchTool;
    expect(tool).toBeInstanceOf(WebFetchTool);
    expect(tool.maxChars).toBe(1234);
    expect(tool.proxy).toBe("http://proxy");
  });

  it("exposes ImageGenerationTool config metadata", () => {
    expect(ImageGenerationTool.configKey).toBe("imageGeneration");
    expect(ImageGenerationTool.configCls()).toBe(ImageGenerationToolConfig);
  });

  it("enables and disables ImageGenerationTool from config", () => {
    const config = mockConfig({ imageGeneration: new ImageGenerationToolConfig({ enabled: true }) });
    const ctx = new ToolContext({ config, workspace: "/tmp" });
    expect(ImageGenerationTool.enabled(ctx)).toBe(true);
    config.imageGeneration.enabled = false;
    expect(ImageGenerationTool.enabled(ctx)).toBe(false);
  });

  it("creates ImageGenerationTool from tool config only", () => {
    const imageGeneration = new ImageGenerationToolConfig({
      enabled: true,
      apiKey: "sk-image-test",
    });
    const tool = ImageGenerationTool.create(
      new ToolContext({
        config: mockConfig({ imageGeneration }),
        workspace: "/tmp",
      }),
    ) as ImageGenerationTool;
    expect(tool).toBeInstanceOf(ImageGenerationTool);
    expect(tool.config).toBe(imageGeneration);
  });

  it("keeps MCP wrappers out of loader discovery", () => {
    expect(MCPToolWrapper.pluginDiscoverable).toBe(false);
    expect(MCPResourceWrapper.pluginDiscoverable).toBe(false);
    expect(MCPPromptWrapper.pluginDiscoverable).toBe(false);
  });
});

describe("Config round-trip", () => {
  it("serializes moved tool config classes with camelCase fields", () => {
    const config = Config.fromObject({
      tools: {
        web: { enable: true, search: { provider: "brave", apiKey: "test" } },
        exec: { enable: false, timeout: 120 },
        imageGeneration: { enabled: true, provider: "openrouter" },
      },
    });
    const dumped = config.toObject();

    expect(dumped.tools.imageGeneration.enabled).toBe(true);
    expect(config.tools.exec.enable).toBe(false);
    expect(config.tools.exec.timeout).toBe(120);
    expect(config.tools.web.search.provider).toBe("brave");
    expect(config.tools.webSearch.provider).toBe("brave");
  });

  it("keeps tool config defaults aligned with memmy", () => {
    const config = Config.fromObject({});
    expect(config.tools.exec.enable).toBe(true);
    expect(config.tools.exec.timeout).toBe(60);
    expect(config.tools.web.enable).toBe(true);
    expect(config.tools.web.search.provider).toBe("duckduckgo");
    expect(config.tools.imageGeneration.enabled).toBe(false);
    expect(config.tools.restrictToWorkspace).toBe(false);
    expect(["cli", "Apps"].join("") in config.tools).toBe(false);
  });

  it("ignores retired my tool config fields", () => {
    const config = Config.fromObject({
      tools: {
        my: { enable: true, allowSet: true },
        myEnabled: true,
        mySet: true,
        webSearch: { provider: "brave" },
      },
    });

    expect(Object.prototype.hasOwnProperty.call(config.tools, "my")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config.tools, "myEnabled")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config.tools, "mySet")).toBe(false);
    expect(config.tools.webSearch.provider).toBe("brave");
  });
});

describe("ToolLoader load integration", () => {
  it("registers the expected default tools", () => {
    const ctx = new ToolContext({
      config: mockConfig(),
      workspace: "/tmp",
      bus: {},
      subagentManager: {},
      cronService: {},
      timezone: "UTC",
    });
    const registry = new ToolRegistry();
    const registered = new ToolLoader().load(ctx, registry);

    expect(registered).toEqual(
      expect.arrayContaining([
        "apply_patch",
        "memmy_agent_source",
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
        "find_files",
        "grep",
        "exec",
        "write_stdin",
        "list_exec_sessions",
        "web_search",
        "web_fetch",
        "message",
        "spawn",
        "cron",
      ]),
    );
    for (const name of registered) expect(registry.has(name)).toBe(true);
    expect(registered).not.toContain(["run", "cli", "app"].join("_"));
  });
});
