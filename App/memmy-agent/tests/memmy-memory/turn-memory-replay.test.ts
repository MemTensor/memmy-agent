import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../src/config/schema.js";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { AgentHookContext } from "../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../src/core/agent-runtime/runner.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { Session, SessionManager } from "../../src/core/session/manager.js";
import { LLMResponse } from "../../src/providers/base.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";
import { renderMemmyContextPacket } from "../../src/memmy-memory/protocol.js";
import { estimatePromptTokens } from "../../src/utils/helpers.js";
import { MemmyMemoryTool, MEMOS_MEMORY_TOOL_SPECS } from "../../src/memmy-memory/tools.js";
import { RequestContext } from "../../src/core/agent-runtime/tools/context.js";

const roots: string[] = [];
const loops: AgentLoop[] = [];
const hooks: MemmyMemoryHook[] = [];
function setup(memory = true) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "turn-memory-replay-"));
  roots.push(workspace);
  const client = {
    openSession: vi.fn(async () => ({ sessionId: "memory-session" })),
    startTurn: vi.fn(async (turnId: string) => ({ injectedContext: `MEMORY_${turnId}`, sourceMemoryIds: [turnId] })),
    completeTurn: vi.fn(async () => ({})),
    closeSession: vi.fn(async () => ({})),
  };
  const hook = new MemmyMemoryHook(client as any);
  hooks.push(hook);
  const requests: any[][] = [];
  const provider = {
    generation: { maxTokens: 100 }, getDefaultModel: () => "test",
    estimatePromptTokens: () => [100, "test"],
    chatWithRetry: vi.fn(async (args: any) => {
      requests.push(structuredClone(args.messages));
      return new LLMResponse({ content: "done" });
    }),
  };
  const loop = new AgentLoop({ workspace, provider, model: "test",
    config: new Config({ fileMemory: { enabled: false }, memmyMemory: { enabled: false },
      sessionDag: { enabled: false }, contextCompaction: { summaryMode: "text" } }),
    hooks: memory ? [hook] : [],
  });
  loops.push(loop);
  const send = (turnId: string) => loop.processMessage(new InboundMessage({
    channel: "cli", chatId: "replay", senderId: "user", content: "same question",
    metadata: { turn_id: turnId },
  }));
  return { client, hook, loop, requests, provider, send };
}
afterEach(async () => {
  for (const hook of hooks.splice(0)) await hook.flushPendingWrites();
  for (const loop of loops.splice(0)) await loop.closeRuntimeTools();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("memory follows its owning user turn", () => {
  it("replays retained memory unchanged on the next turn and after disk reload", async () => {
    const f = setup();
    await f.send("T1");
    await f.send("T2");
    const first = f.requests[0].find((m) => m.role === "user");
    const secondUsers = f.requests[1].filter((m) => m.role === "user");
    expect(secondUsers[0]).toEqual(first);
    expect(JSON.stringify(secondUsers[0])).toContain("MEMORY_T1");
    expect(JSON.stringify(secondUsers[1])).toContain("MEMORY_T2");
    expect(JSON.stringify(secondUsers[1])).not.toContain("MEMORY_T1");
    expect(secondUsers[1].content[1].text).toBe('<current_user_request turn_id="T2">');
    const session = f.loop.sessions.getOrCreate("cli:replay");
    const users = session.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["same question", "same question"]);
    expect(users.map((m) => m.memmy_memory.turnId)).toEqual(["T1", "T2"]);
    const reloaded = new SessionManager(f.loop.sessions.root).getOrCreate(session.key);
    expect(reloaded.getHistory({ includeTimestamps: true })[0]).toEqual(first);
    expect(first).not.toHaveProperty("memmy_memory");
    expect(first).not.toHaveProperty("turn_id");
    expect(f.requests[1][0].content).toContain("Only use <memmy_memory_context> packets with the same turn_id");
    await f.hook.flushPendingWrites();
    expect(f.client.startTurn).toHaveBeenCalledTimes(2);
    expect(f.client.completeTurn.mock.calls.map((call: any) => call[1].query)).toEqual(["same question", "same question"]);
  });

  it("removes old memory when the existing summary mechanism replaces its owner", async () => {
    const f = setup();
    f.loop.maxMessages = 2;
    const archive = vi.spyOn(f.loop.consolidator, "archive").mockResolvedValue("Summary of the first turn.");
    await f.send("T1");
    await f.send("T2");
    expect(archive).toHaveBeenCalled();
    const session = f.loop.sessions.getOrCreate("cli:replay");
    expect(session.lastConsolidated).toBe(2);
    expect(JSON.stringify(f.requests[1])).not.toContain("MEMORY_T1");
    expect(JSON.stringify(f.requests[1])).toContain("MEMORY_T2");
    expect(JSON.stringify(f.requests[1])).toContain("Summary of the first turn.");
  });

  it("does not remove retained memory when summary generation returns no summary", async () => {
    const f = setup();
    await f.send("T1");
    const archive = vi.spyOn(f.loop.consolidator, "archive").mockResolvedValue(null);
    const session = f.loop.sessions.getOrCreate("cli:replay");
    // Trigger the original summary path, while leaving the ordinary replay window large.
    session.addMessage("user", "boundary");
    await f.loop.consolidator.maybeConsolidateByTokens(session, { replayMaxMessages: 2 });
    expect(archive).toHaveBeenCalled();
    expect(session.lastConsolidated).toBe(0);
    expect(JSON.stringify(session.getHistory())).toContain("MEMORY_T1");
  });

  it("lets ordinary message, token and file limits discard a memory with its owner", () => {
    const session = new Session({ key: "limits" });
    session.addMessage("user", "old", { turn_id: "T1", memmy_memory: { turnId: "T1", content: [
      { type: "text", text: renderMemmyContextPacket("OLD_MEMORY " + "x".repeat(6000), "turn_start", "old", "T1") },
    ] } });
    session.addMessage("assistant", "old reply");
    session.addMessage("user", "new", { turn_id: "T2" });
    expect(JSON.stringify(session.getHistory())).toContain("OLD_MEMORY");
    expect(JSON.stringify(session.getHistory({ maxMessages: 1 }))).not.toContain("OLD_MEMORY");
    expect(JSON.stringify(session.getHistory({ maxTokens: 20 }))).not.toContain("OLD_MEMORY");
    const archive = vi.fn();
    session.enforceFileCap(archive, 1);
    expect(session.messages).toHaveLength(1);
    expect(archive).toHaveBeenCalledOnce();
    expect(JSON.stringify(session.messages)).not.toContain("OLD_MEMORY");
  });

  it("keeps snipHistory active and drops the old user packet as a unit", () => {
    const provider = { estimatePromptTokens: (messages: any[], tools: any[]) => [estimatePromptTokens(messages, tools), "test"] };
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: renderMemmyContextPacket("OLD_MEMORY " + "x".repeat(6000), "turn_start", "old", "T1") },
      { role: "assistant", content: "old reply" },
      { role: "user", content: renderMemmyContextPacket("NEW_MEMORY", "turn_start", "new", "T2") },
    ];
    const spec = new AgentRunSpec({ provider: provider as any, messages, contextWindowTokens: 10_000, contextBlockLimit: 500 });
    const result = new AgentRunner(provider as any).snipHistory(spec, messages);
    expect(JSON.stringify(result)).not.toContain("OLD_MEMORY");
    expect(result.at(-1)?.content).toBe(messages.at(-1)?.content);
  });

  it.each(["empty", "unavailable"])("labels the current request even when recall is %s", async (mode) => {
    const f = setup();
    await f.send("T1");
    if (mode === "empty") f.client.startTurn.mockResolvedValue({ injectedContext: "", sourceMemoryIds: [] });
    else {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      f.client.startTurn.mockRejectedValue(new Error("offline"));
    }
    await f.send("T2");
    const users = f.requests[1].filter((m) => m.role === "user");
    expect(JSON.stringify(users[0])).toContain("MEMORY_T1");
    expect(JSON.stringify(users[1])).not.toContain("MEMORY_T1");
    expect(users[1].content.some((b: any) => b.text === '<current_user_request turn_id="T2">')).toBe(true);
  });

  it("does not retag old memory during an assistant-only notification", async () => {
    const f = setup();
    const messages = [{ role: "user", content: "old" }, { role: "assistant", content: "notification" }];
    await f.hook.beforeRun(new AgentHookContext({ spec: { sessionKey: "s", turnId: "T2" }, messages }));
    expect(f.client.startTurn).toHaveBeenCalledOnce();
    expect(messages[0].content).toBe("old");
  });

  it("does not create memory snapshots when the hook is disabled", async () => {
    const f = setup(false);
    await f.send("T1");
    expect(f.loop.sessions.getOrCreate("cli:replay").messages[0]).not.toHaveProperty("memmy_memory");
    expect(f.client.startTurn).not.toHaveBeenCalled();
  });

  it("preserves the original image-placeholder persistence rule inside memory snapshots", async () => {
    const f = setup();
    const image = path.join(roots.at(-1)!, "image.png");
    fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2e0AAAAASUVORK5CYII=", "base64"));
    await f.loop.processMessage(new InboundMessage({ channel: "cli", chatId: "replay", senderId: "user",
      content: "look", media: [image], metadata: { turn_id: "T1" } }));
    const session = f.loop.sessions.getOrCreate("cli:replay");
    const stored = session.messages[0];
    expect(stored.media).toEqual([image]);
    expect(JSON.stringify(stored.memmy_memory)).toContain(image);
    expect(JSON.stringify(stored.memmy_memory)).not.toContain("data:image/");
    expect(JSON.stringify(session.getHistory())).toContain("MEMORY_T1");
  });

  it("saves a system user turn's memory through the existing saveTurn path", async () => {
    const f = setup();
    await f.loop.processSystemMessage(new InboundMessage({
      channel: "system", chatId: "cli:replay", senderId: "cron", content: "scheduled question",
    }), "cli:replay");
    const stored = f.loop.sessions.getOrCreate("cli:replay").messages.find((m) => m.role === "user")!;
    expect(stored.content).toBe("scheduled question");
    expect(stored.memmy_memory.turnId).toBe(stored.turn_id);
    const first = f.requests[0].find((m) => m.role === "user");
    await f.send("T2");
    expect(f.requests[1].filter((m) => m.role === "user")[0]).toEqual(first);
  });

  it("uses the tool caller's runtime turn ID even if a result returns after the active turn changes", async () => {
    let turnId = 'T1"<x>';
    let resolve!: (value: any) => void;
    const client = { search: vi.fn(() => new Promise((done) => { resolve = done; })) };
    const runtime = { currentTurnId: () => turnId, currentSessionId: () => "s", currentEpisodeId: () => null,
      currentUserText: () => "question", requestEnvelope: () => ({}) };
    const tool = new MemmyMemoryTool(MEMOS_MEMORY_TOOL_SPECS[0], client as any, runtime as any);
    tool.setContext(new RequestContext({ sessionKey: "s" }));
    const pending = tool.execute({ query: "memory", turnId: "MODEL_SUPPLIED_ID" });
    turnId = "T2";
    resolve({ injectedContext: "recalled memory" });
    const result = await pending;
    expect(result).toContain('turn_id="T1&quot;&lt;x&gt;"');
    expect(result).not.toContain('turn_id="T2"');
    expect(result).not.toContain('turn_id="MODEL_SUPPLIED_ID"');
  });
});
