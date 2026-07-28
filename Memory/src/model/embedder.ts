import type { EmbeddingConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { stableHash } from "../utils/id.js";
import { bearer, postJsonWithRetry, trimTrailingSlash } from "./http.js";
import { HttpByokTokenUsageRecorder, extractModelTokenUsage } from "./token-usage.js";
import type { Embedder, ModelStatus } from "./types.js";

const logger = createMemoryLogger("embedding");

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  usage?: Record<string, unknown>;
}

interface GeminiEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
  usageMetadata?: Record<string, unknown>;
}

interface CohereEmbeddingResponse {
  embeddings?: number[][] | { float?: number[][] };
  meta?: {
    billed_units?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

type FeatureExtractor = (text: string, options?: Record<string, unknown>) => Promise<{ data?: ArrayLike<number> | Iterable<number> }>;
type PipelineFn = (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;

let localExtractorPromise: Promise<FeatureExtractor> | null = null;
let localExtractorModel: string | null = null;

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new HttpEmbedder(config);
}

class HttpEmbedder implements Embedder {
  private readonly cache = new Map<string, number[]>();
  private lastOkAt: string | undefined;
  private lastError: string | undefined;
  private readonly usageRecorder = new HttpByokTokenUsageRecorder();

  constructor(readonly config: EmbeddingConfig) {}

  isRemote(): boolean {
    return this.config.provider !== "local";
  }

  async embedOne(text: string, role: "query" | "document" = "document"): Promise<number[]> {
    const [vector] = await this.embed([text], role);
    if (!vector) {
      throw new Error(`${this.config.provider} embedding provider returned no vector`);
    }
    return vector;
  }

  async embed(texts: string[], role: "query" | "document" = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out = new Array<number[]>(texts.length);
    const missing: Array<{ text: string; index: number }> = [];

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index] ?? "";
      const key = this.cacheKey(text, role);
      const cached = this.config.cache ? this.cache.get(key) : undefined;
      if (cached) {
        out[index] = cached;
      } else {
        missing.push({ text, index });
      }
    }

    if (missing.length > 0) {
      const vectors = this.isRemote()
        ? await this.embedRemote(missing.map((item) => item.text), role)
        : await this.embedLocal(missing.map((item) => item.text), role);
      for (let index = 0; index < missing.length; index += 1) {
        const item = missing[index]!;
        const rawVector = vectors[index];
        if (!rawVector) {
          throw new Error(`${this.config.provider} embedding row ${index} is missing vector`);
        }
        const vector = this.postProcess(rawVector);
        out[item.index] = vector;
        if (this.config.cache) {
          this.cache.set(this.cacheKey(item.text, role), vector);
        }
      }
    }

    return out;
  }

  status(): ModelStatus {
    return {
      provider: this.config.provider,
      model: this.config.model,
      configured: this.isRemote()
        ? Boolean(this.config.model && (this.config.apiKey || this.config.endpoint))
        : Boolean(this.config.model),
      remote: this.isRemote(),
      lastOkAt: this.lastOkAt,
      lastError: this.lastError
    };
  }

  private async embedRemote(texts: string[], role: "query" | "document"): Promise<number[][]> {
    const startedAt = Date.now();
    const fields = {
      provider: this.config.provider,
      model: this.config.model,
      role,
      batchSize: texts.length
    };
    logger.debug("request.started", fields);
    try {
      const vectors = await this.embedRemoteOnce(texts, role);
      this.lastOkAt = new Date().toISOString();
      this.lastError = undefined;
      logger.info("request.succeeded", { ...fields, durationMs: Date.now() - startedAt });
      return vectors;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error("request.failed", {
        ...fields,
        durationMs: Date.now() - startedAt,
        ...memoryErrorFields(error)
      });
      throw error;
    }
  }

  private async embedLocal(texts: string[], role: "query" | "document"): Promise<number[][]> {
    const startedAt = Date.now();
    const fields = {
      provider: this.config.provider,
      model: this.config.model,
      role,
      batchSize: texts.length
    };
    logger.debug("request.started", fields);
    try {
      const model = this.config.model || "Xenova/all-MiniLM-L6-v2";
      const extractor = await ensureLocalExtractor(model);
      const vectors: number[][] = [];
      for (const text of texts) {
        const result = await extractor(text, { pooling: "mean", normalize: false });
        if (!result.data) {
          throw new Error("local embedding extractor returned no data");
        }
        vectors.push(Array.from(result.data));
      }
      this.lastOkAt = new Date().toISOString();
      this.lastError = undefined;
      logger.info("request.succeeded", { ...fields, durationMs: Date.now() - startedAt });
      return vectors;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error("request.failed", {
        ...fields,
        durationMs: Date.now() - startedAt,
        ...memoryErrorFields(error)
      });
      throw error;
    }
  }

  private embedRemoteOnce(texts: string[], role: "query" | "document"): Promise<number[][]> {
    switch (this.config.provider) {
      case "openai_compatible":
        return this.embedOpenAiCompatible(texts, role);
      case "gemini":
        return this.embedGemini(texts, role);
      case "cohere":
        return this.embedCohere(texts, role);
      case "voyage":
        return this.embedOpenAiShape(texts, "voyage", this.config.endpoint || "https://api.voyageai.com/v1/embeddings", role);
      case "mistral":
        return this.embedOpenAiShape(texts, "mistral", this.config.endpoint || "https://api.mistral.ai/v1/embeddings", role);
      case "local":
        throw new Error("local embedding provider must use the local extractor");
    }
  }

