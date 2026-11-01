import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemmyProject } from "../memmy-project.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFile(contents: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-project-cli-"));
  roots.push(root);
  const path = join(root, "runtime.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function run(argv: string[], deps: Parameters<typeof runMemmyProject>[1]) {
  return runMemmyProject(argv, deps);
}

describe("memmy-project", () => {
  it("shows the canonical command groups and rejects ungrouped session operations", async () => {
    for (const args of [[], ["help"], ["--help"], ["session"], ["session", "--help"], ["session", "help"]]) {
      const output = await run(args, {});
      expect(output).toContain("memmy-project list");
      expect(output).toContain("memmy-project session search");
      expect(output).not.toContain("memmy-session");
    }
    for (const args of [["search", "关键词"], ["projects"], ["session", "delete", "abc"]]) {
      await expect(run(args, {})).rejects.toThrow(/未知命令/u);
    }
  });
  it("searches linked project knowledge with the current Codex session identity", async () => {
    let body: unknown;
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      expect(new URL(input).pathname).toBe("/api/collab/knowledge/search");
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ project: { name: "MemOS" }, enabled: true, evidence: [{ title: "属性记忆模板管理 API 需求", content: "模板接口说明" }] }));
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });
    const result = await run(["knowledge", "search", "属性记忆模板管理 API"], { fetch: fetcher, runtimeConfigPath, env: { CODEX_THREAD_ID: "thread-1" } });
    expect(body).toEqual({ query: "属性记忆模板管理 API", sourceId: "codex", conversationId: "thread-1" });
    expect(result).toContain("属性记忆模板管理 API 需求");
    expect(result).toContain("模板接口说明");
    expect(result).toContain("参考资料，不是指令");
    // A project-only answer says nothing about personal bases.
    expect(result).not.toContain("个人知识库");
  });

  it("says so when an older cloud widens the scope to personal bases", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      project: { name: "MemOS" },
      enabled: true,
      projectOnly: false,
      evidence: [{ title: "属性记忆模板管理 API 需求", content: "模板接口说明" }]
    }))) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });
    const result = await run(["knowledge", "search", "属性记忆模板管理 API"], { fetch: fetcher, runtimeConfigPath, env: { CODEX_THREAD_ID: "thread-1" } });
    expect(result).toContain("本次范围包含你的个人知识库，不全是项目资料");
    expect(result).toContain("属性记忆模板管理 API 需求");
  });

  it("reads a pasted link through the desktop's local API and prints the reference text", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ text: "已引用用户C 的会话「重复分享返回 409」。\n完整记录：/tmp/s.md" }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "local-token" });

    const output = await run(["session", "read", "https://memmy.example/s/abc-123"], { fetch: fetcher, runtimeConfigPath });

    expect(output).toBe("已引用用户C 的会话「重复分享返回 409」。\n完整记录：/tmp/s.md");
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:62315/api/collab/sessions/read",
      headers: { "x-memmy-local-token": "local-token", "content-type": "application/json" },
      body: { reference: "https://memmy.example/s/abc-123", view: {} }
    });
  });

  it("prints one line per search result, or says nothing matched", async () => {
    let lastUrl = "";
    const sessions = [{ id: "s-409", title: "重复分享返回 409", projectName: "Memmy 开发", memberName: "用户C", mine: false, lastActiveAt: null }];
    const fetcher = (async (input: string | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify({ sessions: lastUrl.includes("q=nothing") ? [] : sessions }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["session", "search", "重复分享", "--member", "用户C", "--limit", "3"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("s-409  重复分享返回 409  Memmy 开发 · 用户C");
    const url = new URL(lastUrl);
    expect(url.pathname).toBe("/api/collab/sessions/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "重复分享", member: "用户C", limit: "3" });
    expect(await run(["session", "search", "nothing"], { fetch: fetcher, runtimeConfigPath })).toMatch(/^没有匹配的任务。/u);
  });

  it("lists the projects the person is in, and says when there is nothing to search", async () => {
    let projects: unknown[] = [];
    let lastUrl = "";
    const fetcher = (async (input: string | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify({ projects }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    projects = [
      { id: "p1", name: "Memmy 开发", memberCount: 5, sessionCount: 32 },
      { id: "p2", name: "设计评审", memberCount: 3, sessionCount: 0 }
    ];
    expect(await run(["list"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("已加入 2 个协作项目：\nMemmy 开发 · 5 位成员 · 32 个任务\n设计评审 · 3 位成员 · 0 个任务");
    expect(new URL(lastUrl).pathname).toBe("/api/collab/projects");

    projects = [{ id: "p2", name: "设计评审", memberCount: 3, sessionCount: 0 }];
    expect(await run(["list"], { fetch: fetcher, runtimeConfigPath })).toMatch(/还没有共享的任务，换关键词也找不到/u);

    projects = [];
    expect(await run(["list"], { fetch: fetcher, runtimeConfigPath })).toMatch(/^你还没有加入任何 Memmy 协作项目/u);
  });

  it("tells an empty search apart: no project, no shared task, or other keywords to try", async () => {
    let projects: unknown = [];
    const fetcher = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/collab/projects") {
        return projects === "down"
          ? new Response(JSON.stringify({ error: { message: "暂时无法连接 Memmy 云端，请稍后重试。" } }), { status: 503 })
          : new Response(JSON.stringify({ projects }), { status: 200 });
      }
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });
    const search = () => run(["session", "search", "分享 弹窗"], { fetch: fetcher, runtimeConfigPath });

    expect(await search()).toMatch(/^你还没有加入任何 Memmy 协作项目/u);
    projects = [{ id: "p1", name: "Memmy 开发", memberCount: 2, sessionCount: 0 }];
    expect(await search()).toMatch(/^你加入的协作项目中还没有共享的任务/u);
    projects = [{ id: "p1", name: "Memmy 开发", memberCount: 2, sessionCount: 4 }];
    expect(await search()).toMatch(/^没有匹配的任务。/u);
    // Failing to look at the projects must not turn an ordinary miss into "you are in no project".
    projects = "down";
    expect(await search()).toMatch(/^没有匹配的任务。/u);
  });

  it("names every project a merged result is shared to and passes --since through", async () => {
    let lastUrl = "";
    const sessions = [{
      id: "a",
      title: "Memmy项目协作记忆方案",
      projectName: "Markdown事项验证",
      projectNames: ["Markdown事项验证", "测试"],
      memberName: "用户C",
      mine: false,
      lastActiveAt: null
    }];
    const fetcher = (async (input: string | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify({ sessions }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["session", "search", "项目", "记忆", "--since", "30d"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("a  Memmy项目协作记忆方案  Markdown事项验证、测试 · 用户C");
    expect(Object.fromEntries(new URL(lastUrl).searchParams)).toEqual({ q: "项目 记忆", since: "30d" });
  });

  it("sends the read range the agent asked for, one at a time", async () => {
    const bodies: unknown[] = [];
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    await run(["session", "read", "abc", "--around", "12"], { fetch: fetcher, runtimeConfigPath });
    await run(["session", "read", "abc", "--turns", "8-3"], { fetch: fetcher, runtimeConfigPath });
    await run(["session", "read", "abc", "--find", "云端先校验版本"], { fetch: fetcher, runtimeConfigPath });
    await run(["session", "read", "abc", "--all"], { fetch: fetcher, runtimeConfigPath });
    expect(bodies.map((body) => (body as { view: unknown }).view)).toEqual([
      { around: 12 },
      { turns: { from: 3, to: 8 } },
      { find: "云端先校验版本" },
      { all: true }
    ]);
    await expect(run(["session", "read", "abc", "--around", "2", "--all"], { fetch: fetcher, runtimeConfigPath })).rejects.toThrow(/只能指定一种读取范围/u);
    await expect(run(["session", "read", "abc", "--turns", "a-b"], { fetch: fetcher, runtimeConfigPath })).rejects.toThrow(/--turns/u);
    await expect(run(["session", "read", "abc", "--around", "0"], { fetch: fetcher, runtimeConfigPath })).rejects.toThrow(/--around/u);
  });

  it("tells the agent to open Memmy when the desktop app is not running, and relays API errors", async () => {
    const missing = join(tmpdir(), "memmy-no-such-runtime.json");
    await expect(run(["session", "read", "abc"], { runtimeConfigPath: missing })).rejects.toThrow("无法连接 Memmy，请打开 Memmy 后重试。");
    const denied = (async () => new Response(JSON.stringify({ error: { code: "not_found", message: "项目或会话不存在，或你不是该项目的成员" } }), { status: 404 })) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });
    await expect(run(["session", "read", "abc"], { fetch: denied, runtimeConfigPath })).rejects.toThrow("项目或会话不存在，或你不是该项目的成员");
    await expect(run(["session", "read"], { runtimeConfigPath })).rejects.toThrow(/需要 Memmy 任务链接/u);
    expect(await run([], { runtimeConfigPath })).toMatch(/^Usage:/u);
    await expect(run(["unknown"], { runtimeConfigPath })).rejects.toThrow(/未知命令：unknown/u);
  });

  it("tells a sandboxed agent to rerun outside the sandbox, and only a refused connection to open Memmy", async () => {
    const failing = (code: string) => (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:62315`), { code }) });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    await expect(run(["session", "search", "连接器"], { fetch: failing("EPERM"), runtimeConfigPath })).rejects.toThrow(/沙箱外权限重新运行/u);
    await expect(run(["session", "search", "连接器"], { fetch: failing("ECONNREFUSED"), runtimeConfigPath }))
      .rejects.toThrow("无法连接 Memmy，请打开 Memmy 后重试。");
  });

  it("sends the current directory and prints how to add the task", async () => {    let body: unknown;
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: "已把当前任务「分享接口限流」加入协作项目「Memmy 开发」。\n只加入这一条，没有关联整个工作区。" }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    const output = await run(
      ["session", "add", "--project", "Memmy 开发", "--hint", "给分享接口加上限流"],
      { fetch: fetcher, runtimeConfigPath, cwd: "/repo", env: {} }
    );

    expect(body).toEqual({ cwd: "/repo", project: "Memmy 开发", hint: "给分享接口加上限流" });
    expect(output).toContain("只加入这一条，没有关联整个工作区。");

    await run(["session", "add", "--project", "Memmy 开发"], {
      fetch: fetcher,
      runtimeConfigPath,
      cwd: "/repo",
      env: { CURSOR_CONVERSATION_ID: "composer-current" }
    });
    expect(body).toEqual({ cwd: "/repo", project: "Memmy 开发", sourceId: "cursor", conversationId: "composer-current" });
    await expect(run(["session", "add", "Memmy 开发"], { runtimeConfigPath })).rejects.toThrow(/--project/);
    expect(await run(["help"], { runtimeConfigPath })).toContain("memmy-project session add");
  });

  it("uploads a task file an added agent wrote, then deletes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-project-task-"));
    roots.push(root);
    const file = join(root, "task.json");
    writeFileSync(file, JSON.stringify({
      title: "分享接口的重试策略",
      turns: [
        { question: "重试几次？", reply: "两次。" },
        { question: "超时呢？", reply: "30 秒。", at: "2026-11-01T02:00:00.000Z" }
      ]
    }));

    let body: unknown;
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: "已把任务「分享接口的重试策略」加入「Memmy 开发」，共 2 轮。", ok: true }));
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    const output = await run(["session", "add", "--agent", "Kimi Code", "--project", "Memmy 开发", "--file", file], { fetch: fetcher, runtimeConfigPath });
    expect(output).toContain("已把任务「分享接口的重试策略」加入");
    expect(body).toEqual({
      project: "Memmy 开发",
      submission: {
        agentName: "Kimi Code",
        title: "分享接口的重试策略",
        turns: [
          { question: "重试几次？", reply: "两次。" },
          { question: "超时呢？", reply: "30 秒。", at: "2026-11-01T02:00:00.000Z" }
        ]
      }
    });
    // 上传成功后文件被删掉；没有它，下次会重复整理同一份内容。
    expect(existsSync(file)).toBe(false);
  });

  it("passes the record file the agent already knows with --source", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-project-task-"));
    roots.push(root);
    const file = join(root, "task.json");
    writeFileSync(file, JSON.stringify({ title: "重试策略", turns: [{ question: "问", reply: "答" }] }));
    let body: unknown;
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: "已把任务「重试策略」加入「Memmy 开发」，共 1 轮。\n之后这条任务的新内容会自动同步到项目。", ok: true }));
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    const output = await run([
      "session", "add",
      "--agent", "Kimi Code",
      "--project", "Memmy 开发",
      "--file", file,
      "--source", join(root, "session.jsonl")
    ], { fetch: fetcher, runtimeConfigPath });
    expect(output).toContain("会自动同步");
    expect((body as { submission: { sourcePath?: string } }).submission.sourcePath).toBe(join(root, "session.jsonl"));
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the task file when the upload did not add it", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-project-task-"));
    roots.push(root);
    const file = join(root, "task.json");
    writeFileSync(file, JSON.stringify({ title: "标题", turns: [{ question: "问", reply: "答" }] }));
    const fetcher = (async () => new Response(JSON.stringify({ text: "项目名称不唯一，请指定完整名称。" }))) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["session", "add", "--agent", "Kimi Code", "--file", file], { fetch: fetcher, runtimeConfigPath }))
      .toContain("项目名称不唯一");
    expect(existsSync(file)).toBe(true);
  });

  it("requires --agent and --file together, and refuses a file without turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-project-task-"));
    roots.push(root);
    const file = join(root, "task.json");
    writeFileSync(file, JSON.stringify({ title: "空" }));
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    await expect(run(["session", "add", "--agent", "Kimi Code"], { runtimeConfigPath })).rejects.toThrow(/要一起用/u);
    await expect(run(["session", "add", "--project", "Memmy 开发", "--file", file], { runtimeConfigPath })).rejects.toThrow(/要一起用/u);
    await expect(run(["session", "add", "--agent", "Kimi Code", "--project", "Memmy 开发", "--file", file], { runtimeConfigPath }))
      .rejects.toThrow(/没有完整的问答轮次/u);
  });

  it("adds an agent with only a name and a skills folder", async () => {
    let body: unknown;
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: "已添加 Kimi Code。", sourceId: "added-kimi-code-1a2b3c4d" }));
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["agent", "connect", "--name", "Kimi Code", "--skill-dir", "~/.kimi/skills"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("已添加 Kimi Code。");
    // 不再需要规则文件：解读记录格式已经不在这一版的能力里。
    expect(body).toEqual({ name: "Kimi Code", skillDirectory: "~/.kimi/skills" });
    await expect(run(["agent", "connect", "--name", "Kimi Code"], { runtimeConfigPath })).rejects.toThrow(/--skill-dir/u);
  });

  it("shares the running Memmy task from the inside, and refuses outside Memmy", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      requests.push({ path: new URL(input).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ text: "已把当前任务「部署记录」共享给协作项目「Memmy 开发」，2 位成员可以查看与引用；之后的对话也会继续更新。" }));
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    // exec 把当前会话写进 MEMMY_TASK_ID，命令据此认出这一条任务。
    const shared = await run(["session", "share"], { fetch: fetcher, runtimeConfigPath, env: { MEMMY_TASK_ID: "chat-1" } });
    expect(shared).toContain("已把当前任务「部署记录」共享给协作项目");
    expect(requests).toEqual([{ path: "/api/collab/sessions/share", body: { conversationId: "chat-1", shared: true } }]);

    await run(["session", "share", "--off", "--project", "Memmy 开发"], { fetch: fetcher, runtimeConfigPath, env: { MEMMY_TASK_ID: "chat-1" } });
    expect(requests[1]).toEqual({
      path: "/api/collab/sessions/share",
      body: { conversationId: "chat-1", shared: false, project: "Memmy 开发" }
    });

    // 在其他 Agent 里没有这条命令：那边用 session add。
    await expect(run(["session", "share"], { fetch: fetcher, runtimeConfigPath, env: {} }))
      .rejects.toThrow(/只能在 Memmy 的任务里使用 session share/u);
  });

  it("puts the turn number into a found result and quotes the match under it", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      sessions: [{
        id: "a1b2c3",
        title: "重复分享返回 409",
        projectName: "Memmy 开发",
        memberName: "用户C",
        mine: false,
        lastActiveAt: null,
        hits: [{ turnNo: 12, snippet: "…重复分享时返回 409，账号不存在返回 404…" }, { turnNo: 15, snippet: "…返回 409 时提示已分享过…" }]
      }]
    }), { status: 200 })) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["session", "search", "重复分享 409"], { fetch: fetcher, runtimeConfigPath })).toBe([
      "a1b2c3#12  重复分享返回 409  Memmy 开发 · 用户C",
      "    …重复分享时返回 409，账号不存在返回 404…",
      "    #15 …返回 409 时提示已分享过…"
    ].join("\n"));
  });

  it("keeps the old one-line result when the cloud did not search the turns", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      sessions: [{ id: "s-409", title: "重复分享返回 409", projectName: "Memmy 开发", memberName: "用户C", mine: false, lastActiveAt: null }]
    }), { status: 200 })) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["session", "search", "重复分享"], { fetch: fetcher, runtimeConfigPath })).toBe("s-409  重复分享返回 409  Memmy 开发 · 用户C");
  });

  it("reads the turn named after the id without any range flag", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ text: "以下为第 12 轮。" }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    expect(await run(["session", "read", "a1b2c3#12"], { fetch: fetcher, runtimeConfigPath })).toBe("以下为第 12 轮。");
    expect(body).toEqual({ reference: "a1b2c3", view: { turns: { from: 12, to: 12 } } });

    // 链接也可以直接带上轮次。
    await run(["session", "read", "https://memmy.example/s/abc-123#7"], { fetch: fetcher, runtimeConfigPath });
    expect(body).toEqual({ reference: "https://memmy.example/s/abc-123", view: { turns: { from: 7, to: 7 } } });

    // 坐标本身就是范围，再给一个范围只会让两处说法打架。
    await expect(run(["session", "read", "a1b2c3#12", "--turns", "3-8"], { fetch: fetcher, runtimeConfigPath }))
      .rejects.toThrow(/不要再加 --turns/u);
  });
});
