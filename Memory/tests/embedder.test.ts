import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../src/config/index.js";
import { createEmbedder } from "../src/model/embedder.js";

const transformerMocks = vi.hoisted(() => ({
  env: {
    allowLocalModels: undefined as boolean | undefined,
    allowRemoteModels: undefined as boolean | undefined,
    cacheDir: "module-default-cache" as string | null,
    localModelPath: undefined as string | undefined
  },
  extractor: vi.fn(),
  pipeline: vi.fn()
}));

vi.mock("@huggingface/transformers", () => ({
  env: transformerMocks.env,
  pipeline: transformerMocks.pipeline
}));

afterEach(() => {
  transformerMocks.env.allowLocalModels = undefined;
  transformerMocks.env.allowRemoteModels = undefined;
  transformerMocks.env.cacheDir = "module-default-cache";
  transformerMocks.env.localModelPath = undefined;
  transformerMocks.extractor.mockReset();
  transformerMocks.pipeline.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("embedder", () => {
  it("does not configure a default embedding dimension", () => {
    expect("dimensions" in DEFAULT_MEMMY_CONFIG.embedding).toBe(false);
  });

  it("preserves the provider embedding values and dimension by default", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        data: [
          { embedding: [3, 4, 0, 8, 15] }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "embedding-model",
      apiKey: "sk-test",
      extraHeaders: { "x-endpoint-tenant": "tenant-1" },
      extraBody: { endpoint_option: "exact-endpoint" },
      cache: false,
      maxRetries: 0
    });

    expect(embedder.config.normalize).toBe(false);
    await expect(embedder.embedOne("remember this")).resolves.toEqual([3, 4, 0, 8, 15]);
    const [, init] = fetchMock.mock.calls[0] as [Parameters<typeof fetch>[0], RequestInit];
    expect(new Headers(init.headers).get("x-endpoint-tenant")).toBe("tenant-1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "embedding-model",
      endpoint_option: "exact-endpoint"
    });
  });

  it("does not ask the local extractor to normalize by default", async () => {
    transformerMocks.extractor.mockResolvedValue({ data: [3, 4] });
    transformerMocks.pipeline.mockResolvedValue(transformerMocks.extractor);
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      cache: false
    });

    await expect(embedder.embedOne("local memory")).resolves.toEqual([3, 4]);
    expect(transformerMocks.env.cacheDir).toBe(
      join(homedir(), ".memmy", "memory-service", "model-cache")
    );
    expect(transformerMocks.extractor).toHaveBeenCalledWith("local memory", {
      pooling: "mean",
      normalize: false
    });
  });

  it("loads bundled local embedding models without remote downloads", async () => {
    const root = join(tmpdir(), `memmy-embedded-model-${process.pid}-${Date.now()}`);
    const model = "local/embedded-model";
    await mkdir(join(root, model), { recursive: true });
    vi.stubEnv("MEMMY_EMBEDDING_MODEL_ROOT", root);
    transformerMocks.extractor.mockResolvedValue({ data: [1, 2] });
    transformerMocks.pipeline.mockResolvedValue(transformerMocks.extractor);
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      cache: false,
      model
    });

    try {
      await expect(embedder.embedOne("bundled local memory")).resolves.toEqual([1, 2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(transformerMocks.env.cacheDir).toBe(
      join(homedir(), ".memmy", "memory-service", "model-cache")
    );
    expect(transformerMocks.env.allowLocalModels).toBe(true);
    expect(transformerMocks.env.allowRemoteModels).toBe(false);
    expect(transformerMocks.env.localModelPath).toBe(root);
    expect(transformerMocks.pipeline).toHaveBeenCalledWith("feature-extraction", model, {
      dtype: "q8",
      device: "cpu",
      local_files_only: true
    });
  });
});
