import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CronService } from "../../../src/cron/service.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
import { CronTool } from "../../../src/core/agent-runtime/tools/cron.js";
import { MessageTool } from "../../../src/core/agent-runtime/tools/message.js";
import { SpawnTool } from "../../../src/core/agent-runtime/tools/spawn.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-tool-contextvars-"));
  roots.push(root);
  return root;
}

function deferred(): [Promise<void>, () => void] {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return [promise, resolve];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("tool task-local request context", () => {
  it("keeps MessageTool context local to each async task", async () => {
    const seen: Array<[string, string, string]> = [];
    const [entered, markEntered] = deferred();
    const [release, markRelease] = deferred();
    const tool = new MessageTool({
      sendCallback: async (msg) => {
        seen.push([msg.channel, msg.chatId, msg.content]);
      },
    });

    async function taskOne(): Promise<string> {
      tool.setContext(new RequestContext({ channel: "feishu", chatId: "chat-a" }));
      markEntered();
      await release;
      return tool.execute({ content: "one" });
    }

    async function taskTwo(): Promise<string> {
      await entered;
      tool.setContext(new RequestContext({ channel: "email", chatId: "chat-b" }));
      markRelease();
      return tool.execute({ content: "two" });
    }

    const [resultOne, resultTwo] = await Promise.all([taskOne(), taskTwo()]);

    expect(resultOne).toBe("Message sent to feishu:chat-a");
    expect(resultTwo).toBe("Message sent to email:chat-b");
    expect(seen).toContainEqual(["feishu", "chat-a", "one"]);
    expect(seen).toContainEqual(["email", "chat-b", "two"]);
  });

  it("keeps SpawnTool context local to each async task", async () => {
    const seen: Array<[string, string, string]> = [];
    const [entered, markEntered] = deferred();
    const [release, markRelease] = deferred();
    const manager = {
      maxConcurrentSubagents: 1,
      getRunningCount: () => 0,
      spawn: async ({ task, originChannel, originChatId, sessionKey }: any) => {
        seen.push([originChannel, originChatId, sessionKey]);
        return `${originChannel}:${originChatId}:${task}`;
      },
    };
    const tool = new SpawnTool(manager);

    async function taskOne(): Promise<string> {
      tool.setContext(new RequestContext({ channel: "whatsapp", chatId: "chat-a" }));
      markEntered();
      await release;
      return tool.execute({ task: "one" });
    }

    async function taskTwo(): Promise<string> {
      await entered;
      tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-b" }));
      markRelease();
      return tool.execute({ task: "two" });
    }

    const [resultOne, resultTwo] = await Promise.all([taskOne(), taskTwo()]);

    expect(resultOne).toBe("whatsapp:chat-a:one");
    expect(resultTwo).toBe("telegram:chat-b:two");
    expect(seen).toContainEqual(["whatsapp", "chat-a", "whatsapp:chat-a"]);
    expect(seen).toContainEqual(["telegram", "chat-b", "telegram:chat-b"]);
  });

  it("keeps CronTool context local to each async task", async () => {
    const tool = new CronTool(new CronService(path.join(tmpRoot(), "jobs.json")));
    const [entered, markEntered] = deferred();
    const [release, markRelease] = deferred();

    async function taskOne(): Promise<string> {
      tool.setContext(new RequestContext({ channel: "feishu", chatId: "chat-a" }));
      markEntered();
      await release;
      return tool.execute({ action: "add", message: "first", every_seconds: 60 });
    }

    async function taskTwo(): Promise<string> {
      await entered;
      tool.setContext(new RequestContext({ channel: "email", chatId: "chat-b" }));
      markRelease();
      return tool.execute({ action: "add", message: "second", every_seconds: 60 });
    }

    const [resultOne, resultTwo] = await Promise.all([taskOne(), taskTwo()]);

    expect(resultOne).toMatch(/^Created job/);
    expect(resultTwo).toMatch(/^Created job/);
    const jobs = tool.cron.listJobs();
    expect(new Set(jobs.map((job) => job.payload.channel))).toEqual(new Set(["feishu", "email"]));
    expect(new Set(jobs.map((job) => job.payload.to))).toEqual(new Set(["chat-a", "chat-b"]));
  });
});

describe("tool request context single-task regressions", () => {
  it("routes MessageTool after setContext", async () => {
    const seen: Array<[string, string, string]> = [];
    const tool = new MessageTool({
      sendCallback: async (msg) => {
        seen.push([msg.channel, msg.chatId, msg.content]);
      },
    });
    tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-123", messageId: "msg-456" }));

    const result = await tool.execute({ content: "hello" });

    expect(result).toBe("Message sent to telegram:chat-123");
    expect(seen).toEqual([["telegram", "chat-123", "hello"]]);
  });

  it("uses MessageTool constructor defaults without setContext", async () => {
    const seen: Array<[string, string, string]> = [];
    const tool = new MessageTool({
      sendCallback: async (msg) => {
        seen.push([msg.channel, msg.chatId, msg.content]);
      },
      defaultChannel: "discord",
      defaultChatId: "general",
    });

    const result = await tool.execute({ content: "hi" });

    expect(result).toBe("Message sent to discord:general");
    expect(seen).toEqual([["discord", "general", "hi"]]);
  });

  it("passes SpawnTool origin after setContext", async () => {
    const seen: Array<[string, string, string]> = [];
    const manager = {
      maxConcurrentSubagents: 1,
      getRunningCount: () => 0,
      spawn: async ({ task, originChannel, originChatId, sessionKey }: any) => {
        seen.push([originChannel, originChatId, sessionKey]);
        return `ok: ${task}`;
      },
    };
    const tool = new SpawnTool(manager);
    tool.setContext(new RequestContext({ channel: "feishu", chatId: "chat-abc" }));

    const result = await tool.execute({ task: "do something" });

    expect(result).toBe("ok: do something");
    expect(seen).toEqual([["feishu", "chat-abc", "feishu:chat-abc"]]);
  });

  it("uses SpawnTool CLI defaults without setContext", async () => {
    const seen: Array<[string, string, string]> = [];
    const manager = {
      maxConcurrentSubagents: 1,
      getRunningCount: () => 0,
      spawn: async ({ originChannel, originChatId, sessionKey }: any) => {
        seen.push([originChannel, originChatId, sessionKey]);
        return "ok";
      },
    };
    const tool = new SpawnTool(manager);

    await tool.execute({ task: "test" });

    expect(seen).toEqual([["cli", "direct", "cli:direct"]]);
  });

  it("uses CronTool context when adding jobs", async () => {
    const tool = new CronTool(new CronService(path.join(tmpRoot(), "jobs.json")));
    tool.setContext(new RequestContext({ channel: "wechat", chatId: "user-789" }));

    const result = await tool.execute({ action: "add", message: "standup", every_seconds: 300 });

    expect(result).toMatch(/^Created job/);
    const jobs = tool.cron.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.channel).toBe("wechat");
    expect(jobs[0].payload.to).toBe("user-789");
  });

  it("returns a clear error when CronTool has no session context", async () => {
    const tool = new CronTool(new CronService(path.join(tmpRoot(), "jobs.json")));

    const result = await tool.execute({ action: "add", message: "test", every_seconds: 60 });

    expect(result).toBe("Error: no session context (channel/chatId)");
  });
});
