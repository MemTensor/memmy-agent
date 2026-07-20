import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { Config } from "../../../src/config/schema.js";

const roots: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-usage-"));
  roots.push(dir);
  return dir;
}

function loop(): AgentLoop {
  const root = workspace();
  return new AgentLoop({
    provider: { generation: { maxTokens: 100 }, chat: vi.fn(), getDefaultModel: () => "test-model" },
    workspace: root,
    model: "test-model",
    contextWindowTokens: 4096,
    sessionDir: path.join(root, "sessions"),
    config: new Config({ memmyMemory: { enabled: false } }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentLoop turn usage propagation", () => {
  it("attaches the turn's accumulated token usage to the OutboundMessage metadata", async () => {
    const agent = loop();
    agent.runner.run = vi.fn(async () =>
      new AgentRunResult({
        finalContent: "done",
        messages: [{ role: "assistant", content: "done" }],
        stopReason: "completed",
        // Simulates a turn that ran two tool-call iterations before finishing:
        // AgentRunner.run() sums per-iteration usage before returning here.
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
      }),
    );

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:usage" });

    expect(outbound?.metadata.usage).toEqual({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 });
    expect(agent.lastUsage).toEqual({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 });
  });

  it("falls back to zeroed usage fields when the run reports none", async () => {
    const agent = loop();
    agent.runner.run = vi.fn(async () =>
      new AgentRunResult({
        finalContent: "done",
        messages: [{ role: "assistant", content: "done" }],
        stopReason: "completed",
      }),
    );

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:usage2" });

    expect(outbound?.metadata.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("keeps distinct sessions' usage isolated across sequential turns", async () => {
    const agent = loop();
    const usages = [
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
    ];
    let call = 0;
    agent.runner.run = vi.fn(async () =>
      new AgentRunResult({
        finalContent: "done",
        messages: [{ role: "assistant", content: "done" }],
        stopReason: "completed",
        usage: usages[call++],
      }),
    );

    const first = await agent.processDirect("first", { sessionKey: "cli:a" });
    const second = await agent.processDirect("second", { sessionKey: "cli:b" });

    expect(first?.metadata.usage).toEqual(usages[0]);
    expect(second?.metadata.usage).toEqual(usages[1]);
  });
});
