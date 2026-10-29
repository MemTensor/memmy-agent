import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createPluginSkillContentService } from "../services/plugin-skill-content-service.js";
import { createProgressBus } from "../services/progress-bus.js";
import { buildPluginMcpServer, capabilityToolName } from "../adapters/inbound/local-api/routes/plugin-mcp.js";
import { ToolRegistry } from "../../../memmy-agent/src/core/agent-runtime/tools/registry.js";
import { MCPToolWrapper } from "../../../memmy-agent/src/core/agent-runtime/tools/mcp.js";
import { AgentRunSpec, AgentRunner } from "../../../memmy-agent/src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../memmy-agent/src/providers/base.js";

it("loads cloud instructions through the real bridge without persisting bodies and reloads after restart", async () => {
  const secret = "PRIVATE-CLOUD-TO-MODEL-SENTINEL";
  const payload = JSON.stringify({ format: "memmy-plugin-skill-v1", pluginId: "review", skillId: "review", pluginVersion: "1.0.0", revision: "r1", files: { "SKILL.md": secret, "references/evidence-policy.md": "PRIVATE-EVIDENCE-SENTINEL" } });
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const plugin: any = { id: "review", version: "1.0.0", state: "active", manifest: { id: "review", name: "Review", skills: [{ id: "review", cloud: { revision: "r1", sha256 } }], capabilities: [{ id: "run", name: "Run", description: "Run", inputSchema: { type: "object" } }] } };
  const fetchFn = vi.fn(async () => new Response(payload));
  const content = createPluginSkillContentService({ baseUrl: "https://cloud.test.invalid", getPlugin: () => plugin, authHeaders: () => ({ authorization: "Bearer fixture-account" }), fetch: fetchFn as any });
  const root = mkdtempSync(join(tmpdir(), "memmy-private-skill-e2e-"));
  const connections: Array<{ client: Client; server: ReturnType<typeof buildPluginMcpServer> }> = [];
  const events: unknown[] = []; const saved: unknown[] = []; const checkpoints: unknown[] = [];
  const invoke = vi.fn(async function* () { yield { type: "result" as const, output: { ok: true } }; });
  async function tools() {
    const bus = createProgressBus(); bus.on("plugin.capability_event", event => events.push(event));
    const server = buildPluginMcpServer({ list: () => [plugin], invoke, cancel: async () => {} }, bus, undefined, content);
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "test", version: "1" });
    await server.connect(b); await client.connect(a); connections.push({ client, server });
    const session = { callTool: (name: string, args: any, _timeout: number, meta: any) => client.callTool({ name, arguments: args, _meta: meta }) };
    const registry = new ToolRegistry();
    for (const tool of (await client.listTools()).tools) registry.register(new MCPToolWrapper(session, "plugins", tool));
    return registry;
  }
  try {
    const requests: any[] = [];
    const runTool = `mcp_plugins_${capabilityToolName("review", "run")}`;
    const responses = [
      new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: "load", name: "mcp_plugins_read_plugin_skill", arguments: { pluginId: "review", skillId: "review" } })] }),
      new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: "run", name: runTool })] }),
      new LLMResponse({ content: "review completed" })
    ];
    const provider = { chat: async (args: any) => { requests.push(args); return responses.shift()!; } };
    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({ messages: [{ role: "user", content: "write a review" }], provider: provider as any,
      tools: await tools(), sessionKey: "chat", maxIterations: 4, onPrivateSkillRefsChanged: refs => saved.push(structuredClone(refs)),
      checkpointCallback: checkpoint => { checkpoints.push(structuredClone(checkpoint)); } }));
    expect(invoke).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests[0])).not.toContain(secret);
    expect(JSON.stringify(requests[1])).toContain(secret); expect(JSON.stringify(requests[2])).toContain(secret);
    writeFileSync(join(root, "session.json"), JSON.stringify({ messages: result.messages, metadata: { privatePluginSkillRefs: saved.at(-1) }, checkpoints, events }));
    const transcript = readFileSync(join(root, "session.json"), "utf8");
    expect(transcript).not.toContain(secret); expect(transcript).not.toContain("PRIVATE-EVIDENCE-SENTINEL");
    expect(transcript).toContain("memmy_plugin_skill_ref_v1");
    content.clear(); // Simulated Host restart: all instruction memory is lost.
    const resumedRequests: any[] = [];
    const resumedProvider = { chat: async (args: any) => { resumedRequests.push(args); return new LLMResponse({ content: "resumed" }); } };
    const restored = JSON.parse(transcript);
    const resumed = await new AgentRunner(resumedProvider as any).run(new AgentRunSpec({ messages: [{ role: "user", content: "continue after compaction" }],
      privateSkillRefs: restored.metadata.privatePluginSkillRefs, tools: await tools(), sessionKey: "chat", provider: resumedProvider as any, maxIterations: 1 }));
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(JSON.stringify(resumedRequests)).toContain(secret);
    expect(JSON.stringify(resumed.messages)).not.toContain(secret);
  } finally {
    content.clear(); await Promise.all(connections.flatMap(({ client, server }) => [client.close(), server.close()])); rmSync(root, { recursive: true, force: true });
  }
});
