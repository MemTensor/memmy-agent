import { describe, expect, it } from "vitest";
import {
  RESPONSES_FAILURE_THRESHOLD,
  RESPONSES_PROBE_INTERVAL_S,
  OpenAICompatProvider,
} from "../../src/providers/openai-compat-provider.js";

function provider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: "test-key",
    apiBase: "https://api.openai.com/v1",
    defaultModel: "gpt-5",
    spec: { name: "openai" },
  });
}

describe("Responses API circuit breaker", () => {
  it("uses the Responses API for supported OpenAI models by default", () => {
    expect(provider().shouldUseResponsesApi("gpt-5", null)).toBe(true);
  });

  it("disables Responses API when apiType is chatCompletions", () => {
    const p = provider();
    p.apiType = "chatCompletions";

    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(false);
  });

  it("forces Responses API for OpenAI when apiType is responses", () => {
    const p = provider();
    p.defaultModel = "gpt-4o";
    p.apiType = "responses";

    expect(p.shouldUseResponsesApi("gpt-4o", null)).toBe(true);
  });

  it("ignores the circuit breaker when apiType is responses", () => {
    const p = provider();
    p.defaultModel = "gpt-4o";
    p.apiType = "responses";
    p.responsesFailures = { "gpt-4o:": RESPONSES_FAILURE_THRESHOLD };
    p.responsesTrippedAt = { "gpt-4o:": 0 };

    expect(p.shouldUseResponsesApi("gpt-4o", null)).toBe(true);
  });

  it("does not force Responses API for non-OpenAI providers", () => {
    const p = provider();
    p.spec = { name: "custom" };
    p.apiType = "responses";

    expect(p.shouldUseResponsesApi("gpt-4o", null)).toBe(false);
  });

  it("opens the circuit after the failure threshold", () => {
    const p = provider();
    for (let i = 0; i < RESPONSES_FAILURE_THRESHOLD; i += 1) p.recordResponsesFailure("gpt-5", null);

    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(false);
  });

  it("keeps failures isolated by model", () => {
    const p = provider();
    for (let i = 0; i < RESPONSES_FAILURE_THRESHOLD; i += 1) p.recordResponsesFailure("gpt-5", null);

    expect(p.shouldUseResponsesApi("o4-mini", null)).toBe(true);
  });

  it("resets the circuit after a successful Responses API call", () => {
    const p = provider();
    for (let i = 0; i < RESPONSES_FAILURE_THRESHOLD; i += 1) p.recordResponsesFailure("gpt-5", null);
    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(false);

    p.recordResponsesSuccess("gpt-5", null);

    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(true);
  });

  it("allows a probe after the probe interval elapses", () => {
    const p = provider();
    for (let i = 0; i < RESPONSES_FAILURE_THRESHOLD; i += 1) p.recordResponsesFailure("gpt-5", null);
    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(false);

    p.responsesTrippedAt["gpt-5:"] = Date.now() / 1000 - RESPONSES_PROBE_INTERVAL_S - 1;

    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(true);
  });

  it("still allows Responses API below the failure threshold", () => {
    const p = provider();
    p.recordResponsesFailure("gpt-5", null);
    p.recordResponsesFailure("gpt-5", null);

    expect(p.shouldUseResponsesApi("gpt-5", null)).toBe(true);
  });

  it("keys failures separately by reasoning effort", () => {
    const p = provider();
    for (let i = 0; i < RESPONSES_FAILURE_THRESHOLD; i += 1) p.recordResponsesFailure("o3", "high");

    expect(p.shouldUseResponsesApi("o3", "high")).toBe(false);
    expect(p.shouldUseResponsesApi("o3", "low")).toBe(true);
  });

  it("normalizes reasoning effort case in circuit keys", () => {
    const p = provider();
    for (let i = 0; i < RESPONSES_FAILURE_THRESHOLD; i += 1) p.recordResponsesFailure("o3", "High");

    expect(p.shouldUseResponsesApi("o3", "high")).toBe(false);
  });
});
