import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createArtifactDeliveryContinuation, publishedFilesFromPluginResult, writtenFilesFromToolResult } from "../../../src/core/agent-runtime/artifact-delivery-continuation.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { MessageTool } from "../../../src/core/agent-runtime/tools/message.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

type OutboundCapture = { content: string; media: string[] };

describe("plugin file inventory", () => {
  it("reads published files from MCP text and structured-content blocks", () => {
    const content = JSON.stringify({ publishedFiles: [{ name: "报告.docx", path: "/workspace/报告.docx" }] });
    expect(publishedFilesFromPluginResult([
      { type: "text", text: content },
      { type: "text", text: `[structuredContent]\n${content}` }
    ])).toEqual([{ name: "报告.docx", path: "/workspace/报告.docx" }]);
  });

  it("reminds once about undelivered files without automatically sending every output", () => {
    const files = { role: "tool", name: "mcp_plugins_plugin_review_render_12345678",
      content: JSON.stringify({ publishedFiles: [
        { name: "review.pdf", path: "/workspace/review.pdf" },
        { name: "memmy-logo.png", path: "/workspace/memmy-logo.png" },
      ] }) };
    const messages = [{ role: "user", content: "生成综述" }, files];
    const continuation = createArtifactDeliveryContinuation(() => []);
    const reminder = continuation({ finalContent: "全部产物已交付", messages });
    expect(reminder).toContain("message(media=[absolute paths])");
    expect(reminder).toContain("choose the files the user should open or download");
    expect(reminder).not.toContain("memmy-logo.png");
    expect(continuation({ finalContent: "已完成", messages })).toBeNull();
    expect(createArtifactDeliveryContinuation(() => ["/workspace/review.pdf"])(
      { finalContent: "已交付", messages }
    )).toBeNull();
  });

  it("reminds once when a written file was not attached", () => {
    expect(writtenFilesFromToolResult("Successfully wrote /Users/yuan/Documents/预览.html\nlint ok")).toEqual([
      { name: "预览.html", path: "/Users/yuan/Documents/预览.html" },
    ]);
    expect(writtenFilesFromToolResult("Successfully wrote /Users/yuan/Documents/笔记.md")).toEqual([
      { name: "笔记.md", path: "/Users/yuan/Documents/笔记.md" },
    ]);
    expect(writtenFilesFromToolResult("Successfully wrote /Users/yuan/Documents/app.py")).toEqual([]);
    const messages = [
      { role: "user", content: "生成一个 html" },
      { role: "tool", name: "write_file", content: "Successfully wrote /Users/yuan/Documents/预览.html" },
      { role: "tool", name: "edit_file", content: "Successfully replaced text in /Users/yuan/Documents/app.ts" },
    ];
    const continuation = createArtifactDeliveryContinuation(() => []);
    const reminder = continuation({ finalContent: "写好了", messages });
    expect(reminder).toContain("message(media=[absolute paths])");
    expect(reminder).toContain("omit content");
    expect(reminder).toContain("incidental source edits");
    expect(reminder).not.toContain("brief note");
    expect(continuation({ finalContent: "写好了", messages })).toBeNull();
    expect(createArtifactDeliveryContinuation(() => ["/Users/yuan/Documents/预览.html"])(
      { finalContent: "写好了", messages }
    )).toBeNull();
  });

  it("does not remind for a source file written without a deliverable", () => {
    const messages = [
      { role: "user", content: "改一下" },
      { role: "tool", name: "write_file", content: "Successfully wrote /Users/yuan/Documents/app.py" },
    ];
    expect(createArtifactDeliveryContinuation(() => [])({ finalContent: "改好了", messages })).toBeNull();
  });

  it("attaches a file to the answer already written and does not ask for another summary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-"));
    const filePath = path.join(root, "review.pdf");
    fs.writeFileSync(filePath, "pdf");
    const delivered: OutboundCapture[] = [];
    const resultText = JSON.stringify({ publishedFiles: [{ name: "review.pdf", path: filePath }] });
    const messageTool = new MessageTool({
      sendCallback: async (message) => { delivered.push({ content: message.content, media: [...message.media] }); },
      defaultChannel: "websocket",
      defaultChatId: "chat-1",
    });
    let step = 0;
    const provider: any = { getDefaultModel: () => "test", chatWithRetry: vi.fn(async () => {
      step++;
      if (step === 1) return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({
        id: "render", name: "mcp_plugins_plugin_review_render_12345678", arguments: {}
      })] });
      if (step === 2) return new LLMResponse({ content: "全部产物已交付" });
      if (step === 3) return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({
        id: "send", name: "message", arguments: { content: "报告", media: [filePath] }
      })] });
      return new LLMResponse({ content: "报告已附上" });
    }) };
    const tools: any = {
      getDefinitions: () => [],
      get: (name: string) => name === "message" ? messageTool : null,
      execute: vi.fn(async (name: string, params: { content?: string; media?: string[] }) => {
        if (name === "message") return messageTool.execute(params);
        return resultText;
      }),
    };
    try {
      const result = await new AgentRunner(provider).run(new AgentRunSpec({
        messages: [{ role: "user", content: "生成综述" }], provider, tools,
        finalResponseContinuation: createArtifactDeliveryContinuation(() => delivered.flatMap((item) => item.media)),
      }));
      expect(result.finalContent).toBe("全部产物已交付");
      expect(result.finalContentStreamed).toBe(true);
      expect(provider.chatWithRetry).toHaveBeenCalledTimes(3);
      expect(delivered).toEqual([{ content: "", media: [filePath] }]);
      expect(tools.execute.mock.calls.map((call: any[]) => call[0])).toEqual([
        "mcp_plugins_plugin_review_render_12345678", "message"
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
