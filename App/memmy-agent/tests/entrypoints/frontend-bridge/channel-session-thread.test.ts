import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWebuiThreadResponse } from "../../../src/entrypoints/frontend-bridge/transcript.js";

const roots: string[] = [];
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function useEmptyDataDir(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-channel-thread-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
}

afterEach(() => {
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("channel session thread fallback", () => {
  it("builds a closed WeChat thread from persisted session messages when no WebUI transcript exists", () => {
    useEmptyDataDir();

    const response = buildWebuiThreadResponse("weixin:wx-user", {
      sessionMessages: [
        { role: "user", content: "微信里的问题", timestamp: "2026-07-23T02:00:00.000Z" },
        { role: "assistant", content: "微信里的回答", timestamp: "2026-07-23T02:00:01.000Z" },
      ],
    });

    expect(response).toMatchObject({
      schemaVersion: 3,
      sessionKey: "weixin:wx-user",
      last_turn_closed: true,
      messages: [
        { role: "user", content: "微信里的问题" },
        { role: "assistant", content: "微信里的回答" },
      ],
    });
  });

  it("keeps tool calls and injected subagent messages out of channel history", () => {
    useEmptyDataDir();

    const response = buildWebuiThreadResponse("weixin:wx-user", {
      sessionMessages: [
        { role: "user", content: "帮我查一下" },
        { role: "assistant", content: "内部工具调用", tool_calls: [{ id: "call-1" }] },
        { role: "tool", content: "内部工具结果", tool_call_id: "call-1" },
        { role: "assistant", content: "内部子任务结果", injectedEvent: "subagentResult" },
        { role: "assistant", content: "这是最终回答" },
      ],
    });

    expect(response?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "帮我查一下" }),
      expect.objectContaining({ role: "assistant", content: "这是最终回答" }),
    ]);
  });
});
