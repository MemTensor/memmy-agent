import { describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { parseResponseOutput } from "../../src/providers/openai-responses/index.js";

function reasoningChunk(reasoning: string | null, content: string | null, finish: string | null) {
  return {
    choices: [
      {
        finish_reason: finish,
        delta: {
          content,
          reasoning_content: reasoning,
          tool_calls: null,
        },
      },
    ],
    usage: null,
  };
}

describe("reasoning content", () => {
  it("extracts reasoning_content from chat completion messages", () => {
    const provider = new OpenAICompatProvider();
    const result = provider.parseResponse({
      choices: [{ message: { content: "answer", reasoning_content: "hidden reasoning" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });

    expect(result.content).toBe("answer");
    expect(result.reasoningContent).toBe("hidden reasoning");
  });

  it("returns null reasoning_content when chat completion messages omit it", () => {
    const provider = new OpenAICompatProvider();

    const result = provider.parseResponse({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    });

    expect(result.reasoningContent).toBeNull();
  });

  it("accumulates reasoning_content from object streaming chunks", () => {
    const result = OpenAICompatProvider.parseChunks([
      {
        choices: [
          {
            finish_reason: null,
            delta: { content: null, reasoning_content: "Step 1. " },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: null,
            delta: { content: null, reasoning_content: "Step 2." },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            delta: { content: "answer" },
          },
        ],
      },
    ]);

    expect(result.content).toBe("answer");
    expect(result.reasoningContent).toBe("Step 1. Step 2.");
  });

  it("returns null reasoning_content when object streaming chunks omit it", () => {
    const result = OpenAICompatProvider.parseChunks([
      { choices: [{ finish_reason: "stop", delta: { content: "hi" } }] },
    ]);

    expect(result.content).toBe("hi");
    expect(result.reasoningContent).toBeNull();
  });

  it("accumulates reasoning_content from SDK-like streaming chunks", () => {
    const result = OpenAICompatProvider.parseChunks([
      reasoningChunk("Think... ", null, null),
      reasoningChunk("Done.", null, null),
      reasoningChunk(null, "result", "stop"),
    ]);

    expect(result.content).toBe("result");
    expect(result.reasoningContent).toBe("Think... Done.");
  });

  it("returns null reasoning_content when SDK-like streaming chunks omit it", () => {
    const result = OpenAICompatProvider.parseChunks([reasoningChunk(null, "hello", "stop")]);

    expect(result.reasoningContent).toBeNull();
  });

  it("extracts reasoning summaries from Responses output", () => {
    const result = parseResponseOutput({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "step 1" }, { type: "summary_text", text: " step 2" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
      status: "completed",
    });

    expect(result.reasoningContent).toBe("step 1 step 2");
    expect(result.content).toBe("done");
  });
});
