import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renameMemmyComputerUseMcpV119 } from "../src/migrations/v1.1.9/0001-rename-memmy-computer-use-mcp.js";
import { runMigrationsForTest } from "../src/runner.js";

const roots: string[] = [];
const stock = { type: "stdio", command: "open-computer-use", args: ["mcp"] };

async function fixture(config?: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-computer-use-rename-"));
  roots.push(root);
  const runtimeConfigFile = path.join(root, "config.yaml");
  if (config !== undefined) await fs.writeFile(runtimeConfigFile, YAML.stringify(config), "utf8");
  const context = {
    profileWorkspace: root,
    sessionsDir: path.join(root, "sessions"),
    runtimeConfigFile,
    sessionDagDir: path.join(root, "session-dag"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { context, read: async () => YAML.parse(await fs.readFile(runtimeConfigFile, "utf8")) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("v1.1.9/0001-rename-memmy-computer-use-mcp", () => {
  it("renames the server id and wrapped tool names without dropping custom fields", async () => {
    const { context, read } = await fixture({
      providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } },
      tools: {
        mcpServers: {
          custom: { command: "custom-mcp", env: { TOKEN: "${TOKEN}" } },
          open_computer_use: {
            ...stock,
            enabledTools: ["click", "mcp_open_computer_use_get_screen_state"],
            env: { OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "0" },
          },
        },
      },
    });
    expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    const actual = await read();
    expect(actual.tools.mcpServers.open_computer_use).toBeUndefined();
    expect(actual.tools.mcpServers.memmy_computer_use).toEqual({
      ...stock,
      enabledTools: ["click", "mcp_memmy_computer_use_get_screen_state"],
      env: { OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "0" },
    });
    expect(actual.tools.mcpServers.custom).toEqual({ command: "custom-mcp", env: { TOKEN: "${TOKEN}" } });
    expect(actual.providers.custom.apiKey).toBe("${CUSTOM_API_KEY}");
    const before = await fs.readFile(context.runtimeConfigFile, "utf8");
    expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 0, ignored: 1 });
    expect(await fs.readFile(context.runtimeConfigFile, "utf8")).toBe(before);
  });

  it.each([{}, { tools: {} }, { tools: { mcpServers: {} } }, { tools: { mcpServers: { memmy_computer_use: stock } } }])(
    "leaves a config without the legacy server unchanged: %j",
    async (config) => {
      const { context } = await fixture(config);
      const before = await fs.readFile(context.runtimeConfigFile, "utf8");
      expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 0, ignored: 1 });
      expect(await fs.readFile(context.runtimeConfigFile, "utf8")).toBe(before);
    },
  );

  it("rewrites tool ids already stored under the new server id", async () => {
    const { context, read } = await fixture({
      tools: { mcpServers: { memmy_computer_use: { ...stock, enabledTools: ["mcp_open_computer_use_click"] } } },
    });
    expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect((await read()).tools.mcpServers.memmy_computer_use.enabledTools).toEqual(["mcp_memmy_computer_use_click"]);
  });

  it("drops a stock legacy server when the renamed server is already present", async () => {
    const { context, read } = await fixture({
      tools: { mcpServers: { memmy_computer_use: { ...stock, enabledTools: ["click"] }, open_computer_use: stock } },
    });
    expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect((await read()).tools.mcpServers).toEqual({ memmy_computer_use: { ...stock, enabledTools: ["click"] } });
  });

  it("keeps a customized legacy server when the new server is still the stock preset", async () => {
    const custom = { command: "/custom/ocu", args: ["mcp"], enabledTools: ["mcp_open_computer_use_click"] };
    const { context, read } = await fixture({
      tools: { mcpServers: { memmy_computer_use: stock, open_computer_use: custom } },
    });
    expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect((await read()).tools.mcpServers).toEqual({
      memmy_computer_use: { ...custom, enabledTools: ["mcp_memmy_computer_use_click"] },
    });
  });

  it("keeps both servers when each has its own custom configuration", async () => {
    const { context, read } = await fixture({
      tools: {
        mcpServers: {
          memmy_computer_use: { command: "/new/ocu", args: ["mcp"], enabledTools: ["mcp_open_computer_use_click"] },
          open_computer_use: { command: "/old/ocu", args: ["mcp"], enabledTools: ["mcp_open_computer_use_scroll"] },
        },
      },
    });
    expect(await renameMemmyComputerUseMcpV119.up(context)).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect((await read()).tools.mcpServers).toEqual({
      memmy_computer_use: { command: "/new/ocu", args: ["mcp"], enabledTools: ["mcp_memmy_computer_use_click"] },
      open_computer_use: { command: "/old/ocu", args: ["mcp"], enabledTools: ["mcp_open_computer_use_scroll"] },
    });
  });

  it.each([{ tools: null }, { tools: [] }, { tools: "invalid" }, { tools: { mcpServers: null } }, { tools: { mcpServers: [] } }])(
    "rejects invalid containers without overwriting the file: %j",
    async (config) => {
      const { context } = await fixture(config);
      const before = await fs.readFile(context.runtimeConfigFile, "utf8");
      await expect(renameMemmyComputerUseMcpV119.up(context)).rejects.toMatchObject({ code: "migration_config_invalid" });
      expect(await fs.readFile(context.runtimeConfigFile, "utf8")).toBe(before);
    },
  );

  it("defers a missing config and applies under the runner lock once it exists", async () => {
    const { context, read } = await fixture();
    const options = {
      targets: { agentWorkspace: context.profileWorkspace, runtimeConfigFile: context.runtimeConfigFile, sessionDagDir: context.sessionDagDir },
      logger: context.logger,
    };
    const internals = { definitions: [renameMemmyComputerUseMcpV119] };
    expect((await runMigrationsForTest(options, internals)).deferred).toEqual([renameMemmyComputerUseMcpV119.id]);
    await expect(fs.stat(context.runtimeConfigFile)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(context.runtimeConfigFile, "tools:\n  mcpServers:\n    open_computer_use:\n      command: open-computer-use\n      args: [mcp]\n");
    expect((await runMigrationsForTest(options, internals)).applied.map((item) => item.id)).toEqual([renameMemmyComputerUseMcpV119.id]);
    const config = await read();
    expect(config.tools.mcpServers.memmy_computer_use.command).toBe("open-computer-use");
    expect(config.tools.mcpServers.open_computer_use).toBeUndefined();
  });
});
