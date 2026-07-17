import { describe, expect, it } from "vitest";
import {
  consumeSdkStream,
  convertMessages,
  convertTools,
  convertUserMessage,
  FINISH_REASON_MAP,
  mapFinishReason,
  parseResponseOutput,
  splitToolCallId,
} from "../../src/providers/openai-responses/index.js";

async function* streamFrom(events: any[]): AsyncGenerator<any> {
  for (const event of events) yield event;
}

describe("OpenAI Responses splitToolCallId", () => {
  it("returns a plain call id", () => {
    expect(splitToolCallId("call_abc")).toEqual(["call_abc", null]);
  });

  it("splits compound call and response item ids", () => {
    expect(splitToolCallId("call_abc|fc_1")).toEqual(["call_abc", "fc_1"]);
  });

  it("treats empty compound item ids as absent", () => {
    expect(splitToolCallId("call_abc|")).toEqual(["call_abc", null]);
  });

  it("falls back for null ids", () => {
    expect(splitToolCallId(null)).toEqual(["call_0", null]);
  });

  it("falls back for empty string ids", () => {
    expect(splitToolCallId("")).toEqual(["call_0", null]);
  });

  it("falls back for non-string ids", () => {
    expect(splitToolCallId(42)).toEqual(["call_0", null]);
  });
});

describe("OpenAI Responses convertUserMessage", () => {
  it("converts string content", () => {
    expect(convertUserMessage("hello")).toEqual({ role: "user", content: [{ type: "input_text", text: "hello" }] });
  });

  it("converts text blocks", () => {
    expect(convertUserMessage([{ type: "text", text: "hi" }]).content).toEqual([{ type: "input_text", text: "hi" }]);
  });

  it("converts image_url blocks", () => {
    expect(convertUserMessage([{ type: "image_url", image_url: { url: "https://img.example/a.png" } }]).content).toEqual([
      { type: "input_image", image_url: "https://img.example/a.png", detail: "auto" },
    ]);
  });

  it("converts mixed text and image blocks", () => {
    const result = convertUserMessage([
      { type: "text", text: "what's this?" },
      { type: "image_url", image_url: { url: "https://img.example/b.png" } },
    ]);

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("input_text");
    expect(result.content[1].type).toBe("input_image");
  });

  it("falls back for empty lists", () => {
    expect(convertUserMessage([]).content).toEqual([{ type: "input_text", text: "" }]);
  });

  it("falls back for null content", () => {
    expect(convertUserMessage(null).content).toEqual([{ type: "input_text", text: "" }]);
  });

  it("skips image blocks without URLs", () => {
    expect(convertUserMessage([{ type: "image_url", image_url: {} }]).content).toEqual([{ type: "input_text", text: "" }]);
  });

  it("does not leak metadata fields from content blocks", () => {
    const result = convertUserMessage([{ type: "text", text: "hi", meta: { path: "/tmp/x" } }]);

    expect(result.content[0]).not.toHaveProperty("meta");
  });

  it("skips non-object content items", () => {
    expect(convertUserMessage(["just a string", 42]).content).toEqual([{ type: "input_text", text: "" }]);
  });
});

