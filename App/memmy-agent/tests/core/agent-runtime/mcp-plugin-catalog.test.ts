import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { connectMcpServers, reloadServers, setMcpRuntimeForTest } from "../../../src/core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { Config } from "../../../src/config/schema.js";
import { saveConfig, setConfigPath } from "../../../src/config/loader.js";

it("refreshes restored plugin tools into the current registry after Agent initialization replaces it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-plugin-catalog-"));
  const names = ["plugin_manage"];
  const session = {
    async initialize() {},
    async listTools() { return { tools: names.map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }; },
    async listResources() { return { resources: [] }; },
    async listPrompts() { return { prompts: [] }; }
  };
  setMcpRuntimeForTest({
    ClientSession: class { constructor(read: any) { return read; } },
    StdioServerParameters: class { constructor(init: any) { Object.assign(this, init); } },
    stdioClient: () => ({ async enter() { return [session, {}]; }, async close() {} }),
    sseClient: () => { throw new Error("Unexpected SSE transport"); },
    streamableHttpClient: () => { throw new Error("Unexpected HTTP transport"); }
  });
  let stacks: Awaited<ReturnType<typeof connectMcpServers>> = {};
  try {
    setConfigPath(path.join(root, "config.yaml"));
    const servers = { plugins: { command: "plugin-bridge" } };
    saveConfig(new Config({ tools: { mcpServers: servers } }));
    const initial = new ToolRegistry();
    stacks = await connectMcpServers(servers, initial);
    const state = { mcpServers: servers, mcpStacks: stacks };
    const current = new ToolRegistry();
    for (const [, tool] of initial) current.register(tool);

    names.push("plugin_record_and_replay_cb7d2519");
    await expect(reloadServers(state, current)).resolves.toMatchObject({ ok: true, refreshed: ["plugins"] });
    expect(current.has("mcp_plugins_plugin_record_and_replay_cb7d2519")).toBe(true);
    expect(initial.has("mcp_plugins_plugin_record_and_replay_cb7d2519")).toBe(false);
    names.pop();
    await reloadServers(state, current);
    expect(current.toolNames).toEqual(["mcp_plugins_plugin_manage"]);
  } finally {
    await stacks.plugins?.aclose();
    setMcpRuntimeForTest(null);
    setConfigPath(path.join(os.tmpdir(), "memmy-agent-empty-config.yaml"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
