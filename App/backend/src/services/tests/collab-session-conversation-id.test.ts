import { describe, expect, it } from "vitest";
import { conversationIdFor } from "../collab-service.js";

/**
 * 任务同步按会话 id 找回本机记录：id 取错时这条任务在项目里就永远读不到记录。
 * 本机路径在 Windows 上全是反斜杠，按 `/` 切分会把整串路径当成文件名。
 */
describe("the conversation id of a Memmy task file", () => {
  it("takes the id recorded in the file when there is one", () => {
    expect(conversationIdFor("websocket:9f1c-4d2a", "/Users/q/.memmy/sessions/websocket_9f1c-4d2a.jsonl")).toBe("9f1c-4d2a");
    expect(conversationIdFor("websocket:9f1c-4d2a", "C:\\Users\\xxx\\AppData\\Roaming\\Memmy\\sessions\\websocket_other.jsonl")).toBe("9f1c-4d2a");
  });

  it("falls back to the file name when the record carries no id", () => {
    expect(conversationIdFor("", "/Users/q/.memmy/sessions/websocket_9f1c-4d2a.jsonl")).toBe("9f1c-4d2a");
    expect(conversationIdFor("", "C:\\Users\\xxx\\AppData\\Roaming\\Memmy\\sessions\\websocket_9f1c-4d2a.jsonl", "win32")).toBe("9f1c-4d2a");
    // 不是 websocket 命名的文件：去掉扩展名就是 id。
    expect(conversationIdFor("", "/Users/q/.memmy/sessions/9f1c-4d2a.jsonl")).toBe("9f1c-4d2a");
  });
});
