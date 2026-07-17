import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
import { Session } from "../../../src/core/session/manager.js";
import { websocketTurnWallStartedAt } from "../../../src/core/session/webui-turns.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-stop-context-"));
  roots.push(root);
  return root;
}

function sessionWithCheckpoint(): Session {
  return new Session({
    key: "test:c1",
    messages: [{ role: "user", content: "Search for something" }],
    metadata: {
      runtimeCheckpoint: {
        phase: "awaitingTools",
        iteration: 0,
        assistantMessage: {
          role: "assistant",
          content: "Let me search.",
          tool_calls: [
            {
              id: "tc_1",
              type: "function",
              function: { name: "web_search", arguments: "{}" },
            },
          ],
        },
        completedToolResults: [{ role: "tool", tool_call_id: "tc_1", content: "Search hit." }],
        pendingToolCalls: [],
      },
    },
  });
}

function sessionWithInterruptedCheckpoint(): Session {
  return new Session({
    key: "websocket:c1",
    messages: [{ role: "user", content: "Search for something" }],
    metadata: {
      runtimeCheckpoint: {
        phase: "awaitingTools",
        iteration: 0,
        assistantMessage: {
          role: "assistant",
          content: "Let me search.",
          tool_calls: [
            {
              id: "tc_1",
              type: "function",
              function: { name: "web_search", arguments: "{}" },
            },
            {
              id: "tc_2",
              type: "function",
              function: { name: "web_fetch", arguments: "{}" },
            },
          ],
        },
        completedToolResults: [{ role: "tool", tool_call_id: "tc_1", name: "web_search", content: "Search hit." }],
        pendingToolCalls: [
          {
            id: "tc_2",
            type: "function",
            function: { name: "web_fetch", arguments: "{}" },
          },
        ],
      },
      pendingUserTurn: true,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("stop preserves context", () => {
  it("exposes the runtime checkpoint restore method and key", () => {
    const loop = new AgentLoop({
      workspace: tempRoot(),
      provider: {
        getDefaultModel: () => "test-model",
        generation: { maxTokens: 4096, temperature: 0.1, reasoningEffort: null },
        estimatePromptTokens: () => [10_000, "test"],
      } as any,
    });

    expect(typeof loop.restoreRuntimeCheckpoint).toBe("function");
    expect(AgentLoop.RUNTIME_CHECKPOINT_KEY).toBe("runtimeCheckpoint");
  });

  it("restores assistant and tool messages from a runtime checkpoint", () => {
    const loop = new AgentLoop({
      workspace: tempRoot(),
      provider: {
        getDefaultModel: () => "test-model",
        generation: { maxTokens: 4096, temperature: 0.1, reasoningEffort: null },
        estimatePromptTokens: () => [10_000, "test"],
      } as any,
    });
    const session = sessionWithCheckpoint();

    expect(loop.restoreRuntimeCheckpoint(session)).toBe(true);
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(session.metadata.runtimeCheckpoint).toBeUndefined();
  });

  it("restores and saves checkpoints when dispatch unwinds with an error", async () => {
    const session = sessionWithCheckpoint();
    let saved = false;
    const loop = new AgentLoop({
      workspace: tempRoot(),
      bus: new MessageBus(),
      provider: {
        getDefaultModel: () => "test-model",
        generation: { maxTokens: 4096, temperature: 0.1, reasoningEffort: null },
        estimatePromptTokens: () => [10_000, "test"],
      } as any,
      sessionManager: {
        getOrCreate: () => session,
        save: () => {
          saved = true;
        },
      } as any,
    });
    (loop as any).processMessageInternal = async () => {
      throw new Error("cancelled");
    };

    await expect(
      loop.dispatchMessage(new InboundMessage({ channel: "test", senderId: "u1", chatId: "c1", content: "work", sessionKey: "test:c1" })),
    ).rejects.toThrow("cancelled");

    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(session.metadata.runtimeCheckpoint).toBeUndefined();
    expect(saved).toBe(true);
  });

  it("restores checkpoint and publishes websocket terminal events when dispatch is cancelled", async () => {
    const session = sessionWithInterruptedCheckpoint();
    let saved = false;
    const bus = new MessageBus();
    const loop = new AgentLoop({
      workspace: tempRoot(),
      bus,
      provider: {
        getDefaultModel: () => "test-model",
        generation: { maxTokens: 4096, temperature: 0.1, reasoningEffort: null },
        estimatePromptTokens: () => [10_000, "test"],
      } as any,
      sessionManager: {
        getOrCreate: () => session,
        save: () => {
          saved = true;
        },
      } as any,
    });
    (loop as any).processMessageInternal = async () => {
      const error = new Error("task cancelled");
      error.name = "TaskCancelledError";
      throw error;
    };

    await loop.dispatchMessage(new InboundMessage({
      channel: "websocket",
      senderId: "u1",
      chatId: "c1",
      content: "work",
      metadata: { webui: true },
      sessionKey: "websocket:c1",
    }));

    const running = await bus.consumeOutbound();
    const turnEnd = await bus.consumeOutbound();
    const idle = await bus.consumeOutbound();
    expect(running.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "running" });
    expect(turnEnd.metadata).toMatchObject({ turnEnd: true });
    expect(idle.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "idle" });
    expect(websocketTurnWallStartedAt("c1")).toBeNull();
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(session.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "tc_2",
      name: "web_fetch",
      content: "Error: Task interrupted before this tool finished.",
    });
    expect(session.metadata.runtimeCheckpoint).toBeUndefined();
    expect(session.metadata.pendingUserTurn).toBeUndefined();
    expect(saved).toBe(true);
  });

  it("retains legal recent suffixes beginning at a user turn", () => {
    const session = new Session({
      key: "s",
      messages: [
        { role: "assistant", content: "orphan" },
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
    });

    session.retainRecentLegalSuffix(2);

    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
