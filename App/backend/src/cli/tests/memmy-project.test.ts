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
    const paths: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      // 成员名字让 Agent 能把「让孙落看一下」对到 --member；读不到成员的项目只显示人数。
      if (path === "/api/collab/projects/p1/members") {
        return new Response(JSON.stringify({ members: [{ name: "孙起" }, { name: "孙落" }] }), { status: 200 });
      }
      if (path.endsWith("/members")) return new Response(JSON.stringify({ error: { message: "x" } }), { status: 503 });
      return new Response(JSON.stringify({ projects }), { status: 200 });
    }) as typeof fetch;
    const runtimeConfigPath = runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" });

    projects = [
      { id: "p1", name: "Memmy 开发", memberCount: 2, sessionCount: 32 },
      { id: "p2", name: "设计评审", memberCount: 3, sessionCount: 0 }
    ];
    expect(await run(["list"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("已加入 2 个协作项目：\nMemmy 开发 · 2 位成员（孙起、孙落） · 32 个任务\n设计评审 · 3 位成员 · 0 个任务");
    expect(paths[0]).toBe("/api/collab/projects");

    // 项目列表带上谁接收协助请求：Agent 据此在对方开启了的项目里发请求。
    projects = [
      { id: "p1", name: "Memmy 开发", memberCount: 2, sessionCount: 32, assistReceivers: [{ userId: "2", name: "孙落" }] },
      { id: "p2", name: "设计评审", memberCount: 3, sessionCount: 0, assistReceivers: [] }
    ];
    expect(await run(["list"], { fetch: fetcher, runtimeConfigPath }))
      .toBe("已加入 2 个协作项目：\nMemmy 开发 · 2 位成员（孙起、孙落） · 接收协助：孙落 · 32 个任务\n设计评审 · 3 位成员 · 接收协助：无人开启 · 0 个任务");

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

describe("memmy-project assist", () => {
  function requestFile(): string {
    const root = mkdtempSync(join(tmpdir(), "memmy-assist-request-"));
    roots.push(root);
    const path = join(root, "request.json");
    writeFileSync(path, JSON.stringify({
      title: "收集 Cursor 任务读取相关的信息",
      reason: "关联任务弹窗里看不到 Cursor 的任务",
      items: ["查看 Memmy、Cursor 与系统的版本"]
    }));
    return path;
  }

  it("asks a member's computer for help, naming the agent that is asking", async () => {
    let body: Record<string, unknown> = {};
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      expect(new URL(input).pathname).toBe("/api/collab/assist/requests");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ request: { id: "a7f3k111" }, threadId: "t1", text: "已发送协助请求 A7F3K1。" }));
    }) as typeof fetch;

    const output = await run([
      "assist", "ask", "--project", "Memmy 内测反馈", "--member", "王雨", "--file", requestFile()
    ], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: { CODEX_THREAD_ID: "thread-1" } });

    // 请求只写要做的事和原因，不指定由哪个 Agent 执行；发起方是哪个 Agent 要带上去，弹窗里才说得清。
    expect(body).toMatchObject({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "收集 Cursor 任务读取相关的信息",
      reason: "关联任务弹窗里看不到 Cursor 的任务",
      items: ["查看 Memmy、Cursor 与系统的版本"],
      via: "Codex"
    });
    expect(body).not.toHaveProperty("thread");
    expect(output).toContain("已发送协助请求 A7F3K1。");
  });

  it("names DeepSeek Harness as the asking agent and passes its session record to the desktop", async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      bodies.push({ path: new URL(input).pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (new URL(input).pathname === "/api/collab/assist/requests") {
        return new Response(JSON.stringify({ request: { id: "a7f3k111" }, threadId: "t1", text: "已发送协助请求 A7F3K1。" }));
      }
      return new Response(JSON.stringify({ text: "还没结束" }));
    }) as typeof fetch;
    const env = { DSH_SESSION_ID: "dsh-1", DSH_SESSION_JSONL: "/Users/me/.dsh/sessions/x/session-dsh-1/session.v4.jsonl.zstd" };
    const deps = { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env };

    await run(["assist", "ask", "--project", "Memmy 内测反馈", "--member", "王雨", "--file", requestFile()], deps);
    await run(["assist", "wait", "A7F3K1"], deps);
    await run(["assist", "status", "A7F3K1"], deps);

    const session = { sourceId: "deepseek_harness", sessionId: "dsh-1", recordPath: env.DSH_SESSION_JSONL };
    expect(bodies[0]!.body).toMatchObject({ via: "DeepSeek Harness", requesterSession: session });
    expect(bodies[0]!.body).not.toHaveProperty("sourceTask");
    expect(bodies[1]).toMatchObject({ path: "/api/collab/assist/requests/A7F3K1/wait", body: { requesterSession: session } });
    expect(bodies[2]).toMatchObject({ path: "/api/collab/assist/requests/A7F3K1/status", body: { requesterSession: session } });
  });

  it("drops the session and asks again when an older desktop rejects the field", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      if ("requesterSession" in body) {
        return new Response(JSON.stringify({ error: { code: "invalid_argument", message: "Unrecognized key" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ request: { id: "a7f3k111" }, threadId: "t1", text: "已发送协助请求 A7F3K1。" }));
    }) as typeof fetch;

    const output = await run(["assist", "ask", "--project", "p", "--member", "王雨", "--file", requestFile()], {
      fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: { DSH_SESSION_ID: "dsh-1" }
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("requesterSession");
    expect(output).toContain("已发送协助请求 A7F3K1");
  });

  it.each([
    { env: { MEMMY_TASK_ID: "requester-task" }, via: "Memmy" },
    { env: { CODEX_THREAD_ID: "requester-codex" }, via: "Codex" }
  ])("continues the same investigation by carrying the thread from $via", async ({ env, via }) => {
    let body: Record<string, unknown> = {};
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ request: { id: "r2" }, threadId: "t1", text: "ok" }));
    }) as typeof fetch;

    await run([
      "assist", "ask", "--project", "Memmy 内测反馈", "--member", "王雨", "--file", requestFile(), "--continue", "t1"
    ], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env });

    expect(body).toHaveProperty("thread", "t1");
    // Caller identity is fixture-owned, independent of the agent running the test.
    expect(body).toHaveProperty("via", via);
    if (via === "Memmy") expect(body).toHaveProperty("sourceTask", "requester-task");
    else expect(body).not.toHaveProperty("sourceTask");
  });

  it("prints where the request stands, including the steps and the result", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      request: {
        id: "r1",
        status: "done",
        agent: "claude_code",
        executor: { name: "王雨" },
        steps: [{ text: "运行 sw_vers", output: "macOS 15.6" }],
        reply: "版本：Memmy 1.2.6",
        resultItems: [{ key: "版本", value: "Memmy 1.2.6" }]
      }
    }))) as typeof fetch;

    const output = await run(["assist", "status", "r1"], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) });

    expect(output).toContain("已完成：由王雨的 Claude Code 执行。");
    expect(output).toContain("· 运行 sw_vers → macOS 15.6");
    expect(output).toContain("版本：Memmy 1.2.6");
  });

  it("passes on the cloud's explanation when the member does not receive assist requests", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      error: { code: "collab_assist_not_receiving", message: "王雨还没有在「Memmy 内测反馈」中开启接收协助请求" }
    }), { status: 409 })) as typeof fetch;

    await expect(run([
      "assist", "ask", "--project", "Memmy 内测反馈", "--member", "王雨", "--file", requestFile()
    ], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) }))
      .rejects.toThrow("王雨还没有在「Memmy 内测反馈」中开启接收协助请求");
  });

  it("says why a waiting request ended when the member stopped receiving requests", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      request: { id: "r1", status: "rejected", executor: { name: "王雨" }, failure: "王雨已关闭接收协助请求", steps: [] }
    }))) as typeof fetch;

    const output = await run(["assist", "status", "r1"], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) });

    expect(output).toBe("王雨已关闭接收协助请求。");
  });

  it("prints the backend's status text, which is what gets recorded as received", async () => {
    const paths: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      paths.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify({ request: { id: "r1", status: "done" }, text: "已完成：王雨的 Memmy 在王雨的电脑上执行（第 1 次）。" }));
    }) as typeof fetch;

    const output = await run(["assist", "status", "r1"], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) });

    expect(paths).toEqual(["POST /api/collab/assist/requests/r1/status"]);
    expect(output).toBe("已完成：王雨的 Memmy 在王雨的电脑上执行（第 1 次）。");
  });

  it("does not say it waits for permission when her timed permission will run it", async () => {
    const fetcher = (async (input: string | URL | Request) => new URL(String(input)).pathname.endsWith("/status")
      ? new Response(JSON.stringify({ error: { code: "not_found", message: "Route not found" } }), { status: 404 })
      : new Response(JSON.stringify({ request: { id: "r1", status: "pending", autoRun: true, executor: { name: "王雨" }, steps: [] } }))) as typeof fetch;

    const output = await run(["assist", "status", "r1"], { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) });

    expect(output).toBe("按王雨给你的限时授权，等待王雨的 Agent 开始执行。");
  });

  it("says which of withdrawing and stopping happened, from one command", async () => {
    const cancelTo = (request: Record<string, unknown>, status = 200) => (async (input: string | URL) => {
      expect(new URL(input).pathname).toMatch(/\/api\/collab\/assist\/requests\/r1\/cancel$/u);
      return new Response(JSON.stringify(status === 200
        ? { request }
        : { error: { code: "conflict", message: "这次请求已经处理过了" } }), { status });
    }) as typeof fetch;
    const deps = (fetcher: typeof fetch) => ({ fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) });

    // 还没开始的撤回。
    await expect(run(["assist", "cancel", "r1"], deps(cancelTo({ id: "r1", status: "cancelled" }))))
      .resolves.toBe("已撤回这次协助请求；对方那边的通知随之消失。");
    // 已经在执行的直接停：说明过程还在，并给出换个要求的写法。
    const stopped = await run(["assist", "cancel", "r1"], deps(cancelTo({ id: "a7f3k111-1111", status: "stopped", executor: { name: "李四" } })));
    expect(stopped).toContain("已停止李四那边的执行");
    expect(stopped).toContain("memmy-project assist ask --continue A7F3K1");
    // 已经结束的不是故障：没有可撤回或停止的。
    await expect(run(["assist", "cancel", "r1"], deps(cancelTo({}, 409)))).resolves.toBe("这次请求已经结束，没有可撤回或停止的。");
  });

  it("picks up the latest request to a member when the Agent no longer has its id", async () => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const path = new URL(input).pathname;
      asked.push(path);
      if (path === "/api/collab/projects") return new Response(JSON.stringify({ projects: [{ id: "p1", name: "Memmy 内测反馈" }] }));
      if (path === "/api/collab/projects/p1/assist/threads") {
        return new Response(JSON.stringify({ threads: [
          { threadId: "t1", requests: [{ id: "old-1", mine: true, status: "done", createdAt: "2026-11-05T01:00:00Z", executor: { name: "李四" } }] },
          { threadId: "t2", requests: [
            { id: "new-2", mine: true, status: "done", createdAt: "2026-11-06T03:00:00Z", executor: { name: "李四" } },
            { id: "other", mine: true, status: "done", createdAt: "2026-11-06T04:00:00Z", executor: { name: "王雨" } },
            { id: "theirs", mine: false, status: "done", createdAt: "2026-11-06T05:00:00Z", executor: { name: "李四" } }
          ] }
        ] }));
      }
      if (path === "/api/collab/assist/requests/new-2/status") return new Response(JSON.stringify({ text: "已完成：李四的 Memmy 在李四的电脑上执行。" }));
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Route not found" } }), { status: 404 });
    }) as typeof fetch;
    const deps = { fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) };

    // 换了对话、手里没有请求 ID：取本人最近一次发给李四的请求。
    await expect(run(["assist", "status", "--project", "Memmy 内测反馈", "--member", "李四"], deps))
      .resolves.toBe("已完成：李四的 Memmy 在李四的电脑上执行。");
    expect(asked).toContain("/api/collab/assist/requests/new-2/status");
  });

  it("finds the request to a member in a project when no id is given", async () => {
    const listing = (requests: Array<Record<string, unknown>>) => (async (input: string | URL) => {
      const path = new URL(input).pathname;
      if (path === "/api/collab/projects") return new Response(JSON.stringify({ projects: [{ id: "p1", name: "Memmy 内测反馈" }] }));
      if (path === "/api/collab/projects/p1/assist/threads") {
        return new Response(JSON.stringify({ threads: [{ threadId: "t1", requests }] }));
      }
      if (path === "/api/collab/assist/requests/a7f3k111-1111/cancel") {
        return new Response(JSON.stringify({ request: { id: "a7f3k111-1111", status: "stopped", executor: { name: "李四" } } }));
      }
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Route not found" } }), { status: 404 });
    }) as typeof fetch;
    const deps = (fetcher: typeof fetch) => ({ fetch: fetcher, runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) });
    const mine = { id: "a7f3k111-1111", title: "查日志", status: "running", mine: true, executor: { name: "李四" } };

    // 恰好一条：直接停它。
    await expect(run(["assist", "cancel", "--project", "Memmy 内测反馈", "--member", "李四"], deps(listing([mine]))))
      .resolves.toContain("已停止李四那边的执行");

    // 多条时列出短 id、标题与状态，让用户指定，不猜。
    const several = await run(["assist", "cancel", "--project", "Memmy 内测反馈", "--member", "李四"], deps(listing([
      { ...mine, id: "a7f3k111-1111", title: "查日志", status: "running" },
      { ...mine, id: "b8e4m222-2222", title: "看磁盘", status: "pending" }
    ])));
    expect(several).toContain("有 2 条还没结束");
    expect(several).toContain("A7F3K1 · 查日志 · 执行中");
    expect(several).toContain("B8E4M2 · 看磁盘 · 等待对方授权");

    // 没有：说明没有，不报错。
    await expect(run(["assist", "cancel", "--project", "Memmy 内测反馈", "--member", "李四"], deps(listing([
      { ...mine, status: "done" }
    ])))).resolves.toBe("没有你发给李四、还没结束的协助请求。");
  });

  it("rejects an incomplete ask instead of guessing", async () => {
    await expect(run(["assist", "ask", "--project", "P"], { runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }) }))
      .rejects.toThrow(/--member/u);
    await expect(run(["assist", "nope"], {})).rejects.toThrow(/未知命令/u);
  });
});

