import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { templatesDir, readTemplate } from "../../../src/templates/index.js";
import { syncWorkspaceTemplates } from "../../../src/utils/helpers.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-context-cache-"));
  tmpDirs.push(workspace);
  return workspace;
}

function scopedPrompt(builder: ContextBuilder, sessionKey: string, unifiedSession = false): string {
  return String(builder.buildMessages({
    history: [],
    currentMessage: "test",
    sessionKey,
    unifiedSession,
  })[0].content);
}

function fileMemoryBuilder(workspace = makeWorkspace()): ContextBuilder {
  return new ContextBuilder({ workspace, fileMemoryEnabled: true });
}

describe("Context prompt cache inputs", () => {
  it("uses bundled templates for all bootstrap files", () => {
    for (const filename of ContextBuilder.BOOTSTRAP_FILES) {
      expect(fs.existsSync(path.join(templatesDir(), filename))).toBe(true);
    }
  });

  it("keeps the system prompt stable across wall clock changes", () => {
    const builder = new ContextBuilder({ workspace: makeWorkspace() });
    expect(builder.buildSystemPrompt()).toBe(builder.buildSystemPrompt());
  });

  it("reflects the current Dream memory contract", () => {
    const prompt = fileMemoryBuilder().buildSystemPrompt();
    expect(prompt.match(/# File Memory/g)).toHaveLength(1);
    expect(prompt).toContain("memory/history.jsonl");
    expect(prompt).toContain("maintained automatically by Dream");
    expect(prompt).toContain("Do not edit those files directly");
    expect(prompt).not.toContain("memory/HISTORY.md");
    expect(prompt).not.toContain("write important facts here");
  });

  it("keeps file memory out of the default system prompt", () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "memory", "MEMORY.md"), "secret memory", "utf8");
    const builder = new ContextBuilder({ workspace });
    builder.memory.appendHistory("secret history");

    const prompt = builder.buildSystemPrompt();

    expect(builder.fileMemoryEnabled).toBe(false);
    expect(prompt).not.toContain("# File Memory");
    expect(prompt).not.toContain("secret memory");
    expect(prompt).not.toContain("secret history");
    expect(prompt).not.toContain("# Recent History");
    expect(prompt).not.toContain("File memory is disabled");
  });

  it("appends runtime context to the current user message", () => {
    const messages = new ContextBuilder({ workspace: makeWorkspace() }).buildMessages({
      history: [],
      currentMessage: "Return exactly: OK",
      channel: "cli",
      chatId: "direct",
    });
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).not.toContain("## Current Session");
    expect(messages.at(-1)?.role).toBe("user");
    const content = messages.at(-1)?.content;
    expect(typeof content).toBe("string");
    expect(content).toContain(ContextBuilder.RUNTIME_CONTEXT_TAG);
    expect(content).toContain("Current Time:");
    expect(content).toContain("Channel: cli");
    expect(content).toContain("Chat ID: direct");
    expect(content).toContain("Return exactly: OK");
  });

  it("places user content before runtime context for cache stability", () => {
    const messages = new ContextBuilder({ workspace: makeWorkspace() }).buildMessages({
      history: [],
      currentMessage: "hello world",
      channel: "cli",
      chatId: "direct",
    });
    const content = String(messages.at(-1)?.content);
    expect(content.indexOf("hello world")).toBeLessThan(content.indexOf(ContextBuilder.RUNTIME_CONTEXT_TAG));
  });

  it("includes sender id when runtime context receives one", () => {
    const messages = new ContextBuilder({ workspace: makeWorkspace() }).buildMessages({
      history: [],
      currentMessage: "Return exactly: OK",
      channel: "cli",
      chatId: "direct",
      senderId: "user-12345",
    });
    expect(String(messages.at(-1)?.content)).toContain("Sender ID: user-12345");
  });

  it("omits sender id when runtime context does not receive one", () => {
    const messages = new ContextBuilder({ workspace: makeWorkspace() }).buildMessages({
      history: [],
      currentMessage: "Return exactly: OK",
      channel: "cli",
      chatId: "direct",
      senderId: null,
    });
    expect(String(messages.at(-1)?.content)).not.toContain("Sender ID:");
  });

  it("injects unprocessed memory history with timestamps", () => {
    const builder = fileMemoryBuilder();
    builder.memory.appendHistory("User asked about weather in Tokyo");
    builder.memory.appendHistory("Agent fetched forecast via web_search");
    const prompt = builder.buildSystemPrompt();
    expect(prompt).toContain("# Recent History");
    expect(prompt).toContain("User asked about weather in Tokyo");
    expect(prompt).toContain("Agent fetched forecast via web_search");
    expect(prompt).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  it("injects only recent history owned by the current session", () => {
    const builder = fileMemoryBuilder();
    builder.memory.appendHistory("old-wonton.png");
    builder.memory.appendHistory("wonton-a.png", { sessionKey: "websocket:chat-a" });
    builder.memory.appendHistory("city-b.png", { sessionKey: "websocket:chat-b" });
    builder.memory.appendHistory("internal-cron.png", { sessionKey: "cron:job-1" });

    const promptA = scopedPrompt(builder, "websocket:chat-a");
    const promptB = scopedPrompt(builder, "websocket:chat-b");

    expect(promptA).toContain("wonton-a.png");
    expect(promptA).not.toContain("old-wonton.png");
    expect(promptA).not.toContain("city-b.png");
    expect(promptA).not.toContain("internal-cron.png");
    expect(promptB).toContain("city-b.png");
    expect(promptB).not.toContain("wonton-a.png");
  });

  it("shares legacy and non-internal history only in unified mode", () => {
    const builder = fileMemoryBuilder();
    builder.memory.appendHistory("legacy.png");
    builder.memory.appendHistory("channel-a.png", { sessionKey: "websocket:chat-a" });
    builder.memory.appendHistory("unified.png", { sessionKey: "unified:default" });
    builder.memory.appendHistory("cron.png", { sessionKey: "cron:job-1" });
    builder.memory.appendHistory("heartbeat.png", { sessionKey: "heartbeat" });

    const prompt = scopedPrompt(builder, "unified:default", true);

    expect(prompt).toContain("legacy.png");
    expect(prompt).toContain("channel-a.png");
    expect(prompt).toContain("unified.png");
    expect(prompt).not.toContain("cron.png");
    expect(prompt).not.toContain("heartbeat.png");
  });

  it("filters by session before applying the recent history entry cap", () => {
    const builder = fileMemoryBuilder();
    builder.memory.appendHistory("keep-current-session.png", { sessionKey: "websocket:chat-a" });
    for (let index = 0; index < builder.maxRecentHistory + 20; index += 1) {
      builder.memory.appendHistory(`other-${index}.png`, { sessionKey: "websocket:chat-b" });
    }

    const prompt = scopedPrompt(builder, "websocket:chat-a");

    expect(prompt).toContain("keep-current-session.png");
    expect(prompt).not.toContain("other-");
  });

  it("caps recent history at the configured maximum entry count", () => {
    const builder = fileMemoryBuilder();
    for (let index = 0; index < builder.maxRecentHistory + 20; index += 1) {
      builder.memory.appendHistory(`entry-${index}`);
    }
    const prompt = builder.buildSystemPrompt();
    expect(prompt).not.toContain("entry-0");
    expect(prompt).not.toContain("entry-19");
    expect(prompt).toContain(`entry-${builder.maxRecentHistory + 19}`);
  });

  it("truncates recent history at the configured character maximum", () => {
    const builder = fileMemoryBuilder();
    builder.memory.appendHistory("x".repeat(builder.maxHistoryChars + 5_000));
    const [, historySection] = builder.buildSystemPrompt().split("# Recent History\n\n", 2);
    expect(historySection.length).toBeLessThan(builder.maxHistoryChars + 200);
  });

  it("omits recent history after Dream has processed all entries", () => {
    const builder = fileMemoryBuilder();
    const cursor = builder.memory.appendHistory("already processed entry");
    builder.memory.setLastDreamCursor(cursor);
    expect(builder.buildSystemPrompt()).not.toContain("# Recent History");
  });

  it("shows only history entries after the Dream cursor", () => {
    const builder = fileMemoryBuilder();
    builder.memory.appendHistory("old conversation about TypeScript");
    const cursor = builder.memory.appendHistory("old conversation about Rust");
    builder.memory.appendHistory("recent question about Docker");
    builder.memory.appendHistory("recent question about K8s");
    builder.memory.setLastDreamCursor(cursor);
    const prompt = builder.buildSystemPrompt();
    expect(prompt).not.toContain("old conversation about TypeScript");
    expect(prompt).not.toContain("old conversation about Rust");
    expect(prompt).toContain("recent question about Docker");
    expect(prompt).toContain("recent question about K8s");
  });

  it("loads execution rules from the default SOUL template", () => {
    const workspace = makeWorkspace();
    syncWorkspaceTemplates(workspace);
    const prompt = new ContextBuilder({ workspace }).buildSystemPrompt();
    expect(prompt).toContain("single-step tasks");
    expect(prompt).toContain("multi-step tasks");
    expect(prompt).toContain("Read before writing");
    expect(prompt).toContain("verify the result");
  });

  it("keeps identity free of legacy behavioral instructions", () => {
    const identity = new ContextBuilder({ workspace: makeWorkspace() }).getIdentity(null);
    expect(identity).not.toContain("You are memmy");
    expect(identity).not.toContain("Act, don't narrate");
    expect(identity).not.toContain("Execution Rules");
  });

  it("does not warn about Message Time markers in the system prompt", () => {
    expect(new ContextBuilder({ workspace: makeWorkspace() }).buildSystemPrompt()).not.toContain("Message Time");
  });

  it("keeps execution rules in the bundled SOUL template", () => {
    const soul = readTemplate("SOUL.md");
    expect(soul).toContain("## Execution Rules");
    expect(soul).toContain("single-step tasks");
    expect(soul).toContain("multi-step tasks");
  });

  it("adds a messaging format hint for Telegram", () => {
    const prompt = new ContextBuilder({ workspace: makeWorkspace() }).buildSystemPrompt(null, "telegram");
    expect(prompt).toContain("Format Hint");
    expect(prompt).toContain("messaging app");
  });

  it("adds a plain-text format hint for WhatsApp", () => {
    const prompt = new ContextBuilder({ workspace: makeWorkspace() }).buildSystemPrompt(null, "whatsapp");
    expect(prompt).toContain("Format Hint");
    expect(prompt).toContain("plain text only");
  });

  it("omits format hints for unknown channels", () => {
    const builder = new ContextBuilder({ workspace: makeWorkspace() });
    expect(builder.buildSystemPrompt(null, null)).not.toContain("Format Hint");
    expect(builder.buildSystemPrompt(null, "feishu")).not.toContain("Format Hint");
  });

  it("passes channel through buildMessages to the system prompt", () => {
    const messages = new ContextBuilder({ workspace: makeWorkspace() }).buildMessages({
      history: [],
      currentMessage: "hi",
      channel: "telegram",
      chatId: "123",
    });
    expect(String(messages[0].content)).toContain("Format Hint");
    expect(String(messages[0].content)).toContain("messaging app");
  });

  it("keeps message tool out of normal current-chat replies", () => {
    const prompt = new ContextBuilder({ workspace: makeWorkspace() }).buildSystemPrompt(null, "slack");
    expect(prompt).toContain("Do not use the 'message' tool for ordinary replies in the current chat");
    expect(prompt).toContain("When 'generate_image' creates images");
    expect(prompt).toContain("call 'message' and include the artifact paths in the 'media' parameter");
    expect(prompt).toContain("Wait for the tool results, then answer once");
  });

  it("merges subagent assistant results instead of creating consecutive assistant messages", () => {
    const messages = new ContextBuilder({ workspace: makeWorkspace() }).buildMessages({
      history: [{ role: "assistant", content: "previous result" }],
      currentMessage: "subagent result",
      channel: "cli",
      chatId: "direct",
      currentRole: "assistant",
    });
    for (let index = 0; index < messages.length - 1; index += 1) {
      expect(messages[index].role === "assistant" && messages[index + 1].role === "assistant").toBe(false);
    }
  });

  it("includes always skills as active skills but excludes them from the skills index", () => {
    const prompt = new ContextBuilder({ workspace: makeWorkspace() }).buildSystemPrompt();
    expect(prompt).toContain("# Active Skills");
    expect(prompt).toContain("### Skill: my");
    expect(prompt).not.toContain("### Skill: memory");
    expect(prompt).not.toContain("Memory skill");
    expect(prompt).not.toContain("Tomorrow? Memory.");
    const skillsSection = prompt.split("# Skills\n", 2);
    expect(skillsSection.length).toBeGreaterThan(1);
    const indexText = skillsSection[1].split("\n\n---", 1)[0];
    expect(indexText).not.toContain("**memory**");
  });

  it("skips template MEMORY.md in the system prompt", () => {
    const workspace = makeWorkspace();
    syncWorkspaceTemplates(workspace, undefined, { fileMemoryEnabled: true });
    const prompt = fileMemoryBuilder(workspace).buildSystemPrompt();
    expect(prompt).not.toContain("# Memory\n\n## Long-term Memory");
    expect(prompt).not.toContain("This file is automatically updated by memmy");
  });

  it("injects customized MEMORY.md content", () => {
    const workspace = makeWorkspace();
    syncWorkspaceTemplates(workspace, undefined, { fileMemoryEnabled: true });
    fs.writeFileSync(path.join(workspace, "memory", "MEMORY.md"), "# Long-term Memory\n\nUser prefers dark mode.\n", "utf8");
    const prompt = fileMemoryBuilder(workspace).buildSystemPrompt();
    expect(prompt).toContain("# Memory\n\n## Long-term Memory");
    expect(prompt).toContain("User prefers dark mode");
  });

  it("keeps bootstrap content and order independent from file memory", () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "AGENT_UNIQUE", "utf8");
    fs.writeFileSync(path.join(workspace, "SOUL.md"), "SOUL_UNIQUE", "utf8");
    fs.writeFileSync(path.join(workspace, "USER.md"), "USER_UNIQUE", "utf8");

    for (const fileMemoryEnabled of [false, true]) {
      const prompt = new ContextBuilder({
        workspace,
        fileMemoryEnabled,
      }).buildSystemPrompt(null, null, "session summary");
      expect(prompt.indexOf("AGENT_UNIQUE")).toBeLessThan(prompt.indexOf("SOUL_UNIQUE"));
      expect(prompt.indexOf("SOUL_UNIQUE")).toBeLessThan(prompt.indexOf("USER_UNIQUE"));
      expect(prompt).toContain("[Archived Context Summary]");
      expect(prompt).toContain("session summary");
    }
  });
});
