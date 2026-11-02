import { describe, expect, it, vi } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { MessageTool } from "../../../src/core/agent-runtime/tools/message.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

describe("plugin file output without host delivery rules", () => {
  it("allows the plugin-driven turn to finish without an extra Host continuation", async () => {
    const sent = vi.fn();
    const message = new MessageTool({ sendCallback: sent });
    message.setContext(new RequestContext({ channel: "websocket", chatId: "chat-1" }));
    const pluginName = "mcp_plugins_plugin_report_render_12345678";
    const pluginResult = JSON.stringify({ publishedFiles: [{ name: "report.docx", path: "/workspace/report.docx" }] });
    const responses = [
      new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: "render", name: pluginName, arguments: {} })] }),
      new LLMResponse({ content: "报告已生成，路径已返回。" })
    ];
    const provider = { generation: { maxTokens: 4096 }, chatWithRetry: vi.fn(async () => responses.shift()!) };
    class PluginTool extends Tool {
      get name() { return pluginName; }
      get description() { return "Render a report"; }
      get parameters() { return { type: "object", properties: {} }; }
      execute() { return [{ type: "text", text: pluginResult }]; }
    }
    const tools = new ToolRegistry();
    tools.register(message);
    tools.register(new PluginTool());

    const result = await new AgentRunner(provider as never).run(new AgentRunSpec({
      messages: [{ role: "user", content: "生成报告" }], provider: provider as never, tools
    }));

    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("报告已生成，路径已返回。");
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(sent).not.toHaveBeenCalled();
  });
});
