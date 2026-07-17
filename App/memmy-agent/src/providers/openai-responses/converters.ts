export function splitToolCallId(toolCallId: any): [string, string | null] {
  if (typeof toolCallId !== "string" || !toolCallId) return ["call_0", null];
  const idx = toolCallId.indexOf("|");
  if (idx < 0) return [toolCallId, null];
  return [toolCallId.slice(0, idx) || "call_0", toolCallId.slice(idx + 1) || null];
}

export function convertMessages(messages: Record<string, any>[]): [string, Record<string, any>[]] {
  let instructions = "";
  const items: Record<string, any>[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (id: string) => {
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
    let n = 2;
    while (usedIds.has(`${id}_${n}`)) n += 1;
    const next = `${id}_${n}`;
    usedIds.add(next);
    return next;
  };
  for (const [idx, msg] of messages.entries()) {
    if (msg.role === "system") {
      instructions = String(msg.content ?? "");
    } else if (msg.role === "user") {
      items.push(convertUserMessage(msg.content));
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
          status: "completed",
          id: uniqueId(`msg_${idx}`),
        });
      }
      for (const call of msg.tool_calls ?? []) {
        const [callId, itemId] = splitToolCallId(call.id);
        items.push({
          type: "function_call",
          call_id: callId,
          id: uniqueId(itemId ?? `fc_${idx}`),
          name: call.function?.name ?? call.name ?? "",
          arguments: call.function?.arguments ?? JSON.stringify(call.arguments ?? {}),
        });
      }
    } else if (msg.role === "tool") {
      const [callId] = splitToolCallId(msg.tool_call_id);
      const content = typeof msg.content === "string" ? msg.content : jsonDumpsDefault(msg.content ?? "");
      items.push({ type: "function_call_output", call_id: callId, output: content });
    }
  }
  return [instructions, items];
}

export function convertUserMessage(content: any): Record<string, any> {
  const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  const converted: Record<string, any>[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if ((block.type === "text" || block.type === "input_text") && block.text != null) {
      converted.push({ type: "input_text", text: String(block.text) });
    } else if (block.type === "image_url" && block.image_url?.url) {
      converted.push({ type: "input_image", image_url: block.image_url.url, detail: block.image_url.detail ?? "auto" });
    }
  }
  if (!converted.length) converted.push({ type: "input_text", text: "" });
  return { role: "user", content: converted };
}

export function convertTools(tools: Record<string, any>[]): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const tool of tools) {
    const fn = tool.function ?? tool;
    if (!fn.name) continue;
    const parameters = fn.parameters;
    out.push({
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      parameters: parameters && typeof parameters === "object" && !Array.isArray(parameters) ? parameters : {},
    });
  }
  return out;
}

function jsonDumpsDefault(value: any): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => jsonDumpsDefault(item)).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${jsonDumpsDefault(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}
