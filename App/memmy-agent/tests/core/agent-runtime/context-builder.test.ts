import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { AgentHook, SystemPromptBuildContext } from "../../../src/core/agent-runtime/hook.js";
import { GOAL_STATE_KEY } from "../../../src/core/session/goal-state.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-context-"));
  roots.push(dir);
  return dir;
}

function builder(root = tempRoot(), init: Record<string, any> = {}): ContextBuilder {
  return new ContextBuilder({ workspace: root, ...init });
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Build Runtime Context", () => {
  it("time only", () => {
    const ctx = ContextBuilder.buildRuntimeContext(null, null);
    expect(ctx).toContain("[Runtime Context");
    expect(ctx).toContain("[/Runtime Context]");
    expect(ctx).toContain("Current Time:");
    expect(ctx).not.toContain("Channel:");
  });

  it("with channel and chatId", () => {
    const ctx = ContextBuilder.buildRuntimeContext("telegram", "chat123");
    expect(ctx).toContain("Channel: telegram");
    expect(ctx).toContain("Chat ID: chat123");
  });

  it("with senderId", () => {
    const ctx = ContextBuilder.buildRuntimeContext("cli", "direct", null, { senderId: "user1" });
    expect(ctx).toContain("Sender ID: user1");
  });

  it("with timezone", () => {
    const ctx = ContextBuilder.buildRuntimeContext(null, null, "Asia/Shanghai");
    expect(ctx).toContain("Current Time:");
  });

  it("no channel no chatId omits both", () => {
    const ctx = ContextBuilder.buildRuntimeContext(null, null);
    expect(ctx).not.toContain("Channel:");
    expect(ctx).not.toContain("Chat ID:");
  });

  it("no senderId omits", () => {
    const ctx = ContextBuilder.buildRuntimeContext("cli", "direct");
    expect(ctx).not.toContain("Sender ID:");
  });
});

describe("Merge Message Content", () => {
  it("str plus str", () => {
    expect(ContextBuilder.mergeMessageContent("hello", "world")).toBe("hello\n\nworld");
  });

  it("empty left plus str", () => {
    expect(ContextBuilder.mergeMessageContent("", "world")).toBe("world");
  });

  it("list plus list", () => {
    const result = ContextBuilder.mergeMessageContent([{ type: "text", text: "a" }], [{ type: "text", text: "b" }]) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("a");
    expect(result[1].text).toBe("b");
  });

  it("str plus list", () => {
    const result = ContextBuilder.mergeMessageContent("hello", [{ type: "text", text: "b" }]) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("hello");
    expect(result[1].text).toBe("b");
  });

  it("list plus str", () => {
    const result = ContextBuilder.mergeMessageContent([{ type: "text", text: "a" }], "world") as any[];
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("a");
    expect(result[1].text).toBe("world");
  });

  it("none plus str", () => {
    expect(ContextBuilder.mergeMessageContent(null, "hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("str plus none", () => {
    expect(ContextBuilder.mergeMessageContent("hello", null)).toEqual([{ type: "text", text: "hello" }]);
  });

  it("none plus none", () => {
    expect(ContextBuilder.mergeMessageContent(null, null)).toEqual([]);
  });

  it("list items not dicts wrapped", () => {
    expect(ContextBuilder.mergeMessageContent(["raw_item"], null)).toEqual([{ type: "text", text: "raw_item" }]);
  });
});

describe("Load Bootstrap Files", () => {
  it("no bootstrap files", () => {
    expect(builder().loadBootstrapFiles()).toBe("");
  });

  it("agents md", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Be helpful.", "utf8");
    const result = builder(root).loadBootstrapFiles();
    expect(result).toContain("## AGENTS.md");
    expect(result).toContain("Be helpful.");
  });

  it("multiple bootstrap files", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Rules.", "utf8");
    fs.writeFileSync(path.join(root, "SOUL.md"), "Soul.", "utf8");
    const result = builder(root).loadBootstrapFiles();
    expect(result).toContain("## AGENTS.md");
    expect(result).toContain("## SOUL.md");
    expect(result).toContain("Rules.");
    expect(result).toContain("Soul.");
  });

  it("all bootstrap files when file memory is enabled", () => {
    const root = tempRoot();
    for (const name of ContextBuilder.BOOTSTRAP_FILES) fs.writeFileSync(path.join(root, name), `Content of ${name}`, "utf8");
    const result = builder(root, { fileMemoryEnabled: true }).loadBootstrapFiles();
    for (const name of ContextBuilder.BOOTSTRAP_FILES) expect(result).toContain(`## ${name}`);
  });

  it("omits USER.md when file memory is disabled", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Rules.", "utf8");
    fs.writeFileSync(path.join(root, "SOUL.md"), "Soul.", "utf8");
    fs.writeFileSync(path.join(root, "USER.md"), "User.", "utf8");
    const result = builder(root).loadBootstrapFiles();
    expect(result).toContain("## AGENTS.md");
    expect(result).toContain("## SOUL.md");
    expect(result).not.toContain("## USER.md");
    expect(result).not.toContain("User.");
  });

  it("legacy tools md is not bootstrapped", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "TOOLS.md"), "workspace tool notes", "utf8");
    const result = builder(root).loadBootstrapFiles();
    expect(result).not.toContain("TOOLS.md");
    expect(result).not.toContain("workspace tool notes");
  });

  it("utf8 content", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "用中文回复", "utf8");
    expect(builder(root).loadBootstrapFiles()).toContain("用中文回复");
  });
});