describe("OpenAI Responses convertMessages", () => {
  it("extracts system messages as instructions", () => {
    const [instructions, items] = convertMessages([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ]);

    expect(instructions).toBe("You are helpful.");
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe("user");
  });

  it("uses the last system message as instructions", () => {
    const [instructions] = convertMessages([
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "x" },
    ]);

    expect(instructions).toBe("second");
  });

  it("converts user messages", () => {
    const [, items] = convertMessages([{ role: "user", content: "hello" }]);

    expect(items[0].role).toBe("user");
    expect(items[0].content[0].type).toBe("input_text");
  });

  it("converts assistant text messages", () => {
    const [, items] = convertMessages([{ role: "assistant", content: "I'll help" }]);

    expect(items[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "I'll help" }],
    });
    expect(items[0].id).toBe("msg_0");
  });

  it("skips assistant messages with empty content", () => {
    const [, items] = convertMessages([{ role: "assistant", content: "" }]);

    expect(items).toHaveLength(0);
  });

  it("converts assistant tool calls", () => {
    const [, items] = convertMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_abc|fc_1", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      },
    ]);

    expect(items[0]).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
      id: "fc_1",
      name: "get_weather",
      arguments: '{"city":"SF"}',
    });
  });

  it("deduplicates duplicate response item ids", () => {
    const [, items] = convertMessages([
      { role: "assistant", content: null, tool_calls: [{ id: "call_a|rs_same", function: { name: "first", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_a|rs_same", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_b|rs_same", function: { name: "second", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_b|rs_same", content: "ok" },
    ]);

    expect(items.filter((item) => item.type === "function_call").map((item) => item.id)).toEqual(["rs_same", "rs_same_2"]);
  });

  it("uses unique fallback response item ids for multiple tool calls", () => {
    const [, items] = convertMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", function: { name: "first", arguments: "{}" } },
          { id: "call_b", function: { name: "second", arguments: "{}" } },
        ],
      },
    ]);

    expect(items.filter((item) => item.type === "function_call").map((item) => item.id)).toEqual(["fc_0", "fc_0_2"]);
  });

  it("uses fallback ids for tool calls without ids", () => {
    const [, items] = convertMessages([
      { role: "assistant", content: null, tool_calls: [{ function: { name: "f1", arguments: "{}" } }] },
    ]);

    expect(items[0].call_id).toBe("call_0");
    expect(items[0].id).toBe("fc_0");
  });

  it("converts tool messages", () => {
    const [, items] = convertMessages([{ role: "tool", tool_call_id: "call_abc", content: "result text" }]);

    expect(items[0]).toEqual({ type: "function_call_output", call_id: "call_abc", output: "result text" });
  });

  it("stringifies non-string tool message content", () => {
    const [, items] = convertMessages([{ role: "tool", tool_call_id: "call_1", content: { key: "value" } }]);

    expect(items[0].output).toBe('{"key": "value"}');
  });

  it("does not leak non-standard message keys", () => {
    const [, items] = convertMessages([{ role: "user", content: "hi", extra_field: "should vanish", meta: { path: "/tmp" } }]);

    expect(JSON.stringify(items[0])).not.toContain("extra_field");
    expect(JSON.stringify(items[0])).not.toContain("meta");
  });

  it("converts a full conversation roundtrip", () => {
    const [instructions, items] = convertMessages([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Weather in SF?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1|fc1", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"temp":72}' },
    ]);

    expect(instructions).toBe("Be concise.");
    expect(items.map((item) => item.type ?? item.role)).toEqual(["user", "function_call", "function_call_output"]);
  });
});

describe("OpenAI Responses convertTools", () => {
  it("converts standard function tools", () => {
    const result = convertTools([
      { type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    ]);

    expect(result[0]).toMatchObject({ type: "function", name: "get_weather", description: "Get weather" });
    expect(result[0].parameters).toHaveProperty("properties");
  });

  it("skips tools without names", () => {
    expect(convertTools([{ type: "function", function: { parameters: {} } }])).toEqual([]);
  });

  it("converts tools without a function wrapper", () => {
    expect(convertTools([{ name: "f1", description: "d", parameters: {} }])[0].name).toBe("f1");
  });

  it("defaults missing optional tool fields", () => {
    expect(convertTools([{ type: "function", function: { name: "f" } }])[0]).toMatchObject({ description: "", parameters: {} });
  });

  it("converts multiple tools", () => {
    expect(convertTools([
      { type: "function", function: { name: "a", parameters: {} } },
      { type: "function", function: { name: "b", parameters: {} } },
    ])).toHaveLength(2);
  });
});

describe("OpenAI Responses mapFinishReason", () => {
  it("maps completed to stop", () => {
    expect(mapFinishReason("completed")).toBe("stop");
  });

  it("maps incomplete to length", () => {
    expect(mapFinishReason("incomplete")).toBe("length");
  });

  it("maps failed to error", () => {
    expect(mapFinishReason("failed")).toBe("error");
  });

  it("maps cancelled to error", () => {
    expect(mapFinishReason("cancelled")).toBe("error");
  });

  it("defaults null to stop", () => {
    expect(mapFinishReason(null)).toBe("stop");
  });

  it("defaults unknown statuses to stop", () => {
    expect(mapFinishReason("some_new_status")).toBe("stop");
  });

  it("exports the finish reason map", () => {
    expect(FINISH_REASON_MAP).toMatchObject({ completed: "stop", incomplete: "length", failed: "error", cancelled: "error" });
  });
});

describe("OpenAI Responses parseResponseOutput", () => {
  it("parses text responses", () => {
    const result = parseResponseOutput({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] }],
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });

    expect(result.content).toBe("Hello!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(result.toolCalls).toEqual([]);
  });

  it("parses tool call responses", () => {
    const result = parseResponseOutput({
      output: [{ type: "function_call", call_id: "call_1", id: "fc_1", name: "get_weather", arguments: '{"city": "SF"}' }],
      status: "completed",
      usage: {},
    });

    expect(result.content).toBeNull();
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].arguments).toEqual({ city: "SF" });
    expect(result.toolCalls[0].id).toBe("call_1|fc_1");
  });

  it("repairs malformed tool arguments when possible", () => {
    const result = parseResponseOutput({
      output: [{ type: "function_call", call_id: "c1", id: "fc1", name: "f", arguments: "{bad json" }],
      status: "completed",
      usage: {},
    });

    expect(result.toolCalls[0].arguments).toEqual({ "bad json": null });
  });

  it("extracts reasoning content", () => {
    const result = parseResponseOutput({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "I think " }, { type: "summary_text", text: "therefore I am." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "42" }] },
      ],
      status: "completed",
      usage: {},
    });

    expect(result.content).toBe("42");
    expect(result.reasoningContent).toBe("I think therefore I am.");
  });

  it("handles empty output", () => {
    const result = parseResponseOutput({ output: [], status: "completed", usage: {} });

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it("maps incomplete status", () => {
    expect(parseResponseOutput({ output: [], status: "incomplete", usage: {} }).finishReason).toBe("length");
  });

  it("handles SDK objects with toJSON", () => {
    const result = parseResponseOutput({
      toJSON: () => ({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "sdk" }] }],
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
    });

    expect(result.content).toBe("sdk");
    expect(result.usage.prompt_tokens).toBe(1);
  });

  it("maps Responses API usage keys", () => {
    const result = parseResponseOutput({
      output: [],
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });

    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  });
});

