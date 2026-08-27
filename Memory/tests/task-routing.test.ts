import { describe, expect, it } from "vitest";
import { MemoryModelTaskRouter, type MemoryModelTaskContext } from "../src/model/task-routing.js";
import type { Embedder, LlmClient, LlmCompletionOptions, LlmMessage } from "../src/model/types.js";

function client(name: string): LlmClient {
  return {
    config: {
      provider: "openai_compatible",
      endpoint: "https://example.test/v1",
      model: name,
      apiKey: "test-key",
      sourceProvider: name,
      enableThinking: false,
      temperature: 0.7,
      timeoutMs: 1_000,
      maxRetries: 0,
      malformedRetries: 0
    },
    isConfigured: () => true,
    complete: async (_messages: LlmMessage[], _options: LlmCompletionOptions) => name,
    completeJson: async <T extends Record<string, unknown>>() => ({ name }) as unknown as T,
    status: () => ({
      provider: "openai_compatible",
      model: name,
      configured: true,
      remote: true,
      routing: null
    })
  };
}

function context(name: string): MemoryModelTaskContext {
  return {
    config: { marker: name } as unknown as MemoryModelTaskContext["config"],
    summary: client(`${name}-summary`),
    evolution: client(`${name}-evolution`),
    embedding: embedder(`${name}-embedding`)
  };
}

function embedder(name: string): Embedder {
  return {
    config: {
      provider: "openai_compatible",
      mode: "custom",
      endpoint: "https://example.test/v1",
      model: name,
      apiKey: "test-key",
      batchSize: 10,
      timeoutMs: 1_000,
      maxRetries: 0,
      cache: false,
      normalize: false
    },
    isRemote: () => true,
    embed: async () => [[name.length]],
    embedOne: async () => [name.length],
    status: () => ({
      provider: "openai_compatible",
      model: name,
      configured: true,
      remote: true
    })
  };
}

describe("MemoryModelTaskRouter", () => {
  it("keeps one immutable model snapshot across all LLM calls in a task", async () => {
    let resolutions = 0;
    const router = new MemoryModelTaskRouter(() => context(`task-${++resolutions}`));
    const summary = router.client("summary");
    const evolution = router.client("evolution");
    const embedding = router.embedder();

    const result = await router.run(async () => {
      const first = await summary.complete([], { operation: "test.summary" });
      await Promise.resolve();
      const second = await evolution.complete([], { operation: "test.evolution" });
      const third = embedding.config.model;
      return [first, second, third];
    });

    expect(result).toEqual(["task-1-summary", "task-1-evolution", "task-1-embedding"]);
    expect(resolutions).toBe(1);
  });

  it("isolates concurrent tasks even when their asynchronous work interleaves", async () => {
    let resolutions = 0;
    const router = new MemoryModelTaskRouter(() => context(`task-${++resolutions}`));
    const summary = router.client("summary");
    const evolution = router.client("evolution");
    const embedding = router.embedder();
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = router.run(async () => {
      const before = await summary.complete([], { operation: "test.summary.first" });
      await firstPaused;
      const after = await evolution.complete([], { operation: "test.evolution.first" });
      return [before, after, embedding.config.model];
    });
    const second = router.run(async () => {
      const before = await summary.complete([], { operation: "test.summary.second" });
      const after = await evolution.complete([], { operation: "test.evolution.second" });
      releaseFirst();
      return [before, after, embedding.config.model];
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      ["task-1-summary", "task-1-evolution", "task-1-embedding"],
      ["task-2-summary", "task-2-evolution", "task-2-embedding"]
    ]);
    expect(resolutions).toBe(2);
  });
});
