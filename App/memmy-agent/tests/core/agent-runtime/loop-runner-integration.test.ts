import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME } from "../../../src/core/agent-runtime/tool-result-budget.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse } from "../../../src/providers/base.js";
import { GOAL_STATE_KEY } from "../../../src/core/session/goal-state.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-"));
  roots.push(dir);
  return dir;
}

function provider(responses: string[] = ["ok"]): any {
  const calls: any[] = [];
  return {
    generation: { maxTokens: 100 },
    calls,
    chat: vi.fn(async (args: any) => {
      calls.push(args);
      return new LLMResponse({ content: responses[Math.min(calls.length - 1, responses.length - 1)] });
    }),
    getDefaultModel: () => "test-model",
  };
}

function loop(p = provider(), extra: Record<string, any> = {}): AgentLoop {
  const root = workspace();
  return new AgentLoop({
    provider: p,
    workspace: root,
    model: "test-model",
    contextWindowTokens: 4096,
    sessionDir: path.join(root, "sessions"),
    config: new Config({ memmyMemory: { enabled: false } }),
    ...extra,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentLoop direct processing", () => {
  it("expands the default home workspace instead of creating a literal tilde directory", () => {
    const fakeHome = workspace();
    process.env.HOME = fakeHome;
    const p = provider(["ok"]);
    const agent = new AgentLoop({
      provider: p,
      config: new Config({ agents: { defaults: { workspace: "~/agent-workspace" } } }),
      model: "test-model",
      sessionDir: path.join(workspace(), "sessions"),
    });

    expect(agent.workspace).toBe(path.join(fakeHome, "agent-workspace"));
    expect(agent.workspace).not.toContain(`${path.sep}~${path.sep}`);
  });

  it("processDirect runs the model, returns outbound content, and persists a clean user/assistant turn", async () => {
    const p = provider(["first answer"]);
    const agent = loop(p);

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:test" });

    expect(outbound?.content).toBe("first answer");
    expect(p.chat).toHaveBeenCalledOnce();
    const session = agent.sessions.getOrCreate("cli:test");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.messages[0].content).toBe("hello");
    expect(session.messages[0].content).not.toContain("[Runtime Context");
    expect(session.messages[1].content).toBe("first answer");
    expect(session.messages[1].finish_reason).toBe("stop");
    expect(session.messages[1].latency_ms).toBeGreaterThanOrEqual(0);
    const persistedMessages = fs.readFileSync(agent.sessions.pathFor("cli:test"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persistedMessages.find((message) => message.role === "assistant")).toMatchObject({
      content: "first answer",
      finish_reason: "stop",
    });
  });

  it("publishes a thread session update after early-persisting WebUI user messages", async () => {
    const p = provider(["web answer"]);
    const agent = loop(p);

    const outbound = await agent.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "web-chat",
      senderId: "user",
      content: "hello from web",
      metadata: { webui: true },
    }));

    expect(outbound?.content).toBe("web answer");
    const update = await agent.bus.nextOutbound();
    expect(update.chatId).toBe("web-chat");
    expect(update.metadata).toMatchObject({
      webui: true,
      sessionUpdated: true,
      sessionUpdateScope: "thread",
    });
    expect(agent.bus.outboundSize).toBe(0);
  });

  it("replays prior history on the next direct turn without duplicating the current user message", async () => {
    const p = provider(["one", "two"]);
    const agent = loop(p);

    await agent.processDirect("first", { sessionKey: "cli:test" });
    await agent.processDirect("second", { sessionKey: "cli:test" });

    const secondCallMessages = p.calls[1].messages;
    const userContents = secondCallMessages.filter((message: any) => message.role === "user").map((message: any) => message.content);
    expect(JSON.stringify(secondCallMessages)).toContain("first");
    expect(JSON.stringify(secondCallMessages)).toContain("one");
    expect(secondCallMessages.every((message: any) => !("finish_reason" in message))).toBe(true);
    expect(userContents.filter((content: string) => content.includes("second"))).toHaveLength(1);
    expect(agent.sessions.getOrCreate("cli:test").messages.map((message) => message.content)).toEqual(["first", "one", "second", "two"]);
  });

  it("uses the unified session key when unified sessions are enabled", async () => {
    const p = provider(["ok"]);
    const agent = loop(p, { unifiedSession: true });

    await agent.processDirect("hello", { sessionKey: "cli:a", chatId: "a" });

    expect(agent.sessionKey({ sessionKey: "cli:a" } as any)).toBe(UNIFIED_SESSION_KEY);
    expect(agent.sessions.getOrCreate(UNIFIED_SESSION_KEY).messages[0].content).toBe("hello");
  });

  it("handles slash command shortcuts without calling the model and persists command turns outside LLM history", async () => {
    const p = provider(["should not be used"]);
    const agent = loop(p);

    const outbound = await agent.processDirect("/help", { sessionKey: "cli:test" });

    expect(outbound?.content).toContain("memmy commands");
    expect(p.chat).not.toHaveBeenCalled();
    const session = agent.sessions.getOrCreate("cli:test");
    expect(session.messages).toHaveLength(2);
    expect(session.messages.every((message) => message.commandMessage)).toBe(true);
    expect(session.getHistory({ maxMessages: 10 }).some((message) => String(message.content).includes("/help"))).toBe(false);
  });

  it("rewrites /goal into an agent prompt and continues through the model", async () => {
    const p = provider(["working on it"]);
    const agent = loop(p);

    const outbound = await agent.processDirect("/goal migrate the database", { sessionKey: "cli:test" });

    expect(outbound?.content).toBe("working on it");
    expect(p.chat).toHaveBeenCalledOnce();
    const sent = JSON.stringify(p.calls[0].messages);
    expect(sent).toContain("sustained objective");
    expect(sent).toContain("migrate the database");
    expect(agent.sessions.getOrCreate("cli:test").messages[0].content).toContain("sustained objective");
  });

  it("passes active goal state and runtime runner options through ordinary turns", async () => {
    const p = provider(["unused"]);
    const agent = loop(p);
    agent.contextBlockLimit = 1234;
    agent.providerRetryMode = "aggressive";
    agent.toolHintMaxLength = 12;
    const session = agent.sessions.getOrCreate("cli:goal");
    session.metadata[GOAL_STATE_KEY] = {
      status: "active",
      objective: "Finish the TypeScript parity fixes.",
      uiSummary: "agent parity",
    };
    agent.sessions.save(session);
    let seenSpec: any = null;
    agent.runner.run = vi.fn(async (spec: any) => {
      seenSpec = spec;
      return new AgentRunResult({
        finalContent: "still working",
        messages: [...spec.messages, { role: "assistant", content: "still working" }],
        stopReason: "completed",
      });
    });

    const outbound = await agent.processDirect("continue", { sessionKey: "cli:goal" });

    expect(outbound?.content).toBe("still working");
    expect(JSON.stringify(seenSpec.messages)).toContain("Goal (active):");
    expect(JSON.stringify(seenSpec.messages)).toContain("Finish the TypeScript parity fixes.");
    expect(seenSpec.contextWindowTokens).toBe(4096);
    expect(seenSpec.contextBlockLimit).toBe(1234);
    expect(seenSpec.providerRetryMode).toBe("aggressive");
    expect(seenSpec.toolResultMaxCharsByName).toEqual(SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME);
    expect(seenSpec.retryWaitCallback).toBeTypeOf("function");
    expect(seenSpec.checkpointCallback).toBeTypeOf("function");
    expect(seenSpec.llmTimeoutS).toBe(0);
    expect(seenSpec.goalActivePredicate()).toBe(true);
    expect(seenSpec.goalContinueMessage).toContain("Finish the TypeScript parity fixes.");
  });

  it("extracts document media before building prompt and keeps image media for multimodal content", async () => {
    const p = provider(["read it"]);
    const root = workspace();
    const note = path.join(root, "note.txt");
    fs.writeFileSync(note, "Quarterly revenue is $5M", "utf8");
    const png = path.join(root, "image.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
    const agent = new AgentLoop({
      provider: p,
      workspace: root,
      model: "test-model",
      contextWindowTokens: 4096,
      sessionDir: path.join(root, "sessions"),
    });

    await agent.processDirect("summarize", { sessionKey: "cli:test", media: [note, png] });

    const sent = p.calls[0].messages.at(-1).content;
    expect(JSON.stringify(sent)).toContain("Quarterly revenue is $5M");
    expect(JSON.stringify(sent)).toContain("data:image/png;base64");
    const session = agent.sessions.getOrCreate("cli:test");
    expect(session.messages[0].content).toContain("Quarterly revenue is $5M");
    expect(session.messages[0].media).toEqual([png]);
  });

  it("falls back to the empty-response message and truncates oversized tool outputs when saving turns", async () => {
    const p = provider([""]);
    const agent = loop(p, { maxToolResultChars: 20 });

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:test" });

    expect(outbound?.content).toContain("couldn't produce a final answer");

    const session = agent.sessions.getOrCreate("cli:test");
    agent.saveTurn(
      session,
      [
        { role: "system", content: "sys" },
        { role: "tool", tool_call_id: "t1", name: "x", content: "x".repeat(100) },
      ],
      1,
    );
    expect(String(session.messages.at(-1)?.content).length).toBeLessThan(60);
    expect(String(session.messages.at(-1)?.content)).toContain("truncated");
  });

  it("can be constructed from config with the existing facade path", async () => {
    const p = provider(["ok"]);
    const root = workspace();
    const config = new Config({ agents: { defaults: { workspace: root, provider: "custom", model: "test-model" } } });
    const agent = AgentLoop.fromConfig(config, undefined as any, { provider: p, sessionDir: path.join(root, "sessions") });

    const outbound = await agent.processMessage({ channel: "cli", chatId: "direct", sessionKey: "cli:direct", content: "hi", media: [], metadata: {}, senderId: "user" } as any);

    expect(outbound?.content).toBe("ok");
  });
});
