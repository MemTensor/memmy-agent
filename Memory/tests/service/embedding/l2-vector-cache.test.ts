import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { l2VectorCacheKey, readL2VectorCache } from "../../../src/service/embedding/l2-vector-cache.js";
import { embeddingIdentity, vectorEmbeddingIdentity } from "../../../src/model/embedding-identity.js";

describe("L2 exact vector cache", () => {
  const config = DEFAULT_MEMMY_CONFIG.embedding;
  it("reads pre-optimization persistent cache keys without changing input", () => {
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const space = hash({ provider: config.provider, mode: config.mode, endpoint: config.endpoint,
      model: config.model, sourceProvider: config.sourceProvider, actualModelContext: config.actualModelContext,
      extraBody: config.extraBody, normalize: config.normalize });
    const text = "标题与留白\n  preserve whitespace";
    expect(l2VectorCacheKey(config, "query", text)).toBe(`l2.extract.vector.v1:${hash({ space, role: "query" })}:${hash(text)}`);
  });
  it("isolates role, exact text and embedding configuration", () => {
    const key = l2VectorCacheKey(config, "query", "PPT");
    expect(l2VectorCacheKey(config, "document", "PPT")).not.toBe(key);
    for (const text of ["ppt", "PPT ", "PPT\n"]) expect(l2VectorCacheKey(config, "query", text)).not.toBe(key);
    for (const patch of [{ model: "other" }, { endpoint: "https://different.invalid" },
      { normalize: !config.normalize }, { extraBody: { dimensions: 123 } },
      { sourceProvider: "other" }]) {
      expect(l2VectorCacheKey({ ...config, ...patch }, "query", "PPT")).not.toBe(key);
    }
  });
  it.each([undefined, [], [0, 0], [1, NaN], [Infinity], ["1", 0]])("ignores invalid cache %j", value => {
    expect(readL2VectorCache({ getKv: () => ({ key: "k", value, updatedAt: "now" }) }, "k", config)).toBeUndefined();
  });
  it("preserves exact vector values and restores provenance", () => {
    const value = [0.1234, -0.999, 0];
    const cached = readL2VectorCache({ getKv: () => ({ key: "k", value, updatedAt: "now" }) }, "k", config)!;
    expect(cached).toEqual(value);
    expect(vectorEmbeddingIdentity(cached)).toEqual(embeddingIdentity(config));
  });
});
