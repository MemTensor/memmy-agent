import { createProviderAbortError, LLMResponse, ToolCallRequest } from "../base.js";
import { parseToolArguments } from "../tool-json.js";

export const FINISH_REASON_MAP: Record<string, string> = {
  completed: "stop",
  incomplete: "length",
  failed: "error",
  cancelled: "error",
};

export function mapFinishReason(status?: string | null): string {
  if (!status) return "stop";
  return FINISH_REASON_MAP[status] ?? "stop";
}

export async function* iterSse(response: Response): AsyncGenerator<any> {
  const emit = async function* (eventText: string): AsyncGenerator<any> {
    const dataLines = eventText
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith("data:"))
      .map((line) => line.slice(line.indexOf("data:") + 5).trim());
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;
    try {
      yield JSON.parse(payload);
    } catch (error) {
      if (dataLines.length <= 1) throw error;
      for (const linePayload of dataLines) {
        if (!linePayload || linePayload === "[DONE]") continue;
        yield JSON.parse(linePayload);
      }
    }
  };

  if (!response.body) {
    for await (const event of emit(await response.text())) yield event;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for await (const event of emit(part)) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for await (const event of emit(buffer)) yield event;
  }
}

export function parseResponseOutput(response: any): LLMResponse {
  const data =
    typeof response?.toJSON === "function"
      ? response.toJSON()
      : response;
  const output = data.output ?? [];
  const text = output
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content ?? [])
    .filter((c: any) => c.type === "output_text" || c.text)
    .map((c: any) => c.text ?? "")
    .join("");
  const reasoning = output
    .filter((item: any) => item.type === "reasoning")
    .flatMap((item: any) => item.summary ?? [])
    .map((item: any) => item.text ?? "")
    .join("");
  const calls = output
    .filter((item: any) => item.type === "function_call")
    .map((item: any) => {
      const args = parseToolArguments(item.arguments);
      return new ToolCallRequest({ id: `${item.call_id ?? "call_0"}|${item.id ?? "fc_0"}`, name: item.name, arguments: args });
    });
  const usageRaw = data.usage ?? {};
  const usage = {
    prompt_tokens: usageRaw.prompt_tokens ?? usageRaw.input_tokens ?? 0,
    completion_tokens: usageRaw.completion_tokens ?? usageRaw.output_tokens ?? 0,
    total_tokens: usageRaw.total_tokens ?? 0,
    ...Object.fromEntries(
      Object.entries(usageRaw).filter(([key]) => !["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "total_tokens"].includes(key)),
    ),
  };
  return new LLMResponse({
    content: text || null,
    toolCalls: calls,
    finishReason: mapFinishReason(data.status),
    usage,
    reasoningContent: reasoning || null,
  });
}

export async function consumeSse(response: Response): Promise<LLMResponse> {
  let last: any = null;
  for await (const event of iterSse(response)) last = event;
  return parseResponseOutput(last ?? {});
}

export async function consumeSdkStream(
  stream: AsyncIterable<any>,
  callbacks: {
    onContentDelta?: (delta: string) => Promise<void> | void;
    onToolCallDelta?: (delta: Record<string, any>) => Promise<void> | void;
    signal?: AbortSignal | null;
  } = {},
): Promise<[string, ToolCallRequest[], string, Record<string, any>, string | null]> {
  let text = "";
  let finish = "stop";
  let usage: Record<string, any> = {};
  let reasoning: string | null = null;
  const toolItems = new Map<string, any>();
  const contentCb = callbacks.onContentDelta;
  const toolCb = callbacks.onToolCallDelta;
  const signal = callbacks.signal ?? null;
  for await (const event of stream) {
    if (signal?.aborted) throw createProviderAbortError();
    const type = event.type;
    if (type === "error" || type === "response.failed") {
      throw new RuntimeError(`Response failed: ${event.error ?? event.message ?? "unknown error"}`);
    }
    if (type === "response.output_text.delta") {
      text += event.delta ?? "";
      if (contentCb && !signal?.aborted) await contentCb(event.delta ?? "");
    } else if (type === "response.output_item.added" && event.item?.type === "function_call") {
      toolItems.set(event.item.call_id, {
        call_id: event.item.call_id,
        id: event.item.id,
        name: event.item.name,
        arguments: event.item.arguments ?? "",
      });
      if (toolCb && !signal?.aborted) await toolCb({ call_id: event.item.call_id, name: event.item.name, arguments_delta: "" });
    } else if (type === "response.function_call_arguments.delta") {
      const item = toolItems.get(event.call_id) ?? { call_id: event.call_id, id: "fc_0", name: "" };
      item.arguments = `${item.arguments ?? ""}${event.delta ?? ""}`;
      toolItems.set(event.call_id, item);
      if (toolCb && !signal?.aborted) await toolCb({ call_id: event.call_id, name: item.name, arguments_delta: event.delta ?? "" });
    } else if (type === "response.function_call_arguments.done") {
      const item = toolItems.get(event.call_id) ?? { call_id: event.call_id, id: "fc_0", name: "" };
      item.arguments = event.arguments ?? item.arguments ?? "";
      toolItems.set(event.call_id, item);
    } else if (type === "response.output_item.done" && event.item?.type === "function_call") {
      toolItems.set(event.item.call_id, {
        call_id: event.item.call_id,
        id: event.item.id,
        name: event.item.name,
        arguments: event.item.arguments ?? toolItems.get(event.item.call_id)?.arguments ?? "",
      });
    } else if (type === "response.completed") {
      finish = mapFinishReason(event.response?.status);
      const u = event.response?.usage;
      if (u) {
        usage = {
          prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
          ...Object.fromEntries(
            Object.entries(u).filter(([key]) => !["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "total_tokens"].includes(key)),
          ),
        };
      }
      const summaries = (event.response?.output ?? [])
        .filter((item: any) => item.type === "reasoning")
        .flatMap((item: any) => item.summary ?? [])
        .map((item: any) => item.text ?? "")
        .join("");
      reasoning = summaries || null;
    }
  }
  const calls = [...toolItems.values()].map((item) => {
    const args = parseToolArguments(item.arguments);
    return new ToolCallRequest({ id: `${item.call_id ?? "call_0"}|${item.id ?? "fc_0"}`, name: item.name, arguments: args });
  });
  return [text, calls, finish, usage, reasoning];
}

export class RuntimeError extends Error {}
