import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionReadError, type LocalSessionReader } from "../../adapters/outbound/agent-source/session-reference/local-session-reader.js";
import {
  createCollabService,
  linkedSessionKeys,
  pageOf,
  parseSessionReference,
  sessionKey,
  type CollabServiceOptions,
  type LocalAgentSession
} from "../collab-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** The local session reader answering from the same route table as the fetcher, by fetcher. */
const readersOf = new WeakMap<typeof fetch, LocalSessionReader>();

/**
 * Answers cloud requests, and reads of this machine's agent sessions, from one route table and records each call.
 * The reads keep the paths they had as Memory service requests, so a test can name them the same way.
 */
function fakeFetch(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const readLocal = async (path: string, body: unknown): Promise<any> => {
    const call: Call = { url: `local:${path}`, method: "POST", headers: {}, body };
    calls.push(call);
    const handler = routes[`POST ${path}`];
    if (!handler) throw new LocalSessionReadError("not_found", "no route");
    const result = await handler(call);
    if (!(result instanceof Response)) return result;
    const payload = await result.json().catch(() => ({}));
    if (result.status === 404) throw new LocalSessionReadError("not_found", payload?.error?.message ?? "not found");
    if (!result.ok) throw new Error(`local read failed (${result.status})`);
    return payload;
  };
  const localSessions: LocalSessionReader = {
    available: (input) => readLocal("/api/v1/agent-sessions/available", input),
    read: async (input) => (await readLocal("/api/v1/agent-sessions/read", input)).session,
    readMany: (input) => readLocal("/api/v1/agent-sessions/read-many", input)
  };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const key = `${call.method} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
    const result = await handler(call);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  readersOf.set(fetcher, localSessions);
  return { fetcher, calls };
}

function service(fetcher: typeof fetch, overrides: Partial<CollabServiceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-"));
  roots.push(root);
  return createCollabService({
    cloudBaseUrl: "https://cloud.test.invalid",
    getAccount: () => ({ accountId: "u-b", credential: "uuid-b" }),
    localSessions: readersOf.get(fetcher) ?? null,
    projectsDir: root,
    fetcher,
    now: () => new Date("2026-10-22T06:32:00.000Z"),
    ...overrides
  });
}

const cloudSession = {
  id: "5c1b2d3e-0000-4000-8000-000000000409",
  projectId: "p-1",
  projectName: "Memmy 开发",
  title: "重复分享返回 409",
  lastQuestion: "接口文档也同步更新。",
  memberName: "用户C",
  mine: false,
  source: "codex",
  turnCount: 18,
  lastActiveAt: "2026-10-20T06:32:00Z"
};

describe("collab service", () => {
  it("accepts a pasted link, the copied share text, or a bare session ID", () => {
    const id = cloudSession.id;
    expect(parseSessionReference(`https://memmy.example/s/${id}`)).toBe(id);
    expect(parseSessionReference(`【Memmy】重复分享返回 409 https://memmy.example/s/${id} 按这个处理`)).toBe(id);
    expect(parseSessionReference(id)).toBe(id);
    expect(parseSessionReference("https://memmy.example/projects/p-1")).toBeNull();
    expect(parseSessionReference("../../etc/passwd")).toBeNull();
  });

  it("adds the link and share text to listed sessions", async () => {
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects/p-1/sessions": () => ({ code: 0, data: { project: { id: "p-1", name: "Memmy 开发" }, sessions: [cloudSession] } })
    });
    const result = await service(fetcher).listSessions("p-1");
    expect(calls[0]?.headers.Authorization).toBe("Bearer uuid-b");
    expect(result.sessions[0]).toMatchObject({
      link: `https://cloud.test.invalid/s/${cloudSession.id}`,
      shareText: `【Memmy】重复分享返回 409 https://cloud.test.invalid/s/${cloudSession.id}`
    });
  });

  it("clears the session files an older version cached on this computer", async () => {
    const { fetcher } = fakeFetch({});
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-"));
    roots.push(root);
    const legacy = join(root, "p-1", "sessions");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "s-1.md"), "# 旧版本的缓存\n", "utf8");

    service(fetcher, { projectsDir: root });

    // 清理在后台进行，与启动同时；等它完成后再断言。
    for (let attempt = 0; attempt < 50 && existsSync(legacy); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(legacy)).toBe(false);
  });

  it("reads a referenced session from the cloud and leaves no copy on this computer", async () => {
    const { fetcher } = fakeFetch({
      [`GET /api/collab/sessions/${cloudSession.id}`]: () => ({
        code: 0,
        data: { session: { ...cloudSession, trimmed: true, turns: [{ question: "重复分享时接口返回 500，怎么处理？", reply: "改为返回 HTTP 409。", steps: ["Edit", "Bash", "Bash"], startedAt: "" }] } }
      })
    });
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-"));
    roots.push(root);
    const svc = service(fetcher, { projectsDir: root });
    const reference = await svc.readSession(`【Memmy】重复分享返回 409 https://memmy.example/s/${cloudSession.id}`);

    // 协作任务只在云端保存：读取不建目录、不写文件。
    expect(existsSync(join(root, "p-1"))).toBe(false);
    expect(reference.session.id).toBe(cloudSession.id);
    expect(reference.text).toContain("已读取用户C的任务「重复分享返回 409」（Memmy 开发，");
    expect(reference.text).toContain("共 18 轮，云端保留最近 1 轮。");
    // The cloud says it dropped earlier turns to fit the session cap, so the reader says what it is showing.
    expect(reference.text).toContain("该任务仅保留近期记录");
    expect(reference.text).toContain("### 第 18 轮\n用户C：重复分享时接口返回 500，怎么处理？\n回复：改为返回 HTTP 409。\n执行步骤：Edit、Bash ×2");
  });

  it("prints the turns a read view asks for without saving the whole record", async () => {
    // The cloud keeps the latest 12 of 18 turns, so the first one it returns is turn 7.
    const turns = Array.from({ length: 12 }, (_, index) => ({
      question: `第 ${index + 7} 个问题`,
      reply: index === 3 ? "定案：云端先校验版本，冲突时提示并展示最新内容。" : `第 ${index + 7} 个回复`,
      steps: [],
      startedAt: ""
    }));
    const { fetcher } = fakeFetch({
      [`GET /api/collab/sessions/${cloudSession.id}`]: () => ({ code: 0, data: { session: { ...cloudSession, turns } } })
    });
    const svc = service(fetcher);
    const read = (view: Parameters<typeof svc.readSession>[1]) => svc.readSession(cloudSession.id, view).then((reference) => reference.text);

    const overview = await read({});
    expect(overview).toContain("已读取用户C的任务「重复分享返回 409」");
    expect(overview).toContain("共 18 轮，云端保留最近 12 轮。");
    expect(overview).toContain("- 第 7 轮：第 7 个问题");
    expect(overview).toContain("- 第 13 轮：第 13 个问题");
    expect(overview).not.toContain("### 第 13 轮");
    expect(overview).toContain("### 第 14 轮\n用户C：第 14 个问题\n回复：第 14 个回复");
    expect(overview).toContain("### 第 18 轮");

    // Punctuation differs from the record, as it does when the sentence is read off a screenshot.
    const found = await read({ find: "云端先校验版本 冲突时提示" });
    expect(found).toContain("出现在第 10 轮");
    expect(found).toMatch(/### 第 8 轮[\s\S]*### 第 12 轮\n[\s\S]*……（略去第 13–15 轮）[\s\S]*### 第 16 轮/u);
    expect(found).not.toContain("### 第 7 轮");

    const missing = await read({ find: "重复分享改为 404" });
    expect(missing).toContain("这个任务中没有找到「重复分享改为 404」");
    expect(missing).toContain("- 第 7 轮：第 7 个问题");
    expect(missing).not.toContain("### ");

    expect(await read({ turns: { from: 1, to: 8 } })).toMatch(/以下为第 7–8 轮。\n\n### 第 7 轮[\s\S]*### 第 8 轮[^#]*$/u);
    expect(await read({ around: 3 })).toContain("第 3 轮不在记录中，记录中为第 7–18 轮。");
    expect((await read({ all: true })).match(/### 第/gu)).toHaveLength(12);
    // No view is the overview, which is what the @ menu sends.
    expect((await svc.readSession(cloudSession.id)).text).toContain("以下为最近 5 轮全文");
  });

  it("lists a session shared to several projects once, merging its turn hits, keeps sinceMs, and trims to the limit", async () => {
    const shared = { ...cloudSession, title: "Memmy项目协作记忆方案", lastActiveAt: "2026-10-22T03:11:17.861Z" };
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/sessions/search": () => ({
        code: 0,
        data: {
          sessions: [
            { ...shared, id: "a", projectName: "Markdown事项验证", hits: [{ turnNo: 12, snippet: "…重复分享时返回 409…" }] },
            { ...shared, id: "b", projectName: "测试", hits: [{ turnNo: 7, snippet: "…项目记忆的存法…" }, { turnNo: 12, snippet: "…重复版本的提示…" }] },
            { ...cloudSession, id: "c", projectName: "测试", lastActiveAt: "2026-10-21T00:00:00.000Z" },
            { ...cloudSession, id: "d", title: "九月的旧会话", lastActiveAt: "2026-09-01T00:00:00.000Z" }
          ]
        }
      })
    });
    const svc = service(fetcher);

    const { sessions } = await svc.searchSessions({ query: "项目 记忆", member: "用户C", sinceMs: 30 * 86_400_000, since: "30d" });
    expect(sessions.map((session) => [session.id, session.projectNames])).toEqual([
      ["a", ["Markdown事项验证", "测试"]],
      ["c", ["测试"]]
    ]);
    // 副本各自匹配了不同的轮次：合并后同一轮只出现一次，并按轮次排序。
    expect(sessions[0]!.hits.map((hit) => hit.turnNo)).toEqual([7, 12]);
    expect(sessions[1]!.hits).toEqual([]);
    // The cloud is asked for its full page and the window, so paging happens after the window rather than before.
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toMatchObject({ member: "用户C", limit: "20", since: "30d" });
    expect((await svc.searchSessions({ query: "项目", limit: 1 })).sessions).toHaveLength(1);
  });

  it("reads the person's own nickname as their sessions, since the cloud stores another name for them", async () => {
    const mine = { ...cloudSession, id: "m", title: "Memmy项目协作记忆方案", memberName: "我", mine: true };
    const theirs = { ...cloudSession, id: "t", title: "项目协作的另一条线" };
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/sessions/search": () => ({ code: 0, data: { sessions: [theirs, mine] } })
    });
    const svc = service(fetcher, { getAccount: () => ({ accountId: "u-b", credential: "uuid-b", memberName: "快乐团子" }) });
    const params = () => Object.fromEntries(new URL(calls[calls.length - 1]!.url).searchParams);

    const byMember = await svc.searchSessions({ query: "项目协作记忆", member: "快乐团子" });
    expect(byMember.sessions.map((session) => [session.id, session.memberName])).toEqual([["m", "快乐团子"]]);
    expect(params()).not.toHaveProperty("member");

    const byWord = await svc.searchSessions({ query: "快乐团子 项目协作" });
    expect(byWord.sessions.map((session) => session.id)).toEqual(["m"]);
    expect(params().q).toBe("项目协作");

    // A teammate named as the member keeps the search on that teammate.
    await svc.searchSessions({ query: "快乐团子 项目协作", member: "用户C" });
    expect(params()).toMatchObject({ q: "项目协作", member: "用户C" });
  });

  it("covers a whole group except its excluded sessions, plus sessions linked on their own", () => {
    const candidates = [
      { sourceId: "claude_code", conversationId: "a1", groupId: "/repo" },
      { sourceId: "claude_code", conversationId: "a2", groupId: "/repo" },
      { sourceId: "claude_code", conversationId: "b1", groupId: "/other" },
      { sourceId: "codex", conversationId: "r1", groupId: "/repo" },
      { sourceId: "codex", conversationId: "c1", groupId: null }
    ];
    const keys = linkedSessionKeys({
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a2"] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    }, candidates);

    expect([...keys].sort()).toEqual([
      sessionKey({ sourceId: "claude_code", conversationId: "a1" }),
      sessionKey({ sourceId: "codex", conversationId: "c1" })
    ].sort());
  });

  it("uploads an associated group, then its new and changed sessions on each sync", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "a2", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "b1", "/other", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = linkFetch(local);
    const svc = service(fetcher);

    const saved = await svc.saveLinks("p-1", {
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a2"] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });
    // The selection is saved at once and the two sessions upload in the background.
    expect(saved).toEqual({ uploaded: 0, removed: 0, failed: 0, started: 2 });
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["a1", "c1"]);
    expect(await svc.getLinks("p-1")).toEqual({
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a2"] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });

    calls.length = 0;
    local.push(localSession("claude_code", "a3", "/repo", "2026-10-22T02:00:00.000Z"));
    local[0] = localSession("claude_code", "a1", "/repo", "2026-10-22T02:30:00.000Z");
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 2, removed: 0, failed: 0 });
    expect(uploadedIds(calls).sort()).toEqual(["a1", "a3"]);
    // A cached list is enough: forcing a rescan every minute re-walks every agent's history.
    expect(calls.find((call) => call.url.endsWith("/agent-sessions/available"))?.body).not.toMatchObject({ fresh: true });
  });

  it("re-uploads a session whose title changed, even when its turns did not", async () => {
    const local: LocalAgentSession[] = [
      { ...localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"), title: "关于MemOS项目记忆这部分内容，算法这边提出了疑问" }
    ];
    // The upload rereads the session, so its title is the same one the listing reported.
    let readTitle = "关于MemOS项目记忆这部分内容，算法这边提出了疑问";
    const { fetcher, calls } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": () => ({
        session: { title: readTitle, updatedAt: "2026-10-22T01:00:00.000Z", turns: [{ question: "问", reply: "答", steps: [], startedAt: "" }] }
      }),
      "PUT /api/collab/projects/p-1/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["a1"]);

    // The agent finally names the conversation; nothing else about the session changed.
    calls.length = 0;
    readTitle = "Memmy项目协作记忆方案";
    local[0] = { ...local[0]!, title: "Memmy项目协作记忆方案" };
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 1, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual(["a1"]);
    expect(uploadedTitles(calls)).toEqual(["Memmy项目协作记忆方案"]);

    // Once the cloud has that title, the next sync has nothing left to do.
    calls.length = 0;
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual([]);
  });

  it("removes only what the person unchecked, and never uploads a deleted session again", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = linkFetch(local);
    const svc = service(fetcher);
    await svc.saveLinks("p-1", {
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });
    // Unchecking a group can only remove what the earlier association already uploaded.
    await waitForUploads(svc, "p-1");

    calls.length = 0;
    expect(await svc.saveLinks("p-1", { groups: [], sessions: [{ sourceId: "codex", conversationId: "c1" }] }))
      .toEqual({ uploaded: 0, removed: 1, failed: 0 });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual(["https://cloud.test.invalid/api/collab/projects/p-1/sessions/id-a1"]);

    await svc.removeSession("p-1", "id-c1");
    calls.length = 0;
    local[1] = localSession("codex", "c1", null, "2026-10-22T05:00:00.000Z");
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual([]);
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
  });

  it("retries only the failed unlink after a partial cloud deletion", async () => {
    const local = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "a2", "/repo", "2026-10-22T01:00:00.000Z")
    ];
    let failA2 = true;
    const { fetcher, calls } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": (call: Call) => ({
        session: { title: `会话 ${(call.body as { conversationId: string }).conversationId}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [] }
      }),
      "PUT /api/collab/projects/p-1/sessions": (call: Call) => ({
        code: 0, data: { sessions: [{ id: `id-${(call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!.sourceSessionId}` }] }
      }),
      "DELETE /api/collab/projects/p-1/sessions/id-a1": () => ({ code: 0, data: null }),
      "DELETE /api/collab/projects/p-1/sessions/id-a2": () => failA2
        ? new Response(JSON.stringify({ code: 500, message: "temporary" }), { status: 500 })
        : ({ code: 0, data: null })
    });
    const svc = service(fetcher);
    const group = { sourceId: "claude_code", groupId: "/repo", excluded: [] };
    await svc.saveLinks("p-1", { groups: [group], sessions: [] });
    await waitForUploads(svc, "p-1");

    await expect(svc.saveLinks("p-1", { groups: [], sessions: [] })).rejects.toThrow();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => new URL(call.url).pathname))
      .toEqual(["/api/collab/projects/p-1/sessions/id-a1", "/api/collab/projects/p-1/sessions/id-a2"]);

    failA2 = false;
    await expect(svc.saveLinks("p-1", { groups: [], sessions: [] })).resolves.toMatchObject({ removed: 1 });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => new URL(call.url).pathname))
      .toEqual([
        "/api/collab/projects/p-1/sessions/id-a1",
        "/api/collab/projects/p-1/sessions/id-a2",
        "/api/collab/projects/p-1/sessions/id-a2"
      ]);
  });

  it("treats a stale local link as gone only after a forbidden delete is disproved by a complete listing", async () => {
    const { fetcher } = fakeFetch({
      "DELETE /api/collab/projects/p-1/sessions/stale": () => new Response(JSON.stringify({ code: 403 }), { status: 403 }),
      "GET /api/collab/projects/p-1/sessions": () => ({ code: 0, data: {
        project: { id: "p-1", sessionCount: 0 }, sessions: []
      } })
    });
    const svc = service(fetcher);
    await expect(svc.removeSession("p-1", "stale")).resolves.toEqual({ ok: true });
  });


  it("skips the cloud delete for records the cloud already dropped, reading the listing once", async () => {
    const local = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "a2", "/repo", "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": (call: Call) => ({
        session: { title: `会话 ${(call.body as { conversationId: string }).conversationId}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [] }
      }),
      "PUT /api/collab/projects/p-1/sessions": (call: Call) => ({
        code: 0, data: { sessions: [{ id: `id-${(call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!.sourceSessionId}` }] }
      }),
      // The quota replaced both sessions, so the project reports nothing left to delete.
      "GET /api/collab/projects/p-1/sessions": () => ({ code: 0, data: { project: { id: "p-1", sessionCount: 0 }, sessions: [] } })
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    await waitForUploads(svc, "p-1");
    calls.length = 0;

    expect(await svc.saveLinks("p-1", { groups: [], sessions: [] })).toMatchObject({ removed: 2 });
    // No pointless DELETE per stale record, and the listing was read only once.
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
    // The stored records are gone, so a second save has nothing left to remove.
    expect(await svc.saveLinks("p-1", { groups: [], sessions: [] })).toMatchObject({ removed: 0 });
  });

  it("does not conceal real permission, incomplete lists, lost membership, or network errors", async () => {
    for (const listing of [
      { project: { id: "p-1", sessionCount: 1 }, sessions: [{ id: "other" }] },
      { project: { id: "p-1", sessionCount: 2 }, sessions: [{ id: "other" }] }
    ]) {
      const { fetcher } = fakeFetch({
        "DELETE /api/collab/projects/p-1/sessions/other": () => new Response("{}", { status: 403 }),
        "GET /api/collab/projects/p-1/sessions": () => ({ code: 0, data: listing })
      });
      await expect(service(fetcher).removeSession("p-1", "other")).rejects.toMatchObject({ code: "forbidden" });
    }
    for (const status of [403, 404]) {
      const { fetcher } = fakeFetch({
        "DELETE /api/collab/projects/p-1/sessions/other": () => new Response("{}", { status }),
        "GET /api/collab/projects/p-1/sessions": () => new Response("{}", { status: 404 })
      });
      await expect(service(fetcher).removeSession("p-1", "other")).rejects.toMatchObject({ code: "not_found" });
    }
    const { fetcher } = fakeFetch({
      "DELETE /api/collab/projects/p-1/sessions/other": () => new Response("{}", { status: 503 })
    });
    await expect(service(fetcher).removeSession("p-1", "other")).rejects.toMatchObject({ code: "memory_layer_unavailable" });
  });

  it("uploads only the most recent 20 sessions of what the person associated", async () => {
    // 云端每人每项目只保留 20 个：更早的任务不上传，省掉传完再被删的往返。
    const start = Date.UTC(2026, 9, 22, 10, 0, 0);
    const local = Array.from({ length: 25 }, (_, index) => localSession(
      "codex", `c-${String(index).padStart(2, "0")}`, null, new Date(start - index * 60_000).toISOString()));
    const { fetcher, calls } = linkFetch(local);
    const svc = service(fetcher);

    const saved = await svc.saveLinks("p-1", {
      groups: [],
      sessions: local.map((session) => ({ sourceId: session.sourceId, conversationId: session.conversationId }))
    });
    expect(saved.started).toBe(20);
    await waitForUploads(svc, "p-1");

    const uploaded = uploadedIds(calls);
    expect(uploaded).toHaveLength(20);
    expect(uploaded).toContain("c-00");
    expect(uploaded).not.toContain("c-24");
  });

  it("pages a project's sessions ten at a time, counting every match", async () => {
    const list = Array.from({ length: 23 }, (_, index) => projectSession(`s-${index}`, index));
    const first = pageOf(list, { offset: 0, limit: 10 });
    expect(first.sessions).toHaveLength(10);
    expect(first.total).toBe(23);
    expect(pageOf(list, { offset: 20, limit: 10 }).sessions).toHaveLength(3);
    expect(pageOf(list, { offset: 30, limit: 10 }).sessions).toHaveLength(0);
  });

  it("matches any keyword against the title, the last question, or the member", () => {
    const list = [
      projectSession("s-1", 0, { title: "重复分享返回 409", lastQuestion: "提示怎么写", memberName: "用户C" }),
      projectSession("s-2", 1, { title: "知识库分享", lastQuestion: "重复分享的提示", memberName: "用户D" })
    ];
    expect(pageOf(list, { query: "409" }).sessions.map((session) => session.id)).toEqual(["s-1"]);
    expect(pageOf(list, { query: "重复分享" }).sessions).toHaveLength(2);
    expect(pageOf(list, { query: "用户D" }).sessions.map((session) => session.id)).toEqual(["s-2"]);
    expect(pageOf(list, { query: "无关" }).total).toBe(0);
  });

  it("keeps the member filter separate from the keyword", () => {
    const list = [
      projectSession("s-1", 0, { mine: true }),
      projectSession("s-2", 1, { mine: false })
    ];
    expect(pageOf(list, { member: "me" }).sessions.map((session) => session.id)).toEqual(["s-1"]);
    expect(pageOf(list, { member: "others" }).sessions.map((session) => session.id)).toEqual(["s-2"]);
    expect(pageOf(list, {}).total).toBe(2);
  });

  it("creates a cloud project with a managed working directory when none was chosen", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const { fetcher, calls } = fakeFetch({
      "POST /api/collab/projects": () => ({ code: 0, data: { project: { id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null } } })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects") });

    const created = await svc.createProject("Memmy 开发");

    expect(created.project).toMatchObject({ id: "p-9", localProjectId: null });
    // The folder is named after the project: a task page and the project picker show this name, not an id.
    expect(created.localDirectory).toBe(join(root, "online-projects", "Memmy 开发"));
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /api/collab/projects"]);
  });

  it("keeps the project's own name in the managed folder, and disambiguates a duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    mkdirSync(join(root, "online-projects", "Memmy 开发"), { recursive: true });
    const { fetcher } = fakeFetch({
      "POST /api/collab/projects": () => ({ code: 0, data: { project: { id: "p-9abcdef1", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null } } })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects") });

    // Another project already owns the plain name, so this one gets a short id suffix instead of an id-only name.
    const created = await svc.createProject("Memmy 开发");
    expect(created.localDirectory).toBe(join(root, "online-projects", "Memmy 开发-p-9abcde"));
  });

  it("uses the folder the person picked and registers it as the local project", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const chosen = mkdtempSync(join(tmpdir(), "memmy-collab-folder-"));
    roots.push(chosen);
    const { fetcher } = fakeFetch({
      "POST /api/collab/projects": () => ({ code: 0, data: { project: { id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null } } }),
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects") });

    const created = await svc.createProject("Memmy 开发", chosen);
    expect(created.localDirectory).toBe(chosen);

    await svc.bindLocalProject("p-9", "local-9");
    expect((await svc.listProjects()).projects[0]).toMatchObject({ id: "p-9", localProjectId: "local-9" });
  });

  it("passes pending applications through, and leaves them out when the cloud does not know them", async () => {
    const { fetcher } = fakeFetch({
      "GET /api/collab/projects": () => ({
        code: 0,
        data: {
          projects: [],
          applications: [{ projectId: "p-9", projectName: "Memmy 开发", createdAt: "2026-10-26T12:00:00.000Z" }]
        }
      })
    });
    const listed = await service(fetcher).listProjects();
    expect(listed.applications).toEqual([
      { projectId: "p-9", projectName: "Memmy 开发", createdAt: "2026-10-26T12:00:00.000Z" }
    ]);

    const { fetcher: older } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [] } })
    });
    expect(await service(older).listProjects()).toEqual({ projects: [] });
  });

  it("passes reviewed applications through, and drops statuses it cannot read", async () => {
    const { fetcher } = fakeFetch({
      "GET /api/collab/projects": () => ({
        code: 0,
        data: {
          projects: [],
          applications: [],
          decisions: [
            { projectId: "p-9", projectName: "Memmy 开发", status: "approved", decidedAt: "2026-10-29T03:00:00.000Z" },
            { projectId: "p-8", projectName: "旧项目", status: "rejected", decidedAt: null },
            // 旧云端或以后的第三态：不认识就不当结果，免得桌面端提示错。
            { projectId: "p-7", projectName: "未知", status: "pending", decidedAt: null }
          ]
        }
      })
    });
    expect((await service(fetcher).listProjects()).decisions).toEqual([
      { projectId: "p-9", projectName: "Memmy 开发", status: "approved", decidedAt: "2026-10-29T03:00:00.000Z" },
      { projectId: "p-8", projectName: "旧项目", status: "rejected", decidedAt: null }
    ]);
  });

  it("uploads the bound project's own Memmy tasks, which need no session link", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    writeMemmyTask(agentSessions, "task-1", "local-9", "部署记录", [
      { role: "user", content: "帮我看下部署", timestamp: "2026-10-22T03:00:00.000Z" },
      { role: "tool", name: "read_file", timestamp: "2026-10-22T03:00:01.000Z" },
      { role: "assistant", content: "已确认可以部署。", timestamp: "2026-10-22T03:00:02.000Z" }
    ]);
    writeMemmyTask(agentSessions, "task-2", "local-other", "别的项目", [
      { role: "user", content: "别的项目的问题", timestamp: "2026-10-22T03:00:00.000Z" }
    ]);
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } }),
      "PUT /api/collab/projects/p-9/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });

    await svc.bindLocalProject("p-9", "local-9");
    calls.length = 0;
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 1, removed: 0, failed: 0 });

    const upload = calls.find((call) => call.method === "PUT")!.body as { sessions: Array<{ source: string; title: string; turns: Array<{ question: string; reply: string; steps: string[] }> }> };
    expect(upload.sessions[0]).toMatchObject({ source: "memmy", title: "部署记录" });
    expect(upload.sessions[0]!.turns).toEqual([
      { question: "帮我看下部署", reply: "已确认可以部署。", steps: ["read_file"], startedAt: "2026-10-22T03:00:00.000Z" }
    ]);
  });

  it("syncs one project's tasks when a board asks for that project only", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    for (const [taskId, projectId] of [["task-a", "local-9"], ["task-b", "local-8"]] as const) {
      writeMemmyTask(agentSessions, taskId, projectId, `${projectId} 的会话`, [
        { role: "user", content: "问题", timestamp: "2026-10-22T05:00:00.000Z" },
        { role: "assistant", content: "回答", timestamp: "2026-10-22T05:00:01.000Z" }
      ]);
    }
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects": () => ({
        code: 0,
        data: {
          projects: [
            { id: "p-9", name: "项目 9", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null },
            { id: "p-8", name: "项目 8", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }
          ]
        }
      }),
      "PUT /api/collab/projects/p-9/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      },
      "PUT /api/collab/projects/p-8/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });
    await svc.bindLocalProject("p-9", "local-9");
    await svc.bindLocalProject("p-8", "local-8");
    calls.length = 0;

    // Opening one board must not spend time (or uploads) on the other project.
    expect(await svc.syncProjectTasks("p-9")).toEqual({ uploaded: 1, removed: 0, failed: 0 });
    expect(calls.filter((call) => call.method === "PUT").map((call) => new URL(call.url).pathname))
      .toEqual(["/api/collab/projects/p-9/sessions"]);
  });

  it("lists the project's Memmy sessions and uploads only the ones the person picked", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    writeMemmyTask(agentSessions, "task-a", "local-9", "要分享的会话", [
      { role: "user", content: "这条要分享", timestamp: "2026-10-22T05:00:00.000Z" },
      { role: "assistant", content: "好", timestamp: "2026-10-22T05:00:01.000Z" }
    ]);
    writeMemmyTask(agentSessions, "task-b", "local-9", "只留本机的会话", [
      { role: "user", content: "这条不上传", timestamp: "2026-10-22T04:00:00.000Z" },
      { role: "assistant", content: "好", timestamp: "2026-10-22T04:00:01.000Z" }
    ]);
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } }),
      "PUT /api/collab/projects/p-9/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      },
      "DELETE /api/collab/projects/p-9/sessions/id-task-a": () => ({ code: 0, data: null }),
      "DELETE /api/collab/projects/p-9/sessions/id-task-b": () => ({ code: 0, data: null })
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });

    await svc.bindLocalProject("p-9", "local-9");
    // Nothing is excluded before the person chooses, so both sessions count as included.
    expect((await svc.listProjectTasks("p-9")).tasks).toMatchObject([
      { conversationId: "task-a", title: "要分享的会话", included: true, synced: false },
      { conversationId: "task-b", title: "只留本机的会话", included: true, synced: false }
    ]);

    calls.length = 0;
    const saved = await svc.saveProjectTasks("p-9", ["task-a"]);
    expect(saved).toMatchObject({ removed: 0, failed: 0, started: 1 });
    await waitForUploads(svc, "p-9");

    expect(uploadedIds(calls)).toEqual(["task-a"]);
    expect((await svc.listProjectTasks("p-9")).tasks).toMatchObject([
      { conversationId: "task-a", included: true, synced: true },
      { conversationId: "task-b", included: false, synced: false }
    ]);

    // Unchecking an uploaded session takes it out of the project, so members stop seeing it.
    calls.length = 0;
    const narrowed = await svc.saveProjectTasks("p-9", []);
    expect(narrowed).toMatchObject({ removed: 1 });
    expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/sessions/id-task-a"))).toBe(true);
    expect((await svc.listProjectTasks("p-9")).tasks.every((task) => !task.included)).toBe(true);
  });

  it("syncs a board opening from Memmy tasks alone, without asking the Memory service", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    writeMemmyTask(agentSessions, "task-9", "local-9", "只看任务", [
      { role: "user", content: "只同步任务", timestamp: "2026-10-22T04:00:00.000Z" },
      { role: "assistant", content: "好", timestamp: "2026-10-22T04:00:01.000Z" }
    ]);
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } }),
      "PUT /api/collab/projects/p-9/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });

    await svc.bindLocalProject("p-9", "local-9");
    calls.length = 0;
    expect(await svc.syncProjectTasks()).toEqual({ uploaded: 1, removed: 0, failed: 0 });
    expect(calls.some((call) => call.url.includes("/agent-sessions/"))).toBe(false);
  });

  it("saves the next selection without waiting for the upload already running", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    // A slow upload of the first group must not hold up the second save.
    const routes = {
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": async (call: Call) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const body = call.body as { conversationId: string };
        return { session: { title: `会话 ${body.conversationId}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [] } };
      },
      "PUT /api/collab/projects/p-1/sessions": (call: Call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    } as Record<string, (call: Call) => unknown>;
    const { fetcher } = fakeFetch(routes);
    const svc = service(fetcher);

    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    // The first upload is still running; the second save returns straight away.
    const startedAt = Date.now();
    const second = await svc.saveLinks("p-1", {
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }],
      sessions: [{ sourceId: "codex", conversationId: "c1" }]
    });
    expect(Date.now() - startedAt).toBeLessThan(35);
    expect(second.removed).toBe(0);

    await waitForUploads(svc, "p-1");
    expect((await svc.getLinks("p-1")).sessions).toEqual([{ sourceId: "codex", conversationId: "c1" }]);
  });

  it("reads each agent's sessions in one batch instead of one read per session", async () => {
    const local: LocalAgentSession[] = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "a2", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("claude_code", "gone", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", "/repo", "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read-many": (call) => {
        const body = call.body as { sourceId: string; conversationIds: string[] };
        const found = body.conversationIds.filter((id) => id !== "gone");
        return {
          sessions: found.map((id) => ({ conversationId: id, title: `会话 ${id}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [{ question: `问 ${id}`, reply: "答", steps: [], startedAt: "2026-10-22T01:00:00.000Z" }] })),
          missing: body.conversationIds.filter((id) => id === "gone")
        };
      },
      "PUT /api/collab/projects/p-1/sessions": (call) => {
        const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
        return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
      }
    });
    const svc = service(fetcher);

    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }, { sourceId: "codex", groupId: "/repo", excluded: [] }], sessions: [] });
    await waitForUploads(svc, "p-1");

    const batches = calls.filter((call) => call.url.endsWith("/read-many")).map((call) => call.body as { sourceId: string; conversationIds: string[] });
    expect(batches.map((batch) => [batch.sourceId, [...batch.conversationIds].sort()])).toEqual(expect.arrayContaining([
      ["claude_code", ["a1", "a2", "gone"]],
      ["codex", ["c1"]]
    ]));
    expect(batches).toHaveLength(2);
    // A session the agent no longer has is not read again on its own.
    expect(calls.some((call) => call.url.endsWith("/agent-sessions/read"))).toBe(false);
    const uploaded = calls.filter((call) => call.method === "PUT").map((call) => (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!.sourceSessionId);
    expect(uploaded.sort()).toEqual(["a1", "a2", "c1"]);
    expect(await svc.getSyncProgress("p-1")).toMatchObject({ completed: 4, failed: 1 });
  });

  it("uploads a linked group and a session linked later", async () => {
    const local = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z"),
      localSession("codex", "c1", null, "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = linkFetch(local);
    const svc = service(fetcher);
    const group = { sourceId: "claude_code", groupId: "/repo", excluded: [] };

    await svc.saveLinks("p-1", { groups: [group], sessions: [] });
    await waitForUploads(svc, "p-1");
    await svc.saveLinks("p-1", { groups: [group], sessions: [{ sourceId: "codex", conversationId: "c1" }] });
    await waitForUploads(svc, "p-1");

    const uploads = calls.filter((call) => call.method === "PUT").map((call) => (call.body as { sessions: Array<Record<string, unknown>> }).sessions[0]!);
    expect(uploads.map((upload) => upload.sourceSessionId)).toEqual(["a1", "c1"]);
    // The upload carries the session itself and nothing about when it joined the project.
    expect(Object.keys(uploads[0]!).sort()).toEqual(["lastActiveAt", "source", "sourceSessionId", "title", "turns"]);
  });

  it("offers @ candidates from one project only, never across projects", async () => {
    const { fetcher, calls } = fakeFetch({
      "GET /api/collab/projects/p-1/sessions": () => ({
        code: 0,
        data: {
          project: { id: "p-1", name: "Memmy 开发", role: "owner", memberCount: 1, sessionCount: 2, createdAt: null },
          sessions: [
            { id: "s-1", projectId: "p-1", projectName: "Memmy 开发", title: "重复分享返回 409", memberName: "用户C", mine: false, lastActiveAt: "2026-10-22T05:00:00.000Z" },
            { id: "s-2", projectId: "p-1", projectName: "Memmy 开发", title: "知识库分享", memberName: "我", mine: true, lastActiveAt: "2026-10-22T04:00:00.000Z" }
          ],
          total: 2
        }
      })
    });
    const svc = service(fetcher);

    const candidates = await svc.candidateSessions("p-1", { limit: 5 });
    expect(candidates.sessions.map((session) => session.id)).toEqual(["s-1", "s-2"]);
    // Only the project's own sessions endpoint is read: there is no cross-project search.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/collab/projects/p-1/sessions"]);
  });

  it("renames a shared project in the cloud and keeps its binding", async () => {
    const { fetcher, calls } = fakeFetch({
      "PATCH /api/collab/projects/p-1": () => ({
        code: 0,
        data: {
          project: { id: "p-1", name: "新名字", role: "owner", memberCount: 2, sessionCount: 0, createdAt: null },
          joinMode: "approval"
        }
      })
    });
    const svc = service(fetcher);
    await svc.bindLocalProject("p-1", "local-9");
    calls.length = 0;

    const renamed = await svc.renameProject("p-1", "  新名字  ");

    // The name travels trimmed, and the binding stays so the board keeps its local project.
    expect((calls[0]?.body as { name: string }).name).toBe("新名字");
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["PATCH /api/collab/projects/p-1"]);
    expect(renamed.project).toMatchObject({ id: "p-1", name: "新名字", localProjectId: "local-9" });
  });

  it("rejects an empty project name before reaching the cloud", async () => {
    const { fetcher, calls } = fakeFetch({});
    const svc = service(fetcher);

    await expect(svc.renameProject("p-1", "   ")).rejects.toThrow("请填写项目名称");
    expect(calls).toHaveLength(0);
  });

  it("deletes the cloud project and keeps the local project usable", async () => {
    const local: LocalAgentSession[] = [localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z")];
    const deleted: string[] = [];
    const { fetcher } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": () => ({ session: { title: "会话", updatedAt: "2026-10-22T01:00:00.000Z", turns: [] } }),
      "PUT /api/collab/projects/p-1/sessions": () => ({ code: 0, data: { sessions: [{ id: "id-a1" }] } }),
      "DELETE /api/collab/projects/p-1": () => {
        deleted.push("p-1");
        return { code: 0, data: { ok: true } };
      }
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    await svc.bindLocalProject("p-1", "local-9");

    await svc.deleteProject("p-1");

    expect(deleted).toEqual(["p-1"]);
    // The binding is gone so the local project shows as a plain local project with its tasks. The rewrite is
    // queued rather than awaited, so it lands right after the cloud call instead of holding the response.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const links = await svc.getLinks("p-1");
      if (!links.groups.length && !links.sessions.length) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
    expect((await svc.getSyncProgress("p-1")).running).toBe(false);
  });

  it("answers a save while a sync is still uploading", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-home-"));
    roots.push(root);
    const agentSessions = join(root, "workspace", "sessions");
    mkdirSync(agentSessions, { recursive: true });
    writeMemmyTask(agentSessions, "task-a", "local-9", "会话", [
      { role: "user", content: "问题", timestamp: "2026-10-22T05:00:00.000Z" },
      { role: "assistant", content: "回答", timestamp: "2026-10-22T05:00:01.000Z" }
    ]);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetcher } = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [{ id: "p-9", name: "项目 9", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null }] } }),
      "PUT /api/collab/projects/p-9/sessions": async () => {
        await gate;
        return { code: 0, data: { sessions: [{ id: "id-a" }] } };
      }
    });
    const svc = service(fetcher, { projectsDir: join(root, "projects"), agentSessionsDir: agentSessions });
    await svc.bindLocalProject("p-9", "local-9");

    // The sync is stuck in its upload; a save must not wait behind it.
    const syncing = svc.syncProjectTasks("p-9");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const startedAt = Date.now();
    const saved = await svc.saveProjectTasks("p-9", ["task-a"]);
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(saved.started).toBe(1);

    release?.();
    await syncing;
  });

  // The periodic sync runs inside the write queue and can spend up to a minute per session on a slow Memory service.
  // A delete must not sit behind it: the cloud already dropped the project, the links rewrite follows in queue order.
  it("answers a delete without waiting for a slow sync to release the write queue", async () => {
    let updatedAt = "2026-10-22T01:00:00.000Z";
    let hangUploads = false;
    let releaseUpload: (() => void) | null = null;
    let uploadStarted = false;
    const { fetcher } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({
        sessions: [localSession("claude_code", "a1", "/repo", updatedAt)],
        refreshing: false
      }),
      "POST /api/v1/agent-sessions/read": () => ({ session: { title: "会话", updatedAt, turns: [] } }),
      "PUT /api/collab/projects/p-1/sessions": async () => {
        if (hangUploads) {
          uploadStarted = true;
          await new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
        }
        return { code: 0, data: { sessions: [{ id: "id-a1" }] } };
      },
      "DELETE /api/collab/projects/p-1": () => ({ code: 0, data: { ok: true } })
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [], sessions: [{ sourceId: "claude_code", conversationId: "a1" }] });
    // A newer turn makes the session upload again, and this upload is the one that stalls holding the queue.
    updatedAt = "2026-10-22T02:00:00.000Z";
    hangUploads = true;

    const syncing = svc.syncLinkedSessions();
    while (!uploadStarted) await new Promise((resolve) => setTimeout(resolve, 10));

    const startedAt = Date.now();
    await svc.deleteProject("p-1");
    expect(Date.now() - startedAt).toBeLessThan(1_500 + 1_200);

    releaseUpload!();
    await syncing;
    // The queued rewrite still runs after the sync, so the binding is gone once the queue drains.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const links = await svc.getLinks("p-1");
      if (!links.groups.length && !links.sessions.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
  });

  it("clears this computer's links when the person is no longer in the project", async () => {
    const local = [localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z")];
    const { fetcher, calls } = fakeFetch({
      "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
      "POST /api/v1/agent-sessions/read": () => ({ session: { title: "会话", updatedAt: "2026-10-22T01:00:00.000Z", turns: [] } }),
      "PUT /api/collab/projects/p-1/sessions": () => ({ code: 0, data: { sessions: [{ id: "id-a1" }] } }),
      // 被移出后云端不再列出该项目：本机随之解除关联，不再上传。
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [] } })
    });
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }], sessions: [] });
    await waitForUploads(svc, "p-1");
    calls.length = 0;

    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
    expect(uploadedIds(calls)).toEqual([]);
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
  });

  it("keeps each account's links apart on a shared computer", async () => {
    const local = [localSession("claude_code", "a1", "/repo", "2026-10-22T01:00:00.000Z")];
    const { fetcher } = linkFetch(local);
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-"));
    roots.push(root);
    await service(fetcher, { projectsDir: root }).saveLinks("p-1", { groups: [], sessions: [{ sourceId: "claude_code", conversationId: "a1" }] });

    const other = service(fetcher, { projectsDir: root, getAccount: () => ({ accountId: "u-c", credential: "uuid-c" }) });
    expect(await other.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
    expect(await other.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
  });

  it("explains what to do when signed out, offline, or the link is not a session", async () => {
    const { fetcher } = fakeFetch({
      [`GET /api/collab/sessions/${cloudSession.id}`]: () => new Response(JSON.stringify({ code: 404, message: "项目或会话不存在，或你不是该项目的成员", data: null }), { status: 404 })
    });
    await expect(service(fetcher, { getAccount: () => null }).listProjects()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(service(fetcher).readSession("https://memmy.example/docs")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(service(fetcher).readSession(cloudSession.id)).rejects.toMatchObject({ code: "not_found", message: "项目或会话不存在，或你不是该项目的成员" });
    const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(service(offline).listProjects()).rejects.toMatchObject({ message: "暂时无法连接 Memmy 云端，请稍后重试。" });
    await expect(service(fetcher, { localSessions: null }).listLocalSessions({})).rejects.toMatchObject({ message: "无法读取本机任务，请重启 Memmy 后重试。" });
  });

  it("resolves a session's linked projects without relying on a project working directory", async () => {
    const local = [localSession("codex", "c1", "/other-workspace", "2026-10-22T04:00:00.000Z"),
      localSession("codex", "c2", "/other-workspace", "2026-10-22T03:00:00.000Z")];
    const { fetcher } = addFetch(local);
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [{ sourceId: "codex", groupId: "/other-workspace", excluded: ["c2"] }], sessions: [] });
    expect((await svc.projectsForAgentSession("codex", "c1")).map((p) => p.id)).toEqual(["p-1"]);
    expect(await svc.projectsForAgentSession("codex", "c2")).toEqual([]);
    await svc.saveLinks("p-1", { groups: [], sessions: [{ sourceId: "codex", conversationId: "c2" }] });
    expect((await svc.projectsForAgentSession("codex", "c2")).map((p) => p.id)).toEqual(["p-1"]);
    expect(await svc.projectsForAgentSession("codex", "c1")).toEqual([]);
  });

  it("adds the current task alone, and keeps tasks already linked", async () => {
    const local = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T05:00:00.000Z"),
      localSession("codex", "c1", "/other", "2026-10-22T04:00:00.000Z")
    ];
    const { fetcher, calls } = addFetch(local);
    const svc = service(fetcher);
    await svc.saveLinks("p-1", { groups: [], sessions: [{ sourceId: "codex", conversationId: "c1" }] });
    await waitForUploads(svc, "p-1");
    calls.length = 0;

    const added = await svc.addCurrentSession({ project: "Memmy 开发", cwd: "/repo" });

    expect(added.text).toBe([
      "已把当前任务「会话 a1」加入协作项目「Memmy 开发」。",
      "关联的是这一整条任务，包含目前已有的全部轮次，没有关联整个工作区。正在同步，之后的新内容也会更新。"
    ].join("\n"));
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["a1"]);
    expect(await svc.getLinks("p-1")).toEqual({
      groups: [],
      sessions: [
        { sourceId: "codex", conversationId: "c1" },
        { sourceId: "claude_code", conversationId: "a1" }
      ]
    });

    calls.length = 0;
    const again = await svc.addCurrentSession({ project: "Memmy 开发", cwd: "/repo" });
    expect(again.text).toBe("当前任务「会话 a1」已经在协作项目「Memmy 开发」中。");
    expect(uploadedIds(calls)).toEqual([]);
  });

  it("does not add until the project name is exact", async () => {
    const local = [localSession("claude_code", "a1", "/repo", "2026-10-22T05:00:00.000Z")];
    const { fetcher, calls } = addFetch(local);
    const svc = service(fetcher);

    const unnamed = await svc.addCurrentSession({ cwd: "/repo" });
    expect(unnamed.text).toBe([
      "还没有指定协作项目，当前任务尚未加入。",
      "",
      "当前任务：claude_code · 「会话 a1」 · 2026-10-22",
      "",
      "你加入了 2 个协作项目：",
      "Memmy 开发 · 5 位成员 · 32 个任务",
      "设计评审 · 3 位成员 · 0 个任务",
      "",
      "请用户选择项目，确认后运行：",
      "memmy-project session add --project \"<完整名称>\""
    ].join("\n"));

    const partial = await svc.addCurrentSession({ project: "开发", cwd: "/repo" });
    expect(partial.text).toBe([
      "没有名为「开发」的协作项目。",
      "是不是「Memmy 开发」？向用户确认后运行：",
      "memmy-project session add --project \"Memmy 开发\""
    ].join("\n"));
    expect(uploadedIds(calls)).toEqual([]);
    expect(await svc.getLinks("p-1")).toEqual({ groups: [], sessions: [] });
  });

  it("uses a sentence from the task to choose among several in the same directory", async () => {
    const local = [
      localSession("claude_code", "a1", "/repo", "2026-10-22T05:00:00.000Z"),
      localSession("claude_code", "a2", "/repo", "2026-10-21T05:00:00.000Z")
    ];
    const { fetcher, calls } = addFetch(local, { a1: "给分享接口加上限流", a2: "别的问题" });
    const svc = service(fetcher);

    const unclear = await svc.addCurrentSession({ project: "Memmy 开发", cwd: "/repo" });
    expect(unclear.text).toContain("当前目录下有多条任务，还没有加入。");
    expect(unclear.text).toContain("会话 a1");
    expect(unclear.text).toContain("会话 a2");
    expect(uploadedIds(calls)).toEqual([]);

    const added = await svc.addCurrentSession({
      project: "Memmy 开发",
      cwd: "/repo/app",
      hint: "给分享接口加上限流"
    });
    expect(added.text).toContain("已把当前任务「会话 a1」加入协作项目「Memmy 开发」。");
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["a1"]);
    expect(await svc.getLinks("p-1")).toEqual({
      groups: [],
      sessions: [{ sourceId: "claude_code", conversationId: "a1" }]
    });
  });

  it("refuses the only task in the directory when the sentence is not in it", async () => {
    const { fetcher, calls } = addFetch(
      [localSession("claude_code", "a1", "/repo", "2026-10-22T05:00:00.000Z")],
      { a1: "别的问题" }
    );
    const svc = service(fetcher);

    const missed = await svc.addCurrentSession({ project: "Memmy 开发", cwd: "/repo", hint: "给分享接口加上限流" });

    expect(missed.text).toBe([
      "当前目录只有一条任务：claude_code · 「会话 a1」 · 2026-10-22",
      "但这句原话不在其中，所以没有加入。",
      "若用户确认就是这一条，运行：",
      "memmy-project session add --project \"Memmy 开发\""
    ].join("\n"));
    expect(uploadedIds(calls)).toEqual([]);
  });

  it("says the task is already in when the whole directory is linked, and adds one that was excluded", async () => {
    const local = [localSession("claude_code", "a1", "/repo", "2026-10-22T05:00:00.000Z")];
    const { fetcher, calls } = addFetch(local);
    const svc = service(fetcher);
    const group = { sourceId: "claude_code", groupId: "/repo", excluded: [] as string[] };
    await svc.saveLinks("p-1", { groups: [group], sessions: [] });
    await waitForUploads(svc, "p-1");
    calls.length = 0;

    const covered = await svc.addCurrentSession({ project: "Memmy 开发", cwd: "/repo" });
    expect(covered.text).toBe([
      "当前任务「会话 a1」已经在协作项目「Memmy 开发」中。",
      "这个工作区已经整组关联，新的任务也会同步。这次没有再单独添加。"
    ].join("\n"));
    expect(await svc.getLinks("p-1")).toEqual({ groups: [group], sessions: [] });

    await svc.saveLinks("p-1", { groups: [{ ...group, excluded: ["a1"] }], sessions: [] });
    await waitForUploads(svc, "p-1");
    calls.length = 0;
    const restored = await svc.addCurrentSession({ project: "Memmy 开发", cwd: "/repo" });
    expect(restored.text).toContain("已把当前任务「会话 a1」加入");
    await waitForUploads(svc, "p-1");
    expect(await svc.getLinks("p-1")).toEqual({
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: ["a1"] }],
      sessions: [{ sourceId: "claude_code", conversationId: "a1" }]
    });
  });

  it("stops when the person is in no project, or the directory has no task", async () => {
    const empty = fakeFetch({
      "GET /api/collab/projects": () => ({ code: 0, data: { projects: [] } })
    });
    expect((await service(empty.fetcher).addCurrentSession({ cwd: "/repo", project: "Memmy 开发" })).text)
      .toMatch(/^你还没有加入任何 Memmy 协作项目，无法把当前任务加进去/);

    const elsewhere = addFetch([localSession("claude_code", "a1", "/other", "2026-10-22T05:00:00.000Z")]);
    expect((await service(elsewhere.fetcher).addCurrentSession({ project: "Memmy 开发", cwd: "/repo" })).text)
      .toMatch(/^找不到当前这条任务/);
    expect((await service(elsewhere.fetcher).addCurrentSession({ project: "Memmy 开发" })).text)
      .toMatch(/^无法确定当前目录/);
  });

  it("adds the named current conversation, not whichever task in the directory is newest", async () => {
    const local = [
      localSession("cursor", "newest", "/repo", "2026-10-22T05:00:00.000Z"),
      localSession("cursor", "current", "/repo", "2026-10-22T01:00:00.000Z")
    ];
    const { fetcher, calls } = addFetch(local);
    const svc = service(fetcher);

    const added = await svc.addCurrentSession({
      project: "Memmy 开发",
      cwd: "/repo",
      sourceId: "cursor",
      conversationId: "current"
    });

    expect(added.text).toContain("已把当前任务「会话 current」加入协作项目「Memmy 开发」。");
    expect(added.text).toContain("这一整条任务，包含目前已有的全部轮次");
    await waitForUploads(svc, "p-1");
    expect(uploadedIds(calls)).toEqual(["current"]);

    const missing = await service(addFetch(local).fetcher).addCurrentSession({
      project: "Memmy 开发",
      cwd: "/repo",
      sourceId: "cursor",
      conversationId: "not-this-chat"
    });
    expect(missing.text).toMatch(/还没有读到正在进行的这个对话/);
    expect(missing.text).toContain("不要改加别的任务");
  });
});

