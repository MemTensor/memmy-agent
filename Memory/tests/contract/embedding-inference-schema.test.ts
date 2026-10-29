import { describe, expect, it } from "vitest";
import { EmbeddingInferenceInputSchema } from "../../src/contracts/index.js";

describe("standalone Memory embedding input", () => {
  it("defaults to document embeddings and supports query embeddings", () => {
    expect(EmbeddingInferenceInputSchema.parse({ texts: ["hello"] })).toEqual({ texts: ["hello"], role: "document" });
    expect(EmbeddingInferenceInputSchema.parse({ texts: ["question"], role: "query" }).role).toBe("query");
  });

  it("bounds individual text, text count, and total input", () => {
    for (const texts of [[], [""], ["x".repeat(16_001)], Array(257).fill("x"), Array(13).fill("x".repeat(16_000))]) {
      expect(EmbeddingInferenceInputSchema.safeParse({ texts }).success).toBe(false);
    }
    expect(EmbeddingInferenceInputSchema.safeParse({ texts: Array(12).fill("x".repeat(16_000)) }).success).toBe(true);
  });
});
