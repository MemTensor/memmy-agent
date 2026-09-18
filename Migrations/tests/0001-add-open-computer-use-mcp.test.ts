import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addOpenComputerUseMcpV116 } from "../src/migrations/v1.1.6/0001-add-open-computer-use-mcp.js";
import { runMigrationsForTest } from "../src/runner.js";

const roots: string[] = [];

async function fixture(config?: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-computer-use-migration-"));
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

describe("v1.1.6/0001-add-open-computer-use-mcp", () => {
  it.each([{}, { tools: {} }, { tools: { mcpServers: {} } }])("adds missing config to %j", async (config) => {
    const { context, read } = await fixture(config);
    expect(await addOpenComputerUseMcpV116.up(context)).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect((await read()).tools.mcpServers.open_computer_use).toEqual({
      type: "stdio", command: "open-computer-use", args: ["mcp"],
    });
    const before = await fs.readFile(context.runtimeConfigFile, "utf8");
    expect(await addOpenComputerUseMcpV116.up(context)).toEqual({ scanned: 1, changed: 0, ignored: 1 });
    expect(await fs.readFile(context.runtimeConfigFile, "utf8")).toBe(before);
  });

  it("preserves other servers, model credentials, environment references, and unknown fields", async () => {
    const existing = {
      providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } },
      tools: { futureField: true, mcpServers: { custom: { command: "custom-mcp", env: { TOKEN: "${TOKEN}" } } } },
      futureSection: { keep: true },
    };
    const { context, read } = await fixture(existing);
    await addOpenComputerUseMcpV116.up(context);
    const actual = await read();
    expect(actual.tools.mcpServers.open_computer_use).toBeDefined();
    delete actual.tools.mcpServers.open_computer_use;
    expect(actual).toEqual(existing);
  });

  it.each([
    { command: "/custom/ocu", args: ["mcp"], enabledTools: [] },
    { type: "streamableHttp", url: "http://localhost:4321/mcp", futureField: true },
  ])("does not overwrite an existing server: %j", async (server) => {
    const { context } = await fixture({ tools: { mcpServers: { open_computer_use: server } } });
    const before = await fs.readFile(context.runtimeConfigFile, "utf8");
    expect(await addOpenComputerUseMcpV116.up(context)).toEqual({ scanned: 1, changed: 0, ignored: 1 });
    expect(await fs.readFile(context.runtimeConfigFile, "utf8")).toBe(before);
  });

  it.each([{ tools: null }, { tools: [] }, { tools: "invalid" }, { tools: { mcpServers: null } }, { tools: { mcpServers: [] } }])(
    "rejects invalid containers without overwriting the file: %j", async (config) => {
      const { context } = await fixture(config);
      const before = await fs.readFile(context.runtimeConfigFile, "utf8");
      await expect(addOpenComputerUseMcpV116.up(context)).rejects.toMatchObject({ code: "migration_config_invalid" });
      expect(await fs.readFile(context.runtimeConfigFile, "utf8")).toBe(before);
    },
  );

  it("defers a missing config and applies under the runner lock once it exists", async () => {
    const { context, read } = await fixture();
    const options = {
      targets: { agentWorkspace: context.profileWorkspace, runtimeConfigFile: context.runtimeConfigFile, sessionDagDir: context.sessionDagDir },
      logger: context.logger,
    };
    const internals = { definitions: [addOpenComputerUseMcpV116] };
    expect((await runMigrationsForTest(options, internals)).deferred).toEqual([addOpenComputerUseMcpV116.id]);
    await expect(fs.stat(context.runtimeConfigFile)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(context.runtimeConfigFile, "tools:\n  mcpServers: {}\n");
    expect((await runMigrationsForTest(options, internals)).applied.map((item) => item.id)).toEqual([addOpenComputerUseMcpV116.id]);
    const config = await read();
    expect(config.tools.mcpServers.open_computer_use).toBeDefined();
    delete config.tools.mcpServers.open_computer_use;
    await fs.writeFile(context.runtimeConfigFile, YAML.stringify(config));
    expect((await runMigrationsForTest(options, internals)).skipped).toEqual([addOpenComputerUseMcpV116.id]);
    expect((await read()).tools.mcpServers).toEqual({});
  });
});
