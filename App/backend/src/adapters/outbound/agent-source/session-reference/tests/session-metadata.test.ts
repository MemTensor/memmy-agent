/**
 * 元数据列表路径：读会话文件的方式换了，读出来的字段必须和完整扫描一样。
 *
 * 这些用例锁住两件事：跳过解析的行不能影响最后活动时间，以及人问的第一句/最后一句要取对。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeJsonlFile } from "../session-metadata/jsonl-facts.js";
import type { JsonlMetadataSource } from "../session-metadata/jsonl-facts.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

/** Claude Code's own row shape, reduced to what the listing reads. */
function claudeSource(): JsonlMetadataSource {
  return {
    sourceId: "claude_code",
    createObserver: () => (record, sink) => {
      const type = text(record.type);
      const conversationId = text(record.sessionId) || "s";
      const createdAt = text(record.timestamp);
      if (type === "user" && isRecord(record.origin) && record.origin.kind === "human") {
        const message = isRecord(record.message) ? record.message : {};
        const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
        const words = blocks.filter((b) => b.type === "text").map((b) => text(b.text)).join("\n");
        if (words.trim()) sink.user(conversationId, words, createdAt);
        return;
      }
      if (type === "assistant") {
        sink.message(conversationId, createdAt);
      }
    },
    // 附件、记账行、工具结果都不解析：完整扫描也不为它们产生消息。
    wantsParse: (line) => line.includes('"type":"user"') || line.includes('"type":"assistant"')
  };
}

describe("session metadata listing", () => {
  it("stops the last activity time at the last row that becomes a message", async () => {
    const path = writeSession([
      row("2026-10-29T11:00:00.000Z", { type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "第一问" }] } }),
      row("2026-10-29T11:00:05.000Z", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "答" }] } }),
      row("2026-10-29T11:05:00.000Z", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "最后一条助手正文" }] } }),
      // 记账行与附件带着时间，但它们不产生消息，最后活动时间不该被它们推后。
      row("2026-10-29T11:09:59.000Z", { type: "attachment", attachment: { type: "hook_success" } }),
      row("2026-10-29T11:10:00.000Z", { type: "last-prompt", lastPrompt: "不该算作提问" })
    ]);

    const facts = await summarizeJsonlFile(path, claudeSource(), { hasTitle: false });
    const factsOf = facts.conversations.get("s");

    expect(factsOf?.updatedAt).toBe("2026-10-29T11:05:00.000Z");
    expect(factsOf?.questions.map((q) => q.question)).toEqual(["第一问"]);
  });

  it("keeps the questions in the order they were asked", async () => {
    const path = writeSession([
      row("2026-10-29T11:00:00.000Z", { type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "最早的一问" }] } }),
      row("2026-10-29T11:01:00.000Z", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "答" }] } }),
      row("2026-10-29T11:02:00.000Z", { type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "最新的一问" }] } })
    ]);

    const facts = await summarizeJsonlFile(path, claudeSource(), { hasTitle: false });
    const asked = facts.conversations.get("s")?.questions.map((q) => q.question);

    expect(asked).toEqual(["最早的一问", "最新的一问"]);
  });

  it("reads a row's own timestamp even when the row is not parsed", async () => {
    const path = writeSession([
      row("2026-10-29T11:00:00.000Z", { type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "问" }] } }),
      JSON.stringify({ type: "api-request", timestamp: "2026-10-29T11:30:00.000Z" })
    ]);

    const facts = await summarizeJsonlFile(path, claudeSource(), { hasTitle: false });

    // 没有解析的行不推进时间，与完整扫描一致。
    expect(facts.conversations.get("s")?.updatedAt).toBe("2026-10-29T11:00:00.000Z");
  });
});

function writeSession(rows: readonly string[]): string {
  tempDir = mkdtempSync(join(tmpdir(), "session-metadata-"));
  const dir = join(tempDir, "projects");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "s.jsonl");
  writeFileSync(path, `${rows.join("\n")}\n`);
  return path;
}

function row(timestamp: string, body: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, sessionId: "s", ...body });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
