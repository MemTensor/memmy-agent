import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import {
  WEBUI_TRANSCRIPT_SCHEMA_VERSION,
  appendTranscriptObject,
  buildWebuiThreadResponse,
  readTranscriptLines,
  replayTranscriptToUiMessages,
} from "../../../src/entrypoints/frontend-bridge/transcript.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

const WINDOWS_COMMAND_ERROR = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";

const roots: string[] = [];
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function useDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-transcript-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

function appendAll(key: string, events: Record<string, any>[]): void {
  for (const event of events) appendTranscriptObject(key, event);
}

afterEach(() => {
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("webui transcript replay", () => {
  it("appends and reads JSONL records", () => {
    useDataDir();
    const key = "websocket:t1";

    appendTranscriptObject(key, { event: "user", chat_id: "t1", text: "hello" });
    const lines = readTranscriptLines(key);

    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("hello");
  });

  it("replays assistant deltas, reasoning, and turn-end latency", () => {
    useDataDir();
    const key = "websocket:t2";
    appendAll(key, [
      { event: "user", chat_id: "t2", text: "q" },
      { event: "reasoning_delta", chat_id: "t2", text: "think" },
      { event: "reasoning_end", chat_id: "t2" },
      { event: "delta", chat_id: "t2", text: "a" },
      { event: "stream_end", chat_id: "t2" },
      { event: "turn_end", chat_id: "t2", latency_ms: 42 },
    ]);

    const messages = replayTranscriptToUiMessages(readTranscriptLines(key));

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "q" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "", reasoning: "think" });
    expect(messages[1].isStreaming).not.toBe(true);
    expect(messages[2]).toMatchObject({ role: "assistant", content: "a", latencyMs: 42 });
    expect(messages[2]).not.toHaveProperty("reasoning");
  });

  it("replays resuming stream-end drafts as narration activity before the final answer", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-resuming", text: "q" },
      { event: "delta", chat_id: "t-resuming", text: "tool preface" },
      { event: "stream_end", chat_id: "t-resuming", text: "tool preface", resuming: true },
      { event: "message", chat_id: "t-resuming", kind: "progress", text: "running tool" },
      { event: "message", chat_id: "t-resuming", text: "final answer" },
      { event: "turn_end", chat_id: "t-resuming" },
    ]);

    expect(messages.map((message) => [message.role, message.kind ?? "message"])).toEqual([
      ["user", "message"],
      ["assistant", "narration"],
      ["tool", "trace"],
      ["assistant", "message"],
    ]);
    // The draft keeps its own verbatim narration message: never rewritten,
    // never merged into tool traces.
    expect(messages[1]).toMatchObject({ role: "assistant", kind: "narration", content: "tool preface" });
    expect(messages[2]).toMatchObject({ role: "tool", kind: "trace", traces: ["running tool"] });
    expect(messages[2].traces).not.toContain("tool preface");
    expect(messages[3]).toMatchObject({ role: "assistant", content: "final answer" });
    expect(messages[1].activitySegmentId).toBeTruthy();
    expect(messages[1].activitySegmentId).toBe(messages[2].activitySegmentId);
  });

  it("keeps every resuming draft verbatim as narration without duplicating answers", () => {
    const draft1 = "任务：**「Memmy 技能图鉴」**\n\n## 第 1 轮 — 扫描\n\n先读取技能。";
    const draft2 = "任务：**「Memmy 技能图鉴」**\n\n## 第 1 轮 — 扫描（完成）\n\n## 第 2 轮 — 设计\n\n开始生成图片。";
    const finalText = "完成！**「Memmy 技能图鉴」** 全部三轮结束。";
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-drafts", text: "q" },
      { event: "delta", chat_id: "t-drafts", text: draft1 },
      { event: "stream_end", chat_id: "t-drafts", text: draft1, resuming: true },
      {
        event: "message",
        chat_id: "t-drafts",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "skills/cron/SKILL.md" } }],
      },
      { event: "delta", chat_id: "t-drafts", text: draft2 },
      { event: "stream_end", chat_id: "t-drafts", text: draft2, resuming: true },
      { event: "message", chat_id: "t-drafts", text: finalText },
      { event: "turn_end", chat_id: "t-drafts" },
    ]);

    const narrations = messages.filter((message) => message.kind === "narration");
    const answers = messages.filter((message) => message.role === "assistant" && message.kind !== "narration" && message.kind !== "trace");
    expect(narrations.map((message) => message.content)).toEqual([draft1, draft2]);
    expect(answers.map((message) => message.content)).toEqual([finalText]);
  });

  it("keeps non-resuming assistant text visible when later tool progress arrives", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-mid-answer", text: "q" },
      { event: "delta", chat_id: "t-mid-answer", text: "round 1 summary" },
      { event: "stream_end", chat_id: "t-mid-answer", text: "round 1 summary" },
      {
        event: "message",
        chat_id: "t-mid-answer",
        kind: "progress",
        text: "read_file({\"path\":\"README.md\"})",
        tool_events: [
          { phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } },
        ],
      },
      { event: "message", chat_id: "t-mid-answer", text: "final answer" },
      { event: "turn_end", chat_id: "t-mid-answer" },
    ]);

    expect(messages.map((message) => [message.role, message.kind ?? "message"])).toEqual([
      ["user", "message"],
      ["assistant", "message"],
      ["tool", "trace"],
      ["assistant", "message"],
    ]);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "round 1 summary" });
    expect(messages[2]).toMatchObject({ role: "tool", kind: "trace" });
    expect(messages[2].traces).toEqual(['read_file({"path": "README.md"})']);
    expect(messages[2].traces).not.toContain("round 1 summary");
    expect(messages[3]).toMatchObject({ role: "assistant", content: "final answer" });
  });

  it("replays markdown-like progress without tool events as assistant text", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-narrative-progress", text: "q" },
      {
        event: "message",
        chat_id: "t-narrative-progress",
        kind: "progress",
        text: "好的！这次我设计的任务是：\n\n## Memmy 技能炼金术\n\n第 1 轮：扫描技能。",
      },
      { event: "turn_end", chat_id: "t-narrative-progress" },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "好的！这次我设计的任务是：\n\n## Memmy 技能炼金术\n\n第 1 轮：扫描技能。",
    });
    expect(messages[1]).not.toHaveProperty("kind", "trace");
    expect(messages[1]).not.toHaveProperty("traces");
  });

  it("does not replay empty complete assistant messages after activity-only turns", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-empty", text: "q" },
      {
        event: "message",
        chat_id: "t-empty",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "/tmp/image.png" } }],
      },
      { event: "message", chat_id: "t-empty", text: "" },
      { event: "turn_end", chat_id: "t-empty" },
    ]);

    expect(messages.map((message) => [message.role, message.kind ?? "message"])).toEqual([
      ["user", "message"],
      ["tool", "trace"],
    ]);
    expect(messages.some((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration")).toBe(false);
  });

  it("replays context compaction status updates as one divider message", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-context", text: "q" },
      {
        event: "context_compaction",
        chat_id: "t-context",
        compaction_id: "context-compaction:turn-1",
        status: "running",
        text: "会话压缩中",
      },
      {
        event: "context_compaction",
        chat_id: "t-context",
        compaction_id: "context-compaction:turn-1",
        status: "done",
        text: "压缩已完成",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: "context-compaction:context-compaction:turn-1",
      role: "tool",
      kind: "context_compaction",
      content: "压缩已完成",
      compactionId: "context-compaction:turn-1",
      compactionStatus: "done",
      isStreaming: false,
    });
    expect(messages[1]).not.toHaveProperty("traces");
    expect(messages[1]).not.toHaveProperty("activitySegmentId");
  });

  it("replays creation times from session messages when transcript records omit time", () => {
    const messages = replayTranscriptToUiMessages(
      [
        { event: "user", chat_id: "t-session-time", text: "q" },
        { event: "message", chat_id: "t-session-time", text: "a" },
      ],
      {
        sessionMessages: [
          { role: "user", content: "q", timestamp: "2026-06-19T08:07:00.000Z" },
          { role: "assistant", content: "a", timestamp: "2026-06-19T08:07:03.000Z" },
        ],
      },
    );

    expect(messages[0]).toMatchObject({ role: "user", content: "q", createdAt: Date.parse("2026-06-19T08:07:00.000Z") });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "a", createdAt: Date.parse("2026-06-19T08:07:03.000Z") });
  });

  it("prefers persisted session message times over transcript event times", () => {
    const messages = replayTranscriptToUiMessages(
      [
        { event: "user", chat_id: "t-session-time", text: "q", createdAt: "2026-06-23T10:00:00.000Z" },
        { event: "message", chat_id: "t-session-time", text: "a", createdAt: "2026-06-23T10:00:01.000Z" },
      ],
      {
        sessionMessages: [
          { role: "user", content: "q", timestamp: "2026-06-19T08:07:00.000Z" },
          { role: "assistant", content: "a", timestamp: "2026-06-19T08:07:03.000Z" },
        ],
      },
    );

    expect(messages[0]).toMatchObject({ role: "user", content: "q", createdAt: Date.parse("2026-06-19T08:07:00.000Z") });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "a", createdAt: Date.parse("2026-06-19T08:07:03.000Z") });
  });

  it("augments replayed assistant markdown image text", () => {
    const messages = replayTranscriptToUiMessages(
      [
        { event: "user", chat_id: "t-img", text: "draw" },
        { event: "delta", chat_id: "t-img", text: "![Diagram](diagram.png)" },
        { event: "stream_end", chat_id: "t-img" },
      ],
      { augmentAssistantText: (text) => text.replace("diagram.png", "/api/media/sig/payload") },
    );

    expect(messages[1].content).toBe("![Diagram](/api/media/sig/payload)");
  });

  it("uses stream-end final text when present", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-img", text: "draw" },
      { event: "stream_end", chat_id: "t-img", text: "![Diagram](/api/media/sig/payload)" },
    ]);

    expect(messages[1].content).toBe("![Diagram](/api/media/sig/payload)");
  });

  it("replays delta stream-end followed by complete message as one assistant answer", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-dupe", text: "q" },
      { event: "delta", chat_id: "t-dupe", text: "hel" },
      { event: "stream_end", chat_id: "t-dupe" },
      { event: "message", chat_id: "t-dupe", text: "hello" },
      { event: "turn_end", chat_id: "t-dupe" },
    ]);

    const assistantMessages = messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toBe("hello");
  });

  it("suppresses redundant stream after assistant media delivery", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-img-delivery", text: "画一张图" },
      {
        event: "message",
        chat_id: "t-img-delivery",
        text: "图片已生成",
        media_urls: [{ url: "/api/media/x", name: "image.png" }],
      },
      { event: "message", chat_id: "t-img-delivery", kind: "tool_hint", text: "message()" },
      { event: "delta", chat_id: "t-img-delivery", text: "已发送" },
      { event: "stream_end", chat_id: "t-img-delivery" },
      { event: "turn_end", chat_id: "t-img-delivery" },
    ]);

    const assistantMessages = messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      content: "图片已生成",
      media: [{ kind: "image", url: "/api/media/x", name: "image.png" }],
    });
    expect(messages.some((message) => message.kind === "trace")).toBe(false);
    expect(messages.map((message) => message.content)).not.toContain("已发送");
  });

  it("resumes transcript streaming after assistant media suppression reaches turn end", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-img-resume", text: "画一张图" },
      {
        event: "message",
        chat_id: "t-img-resume",
        text: "图片已生成",
        media_urls: [{ url: "/api/media/x", name: "image.png" }],
      },
      { event: "delta", chat_id: "t-img-resume", text: "冗余" },
      { event: "turn_end", chat_id: "t-img-resume" },
      { event: "user", chat_id: "t-img-resume", text: "继续" },
      { event: "delta", chat_id: "t-img-resume", text: "正常回答" },
      { event: "stream_end", chat_id: "t-img-resume" },
      { event: "turn_end", chat_id: "t-img-resume" },
    ]);

    const assistantMessages = messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages.map((message) => message.content)).toEqual(["图片已生成", "正常回答"]);
    expect(messages.map((message) => message.content)).not.toContain("冗余");
  });

  it("does not suppress transcript streams after non-media complete assistant messages", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-non-media", text: "q" },
      { event: "message", chat_id: "t-non-media", text: "中间完整消息" },
      { event: "delta", chat_id: "t-non-media", text: "后续正常 stream" },
      { event: "stream_end", chat_id: "t-non-media" },
      { event: "turn_end", chat_id: "t-non-media" },
    ]);

    const assistantMessages = messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages.map((message) => message.content)).toEqual(["中间完整消息", "后续正常 stream"]);
  });

  it("replays cron proactive messages as independent assistant messages after a stream", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-cron", text: "q" },
      { event: "delta", chat_id: "t-cron", text: "正在回答" },
      { event: "stream_end", chat_id: "t-cron", text: "正在回答" },
      {
        event: "message",
        chat_id: "t-cron",
        text: "定时任务结果",
        metadata: { proactiveDelivery: "cron" },
      },
      { event: "turn_end", chat_id: "t-cron" },
    ]);

    const assistantMessages = messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]).toMatchObject({ content: "正在回答" });
    expect(assistantMessages[0]).not.toHaveProperty("isStreaming");
    expect(assistantMessages[1]).toMatchObject({ content: "定时任务结果" });
    expect(assistantMessages[1]).not.toHaveProperty("isStreaming");
  });

  it("reports last_turn_closed only when the last user turn has a turn_end", () => {
    useDataDir();
    const key = "websocket:t-closed";
    appendAll(key, [
      { event: "user", chat_id: "t-closed", text: "q" },
      { event: "message", chat_id: "t-closed", text: "answer" },
    ]);
    expect(buildWebuiThreadResponse(key)).toMatchObject({ last_turn_closed: false });

    appendTranscriptObject(key, { event: "turn_end", chat_id: "t-closed" });
    expect(buildWebuiThreadResponse(key)).toMatchObject({ last_turn_closed: true });

    appendTranscriptObject(key, { event: "user", chat_id: "t-closed", text: "next q" });
    expect(buildWebuiThreadResponse(key)).toMatchObject({ last_turn_closed: false });
  });

  it("replays stream-end text followed by revised complete message by replacing content", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-revised", text: "q" },
      { event: "delta", chat_id: "t-revised", text: "初稿" },
      { event: "stream_end", chat_id: "t-revised", text: "初稿" },
      { event: "message", chat_id: "t-revised", text: "最终稿" },
      { event: "turn_end", chat_id: "t-revised" },
    ]);

    const assistantMessages = messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toBe("最终稿");
  });

  it("replays assistant structured media with file, image, and video kinds", () => {
    const messages = replayTranscriptToUiMessages([
      {
        event: "message",
        chat_id: "t-media",
        text: "attachments ready",
        media: ["/tmp/deck.pptx", "/tmp/result.png", "/tmp/clip.mp4"],
        media_urls: [
          { url: "/api/media/sig/deck", name: "deck.pptx" },
          { url: "/api/media/sig/image", name: "result.png" },
          { url: "/api/media/sig/video", name: "clip.mp4" },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].media).toEqual([
      { kind: "file", url: "/api/media/sig/deck", name: "deck.pptx", path: "/tmp/deck.pptx" },
      { kind: "image", url: "/api/media/sig/image", name: "result.png", path: "/tmp/result.png" },
      { kind: "video", url: "/api/media/sig/video", name: "clip.mp4", path: "/tmp/clip.mp4" },
    ]);
  });

  it("augments replayed assistant media paths when signed media urls are missing", () => {
    const messages = replayTranscriptToUiMessages(
      [
        {
          event: "message",
          chat_id: "t-media-path",
          text: "deck ready",
          media: ["/tmp/deck.pptx"],
        },
      ],
      {
        augmentAssistantMedia: (paths) => paths.map((mediaPath) => ({
          url: "/api/media/sig/deck",
          name: path.basename(mediaPath),
          kind: "file",
          path: mediaPath,
        })),
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].media).toEqual([
      { kind: "file", url: "/api/media/sig/deck", name: "deck.pptx", path: "/tmp/deck.pptx" },
    ]);
  });

  it("creates a separate file-edit activity trace", () => {
    useDataDir();
    const key = "websocket:t-file";
    const edit = {
      version: 1,
      call_id: "call-write",
      tool: "write_file",
      path: "foo.txt",
      phase: "end",
      added: 2,
      deleted: 1,
      approximate: false,
      status: "done",
    };
    appendAll(key, [
      { event: "user", chat_id: "t-file", text: "edit" },
      { event: "message", chat_id: "t-file", text: 'write_file({"path":"foo.txt"})', kind: "tool_hint" },
      { event: "file_edit", chat_id: "t-file", edits: [edit] },
    ]);

    const messages = replayTranscriptToUiMessages(readTranscriptLines(key));

    expect(messages).toHaveLength(3);
    expect(messages[1].kind).toBe("trace");
    expect(messages[1].traces).toEqual(['write_file({"path":"foo.txt"})']);
    expect(messages[1]).not.toHaveProperty("fileEdits");
    expect(messages[2].kind).toBe("trace");
    expect(messages[2].traces).toEqual([]);
    expect(messages[2].fileEdits).toEqual([edit]);
    expect(messages[2].activitySegmentId).toBeTruthy();
    expect(messages[2].activitySegmentId).toBe(messages[1].activitySegmentId);
  });

  it("replays same-call file edit and later tool progress in one activity segment", () => {
    const edit = {
      version: 1,
      call_id: "call-write",
      tool: "write_file",
      path: "foo.txt",
      phase: "end",
      added: 1,
      deleted: 0,
      approximate: false,
      status: "done",
    };

    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-file-later-tool", text: "edit" },
      { event: "file_edit", chat_id: "t-file-later-tool", edits: [edit] },
      {
        event: "message",
        chat_id: "t-file-later-tool",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-write", name: "write_file", arguments: { path: "foo.txt" } }],
      },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ role: "tool", kind: "trace", content: "", traces: [], fileEdits: [edit] });
    expect(messages[2]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ['write_file({"path": "foo.txt"})'],
      toolEvents: [{ phase: "end", call_id: "call-write", name: "write_file" }],
    });
    expect(messages[1].activitySegmentId).toBe(messages[2].activitySegmentId);
  });

  it("replays file edit rows with an earlier tool progress segment", () => {
    const startEdit = {
      version: 1,
      call_id: "call-edit",
      tool: "edit_file",
      path: "foo.txt",
      phase: "start",
      added: 2,
      deleted: 1,
      approximate: true,
      status: "editing",
    };
    const endEdit = {
      ...startEdit,
      phase: "end",
      approximate: false,
      status: "done",
    };

    const messages = replayTranscriptToUiMessages([
      {
        event: "message",
        chat_id: "t-file-earlier-tool",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-edit", name: "edit_file", arguments: { path: "foo.txt" } }],
      },
      { event: "file_edit", chat_id: "t-file-earlier-tool", edits: [startEdit] },
      { event: "file_edit", chat_id: "t-file-earlier-tool", edits: [endEdit] },
      {
        event: "message",
        chat_id: "t-file-earlier-tool",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-edit", name: "edit_file", arguments: { path: "foo.txt" } }],
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ['edit_file({"path": "foo.txt"})'],
      toolEvents: [{ phase: "end", call_id: "call-edit", name: "edit_file" }],
    });
    expect(messages[1]).toMatchObject({ role: "tool", kind: "trace", content: "", traces: [], fileEdits: [endEdit] });
    expect(messages[0].activitySegmentId).toBe(messages[1].activitySegmentId);
  });

  it("keeps unrelated or untracked file edits in separate rows within one turn activity segment", () => {
    const noCallMessages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-file-untracked", text: "edit" },
      {
        event: "file_edit",
        chat_id: "t-file-untracked",
        edits: [{ version: 1, tool: "write_file", path: "foo.txt", phase: "end", status: "done" }],
      },
      {
        event: "message",
        chat_id: "t-file-untracked",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-write", name: "write_file", arguments: { path: "foo.txt" } }],
      },
    ]);
    const noCallFileEdit = noCallMessages.find((message) => message.fileEdits);
    const noCallToolTrace = noCallMessages.find((message) => message.toolEvents);

    expect(noCallFileEdit?.activitySegmentId).toBeTruthy();
    expect(noCallToolTrace?.activitySegmentId).toBeTruthy();
    expect(noCallFileEdit?.activitySegmentId).toBe(noCallToolTrace?.activitySegmentId);

    const differentCallMessages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-file-different-call", text: "edit" },
      {
        event: "file_edit",
        chat_id: "t-file-different-call",
        edits: [{ version: 1, call_id: "call-file", tool: "write_file", path: "bar.txt", phase: "end", status: "done" }],
      },
      {
        event: "message",
        chat_id: "t-file-different-call",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-tool", name: "write_file", arguments: { path: "bar.txt" } }],
      },
    ]);
    const differentCallFileEdit = differentCallMessages.find((message) => message.fileEdits);
    const differentCallToolTrace = differentCallMessages.find((message) => message.toolEvents);

    expect(differentCallFileEdit?.activitySegmentId).toBeTruthy();
    expect(differentCallToolTrace?.activitySegmentId).toBeTruthy();
    expect(differentCallFileEdit?.activitySegmentId).toBe(differentCallToolTrace?.activitySegmentId);
  });

  it("dedupes tool trace lines while merging finish events after start events", () => {
    const messages = replayTranscriptToUiMessages([
      {
        event: "message",
        chat_id: "t-tool",
        text: 'exec({"cmd":"ls"})',
        kind: "tool_hint",
        tool_events: [{ phase: "start", call_id: "call-exec", name: "exec", arguments: { cmd: "ls" } }],
      },
      {
        event: "message",
        chat_id: "t-tool",
        text: "",
        kind: "progress",
        tool_events: [
          { phase: "end", call_id: "call-exec", name: "exec", arguments: { cmd: "ls" }, result: "ok" },
          { phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "notes.md" }, result: "done" },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].traces).toEqual(['exec({"cmd": "ls"})', 'read_file({"path": "notes.md"})']);
    expect(messages[0].toolEvents[0].phase).toBe("end");
    expect(messages[0].toolEvents[0].call_id).toBe("call-exec");
  });

  it("finalizes pending activity progress when replay reaches turn_end", () => {
    const messages = replayTranscriptToUiMessages([
      { event: "user", chat_id: "t-turn-end-progress", text: "edit" },
      {
        event: "message",
        chat_id: "t-turn-end-progress",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }],
      },
      {
        event: "file_edit",
        chat_id: "t-turn-end-progress",
        edits: [{ version: 1, call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing" }],
      },
      {
        event: "message",
        chat_id: "t-turn-end-progress",
        kind: "progress",
        tool_events: [{ phase: "error", call_id: "call-error", name: "failing_tool", error: "failed" }],
      },
      {
        event: "file_edit",
        chat_id: "t-turn-end-progress",
        edits: [{ version: 1, call_id: "call-edit-error", tool: "edit_file", path: "BROKEN.md", phase: "error", status: "error" }],
      },
      { event: "turn_end", chat_id: "t-turn-end-progress" },
    ]);

    const toolTrace = messages.find((message) => message.toolEvents);
    const fileEditTrace = messages.find((message) => message.fileEdits);
    const errorToolTrace = messages.find((message) => message.toolEvents?.some((event: Record<string, unknown>) => event.call_id === "call-error"));
    const errorFileEditTrace = messages.find((message) => message.fileEdits?.some((edit: Record<string, unknown>) => edit.call_id === "call-edit-error"));
    expect(toolTrace?.toolEvents[0]).toMatchObject({ call_id: "call-read", phase: "end" });
    expect(fileEditTrace?.fileEdits[0]).toMatchObject({ call_id: "call-edit", phase: "end", status: "done" });
    expect(errorToolTrace?.toolEvents[0]).toMatchObject({ call_id: "call-error", phase: "error" });
    expect(errorFileEditTrace?.fileEdits[0]).toMatchObject({ call_id: "call-edit-error", phase: "error", status: "error" });
  });

  it("keeps tool phase updates when the trace text is deduped", () => {
    const args = { path: "notes.md" };
    const messages = replayTranscriptToUiMessages([
      {
        event: "message",
        chat_id: "t-tool",
        text: "",
        kind: "tool_hint",
        tool_events: [{ phase: "start", call_id: "call-read", name: "read_file", arguments: args }],
      },
      {
        event: "message",
        chat_id: "t-tool",
        text: "",
        kind: "progress",
        tool_events: [
          {
            phase: "error",
            call_id: "call-read",
            name: "read_file",
            arguments: args,
            error: "Error: file not found",
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].traces).toEqual(['read_file({"path": "notes.md"})']);
    expect(messages[0].toolEvents[0].phase).toBe("error");
    expect(messages[0].toolEvents[0].error).toBe("Error: file not found");
  });

  it("preserves decoded Windows errors while replaying transcript tool events", () => {
    const messages = replayTranscriptToUiMessages([
      {
        event: "message",
        chat_id: "t-windows-error",
        kind: "progress",
        tool_events: [{
          phase: "error",
          call_id: "call-windows",
          name: "exec",
          arguments: { command: "node" },
          error: WINDOWS_COMMAND_ERROR,
        }],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].toolEvents[0].error).toBe(WINDOWS_COMMAND_ERROR);
  });

  it("merges file-edit progress after interleaved activity", () => {
    useDataDir();
    const key = "websocket:t-file-progress";
    appendAll(key, [
      { event: "user", chat_id: "t-file-progress", text: "edit" },
      { event: "message", chat_id: "t-file-progress", text: 'write_file({"path":"foo.txt"})', kind: "tool_hint" },
      {
        event: "file_edit",
        chat_id: "t-file-progress",
        edits: [
          {
            version: 1,
            call_id: "call-write",
            tool: "write_file",
            path: "foo.txt",
            phase: "start",
            added: 12,
            deleted: 0,
            approximate: true,
            status: "editing",
          },
        ],
      },
      { event: "message", chat_id: "t-file-progress", text: "still working", kind: "progress" },
      {
        event: "file_edit",
        chat_id: "t-file-progress",
        edits: [
          {
            version: 1,
            call_id: "call-write",
            tool: "write_file",
            path: "foo.txt",
            phase: "end",
            added: 30,
            deleted: 0,
            approximate: false,
            status: "done",
          },
        ],
      },
    ]);

    const fileEditMessages = replayTranscriptToUiMessages(readTranscriptLines(key)).filter((message) => message.fileEdits);

    expect(fileEditMessages).toHaveLength(1);
    expect(fileEditMessages[0].fileEdits).toEqual([
      {
        version: 1,
        call_id: "call-write",
        tool: "write_file",
        path: "foo.txt",
        phase: "end",
        added: 30,
        deleted: 0,
        approximate: false,
        status: "done",
      },
    ]);
  });

  it("upgrades a pending file-edit placeholder when the path arrives", () => {
    useDataDir();
    const key = "websocket:t-file-pending";
    appendAll(key, [
      { event: "user", chat_id: "t-file-pending", text: "write" },
      {
        event: "file_edit",
        chat_id: "t-file-pending",
        edits: [
          {
            version: 1,
            call_id: "call-write",
            tool: "write_file",
            path: "",
            phase: "start",
            added: 1,
            deleted: 0,
            approximate: true,
            status: "editing",
            pending: true,
          },
        ],
      },
      {
        event: "file_edit",
        chat_id: "t-file-pending",
        edits: [
          {
            version: 1,
            call_id: "call-write",
            tool: "write_file",
            path: "foo.txt",
            phase: "start",
            added: 12,
            deleted: 0,
            approximate: true,
            status: "editing",
          },
        ],
      },
    ]);

    const fileEditMessages = replayTranscriptToUiMessages(readTranscriptLines(key)).filter((message) => message.fileEdits);

    expect(fileEditMessages).toHaveLength(1);
    expect(fileEditMessages[0].fileEdits).toEqual([
      {
        version: 1,
        call_id: "call-write",
        tool: "write_file",
        path: "foo.txt",
        phase: "start",
        added: 12,
        deleted: 0,
        approximate: true,
        status: "editing",
      },
    ]);
  });

  it("keeps a new file-edit row after reasoning in order within one activity segment", () => {
    useDataDir();
    const key = "websocket:t-file-order";
    appendAll(key, [
      { event: "user", chat_id: "t-file-order", text: "edit" },
      {
        event: "file_edit",
        chat_id: "t-file-order",
        edits: [
          {
            version: 1,
            call_id: "call-one",
            tool: "write_file",
            path: "one.txt",
            phase: "start",
            added: 10,
            deleted: 0,
            approximate: true,
            status: "editing",
          },
        ],
      },
      { event: "reasoning_delta", chat_id: "t-file-order", text: "Check next." },
      { event: "reasoning_end", chat_id: "t-file-order" },
      {
        event: "file_edit",
        chat_id: "t-file-order",
        edits: [
          {
            version: 1,
            call_id: "call-two",
            tool: "write_file",
            path: "two.txt",
            phase: "start",
            added: 20,
            deleted: 0,
            approximate: true,
            status: "editing",
          },
        ],
      },
    ]);

    const messages = replayTranscriptToUiMessages(readTranscriptLines(key));

    expect(messages.slice(1).map((message) => (message.fileEdits ? message.fileEdits[0].path : message.reasoning))).toEqual([
      "one.txt",
      "Check next.",
      "two.txt",
    ]);
    const fileEditSegments = messages.filter((message) => message.fileEdits).map((message) => message.activitySegmentId);
    expect(fileEditSegments).toHaveLength(2);
    expect(fileEditSegments[0]).toBe(fileEditSegments[1]);
  });

  it("builds the persisted WebUI thread response schema", () => {
    useDataDir();
    const key = "websocket:t3";
    appendTranscriptObject(key, { event: "user", chat_id: "t3", text: "x" });

    const response = buildWebuiThreadResponse(key, { augmentUserMedia: null });

    expect(response).not.toBeNull();
    expect(response?.schemaVersion).toBe(WEBUI_TRANSCRIPT_SCHEMA_VERSION);
    expect(response?.sessionKey).toBe(key);
    expect(response?.messages).toHaveLength(1);
  });

  it("replays complete assistant text written by stream_end without subscribers", async () => {
    useDataDir();
    const channel = new WebSocketChannel({}, new MessageBus());

    await channel.sendDelta("t-nosub", "hel", { streamId: "s1" });
    await channel.sendDelta("t-nosub", "lo", { streamId: "s1", streamEnd: true });

    const response = buildWebuiThreadResponse("websocket:t-nosub", { augmentUserMedia: null });

    expect(response?.messages).toHaveLength(1);
    expect(response?.messages[0]).toMatchObject({ role: "assistant", content: "hello" });
  });
});
