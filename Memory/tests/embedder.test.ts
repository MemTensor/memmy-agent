import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../src/config/index.js";
import { createEmbedder } from "../src/model/embedder.js";

const transformerMocks = vi.hoisted(() => ({
  extractor: vi.fn(),
  pipeline: vi.fn()
}));

vi.mock("@huggingface/transformers", () => ({
  pipeline: transformerMocks.pipeline
}));

afterEach(() => {
  transformerMocks.extractor.mockReset();
  transformerMocks.pipeline.mockReset();
  vi.unstubAllGlobals();
});

describe("embedder", () => {
  it("does not configure a default embedding dimension", () => {
    expect("dimensions" in DEFAULT_MEMMY_CONFIG.embedding).toBe(false);
  });

  it("preserves the provider embedding values and dimension by default", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        data: [
          { embedding: [3, 4, 0, 8, 15] }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ));

    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "embedding-model",
      apiKey: "sk-test",
      cache: false,
      maxRetries: 0
    });

    expect(embedder.config.normalize).toBe(false);
    await expect(embedder.embedOne("remember this")).resolves.toEqual([3, 4, 0, 8, 15]);
  });

  it("does not ask the local extractor to normalize by default", async () => {
    transformerMocks.extractor.mockResolvedValue({ data: [3, 4] });
    transformerMocks.pipeline.mockResolvedValue(transformerMocks.extractor);
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      cache: false
    });

    await expect(embedder.embedOne("local memory")).resolves.toEqual([3, 4]);
    expect(transformerMocks.extractor).toHaveBeenCalledWith("local memory", {
      pooling: "mean",
      normalize: false
    });
  });
});
