export type ProgressEvent = { type: string; [key: string]: any };
export type ProgressOptions = {
  toolHint?: boolean;
  toolEvents?: Array<Record<string, any>> | null;
  fileEditEvents?: Array<Record<string, any>> | null;
  reasoning?: boolean;
  reasoningEnd?: boolean;
  [key: string]: any;
};
export type ProgressCallback = (content: string, opts?: ProgressOptions) => Promise<void> | void;
export type ProgressCapabilities = {
  toolEvents?: boolean;
  fileEditEvents?: boolean;
  reasoning?: boolean;
};

const PROGRESS_CAPABILITIES = Symbol.for("memmy.progressCapabilities");

export function progressEvent(type: string, data: Record<string, any> = {}): ProgressEvent {
  return { type, ...data };
}

function readProgressCapabilities(cb: (...args: any[]) => any): ProgressCapabilities {
  const anyCb = cb as any;
  return {
    ...(anyCb.progressCapabilities ?? {}),
    ...(anyCb[PROGRESS_CAPABILITIES] ?? {}),
  };
}

function acceptsOptions(
  cb: (...args: any[]) => any,
  capability: keyof ProgressCapabilities,
  ...legacyMarkers: string[]
): boolean {
  const caps = readProgressCapabilities(cb);
  const anyCb = cb as any;
  return Boolean(caps[capability]) || legacyMarkers.some((marker) => Boolean(anyCb[marker]));
}

export function withProgressCapabilities<T extends ProgressCallback>(
  cb: T,
  capabilities: ProgressCapabilities,
): T {
  const normalized: ProgressCapabilities = {
    toolEvents: Boolean(capabilities.toolEvents),
    fileEditEvents: Boolean(capabilities.fileEditEvents),
    reasoning: Boolean(capabilities.reasoning),
  };
  Object.defineProperty(cb, "progressCapabilities", {
    configurable: true,
    enumerable: false,
    value: normalized,
  });
  Object.defineProperty(cb, PROGRESS_CAPABILITIES, {
    configurable: true,
    enumerable: false,
    value: normalized,
  });
  const anyCb = cb as any;
  if (normalized.toolEvents) anyCb.acceptsToolEvents = true;
  if (normalized.fileEditEvents) anyCb.acceptsFileEditEvents = true;
  if (normalized.reasoning) {
    anyCb.acceptsReasoning = true;
    anyCb.reasoning = true;
  }
  return cb;
}

export function onProgressAcceptsToolEvents(cb: (...args: any[]) => any): boolean {
  return acceptsOptions(cb, "toolEvents", "acceptsToolEvents");
}

export function onProgressAcceptsFileEditEvents(cb: (...args: any[]) => any): boolean {
  return acceptsOptions(cb, "fileEditEvents", "acceptsFileEditEvents");
}

export function onProgressAcceptsReasoning(cb: (...args: any[]) => any): boolean {
  return acceptsOptions(cb, "reasoning", "acceptsReasoning", "reasoning");
}

export async function invokeOnProgress(
  onProgress: (...args: any[]) => Promise<void> | void,
  content: string,
  {
    toolHint = false,
    toolEvents = null,
  }: {
    toolHint?: boolean;
    toolEvents?: Array<Record<string, any>> | null;
  } = {},
): Promise<void> {
  if (toolEvents?.length && onProgressAcceptsToolEvents(onProgress)) {
    await onProgress(content, { toolHint, toolEvents });
    return;
  }
  await onProgress(content, { toolHint });
}

export async function invokeFileEditProgress(
  onProgress: (...args: any[]) => Promise<void> | void,
  fileEditEvents: Array<Record<string, any>>,
): Promise<void> {
  if (!fileEditEvents.length || !onProgressAcceptsFileEditEvents(onProgress)) return;
  await onProgress("", { fileEditEvents });
}

export function buildToolEventStartPayload(toolCall: any): Record<string, any> {
  return {
    version: 1,
    phase: "start",
    call_id: String(toolCall?.id ?? ""),
    name: toolCall?.name ?? toolCall?.function?.name ?? "",
    arguments: toolCall?.arguments ?? {},
    result: null,
    error: null,
    files: [],
    embeds: [],
  };
}

export function toolEventResultExtras(result: any): [any[], any[]] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [[], []];
  return [
    Array.isArray(result.files) ? result.files : [],
    Array.isArray(result.embeds) ? result.embeds : [],
  ];
}

export function buildToolEventFinishPayloads(context: any): Array<Record<string, any>> {
  const toolCalls = context.toolCalls ?? [];
  const toolResults = context.toolResults ?? [];
  const toolEvents = context.toolEvents ?? [];
  const count = Math.min(toolCalls.length, toolResults.length, toolEvents.length);
  const payloads: Array<Record<string, any>> = [];
  for (let idx = 0; idx < count; idx += 1) {
    const call = toolCalls[idx];
    const result = toolResults[idx];
    const event = toolEvents[idx] && typeof toolEvents[idx] === "object" ? toolEvents[idx] : {};
    const phase = event.status === "ok" ? "end" : "error";
    const [files, embeds] = toolEventResultExtras(result);
    const payload: Record<string, any> = {
      version: 1,
      phase,
      call_id: String(call?.id ?? ""),
      name: call?.name ?? call?.function?.name ?? "",
      arguments: call?.arguments ?? {},
      result: phase === "end" ? result : null,
      error: null,
      files,
      embeds,
    };
    if (phase === "error")
      payload.error =
        typeof result === "string" && result.trim()
          ? result.trim()
          : String(event.detail ?? "Tool execution failed");
    payloads.push(payload);
  }
  return payloads;
}