/** Projects the person is in, plus the local tasks `add` chooses from. */
function addFetch(local: LocalAgentSession[], questions: Record<string, string> = {}) {
  return fakeFetch({
    "GET /api/collab/projects": () => ({
      code: 0,
      data: {
        projects: [
          { id: "p-1", name: "Memmy 开发", role: "owner", memberCount: 5, sessionCount: 32, createdAt: null },
          { id: "p-2", name: "设计评审", role: "member", memberCount: 3, sessionCount: 0, createdAt: null }
        ]
      }
    }),
    "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
    "POST /api/v1/agent-sessions/read-many": (call) => {
      const ids = (call.body as { conversationIds: string[] }).conversationIds;
      return {
        sessions: ids.map((id) => ({
          conversationId: id,
          title: `会话 ${id}`,
          updatedAt: "2026-10-22T01:00:00.000Z",
          turns: [{ question: questions[id] ?? "", reply: "答", steps: [], startedAt: "2026-10-22T01:00:00.000Z" }]
        })),
        missing: []
      };
    },
    "POST /api/v1/agent-sessions/read": (call) => {
      const id = (call.body as { conversationId: string }).conversationId;
      if (!local.some((session) => session.conversationId === id)) {
        return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      }
      return {
        session: {
          title: `会话 ${id}`,
          updatedAt: "2026-10-22T01:00:00.000Z",
          turns: [{ question: questions[id] ?? "问", reply: "答", steps: [], startedAt: "" }]
        }
      };
    },
    "PUT /api/collab/projects/p-1/sessions": (call) => {
      const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
      return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
    },
    "DELETE /api/collab/projects/p-1/sessions/id-a1": () => ({ code: 0, data: null }),
    "DELETE /api/collab/projects/p-1/sessions/id-c1": () => ({ code: 0, data: null })
  });
}