describe("Is Template Content", () => {
  it("nonexistent template returns false", () => {
    expect(ContextBuilder.isTemplateContent("anything", "nonexistent/path.md")).toBe(false);
  });

  it("content matching template", () => {
    const original = fs.readFileSync(path.join(process.cwd(), "src/templates/memory/MEMORY.md"), "utf8");
    expect(ContextBuilder.isTemplateContent(original, "memory/MEMORY.md")).toBe(true);
  });

  it("modified content returns false", () => {
    expect(ContextBuilder.isTemplateContent("totally different", "memory/MEMORY.md")).toBe(false);
  });
});

describe("Bundled Tool Contract", () => {
  it("tool contract balances general and coding workflows", () => {
    const content = fs.readFileSync(path.join(process.cwd(), "src/templates/agent/tool-contract.md"), "utf8");
    expect(content).toContain("## General Tool Contract");
    expect(content).toContain("{% include 'agent/verification-contract.md' %}");
    expect(content).not.toContain("After meaningful changes, verify with the smallest reliable check");
    expect(content).toContain("Use the narrowest structured tool");
    expect(content).toContain("Do not treat `exec` as a universal workaround");
    expect(content).toContain("## Execution Progress");
    expect(content).toContain("A request to change external state is incomplete");
    expect(content).toContain("## File and Coding Workflows");
    expect(content).toContain("apply_patch");
    expect(content).toContain("## Web and External Information");
    expect(content).toContain("## Messaging and Media");
    expect(content).toContain("## Scheduling and Background Work");
    expect(content.toLowerCase()).not.toContain("pure coding");
  });

  it("tool contract is injected without workspace file", () => {
    const prompt = builder().buildSystemPrompt();
    expect(prompt).toContain("# Tool Usage Notes");
    expect(prompt).toContain("## General Tool Contract");
    expect(prompt).toContain("Do not treat `exec` as a universal workaround");
    expect(prompt).toContain("## Execution Progress");
    expect(prompt.match(/# Verification Contract/g)).toHaveLength(1);
    expect(prompt).toContain("`failed` means the validation output must be inspected");
  });
});

describe("Build User Content", () => {
  it("no media returns string", () => {
    expect(builder().buildUserContent("hello", null)).toBe("hello");
  });

  it("empty media returns string", () => {
    expect(builder().buildUserContent("hello", [])).toBe("hello");
  });

  it("nonexistent media file returns string", () => {
    expect(builder().buildUserContent("hello", ["/nonexistent/image.png"])).toBe("hello");
  });

  it("non image file returns string", () => {
    const root = tempRoot();
    const txt = path.join(root, "doc.txt");
    fs.writeFileSync(txt, "not an image", "utf8");
    expect(builder(root).buildUserContent("hello", [txt])).toBe("hello");
  });

  it("valid image returns list", () => {
    const root = tempRoot();
    const png = path.join(root, "test.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
    const result = builder(root).buildUserContent("hello", [png]) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("image_url");
    expect(result[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(result[1]).toEqual({ type: "text", text: "hello" });
  });

  it("image meta includes path", () => {
    const root = tempRoot();
    const png = path.join(root, "test.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
    const result = builder(root).buildUserContent("hello", [png]) as any[];
    expect(result[0].meta).toHaveProperty("path", png);
  });
});

describe("Build System Prompt", () => {
  it("returns nonempty string", () => {
    const result = builder().buildSystemPrompt();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes identity section", () => {
    const result = builder().buildSystemPrompt();
    expect(result.toLowerCase()).toMatch(/workspace|node|typescript/);
  });

  it("includes bootstrap files", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Be helpful and concise.", "utf8");
    expect(builder(root).buildSystemPrompt()).toContain("Be helpful and concise.");
  });

  it("includes sessionSummary", () => {
    const result = builder().buildSystemPrompt(null, null, "Previous chat about TypeScript.");
    expect(result).toContain("Previous chat about TypeScript.");
    expect(result).toContain("[Archived Context Summary]");
  });

  it("sections separated by separator", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Rules.", "utf8");
    const result = builder(root).buildSystemPrompt(null, null, "Summary.");
    expect(result).toContain("\n\n---\n\n");
  });

  it("no bootstrap no summary", () => {
    const result = builder().buildSystemPrompt();
    expect(result).not.toContain("## AGENTS.md");
    expect(result).not.toContain("[Archived Context Summary]");
  });

  it("lets hooks inspect and modify system prompt sections before rendering", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Be helpful and concise.", "utf8");
    const seen: string[] = [];
    class PromptHook extends AgentHook {
      override onBuildSystemPrompt(context: SystemPromptBuildContext): void {
        seen.push(...context.sections.map((section) => section.id));
        expect(context.workspace).toBe(root);
        expect(context.channel).toBe("cli");
        expect(context.skillNames).toEqual(["memory"]);
        expect(context.getSection("bootstrap")?.content).toContain("AGENTS.md");
        context.upsertSection({ id: "memory-instructions", content: "# Memory Instructions\n\nUse memory carefully." }, { after: "tool-contract" });
      }
    }

    const result = builder(root).buildSystemPrompt(["memory"], "cli", null, new PromptHook());

    expect(seen).toContain("identity");
    expect(seen).toContain("bootstrap");
    expect(seen).toContain("tool-contract");
    expect(result).toContain("# Memory Instructions");
    expect(result.indexOf("# Tool Usage Notes")).toBeLessThan(result.indexOf("# Memory Instructions"));
  });
});

describe("Build Messages", () => {
  it("basic empty history", () => {
    const messages = builder().buildMessages([], "hello");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(String(messages[1].content)).toContain("hello");
  });

  it("passes buildMessages hook into system prompt rendering", () => {
    class PromptHook extends AgentHook {
      override onBuildSystemPrompt(context: SystemPromptBuildContext): void {
        context.upsertSection({ id: "hook-section", content: "# Hook Section\n\nInjected." });
      }
    }

    const messages = builder().buildMessages([], "hello", { hook: new PromptHook() });

    expect(String(messages[0].content)).toContain("# Hook Section");
  });

  it("runtime context injected", () => {
    const messages = builder().buildMessages([], "hello", { channel: "cli", chatId: "direct" });
    const userMsg = String(messages.at(-1)?.content);
    expect(userMsg).toContain("[Runtime Context");
    expect(userMsg).toContain("hello");
  });

  it("adds zh-CN language instructions for user-visible reasoning", () => {
    const messages = builder().buildMessages([], "打开钉钉", {
      channel: "websocket",
      chatId: "chat-1",
      responseLanguage: "zh-CN",
    });
    const systemPrompt = String(messages[0].content);

    expect(systemPrompt).toContain("# 语言要求");
    expect(systemPrompt).toContain("当前桌面端界面语言是简体中文");
    expect(systemPrompt).toContain("reasoning/thinking/思考内容");
  });

  it("injects active goalState from session metadata", () => {
    const meta = { [GOAL_STATE_KEY]: { status: "active", objective: "Finish docs migration." } };
    const messages = builder().buildMessages([], "hi", { channel: "cli", chatId: "x", sessionMetadata: meta });
    const userMsg = String(messages.at(-1)?.content);
    expect(userMsg).toContain("Goal (active):");
    expect(userMsg).toContain("Finish docs migration.");
  });

  it("does not leak goalState without session metadata", () => {
    const meta = { [GOAL_STATE_KEY]: { status: "active", objective: "Other chat goal." } };
    const b = builder();
    const withGoal = b.buildMessages([], "hi", { channel: "websocket", chatId: "chat-a", sessionMetadata: meta });
    const withoutGoal = b.buildMessages([], "hi", { channel: "websocket", chatId: "chat-b", sessionMetadata: {} });

    expect(String(withGoal.at(-1)?.content)).toContain("Other chat goal.");
    expect(String(withoutGoal.at(-1)?.content)).not.toContain("Other chat goal.");
    expect(String(withoutGoal.at(-1)?.content)).not.toContain("Goal (active):");
  });

  it("currentRuntimeLines are injected", () => {
    const messages = builder().buildMessages([], "please use @browserbase tonight", {
      currentRuntimeLines: [
        "MCP Preset Attachment: @browserbase (Browserbase; transport=streamableHttp; tool_prefix=mcp_browserbase_).",
      ],
    });
    const userMsg = String(messages.at(-1)?.content);
    expect(userMsg).toContain("MCP Preset Attachment: @browserbase");
    expect(userMsg).toContain("tool_prefix=mcp_browserbase_");
  });

  it("consecutive same role merged", () => {
    const history = [{ role: "user", content: "previous user message" }];
    const messages = builder().buildMessages(history, "new message");
    expect(messages).toHaveLength(2);
    expect(String(messages[1].content)).toContain("previous user message");
    expect(String(messages[1].content)).toContain("new message");
  });

  it("different role appended", () => {
    const history = [{ role: "assistant", content: "previous response" }];
    const messages = builder().buildMessages(history, "new message");
    expect(messages).toHaveLength(3);
  });

  it("media with history", () => {
    const root = tempRoot();
    const png = path.join(root, "img.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
    const history = [{ role: "assistant", content: "see this" }];
    const messages = builder(root).buildMessages(history, "check image", { media: [png] });
    const userMsg = messages.at(-1)?.content;
    expect(Array.isArray(userMsg)).toBe(true);
    expect((userMsg as any[]).some((block) => block.type === "image_url")).toBe(true);
  });
});
