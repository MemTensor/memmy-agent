import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { ModelHttpError } from "../../../src/model/http.js";
import { RewardPipeline } from "../../../src/service/evolution/reward-pipeline.js";
import { RetrievalService } from "../../../src/service/retrieval/retrieval-service.js";

describe("credit errors bypass model fallbacks", () => {
  it.each(["CREDIT_INSUFFICIENT", "CREDIT_BALANCE_RESERVED", "CREDIT_CALL_UNCERTAIN", "40309"])("preserves %s instead of committing a heuristic reward", async code => {
    const error = new ModelHttpError(code, "openai_compatible", 422, code, code);
    const completeJson = vi.fn().mockRejectedValue(error);
    const pipeline = new RewardPipeline({
      config: { ...DEFAULT_MEMMY_CONFIG, algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm,
        reward: { ...DEFAULT_MEMMY_CONFIG.algorithm.reward, llmScoring: true } } },
      llm: { isConfigured: () => true, completeJson }
    } as never);
    await expect(pipeline.scoreFeedbackWithLlm({
      source: { properties: { internal_info: {} } },
      trace: { summary: "summary", userText: "user", agentText: "answer", toolCalls: [], ts: 0 },
      episodeTraces: [], payload: {}, fallback: { rHuman: 0, reason: "fallback", source: "heuristic" }
    } as never)).rejects.toBe(error);
    expect(completeJson).toHaveBeenCalledTimes(1);
  });

  it.each(["CREDIT_INSUFFICIENT", "CREDIT_CALL_UNCERTAIN"])("does not hide %s in text-only retrieval", async code => {
    const error = new ModelHttpError(code, "openai_compatible", 422, code, code);
    const embedOne = vi.fn().mockRejectedValue(error);
    const retrieval = new RetrievalService({ embedder: { embedOne }, withTimeout: (promise: Promise<unknown>) => promise } as never);
    await expect(retrieval.queryVector("fixture query")).rejects.toBe(error);
    expect(embedOne).toHaveBeenCalledTimes(1);
  });
});
