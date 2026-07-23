import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { Config } from "../../src/config/schema.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-memory-loop-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop memmy memory integration", () => {
  it("installs memmy memory hook and tools when enabled", async () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: false },
        memmyMemory: { enabled: true },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeDefined();
    expect(loop.tools.get("memmy_memory_get")).toBeDefined();
    expect(loop.dream).toBeNull();
    expect(loop.context.buildSystemPrompt()).not.toContain("# File Memory");
  });

  it("installs memmy memory hook and tools by default", () => {
    const loop = new AgentLoop({
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeDefined();
    expect(loop.tools.get("memmy_memory_get")).toBeDefined();
  });

  it("keeps memmy memory disabled when explicitly disabled", () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: true },
        memmyMemory: { enabled: false },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeUndefined();
    expect(loop.dream).not.toBeNull();
    expect(loop.context.buildSystemPrompt()).toContain("# File Memory");
  });

  it("keeps both memory systems independently disabled", () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: false },
        memmyMemory: { enabled: false },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeUndefined();
    expect(loop.dream).toBeNull();
    expect(loop.context.buildSystemPrompt()).not.toContain("# File Memory");
  });

  it("keeps both memory systems active when both are enabled", () => {
    const loop = new AgentLoop({
      config: new Config({
        fileMemory: { enabled: true },
        memmyMemory: { enabled: true },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: tempRoot(),
      model: "test-model",
    });

    expect(loop.tools.get("memmy_memory_search")).toBeDefined();
    expect(loop.dream).not.toBeNull();
    expect(loop.context.buildSystemPrompt()).toContain("# File Memory");
  });
});
