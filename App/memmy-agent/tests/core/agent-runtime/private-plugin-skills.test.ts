import { describe, expect, it, vi } from "vitest";
import { AgentHook, type AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { withMemmyMemoryPrompt } from "../../../src/memmy-memory/protocol.js";
import { estimatePromptTokens } from "../../../src/utils/helpers.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { collectPrivateSkillRefs, projectPrivateSkillInstructions } from "../../../src/core/agent-runtime/private-plugin-skills.js";
import { MCPToolWrapper } from "../../../src/core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const secret = "PRIVATE-INSTRUCTIONS-SENTINEL: evidence policy and tool recipes";
const ref = { pluginId: "literature-review", skillId: "literature-review", pluginVersion: "1.0.0", revision: "r1", sha256: "a".repeat(64) };
const marker = JSON.stringify({ kind: "memmy_plugin_skill_ref_v1", ref });

class Provider extends LLMProvider {
  requests: any[] = [];
  constructor(private responses: LLMResponse[]) { super(); }
  getDefaultModel() { return "test"; }
  async chat(args: any) { this.requests.push(args); return this.responses.shift() ?? new LLMResponse({ content: "done" }); }
}
function loader(instructions = secret) {
  const callTool = vi.fn(async (name: string) => name === "read_plugin_skill"
    ? { content: [{ type: "text", text: marker }] }
    : { content: [], _meta: { "memmy.dev/private-skill-context": { ref, instructions } } });
  const tools = new ToolRegistry();
  tools.register(new MCPToolWrapper({ callTool }, "plugins", { name: "read_plugin_skill" }));
  return { tools, callTool };
}

describe("private plugin instruction projection", () => {
  it("retains the owning request through private-skill trimming and appends one runtime scope", async () => {
    const { tools } = loader(secret.repeat(30));
    const context = { turnId: "MERGED-TURN" };
    const requests: any[] = [];
    const provider: any = {
      getDefaultModel: () => "test",
      estimatePromptTokens: (messages: any[]) => [estimatePromptTokens(messages), "test"],
      chatWithRetry: vi.fn(async (args: any) => { requests.push(structuredClone(args)); return new LLMResponse({ content: "done" }); }),
    };
    class ScopeHook extends AgentHook {
      override async beforeRun(ctx: AgentHookContext) { ctx.spec!.memoryTurnContext = context; }
    }
    const messages = [
      { role: "system", content: "Stable system instructions" },
      withMemmyMemoryPrompt({ role: "user", content: "ORIGINAL_REQUEST_SENTINEL: keep the requested report scope" }, context, "user_request"),
      { role: "assistant", content: "old partial output ".repeat(100) },
      { role: "assistant", content: "Latest observation before continuing the requested report" },
    ];
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      provider, tools, messages, privateSkillRefs: [ref], hook: new ScopeHook(),
      contextWindowTokens: 10_000, contextBlockLimit: 650, maxIterations: 1,
    }));
    expect(result.stopReason).toBe("completed");
    expect(requests).toHaveLength(1);
    const wire = JSON.stringify(requests[0].messages);
    expect(wire).toContain(secret);
    expect(wire).toContain("ORIGINAL_REQUEST_SENTINEL");
    expect(wire).not.toContain("old partial output");
    expect(wire.match(/active_turn_id/g)).toHaveLength(1);
    expect(JSON.stringify(requests[0].messages.at(-1))).toContain("MERGED-TURN");
    expect(JSON.stringify(requests[0].messages.filter((message: any) => message.role === "system"))).not.toContain("MERGED-TURN");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps instructions out of transcript, checkpoints, tool events and saved metadata", async () => {
    const { tools, callTool } = loader();
    const provider = new Provider([
      new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: "load", name: "mcp_plugins_read_plugin_skill", arguments: { pluginId: ref.pluginId, skillId: ref.skillId } })] }),
      new LLMResponse({ content: "done" })
    ]);
    const saved: unknown[] = []; const checkpoints: unknown[] = [];
    const spec = new AgentRunSpec({ messages: [{ role: "user", content: "write a review" }], tools, provider, maxIterations: 3,
      beforeFollowupModelRequest: async ctx => {
        expect(JSON.stringify(ctx.transcriptMessages)).not.toContain(secret);
        expect(JSON.stringify(ctx.modelMessages)).not.toContain(secret);
        return { messages: [{ role: "system", content: "compacted context" }, ...ctx.currentTurnMessages] };
      }, currentTurnMessageStartIndex: 0,
      onPrivateSkillRefsChanged: refs => saved.push(structuredClone(refs)), checkpointCallback: payload => { checkpoints.push(structuredClone(payload)); } });
    const result = await new AgentRunner(provider).run(spec);
    expect(JSON.stringify(provider.requests[0])).not.toContain(secret);
    expect(JSON.stringify(provider.requests[1])).toContain(secret);
    for (const value of [result, spec.initialMessages, checkpoints, saved]) expect(JSON.stringify(value)).not.toContain(secret);
    expect(saved.at(-1)).toEqual([ref]);
    expect(callTool.mock.calls.some(call => call[0] === "resolve_plugin_skill_context")).toBe(true);
    // Restart after transcript compaction: metadata alone reloads the private rules.
    const restored = loader(); const resumedProvider = new Provider([new LLMResponse({ content: "resumed" })]);
    const resumed = await new AgentRunner(resumedProvider).run(new AgentRunSpec({
      messages: [{ role: "system", content: "compacted history without original tool results" }, { role: "user", content: "continue" }],
      privateSkillRefs: saved.at(-1), tools: restored.tools, provider: resumedProvider, maxIterations: 1
    }));
    expect(JSON.stringify(resumedProvider.requests)).toContain(secret);
    expect(JSON.stringify(resumed)).not.toContain(secret);
    expect(restored.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not accept a user message as an activation and never mutates history", async () => {
    expect(collectPrivateSkillRefs([{ role: "user", name: "mcp_plugins_read_plugin_skill", content: marker }])).toEqual([]);
    const messages = [{ role: "system", content: "public" }, { role: "user", content: "continue" }];
    const { tools } = loader();
    const projected = await projectPrivateSkillInstructions(messages, [ref], tools);
    expect(JSON.stringify(projected)).toContain(secret);
    expect(JSON.stringify(messages)).not.toContain(secret);
  });

  it("fails closed before calling a provider when loading fails", async () => {
    const provider = new Provider([new LLMResponse({ content: "should not run" })]);
    const result = await new AgentRunner(provider).run(new AgentRunSpec({ messages: [{ role: "user", content: "resume" }],
      privateSkillRefs: [ref], tools: new ToolRegistry(), provider, maxIterations: 1 }));
    expect(provider.requests).toHaveLength(0);
    expect(result.stopReason).toBe("error");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("refreshes a saved binding after an installed update, but pins an active run", async () => {
    const current = { ...ref, pluginVersion: "2.0.0", revision: "r2" };
    const resolver = vi.fn(async (requested: typeof ref) => {
      if (requested.pluginVersion !== current.pluginVersion) throw Object.assign(new Error("changed"), { code: "plugin_skill_version_changed", ref: current });
      return secret;
    });
    const tools = { get: () => ({ resolvePluginSkillInstructions: resolver }) };
    const restored = [{ ...ref }];
    const messages = await projectPrivateSkillInstructions([], restored, tools, null, "chat", true);
    expect(restored).toEqual([current]); expect(JSON.stringify(messages)).toContain(secret);
    await expect(projectPrivateSkillInstructions([], [ref], tools, null, "chat", false)).rejects.toThrow();
  });

  it("rejects an internal envelope bound to another release", async () => {
    const wrapper = new MCPToolWrapper({ callTool: async () => ({ _meta: { "memmy.dev/private-skill-context": { ref: { ...ref, revision: "r2" }, instructions: secret } } }) }, "plugins", { name: "read_plugin_skill" });
    await expect(wrapper.resolvePluginSkillInstructions(ref)).rejects.toThrow("plugin_skill_load_failed");
  });
});