  private async embedOpenAiCompatible(texts: string[], role: "query" | "document"): Promise<number[][]> {
    const base = trimTrailingSlash(this.config.endpoint || "https://api.openai.com/v1");
    const url = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
    return this.embedOpenAiShape(texts, "openai_compatible", url, role);
  }

  private async embedOpenAiShape(texts: string[], provider: string, url: string, role: "query" | "document"): Promise<number[][]> {
    if (!this.config.apiKey && !this.config.endpoint) {
      throw new Error(`${provider} embedding provider requires apiKey or endpoint`);
    }
    const response = await postJsonWithRetry<OpenAiEmbeddingResponse>({
      provider,
      operation: `embedding.${role}`,
      model: this.config.model,
      url,
      headers: bearer(this.config.apiKey),
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      body: {
        model: this.config.model,
        input: texts
      }
    });
    const vectors = validateVectors(provider, response.data?.map((row) => row.embedding), texts.length);
    this.recordEmbeddingUsage(response, provider, role);
    return vectors;
  }

  private async embedGemini(texts: string[], role: "query" | "document"): Promise<number[][]> {
    if (!this.config.apiKey) {
      throw new Error("gemini embedding provider requires apiKey");
    }
    const base = trimTrailingSlash(this.config.endpoint || "https://generativelanguage.googleapis.com/v1beta");
    const model = this.config.model || "text-embedding-004";
    const url = `${base}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(this.config.apiKey)}`;
    const response = await postJsonWithRetry<GeminiEmbeddingResponse>({
      provider: "gemini",
      operation: `embedding.${role}`,
      model,
      url,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      body: {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] }
        }))
      }
    });
    const vectors = validateVectors("gemini", response.embeddings?.map((row) => row.values), texts.length);
    this.recordEmbeddingUsage(response, "gemini", role);
    return vectors;
  }

  private async embedCohere(texts: string[], role: "query" | "document"): Promise<number[][]> {
    if (!this.config.apiKey) {
      throw new Error("cohere embedding provider requires apiKey");
    }
    const url = this.config.endpoint || "https://api.cohere.com/v2/embed";
    const response = await postJsonWithRetry<CohereEmbeddingResponse>({
      provider: "cohere",
      operation: `embedding.${role}`,
      model: this.config.model || "embed-v4.0",
      url,
      headers: bearer(this.config.apiKey),
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      body: {
        model: this.config.model || "embed-v4.0",
        texts,
        input_type: role === "query" ? "search_query" : "search_document",
        embedding_types: ["float"]
      }
    });
    const vectors = Array.isArray(response.embeddings)
      ? response.embeddings
      : response.embeddings?.float;
    const validated = validateVectors("cohere", vectors, texts.length);
    this.recordEmbeddingUsage(cohereUsagePayload(response), "cohere", role);
    return validated;
  }

  private postProcess(vector: number[]): number[] {
    if (!this.config.normalize) return vector;
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map((value) => value / norm) : vector;
  }

  private cacheKey(text: string, role: string): string {
    return stableHash(`${this.config.provider}:${this.config.model}:${role}:${text}`);
  }

  private recordEmbeddingUsage(response: unknown, provider: string, role: "query" | "document"): void {
    this.usageRecorder.record({
      kind: "embedding",
      operation: `embedding.${role}`,
      provider,
      model: this.config.model,
      endpoint: this.config.endpoint,
      usage: extractModelTokenUsage(response),
      metadata: { role }
    });
  }
}

async function ensureLocalExtractor(model: string): Promise<FeatureExtractor> {
  if (localExtractorPromise && localExtractorModel === model) {
    return localExtractorPromise;
  }
  localExtractorModel = model;
  localExtractorPromise = (async () => {
    const mod = await import("@huggingface/transformers");
    const pipeline = (mod as unknown as { pipeline: PipelineFn }).pipeline;
    return await pipeline("feature-extraction", model, {
      dtype: "q8",
      device: "cpu"
    }) as FeatureExtractor;
  })().catch((error) => {
    localExtractorPromise = null;
    throw error;
  });
  return localExtractorPromise;
}

function cohereUsagePayload(response: CohereEmbeddingResponse): unknown {
  const billedUnits = response.meta?.billed_units;
  if (!billedUnits) {
    return response;
  }
  const inputTokens = billedUnits.input_tokens ?? 0;
  const outputTokens = billedUnits.output_tokens ?? 0;
  return {
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  };
}

function validateVectors(provider: string, vectors: Array<number[] | undefined> | undefined, expected: number): number[][] {
  if (!vectors || vectors.length !== expected) {
    throw new Error(`${provider} returned ${vectors?.length ?? 0} embeddings for ${expected} inputs`);
  }
  return vectors.map((vector, index) => {
    if (!Array.isArray(vector)) {
      throw new Error(`${provider} embedding row ${index} is missing vector`);
    }
    return vector;
  });
}
