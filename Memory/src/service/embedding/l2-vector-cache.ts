import { createHash } from "node:crypto";
import type { EmbeddingConfig } from "../../config/index.js";
import { embeddingIdentity, rememberEmbeddingIdentity } from "../../model/embedding-identity.js";
import type { Repositories } from "../../storage/repositories.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Keep the existing cache identity: no input normalization, shortening or role mixing. */
export function l2EmbeddingSpace(config: EmbeddingConfig): string {
  return digest({ provider: config.provider, mode: config.mode, endpoint: config.endpoint,
    model: config.model, sourceProvider: config.sourceProvider, actualModelContext: config.actualModelContext,
    extraBody: config.extraBody, normalize: config.normalize });
}

export function l2VectorCacheKey(config: EmbeddingConfig, role: "query" | "document", text: string): string {
  return `l2.extract.vector.v1:${digest({ space: l2EmbeddingSpace(config), role })}:${digest(text)}`;
}

export function readL2VectorCache(
  runtime: Pick<Repositories["runtime"], "getKv">,
  key: string,
  config: EmbeddingConfig
): number[] | undefined {
  const value = runtime.getKv(key)?.value;
  if (!Array.isArray(value) || !value.length || !value.every((n) => typeof n === "number" && Number.isFinite(n))
    || !value.some((n) => n !== 0)) return undefined;
  return rememberEmbeddingIdentity(value as number[], embeddingIdentity(config));
}
