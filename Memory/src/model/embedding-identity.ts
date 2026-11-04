import type { EmbeddingConfig } from "../config/index.js";

/** Identity persisted by both vector stores. Unknown legacy identities are not compatible. */
export interface EmbeddingIdentity {
  provider: string;
  model: string;
}

const provenance = new WeakMap<readonly number[], EmbeddingIdentity>();

export function embeddingIdentity(config: Pick<EmbeddingConfig, "provider" | "model">): EmbeddingIdentity {
  return { provider: config.provider, model: config.model || config.provider };
}

export function sameEmbeddingIdentity(
  value: { embeddingProvider?: string | null; embeddingModel?: string | null },
  expected: EmbeddingIdentity
): boolean {
  return value.embeddingProvider === expected.provider && value.embeddingModel === expected.model;
}

export function rememberEmbeddingIdentity(vector: number[], identity: EmbeddingIdentity): number[] {
  provenance.set(vector, { ...identity });
  return vector;
}

/** Carry the model used for this request across an asynchronous config reload. */
export function vectorEmbeddingIdentity(vector: readonly number[]): EmbeddingIdentity | undefined {
  return provenance.get(vector);
}