describe("OpenAI Responses consumeSdkStream", () => {
  it("consumes text streams", async () => {
    const [content, toolCalls, finish] = await consumeSdkStream(streamFrom([
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " world" },
      { type: "response.completed", response: { status: "completed", usage: null, output: [] } },
    ]));

    expect(content).toBe("Hello world");
    expect(toolCalls).toEqual([]);
    expect(finish).toBe("stop");
  });

  it("calls content delta callbacks", async () => {
    const deltas: string[] = [];

    await consumeSdkStream(streamFrom([
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response: { status: "completed", usage: null, output: [] } },
    ]), {
      onContentDelta: async (text) => {
        deltas.push(text);
      },
    });

    expect(deltas).toEqual(["hi"]);
  });

  it("consumes tool call streams", async () => {
    const [, toolCalls] = await consumeSdkStream(streamFrom([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", id: "fc1", name: "get_weather", arguments: "" } },
      { type: "response.function_call_arguments.delta", call_id: "c1", delta: '{"ci' },
      { type: "response.function_call_arguments.done", call_id: "c1", arguments: '{"city":"SF"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", id: "fc1", name: "get_weather", arguments: '{"city":"SF"}' } },
      { type: "response.completed", response: { status: "completed", usage: null, output: [] } },
    ]));

    expect(toolCalls[0].name).toBe("get_weather");
    expect(toolCalls[0].arguments).toEqual({ city: "SF" });
  });

  it("calls tool-call argument delta callbacks", async () => {
    const deltas: Record<string, any>[] = [];

    await consumeSdkStream(streamFrom([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", id: "fc1", name: "write_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", call_id: "c1", delta: '{"path":"a.txt","content":"' },
      { type: "response.function_call_arguments.delta", call_id: "c1", delta: "hello\\n" },
      { type: "response.function_call_arguments.done", call_id: "c1", arguments: '{"path":"a.txt","content":"hello\\n"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", id: "fc1", name: "write_file", arguments: '{"path":"a.txt","content":"hello\\n"}' } },
      { type: "response.completed", response: { status: "completed", usage: null, output: [] } },
    ]), {
      onToolCallDelta: async (delta) => {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual([
      { call_id: "c1", name: "write_file", arguments_delta: "" },
      { call_id: "c1", name: "write_file", arguments_delta: '{"path":"a.txt","content":"' },
      { call_id: "c1", name: "write_file", arguments_delta: "hello\\n" },
    ]);
  });

  it("extracts usage", async () => {
    const [, , , usage] = await consumeSdkStream(streamFrom([
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [] } },
    ]));

    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("extracts reasoning summaries", async () => {
    const [, , , , reasoning] = await consumeSdkStream(streamFrom([
      { type: "response.completed", response: { status: "completed", usage: null, output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] }] } },
    ]));

    expect(reasoning).toBe("thinking...");
  });

  it("throws on error events", async () => {
    await expect(consumeSdkStream(streamFrom([{ type: "error", error: "rate_limit_exceeded" }]))).rejects.toThrow(/Response failed.*rate_limit_exceeded/);
  });

  it("throws on failed events", async () => {
    await expect(consumeSdkStream(streamFrom([{ type: "response.failed", error: "server_error" }]))).rejects.toThrow(/Response failed.*server_error/);
  });

  it("repairs malformed streaming tool arguments when possible", async () => {
    const [, toolCalls] = await consumeSdkStream(streamFrom([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", id: "fc1", name: "f", arguments: "" } },
      { type: "response.function_call_arguments.done", call_id: "c1", arguments: "{bad" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", id: "fc1", name: "f", arguments: "{bad" } },
      { type: "response.completed", response: { status: "completed", usage: null, output: [] } },
    ]));

    expect(toolCalls[0].arguments).toEqual({ bad: null });
  });
});
