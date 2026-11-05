import type { EmbeddingConfig, LlmConfig } from "../config/index.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionOptions {
  operation: string;
  thinkingMode?: "inherit" | "enabled" | "disabled";
  temperature?: number;
  maxTokens?: number;
  /** Keep a length retry within this output cap when input has a fixed budget. */
  retryTokenCeiling?: number;
  timeoutMs?: number;
  maxRetries?: number;
  jsonMode?: boolean;
  // Replaces the summary role's default input budget for this call only. The
  // caller is expected to have fitted its messages to this budget already.
  inputTokenBudget?: number;
  /** Reject even parseable JSON when the provider reports truncated output. */
  requireCompleteJson?: boolean;
}

export interface LlmClient {
  readonly config: LlmConfig;
  isConfigured(): boolean;
  complete(messages: LlmMessage[], options: LlmCompletionOptions): Promise<string>;
  completeJson<T extends Record<string, unknown>>(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<T>;
  status(): ModelStatus;
}

export interface Embedder {
  readonly config: EmbeddingConfig;
  isRemote(): boolean;
  embed(texts: string[], role?: "query" | "document"): Promise<number[][]>;
  embedOne(text: string, role?: "query" | "document"): Promise<number[]>;
  status(): ModelStatus;
}

export interface ModelStatus {
  provider: string;
  model?: string;
  configured: boolean;
  remote: boolean;
  lastOkAt?: string;
  lastError?: string;
}
