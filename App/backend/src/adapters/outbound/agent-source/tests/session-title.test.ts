import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexThreadTitles } from "../codex/session-titles.js";
import {
  createJsonlTitleTracker,
  readJsonlSessionTitle
} from "../jsonl-session-title.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-session-title-"));
  roots.push(root);
  return root;
}

function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

describe("agent generated session titles", () => {
  it("prefers the name the agent settled on, then the title it generated, then its own name", () => {
    const tracker = createJsonlTitleTracker();

    expect(tracker.observe({ type: "ai-title", aiTitle: "Claude内存模块实现原理" })).toBe("Claude内存模块实现原理");
    expect(tracker.observe({ type: "agent-name", agentName: "内存模块" })).toBe("Claude内存模块实现原理");
    expect(tracker.observe({ type: "custom-title", customTitle: "Claude 的记忆模块" })).toBe("Claude 的记忆模块");
    // A later generated title does not displace the one the person or agent named the session with.
    expect(tracker.observe({ type: "ai-title", aiTitle: "另一个标题" })).toBe("Claude 的记忆模块");
    expect(tracker.observe({ type: "user", uuid: "u-1" })).toBeNull();
    expect(tracker.current()).toBe("Claude 的记忆模块");
  });

  it("reads the latest title a Claude Code session wrote, at the end of the file", async () => {
    const root = workdir();
    const file = join(root, "session.jsonl");
    writeFileSync(file, `${jsonl([
      { type: "custom-title", customTitle: "旧标题", sessionId: "c-1" },
      { type: "user", message: { role: "user", content: "第一问" }, sessionId: "c-1" },
      { type: "ai-title", aiTitle: "Claude内存模块实现原理", sessionId: "c-1" },
      { type: "custom-title", customTitle: "Claude 的记忆模块", sessionId: "c-1" }
    ])}\n`);

    expect(await readJsonlSessionTitle(file)).toBe("Claude 的记忆模块");
  });

  it("still finds a title written once at the start of a long session that was never retitled", async () => {
    const root = workdir();
    const file = join(root, "long.jsonl");
    const filler = Array.from({ length: 4_000 }, (_, index) => ({
      type: "assistant",
      message: { role: "assistant", content: `第 ${index} 段回复`.padEnd(200, "·") },
      sessionId: "c-long"
    }));
    writeFileSync(file, `${jsonl([
      { type: "ai-title", aiTitle: "调研三款记忆产品商业版", sessionId: "c-long" },
      ...filler
    ])}\n`);

    expect(await readJsonlSessionTitle(file)).toBe("调研三款记忆产品商业版");
  });

  it("returns nothing for a session without a title, so the caller derives one", async () => {
    const root = workdir();
    const file = join(root, "plain.jsonl");
    writeFileSync(file, `${jsonl([{ type: "user", message: { role: "user", content: "没有标题" } }])}\n`);

    expect(await readJsonlSessionTitle(file)).toBeNull();
    expect(await readJsonlSessionTitle(join(root, "missing.jsonl"))).toBeNull();
  });

  it("reads Codex thread names from the index beside the session files", async () => {
    const root = workdir();
    const sessionsRoot = join(root, "sessions");
    writeFileSync(join(root, "session_index.jsonl"), `${jsonl([
      { id: "019e6756-8c31-7850-87f1-a0f7d51a11d4", thread_name: "调研三款记忆产品商业版" },
      { id: "019e786b-adad-76e2-97b8-003bcfc6ac66", thread_name: "找 Esus4 和弦图" },
      { id: "no-title" }
    ])}\n`);

    const titles = await readCodexThreadTitles(sessionsRoot);
    expect(titles.get("019e6756-8c31-7850-87f1-a0f7d51a11d4")).toBe("调研三款记忆产品商业版");
    expect(titles.get("019e786b-adad-76e2-97b8-003bcfc6ac66")).toBe("找 Esus4 和弦图");
    expect(titles.size).toBe(2);
    // An older Codex has no index at all.
    expect((await readCodexThreadTitles(join(root, "nowhere", "sessions"))).size).toBe(0);
  });
});
