import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { get_encoding } from "tiktoken";
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
      input: ["remember this"],
      endpoint_option: "exact-endpoint"
    });
  });

  it("chunks oversized OpenAI embedding inputs and preserves original vector order", async () => {
    const requestBodies: Array<{ input: number[][] }> = [];
    let vectorIndex = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: number[][] };
      requestBodies.push(body);
      return new Response(JSON.stringify({
        data: body.input.map(() => {
          const embedding = vectorIndex === 0 ? [1, 0] : vectorIndex === 1 ? [0, 1] : [0, 2];
          vectorIndex += 1;
          return { embedding };
        })
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      cache: false,
      maxRetries: 0
    });

    const vectors = await embedder.embed([`<|endoftext|>${" memory".repeat(8_001)}`, "short"]);
    const sentInputs = requestBodies.flatMap((body) => body.input);

    expect(sentInputs).toHaveLength(3);
    expect(sentInputs.every((input) => Array.isArray(input) && input.length <= 7_500)).toBe(true);
    const firstWeight = sentInputs[0]!.length;
    const secondWeight = sentInputs[1]!.length;
    const totalWeight = firstWeight + secondWeight;
    const mean = [firstWeight / totalWeight, secondWeight / totalWeight];
    const norm = Math.hypot(...mean);
    expect(vectors[0]?.[0]).toBeCloseTo(mean[0]! / norm, 8);
    expect(vectors[0]?.[1]).toBeCloseTo(mean[1]! / norm, 8);
    expect(vectors[1]).toEqual([0, 2]);
  });

  it("uses an explicit token budget for an OpenAI-compatible deployment alias", async () => {
    const sentInputs: number[][] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: number[][] };
      sentInputs.push(...body.input);
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0] }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "production-embedding-deployment",
      apiKey: "sk-test",
      maxInputTokens: 512,
      cache: false,
      maxRetries: 0
    });

    await expect(embedder.embedOne(" memory".repeat(600))).resolves.toEqual([1, 0]);

    expect(sentInputs.length).toBeGreaterThan(1);
    expect(sentInputs.every((input) => input.length <= 512)).toBe(true);
  });

  it("uses the conservative token budget for an opaque deployment alias by default", async () => {
    const sentInputs: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      sentInputs.push(...body.input);
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0] }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "production-embedding-deployment",
      apiKey: "sk-test",
      cache: false,
      maxRetries: 0
    });

    await expect(embedder.embedOne(" memory".repeat(8_001))).resolves.toEqual([1, 0]);

    expect(sentInputs.length).toBeGreaterThan(1);
    const encoder = get_encoding("cl100k_base");
    expect(sentInputs.every((input) => encoder.encode(input).length <= 7_500)).toBe(true);
    expect(sentInputs.join("")).toBe(" memory".repeat(8_001));
  });

  it("keeps short opaque deployment inputs as text", async () => {
    let requestInput: unknown;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      requestInput = (JSON.parse(String(init?.body)) as { input: unknown }).input;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "production-embedding-deployment",
      apiKey: "sk-test",
      cache: false,
      maxRetries: 0
    });

    await expect(embedder.embedOne("short memory")).resolves.toEqual([1, 0]);
    expect(requestInput).toEqual(["short memory"]);
  });

  it("keeps chunked OpenAI embedding request batches below the aggregate token budget", async () => {
    const requestTokenCounts: number[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: number[][] };
      requestTokenCounts.push(body.input.reduce((sum, input) => sum + input.length, 0));
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0] }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      cache: false,
      maxRetries: 0
    });

    await expect(embedder.embedOne(" memory".repeat(300_001))).resolves.toEqual([1, 0]);

    expect(requestTokenCounts.length).toBeGreaterThan(1);
    expect(requestTokenCounts.every((count) => count <= 290_000)).toBe(true);
  });

  it("splits OpenAI embedding batches when individually valid inputs exceed the aggregate token budget", async () => {
    const requestTokenCounts: number[] = [];
    const requestInputCounts: number[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: number[][] };
      requestTokenCounts.push(body.input.reduce((sum, input) => sum + input.length, 0));
      requestInputCounts.push(body.input.length);
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [1, 0] }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const embedder = createEmbedder({
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint: "https://api.example.test/v1",
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      cache: false,
      maxRetries: 0
    });

    const vectors = await embedder.embed(Array.from({ length: 40 }, () => " memory".repeat(7_400)));

    expect(vectors).toHaveLength(40);
    expect(requestTokenCounts.length).toBeGreaterThan(1);
    expect(requestTokenCounts.every((count) => count <= 290_000)).toBe(true);
    expect(requestInputCounts.reduce((sum, count) => sum + count, 0)).toBe(40);
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
