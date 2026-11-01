import { describe, expect, it } from "vitest";
import { createSourceRegistry } from "../../source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../../types.js";
import { cleanQuestion, createLocalSessionReader, isInternalUserMessage } from "../local-session-reader.js";

describe("local session reader", () => {
  it("lists each session once with its first question as title", async () => {
    const reader = readerWith([fakeAdapter("codex", "Codex", [
      message("codex", "c-1", "user", "分享弹窗重复分享时怎么提示？", "2026-10-20T08:00:00.000Z", "/repo"),
      message("codex", "c-1", "assistant", "返回 409 时提示「已分享给该成员」。", "2026-10-20T08:00:05.000Z", "/repo"),
      message("codex", "c-1", "user", "账号不存在呢？", "2026-10-20T08:05:00.000Z", "/repo"),
      message("codex", "c-no-question", "system", "boot", "2026-10-20T07:00:00.000Z", "/repo")
    ])]);

    expect((await reader.available({})).sessions).toEqual([{
      sourceId: "codex",
      agentName: "Codex",
      conversationId: "c-1",
      title: "分享弹窗重复分享时怎么提示？",
      lastQuestion: "账号不存在呢？",
      workspacePath: "/repo",
      group: { id: "/repo", label: "repo", path: "/repo" },
      updatedAt: "2026-10-20T08:05:00.000Z",
      turnCount: 2
    }]);
  });

  it("fills the list with the number of sessions asked for, skipping files that hold no question", async () => {
    const messages: ConversationMessage[] = [];
    const start = Date.UTC(2026, 9, 21, 12, 0, 0);
    for (let index = 0; index < 40; index += 1) {
      const id = `c-${String(index).padStart(2, "0")}`;
      const at = new Date(start - index * 60_000).toISOString();
      // 最前面 6 个是空记录，和真实目录里没有人工提问的记录一样，占窗口但不进列表。
      messages.push(index < 6
        ? message("codex", id, "system", "boot", at, "/repo")
        : message("codex", id, "user", `第 ${index} 个问题`, at, "/repo"));
    }
    const reader = readerWith([windowedAdapter("codex", "Codex", messages)]);

    const { sessions } = await reader.available({ limit: 30 });

    expect(sessions).toHaveLength(30);
    // 补上的是更早的任务，空记录不会出现在列表里。
    expect(sessions.map((session) => session.conversationId))
      .toEqual(Array.from({ length: 30 }, (_, index) => `c-${String(index + 6).padStart(2, "0")}`));
  });

  it("ranks keyword hits, then the given directory, then the most recent, and filters by agent", async () => {
    const reader = readerWith([
      fakeAdapter("codex", "Codex", [
        message("codex", "new-other", "user", "别的仓库的分享", "2026-10-21T10:00:00.000Z", "/elsewhere"),
        message("codex", "old-here", "user", "同仓库旧会话", "2026-10-19T10:00:00.000Z", "/repo/App")
      ]),
      fakeAdapter("claude_code", "Claude Code", [message("claude_code", "new-here", "user", "同仓库新会话", "2026-10-21T09:00:00.000Z", "/repo")])
    ]);

    expect((await reader.available({ cwd: "/repo" })).sessions.map((session) => session.conversationId))
      .toEqual(["new-here", "old-here", "new-other"]);
    expect((await reader.available({ query: "分享" })).sessions.map((session) => session.conversationId)).toEqual(["new-other"]);
    expect((await reader.available({ sourceIds: ["claude_code"] })).sessions.map((session) => session.conversationId)).toEqual(["new-here"]);
  });

  it("keeps listing other agents when one source fails", async () => {
    const broken: SourceAdapter = {
      descriptor: { sourceId: "cursor", displayName: "Cursor", builtin: true, dataPath: "/missing" },
      detect: async () => true,
      scan: async function* () {
        throw new Error("native module mismatch");
      }
    };
    const reader = readerWith([
      broken,
      fakeAdapter("workbuddy", "WorkBuddy", [message("workbuddy", "w-1", "user", "sitemap 是什么", "2026-10-21T03:00:00.000Z", null)])
    ]);

    expect((await reader.available({})).sessions.map((session) => session.conversationId)).toEqual(["w-1"]);
  });

  it("answers from the last scan at once while a newer scan runs, and waits only when asked for fresh", async () => {
    const messages = [message("codex", "c-1", "user", "第一个会话", "2026-10-21T08:00:00.000Z", "/repo")];
    let clock = 0;
    const reader = createLocalSessionReader({
      registry: createSourceRegistry([fakeAdapter("codex", "Codex", messages)]),
      snapshotTtlMs: 15_000,
      now: () => clock
    });

    expect(await reader.available({})).toMatchObject({ refreshing: false, sessions: [{ conversationId: "c-1" }] });
    messages.push(message("codex", "c-2", "user", "新会话", "2026-10-21T09:00:00.000Z", "/repo"));
    expect((await reader.available({})).sessions).toHaveLength(1);

    clock = 20_000;
    const stale = await reader.available({});
    expect(stale.refreshing).toBe(true);
    expect(stale.sessions).toHaveLength(1);
    const fresh = await reader.available({ fresh: true });
    expect(fresh.refreshing).toBe(false);
    expect(fresh.sessions.map((session) => session.conversationId)).toEqual(["c-2", "c-1"]);
  });

  it("reads one session's turns with replies and tool steps, without injected context", async () => {
    const reader = readerWith([fakeAdapter("claude_code", "Claude Code", [
      message("claude_code", "s-1", "user", "<memmy_memory_context>旧记忆</memmy_memory_context>修复权限弹窗卡死", "2026-10-21T07:00:00.000Z", "/repo"),
      message("claude_code", "s-1", "tool", "Tool: Bash\n\nInput: ls", "2026-10-21T07:00:01.000Z", "/repo", { toolName: "Bash" }),
      message("claude_code", "s-1", "tool", "Tool: Edit\n\nInput: {}", "2026-10-21T07:00:03.000Z", "/repo"),
      message("claude_code", "s-1", "assistant", "检测请求加了超时。", "2026-10-21T07:00:04.000Z", "/repo"),
      message("claude_code", "s-2", "user", "别的会话", "2026-10-21T08:00:00.000Z", "/repo")
    ])]);

    const session = await reader.read({ sourceId: "claude_code", conversationId: "s-1" });

    expect(session.title).toBe("修复权限弹窗卡死");
    expect(session.turns).toEqual([{
      question: "修复权限弹窗卡死",
      reply: "检测请求加了超时。",
      steps: ["Bash", "Edit"],
      startedAt: "2026-10-21T07:00:00.000Z"
    }]);
    await expect(reader.read({ sourceId: "claude_code", conversationId: "missing" })).rejects.toThrow(/Session not found/u);
    await expect(reader.read({ sourceId: "nope", conversationId: "s-1" })).rejects.toThrow(/Unknown agent source/u);
  });

  it("reads several sessions of an agent in one pass, widening once for older ones", async () => {
    const windows: number[] = [];
    // c-0 is the most recent; a scan yields only as many conversations as its window allows, like the real stores.
    const conversations = Array.from({ length: 40 }, (_, index) => `c-${index}`);
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: "/fake/codex" },
      detect: async () => true,
      scan: async function* (options) {
        windows.push(options.maxConversations ?? 0);
        for (const [index, id] of conversations.slice(0, options.maxConversations).entries()) {
          yield message("codex", id, "user", `问题 ${id}`, new Date(Date.UTC(2026, 9, 21, 8, 0, 40 - index)).toISOString(), "/repo");
        }
      }
    };
    const reader = createLocalSessionReader({ registry: createSourceRegistry([adapter]), snapshotTtlMs: 0, sessionsPerSource: 30 });

    const recent = await reader.readMany({ sourceId: "codex", conversationIds: ["c-1", "c-5", "c-1"] });
    expect(recent.sessions.map((session) => session.conversationId).sort()).toEqual(["c-1", "c-5"]);
    expect(recent.missing).toEqual([]);
    expect(windows).toEqual([30]);

    const mixed = await reader.readMany({ sourceId: "codex", conversationIds: ["c-2", "c-35", "gone"] });
    expect(mixed.sessions.map((session) => session.conversationId).sort()).toEqual(["c-2", "c-35"]);
    expect(mixed.missing).toEqual(["gone"]);
    expect(windows).toEqual([30, 30, 200]);

    await expect(reader.readMany({ sourceId: "codex", conversationIds: Array.from({ length: 51 }, (_, index) => `x-${index}`) }))
      .rejects.toThrow(/At most 50/u);
  });

  it("strips host-injected blocks and automation ids from titles", () => {
    expect(cleanQuestion("<environment_context>cwd</environment_context>帮我拉起服务")).toBe("帮我拉起服务");
    expect(cleanQuestion("Automation: MemOS 社区周报 Automation ID: abc")).toBe("MemOS 社区周报");
    // 任务之间互相引用时留下的注释与引用前缀，不该出现在标题里
    expect(cleanQuestion("<!-- reply 2 --> > conversation_id 写入项目记忆时还是必填？ <!-- reply --> > 否"))
      .toBe("conversation_id 写入项目记忆时还是必填？ 否");
  });

  it("does not turn harness notes into questions or titles", async () => {
    // Qoder 把打断标记、工作区说明与技能正文都写进用户消息；它们不是谁问的话。
    expect(isInternalUserMessage("[Request interrupted by user for tool use]")).toBe(true);
    expect(isInternalUserMessage("Base directory for this skill: ~/.qoder/skills/memmy-project")).toBe(true);
    expect(isInternalUserMessage("Repository: MemOS-WorkSpace 聚合工作区\nBranch: local\n\n== Root-level Directory Tree (depth 2) ==\n.")).toBe(true);
    expect(isInternalUserMessage("Module: memmy/app\nSlug: app\nForm: leaf\n\nDirectory tree for this module's scope:")).toBe(true);
    expect(isInternalUserMessage("Do not call any more tools. Follow the original output format and provide the final answer now.")).toBe(true);
    expect(isInternalUserMessage("帮我看下部署")).toBe(false);

    const reader = readerWith([fakeAdapter("qoder", "Qoder", [
      message("qoder", "q-1", "user", "[Request interrupted by user]", "2026-10-21T07:00:00.000Z", "/repo"),
      message("qoder", "q-1", "user", "去看看决策冲突处理方案", "2026-10-21T07:00:10.000Z", "/repo"),
      message("qoder", "q-1", "assistant", "读完了。", "2026-10-21T07:00:20.000Z", "/repo"),
      message("qoder", "q-1", "user", "Base directory for this skill: ~/.qoder/skills/memmy-project\n\n# Memmy 协作项目", "2026-10-21T07:00:30.000Z", "/repo")
    ])]);
    const listed = (await reader.available({})).sessions;
    expect(listed[0]?.title).toBe("去看看决策冲突处理方案");
    expect(listed[0]?.lastQuestion).toBe("去看看决策冲突处理方案");
    expect(listed[0]?.turnCount).toBe(1);
  });

  it("uses the title the agent generated, not the first sentence the person typed", async () => {
    const reader = readerWith([fakeAdapter("claude_code", "Claude Code", [
      message("claude_code", "s-1", "user", "关于MemOS项目记忆这部分内容，算法这边提出了疑问，也是我心中的疑问", "2026-10-21T07:00:00.000Z", "/repo"),
      message("claude_code", "s-1", "assistant", "先看写入时机。", "2026-10-21T07:00:04.000Z", "/repo", {}, "Memmy项目协作记忆方案"),
      message("claude_code", "s-1", "user", "那 conversation_id 呢？", "2026-10-21T07:05:00.000Z", "/repo", {}, "Memmy项目协作记忆方案")
    ])]);

    const listed = (await reader.available({})).sessions;
    expect(listed[0]?.title).toBe("Memmy项目协作记忆方案");
    expect((await reader.read({ sourceId: "claude_code", conversationId: "s-1" })).title).toBe("Memmy项目协作记忆方案");
  });

  it("keeps the last title the agent wrote, and falls back when it wrote none", async () => {
    const reader = readerWith([fakeAdapter("codex", "Codex", [
      message("codex", "retitled", "user", "调研记忆产品", "2026-10-21T07:00:00.000Z", "/repo", {}, "旧标题"),
      message("codex", "retitled", "user", "继续", "2026-10-21T07:05:00.000Z", "/repo", {}, "调研三款记忆产品商业版"),
      message("codex", "untitled", "user", "没有原生标题的首问", "2026-10-21T08:00:00.000Z", "/repo")
    ])]);

    const titles = new Map((await reader.available({})).sessions.map((session) => [session.conversationId, session.title]));
    expect(titles.get("retitled")).toBe("调研三款记忆产品商业版");
    expect(titles.get("untitled")).toBe("没有原生标题的首问");
  });
});

