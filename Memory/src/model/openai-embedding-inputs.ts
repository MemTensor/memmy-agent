import { get_encoding } from "tiktoken";

const OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET = 7_500;
const OPAQUE_EMBEDDING_INPUT_TOKEN_BUDGET = 4_000;
// An alias may use a different tokenizer. Bound bytes independently of our
// token estimate; this is a conservative default, not a provider context limit.
const OPAQUE_EMBEDDING_INPUT_BYTE_BUDGET = 12_000;

export class EmbeddingInputLimitError extends Error {
  override readonly name = "EmbeddingInputLimitError";
}
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

let openAiEncoder: ReturnType<typeof get_encoding> | undefined;
let opaqueModelEncoder: ReturnType<typeof get_encoding> | undefined;

export function planOpenAiEmbeddingInputs(
  texts: string[],
  model?: string,
  configuredMaxInputTokens?: number,
  configuredMaxInputBytes?: number
): OpenAiEmbeddingPlan | null {
  const knownOpenAiModel = isKnownOpenAiEmbeddingModel(model);
  const inputTokenBudget = resolveInputTokenBudget(model, configuredMaxInputTokens);
  // Only known OpenAI embedding models receive token IDs. Opaque aliases may
  // use a different tokenizer (for example BGE-M3), so keep their chunks as
  // text and let the provider apply its native tokenizer.
  const useTokenIds = knownOpenAiModel;
  const inputByteBudget = knownOpenAiModel ? Infinity :
    Math.min(positiveBudget(configuredMaxInputBytes) ?? OPAQUE_EMBEDDING_INPUT_BYTE_BUDGET,
      OPAQUE_EMBEDDING_INPUT_BYTE_BUDGET);
  const encoder = knownOpenAiModel
    ? (openAiEncoder ??= get_encoding("cl100k_base"))
    : (opaqueModelEncoder ??= get_encoding("o200k_base"));
  const inputs = texts.flatMap((text, originalIndex) =>
    (useTokenIds ? [text] : splitUtf8Input(text, inputByteBudget))
      .map((part) => ({ originalIndex, tokens: Array.from(encoder.encode(part, [], [])) }))
  );
  const totalTokens = inputs.reduce((sum, item) => sum + item.tokens.length, 0);
  if (inputs.length === texts.length && totalTokens <= OPENAI_EMBEDDING_BATCH_TOKEN_BUDGET &&
    inputs.every((item) => item.tokens.length <= inputTokenBudget)) return null;

  const chunks = inputs.flatMap(({ tokens, originalIndex }) => {
    if (tokens.length === 0) return [{ originalIndex, tokens, input: useTokenIds ? tokens : "" }];
    const tokenBytes = useTokenIds
      ? undefined
      : tokens.map((token) => encoder.decode_single_token_bytes(token));
    const items: OpenAiEmbeddingChunk[] = [];
    for (let offset = 0; offset < tokens.length;) {
      let end = Math.min(tokens.length, offset + inputTokenBudget);
      if (!useTokenIds) {
        // Never cut through a UTF-8 character, including when one character
        // occupies several tokens. If it cannot fit, fail without sending it.
        while (end > offset && end < tokens.length && startsWithContinuationByte(tokenBytes![end])) end -= 1;
        if (end === offset) {
          throw new EmbeddingInputLimitError("Embedding token budget is too small for one complete character; increase maxInputTokens.");
        }
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

function positiveBudget(value?: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function resolveInputTokenBudget(model?: string, configured?: number): number {
  const explicit = positiveBudget(configured);
  const defaultBudget = isKnownOpenAiEmbeddingModel(model)
    ? OPENAI_EMBEDDING_INPUT_TOKEN_BUDGET
    : OPAQUE_EMBEDDING_INPUT_TOKEN_BUDGET;
  return Math.min(explicit ?? defaultBudget, defaultBudget);
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

function splitUtf8Input(text: string, budget: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= budget) return [text];
  const parts: string[] = [];
  let offset = 0;
  let start = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (size > budget) {
      throw new EmbeddingInputLimitError("Embedding byte budget is too small for one complete character; increase maxInputBytes.");
    }
    if (bytes + size > budget) {
      parts.push(text.slice(start, offset));
      start = offset;
      bytes = 0;
    }
    offset += character.length;
    bytes += size;
  }
  parts.push(text.slice(start));
  return parts;
}