function localSession(sourceId: string, conversationId: string, groupId: string | null, updatedAt: string): LocalAgentSession {
  return {
    sourceId,
    agentName: sourceId,
    conversationId,
    title: `会话 ${conversationId}`,
    lastQuestion: "",
    workspacePath: groupId,
    group: groupId ? { id: groupId, label: groupId, path: groupId } : null,
    updatedAt,
    turnCount: 1
  };
}

/** Memory lists `local`; the cloud accepts uploads as id-<conversation> and deletes any session. */
function linkFetch(local: LocalAgentSession[]) {
  const deleted = (call: Call) => (call.url.includes("/sessions/id-") ? { code: 0, data: null } : new Response("{}", { status: 404 }));
  return fakeFetch({
    "POST /api/v1/agent-sessions/available": () => ({ sessions: local, refreshing: false }),
    "POST /api/v1/agent-sessions/read": (call) => {
      const body = call.body as { conversationId: string };
      return { session: { title: `会话 ${body.conversationId}`, updatedAt: "2026-10-22T01:00:00.000Z", turns: [{ question: "问", reply: "答", steps: [], startedAt: "" }] } };
    },
    "PUT /api/collab/projects/p-1/sessions": (call) => {
      const upload = (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!;
      return { code: 0, data: { sessions: [{ id: `id-${upload.sourceSessionId}` }] } };
    },
    "DELETE /api/collab/projects/p-1/sessions/id-a1": deleted,
    "DELETE /api/collab/projects/p-1/sessions/id-c1": deleted
  });
}

function uploadedIds(calls: Call[]): string[] {
  return calls
    .filter((call) => call.method === "PUT")
    .map((call) => (call.body as { sessions: Array<{ sourceSessionId: string }> }).sessions[0]!.sourceSessionId);
}

function uploadedTitles(calls: Call[]): string[] {
  return calls
    .filter((call) => call.method === "PUT")
    .map((call) => (call.body as { sessions: Array<{ title: string }> }).sessions[0]!.title);
}

/** Writes a Memmy task session file: a metadata line first, then the records of each turn. */
function writeMemmyTask(
  directory: string,
  id: string,
  projectId: string,
  title: string,
  records: Array<Record<string, unknown>>
): void {
  const lines = [{
    recordType: "metadata",
    key: `websocket:${id}`,
    createdAt: "2026-10-22T03:00:00.000Z",
    updatedAt: "2026-10-22T03:00:02.000Z",
    metadata: { webui: true, webuiProjectId: projectId, webuiWorkspaceCwd: "/tmp/project", title }
  }, ...records];
  writeFileSync(join(directory, `websocket_${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/** Waits until a queued association finishes uploading, so a test can assert what reached the cloud. */
async function waitForUploads(svc: ReturnType<typeof service>, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const progress = await svc.getSyncProgress(projectId);
    if (!progress.running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("upload did not finish");
}

/** A listed session, for the paging and search rules. */
function projectSession(
  id: string,
  index: number,
  overrides: Partial<{ title: string; lastQuestion: string; memberName: string; mine: boolean }> = {}
) {
  return {
    id,
    projectId: "p-1",
    projectName: "Memmy 开发",
    title: overrides.title ?? `会话 ${index}`,
    lastQuestion: overrides.lastQuestion ?? "",
    memberName: overrides.memberName ?? "用户C",
    mine: overrides.mine ?? false,
    source: "memmy",
    turnCount: 1,
    lastActiveAt: `2026-10-22T0${index % 10}:00:00.000Z`,
    link: `https://cloud.test.invalid/s/${id}`,
    shareText: `【Memmy】会话 ${index} https://cloud.test.invalid/s/${id}`
  };
}
