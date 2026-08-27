import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";

const roots: string[] = [];

function makeLoop(): AgentLoop {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-max-rollover-"));
  roots.push(workspace);
  const loop = new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
    provider: { generation: { maxTokens: 256 }, getDefaultModel: () => "test-model" },
    workspace,
    model: "test-model",
  });
  loop.initializeRuntimeTools = vi.fn(async () => undefined);
  return loop;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop maxIterations rollover", () => {
  it("always delivers the maxIterations final even after the message tool sent", () => {
    const loop = makeLoop();
    const messageTool = loop.tools.get("message") as any;
    messageTool.sentInTurn = true;

    expect(loop.assembleOutbound(
      new InboundMessage({ channel: "test", chatId: "message-tool", content: "work" }),
      "honest final",
      [],
      "maxIterations",
      false,
    )?.content).toBe("honest final");
    expect(loop.assembleOutbound(
      new InboundMessage({ channel: "test", chatId: "message-tool", content: "work" }),
      "duplicate final",
      [],
      "completed",
      false,
    )).toBeNull();
  });

  it("runs residual steer as a successor before existing queued Turns", async () => {
    const loop = makeLoop();
    const started: Array<{ content: string; turnId: string }> = [];
    const successorSteer: string[] = [];
    let releaseMax!: () => void;
    const maxGate = new Promise<void>((resolve) => {
      releaseMax = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      started.push({ content: message.content, turnId: options.turnId });
      options.slot.acceptingSteer = true;
      if (message.content === "max root") await maxGate;
      if (message.content === "residual one") {
        while (true) {
          const pending = options.pendingQueue.getNowait();
          if (!pending) break;
          successorSteer.push(pending.content);
        }
      }
      options.slot.stopReason = message.content === "max root" ? "maxIterations" : "completed";
      return new OutboundMessage({
        channel: message.channel,
        chatId: message.chatId,
        content: `answer:${message.content}`,
        metadata: { turnId: options.turnId },
      });
    }) as any;

    const running = loop.run();
    const base = {
      channel: "test",
      chatId: "rollover",
      senderId: "user",
      sessionKeyOverride: "test:rollover",
    } as const;
    await loop.bus.publishInbound(new InboundMessage({ ...base, content: "max root" }));
    await waitUntil(() => started.length === 1);
    await loop.bus.publishInbound(new InboundMessage({ ...base, content: "ordinary queued" }));
    await loop.bus.publishInbound(new InboundMessage({
      ...base,
      content: "residual one",
      turnAdmission: "steer",
    }));
    await loop.bus.publishInbound(new InboundMessage({
      ...base,
      content: "residual two",
      turnAdmission: "steer",
    }));
    await waitUntil(() => {
      const slot = (loop.turnSlots.get("test:rollover") as any[])?.[0];
      return slot?.pendingSteer.size === 2;
    });

    releaseMax();
    await waitUntil(() => started.length === 3);
    await waitUntil(() => !loop.isSessionBusy("test:rollover"));
    expect(started.map((item) => item.content)).toEqual([
      "max root",
      "residual one",
      "ordinary queued",
    ]);
    expect(new Set(started.map((item) => item.turnId)).size).toBe(3);
    expect(successorSteer).toEqual(["residual two"]);
    const successorRoot = (loop.processMessageInternal as any).mock.calls[1][0] as InboundMessage;
    expect(successorRoot.turnAdmission).toBe("queue");

    loop.stop();
    await running;
  });

  it("does not create a successor for residual steer after a non-max result", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options: any) => {
      started.push(message.content);
      options.slot.acceptingSteer = true;
      if (message.content === "normal") await gate;
      options.slot.stopReason = "completed";
      return null;
    }) as any;

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "test",
      chatId: "normal",
      senderId: "user",
      content: "normal",
    }));
    await waitUntil(() => started.length === 1);
    await loop.bus.publishInbound(new InboundMessage({
      channel: "test",
      chatId: "normal",
      senderId: "user",
      content: "late steer",
      turnAdmission: "steer",
    }));
    await waitUntil(() => ((loop.turnSlots.get("test:normal") as any[])?.[0]?.pendingSteer.size ?? 0) === 1);
    release();
    await waitUntil(() => started.length === 2);
    await waitUntil(() => !loop.isSessionBusy("test:normal"));
    expect(started).toEqual(["normal", "late steer"]);
    loop.stop();
    await running;
  });
});
