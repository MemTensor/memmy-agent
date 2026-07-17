import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-session-history-"));
  roots.push(root);
  return root;
}

function assertNoOrphans(history: Record<string, any>[]): void {
  const declared = new Set(
    history.flatMap((message) => (message.role === "assistant" ? (message.tool_calls ?? []).map((tc: any) => tc.id) : [])),
  );
  const orphans = history
    .filter((message) => message.role === "tool" && !declared.has(message.tool_call_id))
    .map((message) => message.tool_call_id);
  expect(orphans).toEqual([]);
}

function toolTurn(prefix: string, idx: number): Record<string, any>[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `${prefix}-${idx}-a`, type: "function", function: { name: "x", arguments: "{}" } },
        { id: `${prefix}-${idx}-b`, type: "function", function: { name: "y", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: `${prefix}-${idx}-a`, name: "x", content: "ok" },
    { role: "tool", tool_call_id: `${prefix}-${idx}-b`, name: "y", content: "ok" },
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionManager history and previews", () => {
  it("listSessions includes metadata title", () => {
    const manager = new SessionManager(tempRoot());
    const session = manager.getOrCreate("websocket:chat-title");
    session.metadata.title = "自动生成标题";
    manager.save(session);

    const rows = manager.listSessions();

    expect(rows[0]).toMatchObject({ key: "websocket:chat-title", title: "自动生成标题" });
  });

  it("renames a session title and marks it as user edited", () => {
    const manager = new SessionManager(tempRoot());
    const session = manager.getOrCreate("websocket:chat-rename");
    session.metadata.webui = true;
    session.metadata.title = "自动生成标题";
    session.addMessage("user", "帮我整理 PRD");
    manager.save(session);

    const renamed = manager.renameSession("websocket:chat-rename", "  我的 PRD 任务  ");

    expect(renamed).toMatchObject({
      key: "websocket:chat-rename",
      title: "我的 PRD 任务",
      preview: "帮我整理 PRD",
    });
    expect(manager.loadSession("websocket:chat-rename")?.metadata).toMatchObject({
      webui: true,
      title: "我的 PRD 任务",
      titleUserEdited: true,
    });

    const cleared = manager.renameSession("websocket:chat-rename", " ");
    expect(cleared).toMatchObject({ key: "websocket:chat-rename" });
    expect(cleared?.title).toBeUndefined();
    expect(manager.loadSession("websocket:chat-rename")?.metadata).toMatchObject({ webui: true });
    expect(manager.loadSession("websocket:chat-rename")?.metadata.title).toBeUndefined();
    expect(manager.loadSession("websocket:chat-rename")?.metadata.titleUserEdited).toBeUndefined();
  });

  it("listSessions includes a user preview", () => {
    const manager = new SessionManager(tempRoot());
    const session = manager.getOrCreate("websocket:chat-preview");
    session.addMessage("user", "帮我总结一下 OpenAI 的最新硬件计划");
    session.addMessage("assistant", "可以，我会先查最新消息。");
    manager.save(session);

    const rows = manager.listSessions();

    expect(rows[0]).toMatchObject({
      key: "websocket:chat-preview",
      preview: "帮我总结一下 OpenAI 的最新硬件计划",
    });
  });

  it("listSessions scrubs subagent result announcements in previews", () => {
    const manager = new SessionManager(tempRoot());
    const session = manager.getOrCreate("websocket:subagent-preview");
    session.messages.push({
      role: "assistant",
      content:
        "[Subagent 'research' completed]\n\nTask:\nFind internal details\n\nResult:\nOnly the final result should show.\n\nSummarize this naturally for the user.",
      injectedEvent: "subagentResult",
    });
    manager.save(session);

    const rows = manager.listSessions();

    expect(rows[0]).toMatchObject({
      key: "websocket:subagent-preview",
      preview: "[Subagent 'research' completed] Only the final result should show.",
    });
    expect(rows[0].preview).not.toContain("Task:");
    expect(rows[0].preview).not.toContain("Summarize this naturally");
  });

  it("listSessions bounds preview scanning", () => {
    const manager = new SessionManager(tempRoot());
    const session = manager.getOrCreate("websocket:chat-long-preview");
    for (let index = 0; index < 220; index += 1) session.addMessage("assistant", `assistant trace ${index}`);
    session.addMessage("user", "this should not force a full sidebar scan");
    manager.save(session);

    const rows = manager.listSessions();

    expect(rows[0]).toMatchObject({ key: "websocket:chat-long-preview", preview: "assistant trace 0" });
  });

  it("getHistory drops orphan tool results when the window cuts tool calls", () => {
    const session = new Session({ key: "telegram:test" });
    session.messages.push({ role: "user", content: "old turn" });
    for (let i = 0; i < 20; i += 1) session.messages.push(...toolTurn("old", i));
    session.messages.push({ role: "user", content: "problem turn" });
    for (let i = 0; i < 25; i += 1) session.messages.push(...toolTurn("cur", i));
    session.messages.push({ role: "user", content: "new telegram question" });

    const history = session.getHistory({ maxMessages: 100 });

    assertNoOrphans(history);
  });

  it("preserves legitimate tool pairs after trim", () => {
    const session = new Session({ key: "test:positive" });
    session.messages.push({ role: "user", content: "hello" });
    for (let i = 0; i < 5; i += 1) session.messages.push(...toolTurn("ok", i));
    session.messages.push({ role: "assistant", content: "done" });

    const history = session.getHistory({ maxMessages: 500 });

    assertNoOrphans(history);
    expect(history.filter((message) => message.role === "tool")).toHaveLength(10);
    expect(history[0].role).toBe("user");
  });

  it("retainRecentLegalSuffix keeps recent messages", () => {
    const session = new Session({ key: "test:trim" });
    for (let i = 0; i < 10; i += 1) session.messages.push({ role: "user", content: `msg${i}` });

    session.retainRecentLegalSuffix(4);

    expect(session.messages).toHaveLength(4);
    expect(session.messages[0].content).toBe("msg6");
    expect(session.messages.at(-1)?.content).toBe("msg9");
  });

  it("retainRecentLegalSuffix adjusts lastConsolidated", () => {
    const session = new Session({ key: "test:trim-cons" });
    for (let i = 0; i < 10; i += 1) session.messages.push({ role: "user", content: `msg${i}` });
    session.lastConsolidated = 7;

    session.retainRecentLegalSuffix(4);

    expect(session.messages).toHaveLength(4);
    expect(session.lastConsolidated).toBe(1);
  });

  it("retainRecentLegalSuffix with zero clears the session", () => {
    const session = new Session({ key: "test:trim-zero" });
    for (let i = 0; i < 10; i += 1) session.messages.push({ role: "user", content: `msg${i}` });
    session.lastConsolidated = 5;

    session.retainRecentLegalSuffix(0);

    expect(session.messages).toEqual([]);
    expect(session.lastConsolidated).toBe(0);
  });

  it("retainRecentLegalSuffix keeps a legal tool boundary", () => {
    const session = new Session({ key: "test:trim-tools" });
    session.messages.push({ role: "user", content: "old" });
    session.messages.push(...toolTurn("old", 0));
    session.messages.push({ role: "user", content: "keep" });
    session.messages.push(...toolTurn("keep", 0));
    session.messages.push({ role: "assistant", content: "done" });

    session.retainRecentLegalSuffix(4);

    const history = session.getHistory({ maxMessages: 500 });
    assertNoOrphans(history);
    expect(history[0]).toMatchObject({ role: "user", content: "keep" });
  });

  it("orphan trimming works with lastConsolidated", () => {
    const session = new Session({ key: "test:consolidated" });
    for (let i = 0; i < 10; i += 1) {
      session.messages.push({ role: "user", content: `old ${i}` });
      session.messages.push(...toolTurn("cons", i));
    }
    session.lastConsolidated = 30;
    session.messages.push({ role: "user", content: "recent" });
    for (let i = 0; i < 15; i += 1) session.messages.push(...toolTurn("new", i));
    session.messages.push({ role: "user", content: "latest" });

    const history = session.getHistory({ maxMessages: 20 });

    assertNoOrphans(history);
    expect(history.every((message) => message.role !== "tool" || message.tool_call_id.startsWith("new_"))).toBe(true);
  });

  it("leaves plain history unchanged aside from the requested window", () => {
    const session = new Session({ key: "test:plain" });
    for (let i = 0; i < 5; i += 1) {
      session.messages.push({ role: "user", content: `q${i}` });
      session.messages.push({ role: "assistant", content: `a${i}` });
    }

    const history = session.getHistory({ maxMessages: 6 });

    expect(history).toHaveLength(6);
    assertNoOrphans(history);
  });

  it("strips all orphan tool results at the prefix", () => {
    const session = new Session({ key: "test:all-orphan" });
    session.messages.push({ role: "tool", tool_call_id: "gone_1", name: "x", content: "ok" });
    session.messages.push({ role: "tool", tool_call_id: "gone_2", name: "y", content: "ok" });
    session.messages.push({ role: "user", content: "fresh start" });
    session.messages.push({ role: "assistant", content: "hi" });

    const history = session.getHistory({ maxMessages: 500 });

    assertNoOrphans(history);
    expect(history).toEqual([
      { role: "user", content: "fresh start" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("returns an empty history for empty sessions", () => {
    expect(new Session({ key: "test:empty" }).getHistory({ maxMessages: 500 })).toEqual([]);
  });

  it("drops assistant replay artifacts that sanitize to empty and strips runtime metadata", () => {
    const session = new Session({ key: "test:empty-assistant" });
    session.messages.push({
      role: "user",
      content: "hi",
      senderId: "user-1",
      channelDelivery: true,
      timestamp: "2026-06-05T10:00:00Z",
    });
    session.messages.push({
      role: "assistant",
      content:
        "[Message Time: 2026-06-05T10:00:01Z]\n[image: /tmp/generated.png]\ngenerate_image(\"16:9\")\nmessage(\"done\")",
      senderId: "assistant",
      injectedEvent: "subagentResult",
      subagentTaskId: "task-1",
      latency_ms: 17,
      timestamp: "2026-06-05T10:00:01Z",
    });
    session.messages.push({
      role: "assistant",
      content: "done",
      senderId: "assistant",
      latency_ms: 23,
      timestamp: "2026-06-05T10:00:02Z",
    });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("keeps empty assistant rows when they carry tool call state", () => {
    const session = new Session({ key: "test:empty-tool-call" });
    session.messages.push({ role: "user", content: "run it" });
    session.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      senderId: "assistant",
    });
    session.messages.push({ role: "tool", tool_call_id: "tc_1", name: "read_file", content: "ok", latency_ms: 5 });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history).toEqual([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", tool_call_id: "tc_1", name: "read_file" },
    ]);
  });

  it("preserves reasoning content and thinking blocks", () => {
    const session = new Session({ key: "test:reasoning" });
    session.messages.push({ role: "user", content: "hi" });
    session.messages.push({
      role: "assistant",
      content: "done",
      reasoning_content: "hidden chain of thought",
      thinking_blocks: [{ type: "thinking", thinking: "hidden chain of thought", signature: "sig" }],
      extra_content: { cache_control: { type: "ephemeral" } },
      senderId: "assistant",
      latency_ms: 12,
    });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "done",
        reasoning_content: "hidden chain of thought",
        thinking_blocks: [{ type: "thinking", thinking: "hidden chain of thought", signature: "sig" }],
        extra_content: { cache_control: { type: "ephemeral" } },
      },
    ]);
  });

  it("annotates user turns but not assistant turns with timestamps", () => {
    const session = new Session({ key: "test:timestamps" });
    session.messages.push({ role: "user", content: "10 点提醒是昨天发生的", timestamp: "2026-04-26T22:00:00" });
    session.messages.push({ role: "assistant", content: "记下来了", timestamp: "2026-04-26T22:00:05" });

    const history = session.getHistory({ maxMessages: 500, includeTimestamps: true });

    expect(history).toEqual([
      { role: "user", content: "[Message Time: 2026-04-26T22:00:00]\n10 点提醒是昨天发生的" },
      { role: "assistant", content: "记下来了" },
    ]);
  });

  it("does not annotate proactive assistant deliveries with timestamps", () => {
    const session = new Session({ key: "test:proactive-timestamps" });
    session.messages.push({ role: "assistant", content: "记得喝水", timestamp: "2026-04-26T15:00:00", channelDelivery: true });
    session.messages.push({ role: "user", content: "好", timestamp: "2026-04-26T18:00:00" });

    const history = session.getHistory({ maxMessages: 500, includeTimestamps: true });

    expect(history).toEqual([
      { role: "assistant", content: "记得喝水" },
      { role: "user", content: "[Message Time: 2026-04-26T18:00:00]\n好" },
    ]);
  });

  it("does not annotate tool results with timestamps", () => {
    const session = new Session({ key: "test:tool-timestamps" });
    session.messages.push({ role: "user", content: "run tool" });
    session.messages.push(...toolTurn("ts", 0));
    session.messages[session.messages.length - 1].timestamp = "2026-04-26T22:00:10";

    const history = session.getHistory({ maxMessages: 500, includeTimestamps: true });

    expect(history.at(-1)).toMatchObject({ role: "tool", content: "ok" });
  });

  it("trims windows that cut mid tool group", () => {
    const session = new Session({ key: "test:mid-cut" });
    session.messages.push({ role: "user", content: "setup" });
    session.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "split_a", type: "function", function: { name: "x", arguments: "{}" } },
        { id: "split_b", type: "function", function: { name: "y", arguments: "{}" } },
      ],
    });
    session.messages.push({ role: "tool", tool_call_id: "split_a", name: "x", content: "ok" });
    session.messages.push({ role: "tool", tool_call_id: "split_b", name: "y", content: "ok" });
    session.messages.push({ role: "user", content: "next" });
    session.messages.push(...toolTurn("intact", 0));
    session.messages.push({ role: "assistant", content: "final" });

    const history = session.getHistory({ maxMessages: 6 });

    assertNoOrphans(history);
  });

  it("synthesizes image breadcrumbs from media kwargs", () => {
    const session = new Session({ key: "test:media" });
    session.messages.push({ role: "user", content: "look", media: ["/m/a.png", "/m/b.png"] });
    session.messages.push({ role: "assistant", content: "nice" });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history).toEqual([
      { role: "user", content: "look\n[image: /m/a.png]\n[image: /m/b.png]" },
      { role: "assistant", content: "nice" },
    ]);
  });

  it("synthesizes breadcrumbs for image-only turns", () => {
    const session = new Session({ key: "test:image-only" });
    session.messages.push({ role: "user", content: "", media: ["/m/pic.png"] });
    session.messages.push({ role: "assistant", content: "I see a cat" });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history[0]).toEqual({ role: "user", content: "[image: /m/pic.png]" });
  });

  it("synthesizes MCP preset attachment breadcrumbs", () => {
    const session = new Session({ key: "test:mcp-preset" });
    session.messages.push({
      role: "user",
      content: "please use @browserbase",
      mcp_presets: [{ name: "browserbase", transport: "streamableHttp" }],
    });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history).toEqual([
      {
        role: "user",
        content:
          "please use @browserbase\n[MCP Preset Attachment: @browserbase; tool_prefix=mcp_browserbase_; transport=streamableHttp]",
      },
    ]);
  });

  it("ignores media kwargs on non-user rows", () => {
    const session = new Session({ key: "test:defensive" });
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "structured" }], media: ["/m/x.png"] });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history[0].content).toEqual([{ type: "text", text: "structured" }]);
  });

  it("does not paste assistant media paths into replay", () => {
    const session = new Session({ key: "test:assistant-media" });
    session.messages.push({ role: "assistant", content: "来了 🎨", media: ["~/.memmy/media/generated/img_abc.png"] });

    const history = session.getHistory({ maxMessages: 500 });

    expect(history).toEqual([{ role: "assistant", content: "来了 🎨" }]);
  });

  it("sanitizes existing assistant replay artifacts", () => {
    const session = new Session({ key: "test:polluted-assistant" });
    session.messages.push({
      role: "assistant",
      content:
        "[Message Time: 2026-05-09 00:33:48]\n来了 🎨\n[image: ~/.memmy/media/generated/img_old.png]\n\ngenerate_image(\"16:9\")\nmessage(\"来了 🎨\")",
    });

    const history = session.getHistory({ maxMessages: 500, includeTimestamps: true });

    expect(history).toEqual([{ role: "assistant", content: "来了 🎨" }]);
  });

  it("respects max token budgets", () => {
    const session = new Session({ key: "test:token-cap" });
    session.messages.push(
      { role: "user", content: "u1".repeat(200) },
      { role: "assistant", content: "a1".repeat(200) },
      { role: "user", content: "u2".repeat(200) },
      { role: "assistant", content: "a2".repeat(200) },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    );

    const history = session.getHistory({ maxMessages: 500, maxTokens: 60 });

    expect(history.map((message) => message.content)).toEqual(["u3", "a3"]);
  });

  it("recovers a user turn when token slicing would be assistant-only", () => {
    const session = new Session({ key: "test:assistant-only-slice" });
    session.messages.push(
      { role: "user", content: "u1".repeat(200) },
      { role: "assistant", content: "a1".repeat(200) },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2".repeat(200) },
    );

    const history = session.getHistory({ maxMessages: 500, maxTokens: 60 });

    expect(history.map((message) => message.content)).toEqual(["u2", "a2".repeat(200)]);
  });

  it("hard-caps long non-user chains when retaining recent legal suffixes", () => {
    const session = new Session({ key: "test:hard-cap-chain" });
    session.messages.push({ role: "user", content: "u0" });
    session.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
    });
    for (let i = 0; i < 12; i += 1) session.messages.push({ role: "assistant", content: `a${i}` });

    session.retainRecentLegalSuffix(6);

    expect(session.messages.length).toBeLessThanOrEqual(6);
  });
});
