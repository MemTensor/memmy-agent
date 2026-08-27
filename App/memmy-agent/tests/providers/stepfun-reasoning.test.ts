import { describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

function stepfunProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: "test-key",
    defaultModel: "step-3",
    spec: findByName("stepfun"),
  });
}

function standardProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: "test-key",
    defaultModel: "gpt-4o",
    spec: { name: "openai" },
  });
}

function sdkMessage(content: string | null, reasoning?: string | null, reasoningContent?: string | null): Record<string, any> {
  const message: Record<string, any> = { content, tool_calls: null };
  if (reasoning !== undefined) message.reasoning = reasoning;
  if (reasoningContent !== undefined) message.reasoning_content = reasoningContent;
  return message;
}

function sdkChunk({
  reasoningContent = null,
  reasoning = null,
  content = null,
  finish = null,
}: {
  reasoningContent?: string | null;
  reasoning?: string | null;
  content?: string | null;
  finish?: string | null;
}): Record<string, any> {
  return {
    choices: [
      {
        finish_reason: finish,
        delta: {
          content,
          reasoning_content: reasoningContent,
          reasoning,
          tool_calls: null,
        },
      },
    ],
    usage: null,
  };
}

describe("StepFun reasoning", () => {
  it("falls back to reasoning as content for StepFun object responses", () => {
    const result = stepfunProvider().parseResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning: "Let me think... The answer is 42.",
          },
          finish_reason: "stop",
        },
      ],
    });

    expect(result.content).toBe("Let me think... The answer is 42.");
    expect(result.reasoningContent).toBe("Let me think... The answer is 42.");
  });

  it("keeps reasoning_content priority while using reasoning as visible content", () => {
    const result = stepfunProvider().parseResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning: "informal thinking",
            reasoning_content: "formal reasoning content",
          },
          finish_reason: "stop",
        },
      ],
    });

    expect(result.content).toBe("informal thinking");
    expect(result.reasoningContent).toBe("formal reasoning content");
  });

  it("falls back to SDK message reasoning as StepFun content", () => {
    const result = stepfunProvider().parseResponse({
      choices: [{ finish_reason: "stop", message: sdkMessage(null, "After analysis: result is 4.") }],
      usage: null,
    });

    expect(result.content).toBe("After analysis: result is 4.");
    expect(result.reasoningContent).toBe("After analysis: result is 4.");
  });

  it("keeps SDK message reasoning_content priority", () => {
    const result = stepfunProvider().parseResponse({
      choices: [{ finish_reason: "stop", message: sdkMessage(null, "thinking process", "formal reasoning") }],
      usage: null,
    });

    expect(result.content).toBe("thinking process");
    expect(result.reasoningContent).toBe("formal reasoning");
  });

  it("uses streaming object reasoning when reasoning_content is absent", () => {
    const result = OpenAICompatProvider.parseChunks([
      { choices: [{ finish_reason: null, delta: { content: null, reasoning: "Thinking step 1... " } }] },
      { choices: [{ finish_reason: null, delta: { content: null, reasoning: "step 2." } }] },
      { choices: [{ finish_reason: "stop", delta: { content: "final answer" } }] },
    ]);

    expect(result.content).toBe("final answer");
    expect(result.reasoningContent).toBe("Thinking step 1... step 2.");
  });

  it("leaves normal models with reasoning_content unaffected", () => {
    const result = standardProvider().parseResponse({
      choices: [
        {
          message: {
            content: "The answer is 42.",
            reasoning_content: "Let me think step by step...",
          },
          finish_reason: "stop",
        },
      ],
    });

    expect(result.content).toBe("The answer is 42.");
    expect(result.reasoningContent).toBe("Let me think step by step...");
  });

  it("leaves standard models without reasoning fields unaffected", () => {
    const result = standardProvider().parseResponse({
      choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
    });

    expect(result.content).toBe("Hello!");
    expect(result.reasoningContent).toBeNull();
  });

  it("prefers reasoning_content over reasoning in object chunks", () => {
    const result = OpenAICompatProvider.parseChunks([
      {
        choices: [
          {
            finish_reason: null,
            delta: {
              content: null,
              reasoning_content: "formal: ",
              reasoning: "informal: ",
            },
          },
        ],
      },
      { choices: [{ finish_reason: "stop", delta: { content: "result" } }] },
    ]);

    expect(result.reasoningContent).toBe("formal: ");
  });

  it("uses streaming SDK reasoning when reasoning_content is absent", () => {
    const result = OpenAICompatProvider.parseChunks([
      sdkChunk({ reasoning: "Thinking... ", content: null, finish: null }),
      sdkChunk({ reasoning: null, content: "answer", finish: "stop" }),
    ]);

    expect(result.content).toBe("answer");
    expect(result.reasoningContent).toBe("Thinking... ");
  });

  it("prefers SDK chunk reasoning_content over reasoning", () => {
    const result = OpenAICompatProvider.parseChunks([
      sdkChunk({ reasoningContent: "formal: ", reasoning: "informal: ", content: null }),
      sdkChunk({ reasoningContent: null, reasoning: null, content: "result", finish: "stop" }),
    ]);

    expect(result.reasoningContent).toBe("formal: ");
  });

  it("does not promote reasoning to content for non-StepFun object responses", () => {
    const result = standardProvider().parseResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning: "internal thought process that should NOT be shown to user",
          },
          finish_reason: "stop",
        },
      ],
    });

    expect(result.content).toBeNull();
    expect(result.reasoningContent).toBe("internal thought process that should NOT be shown to user");
  });

  it("does not promote reasoning to content for non-StepFun SDK responses", () => {
    const result = standardProvider().parseResponse({
      choices: [{ finish_reason: "stop", message: sdkMessage(null, "internal monologue") }],
      usage: null,
    });

    expect(result.content).toBeNull();
    expect(result.reasoningContent).toBe("internal monologue");
  });
});
