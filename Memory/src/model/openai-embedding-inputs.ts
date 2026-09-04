import { get_encoding } from "tiktoken";

const OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET = 7_500;
const OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET = 290_000;

export interface OpenAiEmbeddingChunk {
  originalIndex: number;
  tokens: number[];
  input: string | number[];
}

export interface OpenAiEmbeddingPlan {
  batches: OpenAiEmbeddingChunk[][];
  chunks: OpenAiEmbeddingChunk[];
  originalCount: number;
}

let encoder: ReturnType<typeof get_encoding> | undefined;

export function planOpenAiEmbeddingInputs(
  texts: string[],
  model?: string,
  configuredMaxInputTokens?: number
): OpenAiEmbeddingPlan | null {
  const inputTokenBudget = resolveInputTokenBudget(model, configuredMaxInputTokens);
  // Explicit budgets retain the historical token-id request shape for
  // deployments that opt into it; opaque aliases use text chunks so their
  // model-specific tokenizer is still applied by the provider.
  const useTokenIds = isKnownOpenAiEmbeddingModel(model) || configuredMaxInputTokens !== undefined;
  encoder ??= get_encoding("cl100k_base");
  const encoded = texts.map((text) => Array.from(encoder!.encode(text, [], [])));
  const totalTokens = encoded.reduce((sum, tokens) => sum + tokens.length, 0);
  if (totalTokens <= OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET &&
    encoded.every((tokens) => tokens.length <= inputTokenBudget)) return null;

  const chunks = encoded.flatMap((tokens, originalIndex) => {
    if (tokens.length === 0) return [{ originalIndex, tokens, input: useTokenIds ? tokens : "" }];
    const tokenBytes = useTokenIds
      ? undefined
      : tokens.map((token) => encoder!.decode_single_token_bytes(token));
    const items: OpenAiEmbeddingChunk[] = [];
    for (let offset = 0; offset < tokens.length;) {
      let end = Math.min(tokens.length, offset + inputTokenBudget);
      if (!useTokenIds && end < tokens.length) {
        while (end > offset && startsWithContinuationByte(tokenBytes?.[end])) {
          end -= 1;
        }
        if (end === offset) end = Math.min(tokens.length, offset + inputTokenBudget);
      }
      const chunkTokens = tokens.slice(offset, end);
      items.push({
        originalIndex,
        tokens: chunkTokens,
        input: useTokenIds ? chunkTokens : decodeTokenBytes(tokenBytes!.slice(offset, end))
      });
      offset = end;
    }
    return items;
  });
  return {
    batches: batchChunks(chunks),
    chunks,
    originalCount: texts.length
  };
}

export function aggregateOpenAiEmbeddingVectors(plan: OpenAiEmbeddingPlan, vectors: number[][]): number[][] {
  if (vectors.length !== plan.chunks.length) {
    throw new Error(`openai_compatible returned ${vectors.length} embeddings for ${plan.chunks.length} chunks`);
  }
  return Array.from({ length: plan.originalCount }, (_item, originalIndex) => {
    const entries = plan.chunks
      .map((chunk, index) => ({ chunk, vector: vectors[index]! }))
      .filter((entry) => entry.chunk.originalIndex === originalIndex);
    if (entries.length === 1) return entries[0]!.vector;
    const dimensions = entries[0]?.vector.length ?? 0;
    if (dimensions === 0 || entries.some((entry) => entry.vector.length !== dimensions)) {
      throw new Error("openai_compatible returned incompatible embedding dimensions for chunked input");
    }
    const totalWeight = entries.reduce((sum, entry) => sum + Math.max(1, entry.chunk.tokens.length), 0);
    const mean = Array.from({ length: dimensions }, (_value, dimension) =>
      entries.reduce((sum, entry) =>
        sum + entry.vector[dimension]! * Math.max(1, entry.chunk.tokens.length), 0) / totalWeight
    );
    const norm = Math.hypot(...mean);
    return norm > 0 ? mean.map((value) => value / norm) : mean;
  });
}

function isKnownOpenAiEmbeddingModel(model?: string): boolean {
  return /(?:^|[/.:])text-embedding-(?:3-(?:small|large)|ada-002)(?:$|[/.:])/i.test(model?.trim() ?? "");
}

function resolveInputTokenBudget(_model?: string, configured?: number): number {
  const explicit = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : undefined;
  // OpenAI-compatible deployments frequently expose an opaque deployment
  // alias instead of the upstream model id.  We cannot safely assume that
  // alias has a larger context window, so apply the same conservative budget
  // used for known OpenAI embedding models unless the caller opts into a
  // smaller budget explicitly.
  return Math.min(explicit ?? OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET, OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET);
}

function decodeTokenBytes(tokenBytes: Uint8Array[]): string {
  const bytes = tokenBytes.flatMap((value) => Array.from(value));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function startsWithContinuationByte(bytes: Uint8Array | undefined): boolean {
  const first = bytes?.[0];
  return first !== undefined && (first & 0xc0) === 0x80;
}

function batchChunks(chunks: OpenAiEmbeddingChunk[]): OpenAiEmbeddingChunk[][] {
  const batches: OpenAiEmbeddingChunk[][] = [];
  let current: OpenAiEmbeddingChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && currentTokens + chunk.tokens.length > OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(chunk);
    currentTokens += chunk.tokens.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
