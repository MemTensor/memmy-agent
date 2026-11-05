import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunSpec, AgentRunner, MICROCOMPACT_KEEP_RECENT } from "../../../src/core/agent-runtime/runner.js";
import { Session } from "../../../src/core/session/manager.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tool-compression-"));
  roots.push(workspace);
  return workspace;
}
describe("optional tool result compression", () => {
  it("defaults off, round trips through config, and rejects non-boolean values", () => {
    expect(new Config().agents.defaults.toolResultCompressionEnabled).toBe(false);
    expect(new AgentRunSpec({}).toolResultCompressionEnabled).toBe(false);
    for (const enabled of [false, true]) {
      const config = new Config({ agents: { defaults: { toolResultCompressionEnabled: enabled } } });
      expect(new Config(config.toObject()).agents.defaults.toolResultCompressionEnabled).toBe(enabled);
    }
    expect(() => new Config({ agents: { defaults: { toolResultCompressionEnabled: "false" } } })).toThrow("boolean");
  });

  it.each([false, true])("controls newly executed tool results when enabled=%s", async (enabled) => {
    const body = "full observation ".repeat(200);
    const tools = { getDefinitions: () => [], get: () => null, execute: vi.fn(async () => body) };
    const runner = new AgentRunner();
    const results = await runner.executeTools(new AgentRunSpec({
      tools: tools as any, maxToolResultChars: 100, toolResultCompressionEnabled: enabled,
    }), [new ToolCallRequest({ id: "one", name: "lookup", arguments: {} })]);
    if (enabled) expect(String(results[0].result).length).toBeLessThan(body.length);
    else expect(results[0].result).toBe(body);
  });

  it.each([false, true])("controls replay shortening and microcompaction when enabled=%s", async (enabled) => {
    const body = "long observation ".repeat(500);
    const messages: any[] = [{ role: "user", content: "work" }];
    for (let i = 0; i < MICROCOMPACT_KEEP_RECENT + 2; i++) {
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
      messages.push({ role: "tool", name: "read_file", tool_call_id: `c${i}`, content: body });
    }
    const chat = vi.fn(async () => new LLMResponse({ content: "done" }));
    const provider = { chatWithRetry: chat };
    await new AgentRunner(provider as any).run(new AgentRunSpec({ provider: provider as any, messages,
      maxIterations: 1, maxToolResultChars: 100_000, toolResultCompressionEnabled: enabled }));
    const sent = (chat.mock.calls as any)[0][0].messages.find((m: any) => m.role === "tool");
    if (enabled) expect(sent.content).not.toBe(body);
    else expect(sent.content).toBe(body);
  });

  it.each([false, true])("propagates the option and preserves its setting when saving results (%s)", (enabled) => {
    const loop = new AgentLoop({ workspace: root(), provider: { generation: {}, getDefaultModel: () => "test" },
      config: new Config({ memmyMemory: { enabled: false }, fileMemory: { enabled: true }, sessionDag: { enabled: false }, contextCompaction: { summaryMode: "text" },
        agents: { defaults: { toolResultCompressionEnabled: enabled, maxToolResultChars: 100 } } }) });
    expect(loop.toolResultCompressionEnabled).toBe(enabled);
    expect(loop.subagents.toolResultCompressionEnabled).toBe(enabled);
    expect(loop.dream!.toolResultCompressionEnabled).toBe(enabled);
    const session = new Session({ key: "save" });
    const body = "output ".repeat(100);
    loop.saveTurn(session, [{ role: "tool", name: "custom", content: body }], 0);
    if (enabled) expect(session.messages[0].content).not.toBe(body);
    else expect(session.messages[0].content).toBe(body);
  });
});
