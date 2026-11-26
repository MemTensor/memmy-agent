import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAntigravityInsightSampler,
  createBuiltinOnboardingInsightSamplers,
  createCodexInsightSampler,
  createSourceRegistryOnboardingConversationWindowReader,
  createWorkbuddyInsightSampler
} from "../onboarding-insight-samplers.js";
import { createSourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("onboarding insight samplers", () => {
  it("keeps the built-in agent sources in order for the first-login scan", () => {
    expect(createBuiltinOnboardingInsightSamplers().map((sampler) => sampler.sourceId)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "antigravity",
      "opencode",
      "openclaw",
      "hermes",
      "deepseek_harness",
      "workbuddy",
      "pi",
      "qwenwork"
    ]);
  });

  describe("Antigravity", () => {
    const first = "9c700000-3a17-406b-b3f3-eecb4434ae95";
    const second = "b83c0000-842d-44bc-b296-96ddd9958777";
    const options = { maxSessionFiles: 2, maxQueries: 10, maxQueryChars: 200, maxBytesPerFile: 64_000, deadlineMs: 5_000 };

    function fixture() {
      const home = mkdtempSync(join(tmpdir(), "memmy-antigravity-onboarding-"));
      roots.push(home);
      const root = join(home, ".gemini", "antigravity", "brain");
      return {
        root,
        sampler: createAntigravityInsightSampler({ root }),
        write(conversationId: string, filename: string, prompt: string, modifiedAt: string) {
          const logs = join(root, conversationId, ".system_generated", "logs");
          mkdirSync(logs, { recursive: true });
          const path = join(logs, filename);
          writeFileSync(path, JSON.stringify({
            step_index: 5, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: modifiedAt,
            content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>settings</ADDITIONAL_METADATA>`
          }) + "\n");
          utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
          return path;
        }
      };
    }

    it.each(["transcript_full.jsonl", "transcript.jsonl"])("samples and redacts a session containing only %s", async (name) => {
      const { sampler, write } = fixture();
      const time = "2026-11-25T11:06:20.000Z";
      write(first, name, "Check password=fixture-secret", time);
      const sample = await sampler.sampleRecentUserQueries(options);

      expect(sample.errors).toEqual([]);
      expect(sample.recentSessionCount).toBe(1);
      expect(sample.queries).toEqual([expect.objectContaining({
        conversationId: first, messageId: `antigravity:${first}:5:${time}`, text: "Check password=[REDACTED:password]"
      })]);
      expect(sample.recentMessages?.map(message => message.text)).toEqual(["Check password=[REDACTED:password]"]);
    });

    it("selects one full transcript per session before ordering and limiting the recent files", async () => {
      const { sampler, write } = fixture();
      write(first, "transcript_full.jsonl", "First full prompt", "2026-11-25T11:06:10.000Z");
      write(first, "transcript.jsonl", "First abbreviated prompt", "2026-11-25T11:06:40.000Z");
      write(second, "transcript.jsonl", "Second abbreviated prompt", "2026-11-25T11:06:20.000Z");
      const latest = "2026-11-25T11:06:30.000Z";
      write(second, "transcript_full.jsonl", "Second full prompt", latest);

      const both = await sampler.sampleRecentUserQueries(options);
      expect(both.recentSessionCount).toBe(2);
      expect(both.latestActivityAt).toBe(latest);
      expect(both.queries.map(query => query.text)).toEqual(["Second full prompt", "First full prompt"]);
      expect(both.recentMessages?.map(message => message.text)).toEqual(["Second full prompt", "First full prompt"]);

      const newest = await sampler.sampleRecentUserQueries({ ...options, maxSessionFiles: 1 });
      expect(newest.recentSessionCount).toBe(1);
      expect(newest.queries.map(query => query.conversationId)).toEqual([second]);
    });

    it("honors the byte budget when the short view fits but the full prompt exceeds it", async () => {
      const { sampler, write } = fixture();
      const time = "2026-11-25T11:06:20.000Z";
      write(first, "transcript.jsonl", "Abbreviated prompt", time);
      write(first, "transcript_full.jsonl", "A long explicit request. ".repeat(100), time);

      const sample = await sampler.sampleRecentUserQueries({ ...options, maxBytesPerFile: 512 });
      expect(sample.recentSessionCount).toBe(1);
      expect(sample.queries).toEqual([]);
      expect(sample.recentMessages).toEqual([]);
    });

    it.each([".system_generated", "logs"])("skips a linked %s directory", async (directory) => {
      const { root, sampler } = fixture();
      const other = fixture();
      other.write(first, "transcript_full.jsonl", "Other session", "2026-11-25T11:06:20.000Z");
      const relative = directory === "logs" ? join(first, ".system_generated", "logs") : join(first, directory);
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      symlinkSync(join(other.root, relative), join(root, relative), process.platform === "win32" ? "junction" : "dir");

      const sample = await sampler.sampleRecentUserQueries(options);
      expect(sample.recentSessionCount).toBe(0);
      expect(sample.queries).toEqual([]);
    });

    it("falls back to the local short transcript when the full transcript is a link", async () => {
      const { sampler, write } = fixture();
      const time = "2026-11-25T11:06:20.000Z";
      const short = write(first, "transcript.jsonl", "Local short prompt", time);
      const other = fixture().write(second, "transcript_full.jsonl", "Other full prompt", time);
      symlinkSync(other, join(dirname(short), "transcript_full.jsonl"), "file");

      const sample = await sampler.sampleRecentUserQueries(options);
      expect(sample.queries.map(query => query.text)).toEqual(["Local short prompt"]);
    });

    it("skips discovery after cancellation or an exhausted deadline", async () => {
      const { sampler, write } = fixture();
      write(first, "transcript_full.jsonl", "Local prompt", "2026-11-25T11:06:20.000Z");
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      for (const limits of [{ signal: AbortSignal.abort() }, { deadlineMs: 0 }]) {
        const sample = await sampler.sampleRecentUserQueries({ ...options, ...limits });
        expect(sample.recentSessionCount).toBe(0);
        expect(sample.queries).toEqual([]);
      }
    });
  });

  it("skips Codex tool records before JSON.parse during first-login sampling", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-codex-onboarding-sampler-"));
    roots.push(root);
    const filePath = join(root, "rollout-2026-06-29T10-00-00-00000000-0000-4000-8000-000000000001.jsonl");
    const toolLine = JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-29T10:00:01.000Z",
      payload: {
        type: "custom_tool_call",
        name: "deep_tool",
        input: {
          sentinel: "deep-tool-sentinel"
        }
      }
    });
    const userLine = JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-29T10:00:02.000Z",
      cwd: "/tmp/project",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "首次登陆扫描要跳过 Codex tool 原始记录。" }]
      }
    });
    writeFileSync(filePath, `${toolLine}\n${userLine}\n`, "utf8");

    const parseJson = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation(((input: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (input.includes("deep-tool-sentinel")) {
        throw new RangeError("Maximum call stack size exceeded");
      }
      return parseJson(input, reviver);
    }) as typeof JSON.parse);

    const result = await createCodexInsightSampler({ root }).sampleRecentUserQueries({
      maxSessionFiles: 10,
      maxQueries: 10,
      maxQueryChars: 500,
      maxBytesPerFile: 64 * 1024,
      deadlineMs: 5_000
    });

    expect(result.errors).toEqual([]);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toMatchObject({
      sourceId: "codex",
      text: "首次登陆扫描要跳过 Codex tool 原始记录。",
      workspacePath: "/tmp/project"
    });
    expect(result.recentMessages?.map((message) => message.role)).toEqual(["user"]);
  });

  it("samples only recent WorkBuddy user messages across current and migrated history shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-workbuddy-onboarding-sampler-"));
    roots.push(root);
    const currentFile = join(root, "current.jsonl");
    const migratedFile = join(root, "migrated.jsonl");
    writeFileSync(currentFile, [
      JSON.stringify({ type: "function_call_result", role: "tool", output: { text: "large tool output" } }),
      JSON.stringify({ type: "message", role: "user", id: "current-user", sessionId: "current-session", timestamp: 1_784_170_100_000, cwd: "/current", content: [{ type: "input_text", text: "Current WorkBuddy question" }] }),
      JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] })
    ].join("\n"), "utf8");
    writeFileSync(migratedFile, JSON.stringify({
      role: "human",
      uuid: "migrated-user",
      conversationId: "migrated-session",
      createdAt: "2026-07-15T10:00:00.000Z",
      message: JSON.stringify({ content: [{ type: "text", text: "Migrated WorkBuddy question" }] })
    }), "utf8");

    const result = await createWorkbuddyInsightSampler({ root }).sampleRecentUserQueries({
      maxSessionFiles: 10,
      maxQueries: 10,
      maxQueryChars: 500,
      maxBytesPerFile: 64 * 1024,
      deadlineMs: 5_000
    });

    expect(result.sourceId).toBe("workbuddy");
    expect(result.queries.map((query) => query.text).sort()).toEqual([
      "Current WorkBuddy question",
      "Migrated WorkBuddy question"
    ]);
    expect(result.recentMessages?.some((message) => message.role === "assistant")).toBe(true);
  });

  it("reads the first two and last twelve turns from the newest conversation and compacts tools", async () => {
    const baseTime = Date.parse("2026-07-20T10:00:00.000Z");
    const messages = Array.from({ length: 15 }, (_, index) => {
      const conversationId = "latest-conversation";
      return [
        conversationMessage(index * 3, `user-${index}`, "user", `user ${index}`, conversationId),
        conversationMessage(index * 3 + 1, `tool-${index}`, "tool", `Tool: shell\n${"x".repeat(700)}\nStatus: success`, conversationId),
        conversationMessage(index * 3 + 2, `assistant-${index}`, "assistant", `assistant ${index}`, conversationId)
      ];
    }).flat().map((message, index) => ({
      ...message,
      createdAt: new Date(baseTime + index * 1000).toISOString()
    }));
    const scanStarted = vi.fn();
    const sourceRegistry = createSourceRegistry([{
      descriptor: {
        sourceId: "codex",
        displayName: "Codex",
        builtin: true,
        dataPath: "/tmp/codex"
      },
      async detect() {
        return true;
      },
      async *scan(options) {
        scanStarted(options);
        yield* messages;
      }
    }]);
    const reader = createSourceRegistryOnboardingConversationWindowReader(sourceRegistry);

    const window = await reader.readConversation({
      sourceId: "codex",
      displayName: "Codex",
      conversationId: "latest-conversation",
      latestActivityAt: messages.at(-1)?.createdAt ?? new Date(baseTime).toISOString(),
      workspacePath: "/tmp/project"
    }, {
      maxQueryChars: 600,
      deadlineMs: 5_000
    });

    const userIds = window?.messages.filter((message) => message.role === "user").map((message) => message.messageId);
    expect(scanStarted).toHaveBeenCalledWith(expect.objectContaining({
      fullHistory: true,
      order: "recent_first",
      maxScanTargets: 6
    }));
    expect(userIds).toEqual(["user-0", "user-1", ...Array.from({ length: 12 }, (_, index) => `user-${index + 3}`)]);
    expect(window?.messages.filter((message) => message.role === "assistant")).toHaveLength(14);
    expect(window?.messages.filter((message) => message.role === "tool")).toHaveLength(14);
    expect(window?.messages.find((message) => message.role === "tool")?.text.length).toBeLessThanOrEqual(405);
    expect(window?.messages.find((message) => message.role === "tool")?.text).toContain("Status: success");
  });

  it("does not start a conversation scan after its signal has expired", async () => {
    const scanStarted = vi.fn();
    const sourceRegistry = createSourceRegistry([{
      descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: "/tmp/codex" },
      async detect() {
        return true;
      },
      async *scan() {
        scanStarted();
        yield conversationMessage(0, "user-0", "user", "latest question", "latest-conversation");
      }
    }]);
    const controller = new AbortController();
    controller.abort();
    const reader = createSourceRegistryOnboardingConversationWindowReader(sourceRegistry);

    await expect(reader.readConversation({
      sourceId: "codex",
      displayName: "Codex",
      conversationId: "latest-conversation",
      latestActivityAt: "2026-07-20T10:00:00.000Z",
      workspacePath: "/tmp/project"
    }, { maxQueryChars: 600, deadlineMs: 5_000, signal: controller.signal })).resolves.toBeNull();
    expect(scanStarted).not.toHaveBeenCalled();
  });

  it.each(["latest-conversation", "unrelated-conversation"])(
    "closes a microtask-only scan at the wall-clock deadline while reading %s",
    async (conversationId) => {
      let wallClock = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => wallClock);
      let yieldedMessages = 0;
      let iteratorClosed = false;
      let scanSignal: AbortSignal | undefined;
      const sourceRegistry = createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: "/tmp/codex" },
        async detect() {
          return true;
        },
        async *scan(options) {
          scanSignal = options.signal;
          try {
            for (let index = 0; index < 10_000; index += 1) {
              wallClock += 1_250;
              yieldedMessages += 1;
              yield conversationMessage(index, `user-${index}`, "user", `question ${index}`, conversationId);
            }
          } finally {
            iteratorClosed = true;
          }
        }
      }]);
      const reader = createSourceRegistryOnboardingConversationWindowReader(sourceRegistry);

      const window = await reader.readConversation({
        sourceId: "codex",
        displayName: "Codex",
        conversationId: "latest-conversation",
        latestActivityAt: "2026-07-20T10:00:00.000Z",
        workspacePath: "/tmp/project"
      }, { maxQueryChars: 600, deadlineMs: 5_000 });

      expect(yieldedMessages).toBe(4);
      expect(iteratorClosed).toBe(true);
      expect(scanSignal?.aborted).toBe(false);
      // An incomplete prefix must not replace the shallow sample's latest turns.
      expect(window).toBeNull();
    }
  );
});

function conversationMessage(
  offset: number,
  messageId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  conversationId: string
) {
  return {
    sourceId: "codex",
    conversationId,
    messageId,
    role,
    content,
    createdAt: new Date(Date.parse("2026-07-20T10:00:00.000Z") + offset * 1000).toISOString(),
    workspacePath: "/tmp/project",
    gitRoot: "/tmp/project",
    rawMeta: Object.freeze({})
  };
}