function readerWith(adapters: SourceAdapter[]) {
  return createLocalSessionReader({ registry: createSourceRegistry(adapters), snapshotTtlMs: 0 });
}

function fakeAdapter(sourceId: string, displayName: string, messages: ConversationMessage[]): SourceAdapter {
  return {
    descriptor: { sourceId, displayName, builtin: true, dataPath: `/fake/${sourceId}` },
    detect: async () => true,
    scan: async function* () {
      yield* messages;
    }
  };
}

/** Stops after `maxScanTargets` conversations, the way the file-based adapters do. */
function windowedAdapter(sourceId: string, displayName: string, messages: ConversationMessage[]): SourceAdapter {
  return {
    descriptor: { sourceId, displayName, builtin: true, dataPath: `/fake/${sourceId}` },
    detect: async () => true,
    scan: async function* (options) {
      const window = options.maxScanTargets ?? Number.MAX_SAFE_INTEGER;
      const seen = new Set<string>();
      for (const entry of messages) {
        if (!seen.has(entry.conversationId)) {
          if (seen.size >= window) return;
          seen.add(entry.conversationId);
        }
        yield entry;
      }
    }
  };
}

function message(
  sourceId: string,
  conversationId: string,
  role: ConversationMessage["role"],
  content: string,
  createdAt: string,
  workspacePath: string | null,
  rawMeta: Record<string, unknown> = {},
  sessionTitle?: string
): ConversationMessage {
  return {
    messageId: `${conversationId}:${createdAt}`,
    sourceId,
    conversationId,
    role,
    content,
    createdAt,
    workspacePath,
    gitRoot: null,
    rawMeta,
    ...(sessionTitle ? { sessionTitle } : {})
  };
}