/**
 * `assist ask` 的附件：请求文件里列本地路径，这里读成正文与指纹，内联随请求一起提交；
 * 只收文本与脚本，正文偏长又没带附件时提示一句。
 */
describe("memmy-project assist ask 的附件", () => {
  function workdir(): string {
    const root = mkdtempSync(join(tmpdir(), "memmy-assist-files-"));
    roots.push(root);
    return root;
  }

  function requestFile(root: string, value: unknown): string {
    const path = join(root, "request.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  function askFetcher(seen: { body?: Record<string, unknown> }) {
    return (async (_input: string | URL, init?: RequestInit) => {
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ request: { id: "abc-1" }, text: "已发送协助请求 abc-1。" }));
    }) as typeof fetch;
  }

  it("reads the listed local files into inline attachments with a sha256 and the note", async () => {
    const root = workdir();
    const script = join(root, "probe.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    const seen: { body?: Record<string, unknown> } = {};
    const output = await run(
      ["assist", "ask", "--project", "Memmy 内测反馈", "--member", "王雨", "--file", requestFile(root, { title: "原样跑一遍", items: ["跑脚本"], attachments: [{ path: script, note: "排查脚本，\n用 sh 运行" }] })],
      { fetch: askFetcher(seen), runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: {} }
    );

    expect(output).toContain("已发送协助请求 abc-1");
    const attachments = seen.body?.attachments as Array<Record<string, string>>;
    expect(attachments).toHaveLength(1);
    // 说明压成一行：它写进对方提示词里附件那一行。
    expect(attachments[0]).toMatchObject({ name: "probe.sh", content: "#!/bin/sh\necho hi\n", note: "排查脚本， 用 sh 运行" });
    expect(attachments[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
    // 有附件时不再提示「把脚本写进 attachments」。
    expect(output).not.toContain("这条请求正文较长");
  });

  it("rejects files that are neither text nor script", async () => {
    const root = workdir();
    const slides = join(root, "slides.pptx");
    writeFileSync(slides, "x");
    await expect(run(
      ["assist", "ask", "--project", "P", "--member", "王雨", "--file", requestFile(root, { title: "看材料", items: ["看一遍"], attachments: [{ path: slides, note: "复盘材料" }] })],
      { fetch: askFetcher({}), runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: {} }
    )).rejects.toThrow(/附件只收文本与脚本.*不支持 \.pptx/u);
  });

  it("says a missing attachment file is missing", async () => {
    const root = workdir();
    await expect(run(
      ["assist", "ask", "--project", "P", "--member", "王雨", "--file", requestFile(root, { title: "原样跑一遍", items: ["跑脚本"], attachments: [{ path: join(root, "nope.sh"), note: "排查脚本" }] })],
      { fetch: askFetcher({}), runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: {} }
    )).rejects.toThrow(/找不到附件文件/u);
  });

  it("refuses an attachment without a note and says how to write it", async () => {
    // 对方的 Agent 只拿到一个目录里的几个文件：不说清是什么、怎么用，它只能按文件名猜。
    const root = workdir();
    const script = join(root, "probe.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    for (const attachments of [[script], [{ path: script }], [{ path: script, note: "  " }]]) {
      await expect(run(
        ["assist", "ask", "--project", "P", "--member", "王雨", "--file", requestFile(root, { title: "原样跑一遍", items: ["跑脚本"], attachments })],
        { fetch: askFetcher({}), runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: {} }
      )).rejects.toThrow(/附件 probe\.sh 缺少 note.*"path".*"note"/u);
    }
  });

  it("hints at attachments when the body is long and none were given", async () => {
    const root = workdir();
    const seen: { body?: Record<string, unknown> } = {};
    const output = await run(
      ["assist", "ask", "--project", "P", "--member", "王雨", "--file", requestFile(root, { title: "长正文", reason: "原".repeat(1_500), items: ["第一条"] })],
      { fetch: askFetcher(seen), runtimeConfigPath: runtimeFile({ baseUrl: "http://127.0.0.1:62315", localToken: "t" }), env: {} }
    );

    expect(seen.body?.attachments).toBeUndefined();
    expect(output).toContain("这条请求正文较长");
    expect(output).toContain("对方能原样执行、也能核对");
  });
});
