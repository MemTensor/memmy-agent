import { authenticateMemmateRuntime, createMemmatePermissionScope, memmatePermissionRequired, withMemmatePermission } from "../../core/agent-runtime/memmate-permission.js";
import { requestTiming, withRequestTiming } from "../../utils/request-timing.js";
import fs from "node:fs";
import path from "node:path";
import { Config } from "../../config/schema.js";
import { getMediaDir } from "../../config/paths.js";
import { InboundMessage } from "../../core/runtime-messages/events.js";
import { FileSizeExceeded, saveBase64DataUrl } from "../../utils/media-decode.js";
import { withProgressCapabilities } from "../../utils/progress-events.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../../utils/runtime.js";

export const API_SESSION_KEY = "api:default";
export const API_CHAT_ID = "default";
export const API_MAX_BODY_BYTES = 256 * 1024 * 1024;

export { FileSizeExceeded, saveBase64DataUrl };

export class RequestBodyTooLarge extends Error {
  constructor(message = "Request body exceeds 256MB limit") {
    super(message);
    this.name = "RequestBodyTooLarge";
  }
}

type ApiContext = {
  agentLoop: any;
  modelName: string;
  sessionLocks: Map<string, Promise<void>>;
  activeRequests: Map<string, { controller: AbortController; done: Promise<void> }>;
};

type ChatCompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export function errorJson(status: number, message: string, errType = "invalid_request_error"): Response {
  return Response.json({ error: { message, type: errType, code: status } }, { status });
}

function tokenCount(value: any): number | null {
  if (value == null || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
}

function normalizeChatUsage(usage: Record<string, any> | null | undefined): ChatCompletionUsage {
  const promptTokens = tokenCount(usage?.prompt_tokens) ?? 0;
  const completionTokens = tokenCount(usage?.completion_tokens) ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: tokenCount(usage?.total_tokens) ?? promptTokens + completionTokens,
  };
}

export function chatCompletionResponse(content: string, model: string, usage?: Record<string, any>): Record<string, any> {
  return {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: normalizeChatUsage(usage),
  };
}

function responseText(value: any): string {
  if (value == null) return "";
  if (typeof value?.content === "string") return value.content;
  return String(value);
}

/** Model failures are returned on the outbound message. A clean SSE close would look like success. */
function modelFailure(value: unknown): { message: string; code: string } | null {
  if (!value || typeof value !== "object") return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  if (typeof record.modelErrorCategory !== "string" || !record.modelErrorCategory.trim()) return null;
  // Prefer the user-facing text the API used to return, such as the localized
  // image-input message. The raw provider detail is only a fallback.
  const detail = typeof record.modelErrorDetail === "string" ? record.modelErrorDetail.trim() : "";
  const message = responseText(value).trim() || detail;
  if (!message) return null;
  return { message, code: record.modelErrorCategory.trim() };
}

function responseUsage(value: any): Record<string, any> {
  const usage = value?.metadata?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {};
}

function mergeUsageRecords(left: Record<string, any>, right: Record<string, any>): ChatCompletionUsage {
  const leftUsage = normalizeChatUsage(left);
  const rightUsage = normalizeChatUsage(right);
  return {
    prompt_tokens: leftUsage.prompt_tokens + rightUsage.prompt_tokens,
    completion_tokens: leftUsage.completion_tokens + rightUsage.completion_tokens,
    total_tokens: leftUsage.total_tokens + rightUsage.total_tokens,
  };
}

export function sseChunk(delta: string, model: string, chunkId: string, finishReason: string | null = null): string {
  const payload = {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: delta ? { content: delta } : {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseMemmyEvent(type: string, payload: Record<string, any>, model: string, chunkId: string): string {
  return `data: ${JSON.stringify({
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    memmy_event: { type, ...payload },
  })}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

function safeFilename(name: string): string {
  const base = path.basename(name || "upload.bin").replace(/[^A-Za-z0-9._-]+/g, "_");
  return base || "upload.bin";
}

export function parseJsonContent(body: Record<string, any>): [string, string[]] {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    throw new Error("Only a single user message is supported");
  }
  const message = messages[0];
  if (!message || typeof message !== "object" || message.role !== "user") {
    throw new Error("Only a single user message is supported");
  }

  const content = message.content ?? "";
  const mediaDir = getMediaDir("api");
  const mediaPaths: string[] = [];

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") textParts.push(String(part.text ?? ""));
      else if (part.type === "image_url") {
        const url = String(part.image_url?.url ?? "");
        if (url.startsWith("data:")) {
          const saved = saveBase64DataUrl(url, mediaDir);
          if (saved) mediaPaths.push(saved);
        } else if (url) {
          throw new Error("Remote image URLs are not supported. Use base64 data URLs or upload files via multipart/form-data.");
        }
      }
    }
    return [textParts.join(" "), mediaPaths];
  }
  if (typeof content === "string") return [content, mediaPaths];
  throw new Error("Invalid content format");
}

async function parseMultipart(request: Request): Promise<[string, string[], string | null, string | null]> {
  const form = await request.formData();
  const mediaDir = getMediaDir("api");
  fs.mkdirSync(mediaDir, { recursive: true });
  let text = "";
  let sessionId: string | null = null;
  let model: string | null = null;
  const mediaPaths: string[] = [];

  for (const [name, value] of form.entries()) {
    if (name === "message" && typeof value === "string") text = value;
    else if (name === "session_id" && typeof value === "string") sessionId = value.trim();
    else if (name === "model" && typeof value === "string") model = value.trim();
    else if (name === "files" && value && typeof value === "object" && "arrayBuffer" in value) {
      const file = value as File;
      const raw = Buffer.from(await file.arrayBuffer());
      const dest = path.join(mediaDir, `${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_${safeFilename(file.name || "upload.bin")}`);
      fs.writeFileSync(dest, raw);
      mediaPaths.push(dest);
    }
  }

  if (!text) text = "请分析上传的文件";
  return [text, mediaPaths, sessionId, model];
}

async function withSessionLock<T>(ctx: ApiContext, sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = ctx.sessionLocks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  ctx.sessionLocks.set(sessionKey, queued);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (ctx.sessionLocks.get(sessionKey) === queued) ctx.sessionLocks.delete(sessionKey);
  }
}

async function callAgent(ctx: ApiContext, args: Record<string, any>): Promise<any> {
  const loop = ctx.agentLoop;
  const directOptions = {
    media: args.media ?? [],
    sessionKey: args.sessionKey ?? args.session_key,
    channel: args.channel,
    chatId: args.chatId ?? args.chat_id,
    metadata: args.metadata,
    onProgress: args.onProgress,
    onStream: args.onStream,
    onStreamEnd: args.onStreamEnd,
    abortSignal: args.abortSignal,
  };
  const isAgentLoopStyle = typeof loop?.processMessageInternal === "function";
  if (typeof loop?.processDirect === "function") {
    return isAgentLoopStyle ? loop.processDirect(args.content, directOptions) : loop.processDirect(args);
  }
  if (typeof loop?.processMessage === "function") {
    return loop.processMessage(
      new InboundMessage({
        channel: args.channel,
        chatId: args.chat_id ?? args.chatId,
        senderId: "api",
        content: args.content,
        media: args.media ?? [],
        metadata: args.metadata,
        sessionKey: args.session_key ?? args.sessionKey,
      }),
      args.session_key ?? args.sessionKey,
      { abortSignal: args.abortSignal },
    );
  }
  if (typeof loop === "function") return loop(args);
  throw new Error("API agent loop does not expose processDirect/processMessage");
}

export async function handleChatCompletions(request: Request, ctx?: ApiContext): Promise<Response> {
  return withRequestTiming(request.headers.get("x-memmy-trace-id"), () => handleTimedChatCompletions(request, ctx));
}

async function handleTimedChatCompletions(request: Request, ctx?: ApiContext): Promise<Response> {
  const context = ctx ?? {
    agentLoop: null,
    modelName: "memmy",
    sessionLocks: new Map<string, Promise<void>>(),
    activeRequests: new Map(),
  };
  const managed = memmatePermissionRequired();
  if (managed && !authenticateMemmateRuntime(request)) return errorJson(401, "MemMate runtime authentication required");
  const controller = new AbortController();
  const permissionAbort = new AbortController();
  const permissionSignal = AbortSignal.any([request.signal, permissionAbort.signal, controller.signal]);
  let permission: ReturnType<typeof createMemmatePermissionScope> | undefined;
  const contentType = request.headers.get("content-type") ?? "";
  let text = "";
  let mediaPaths: string[] = [];
  let sessionId: string | null | undefined;
  let requestedModel: string | null | undefined;
  let stream = false;
  let requestId: string = crypto.randomUUID();

  try {
    if (contentType.startsWith("multipart/")) {
      if (managed) return errorJson(400, "Managed requests require a JSON approval context");
      [text, mediaPaths, sessionId, requestedModel] = await parseMultipart(request);
    } else {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return errorJson(400, "Invalid JSON body");
      }
      if (managed) permission = createMemmatePermissionScope(body.memmate_permission, permissionSignal);
      stream = Boolean(body.stream);
      requestedModel = body.model;
      [text, mediaPaths] = parseJsonContent(body);
      sessionId = body.session_id;
      if (body.request_id !== undefined) {
        if (typeof body.request_id !== "string" || !body.request_id.trim() || body.request_id.length > 4096) {
          return errorJson(400, "Invalid request_id");
        }
        requestId = body.request_id;
      }
    }
  } catch (err) {
    if (err instanceof FileSizeExceeded) return errorJson(413, err.message);
    return errorJson(400, (err as Error).message);
  }

  if (requestedModel && requestedModel !== context.modelName) {
    return errorJson(400, `Only configured model '${context.modelName}' is available`);
  }

  const sessionKey = sessionId ? `api:${sessionId}` : API_SESSION_KEY;
  const requestKey = JSON.stringify([sessionKey, requestId]);
  if (context.activeRequests.has(requestKey)) return errorJson(409, "Request is already running");
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  context.activeRequests.set(requestKey, { controller, done });
  const finishRequest = (): void => {
    context.activeRequests.delete(requestKey);
    finish();
  };
  const baseArgs = {
    abortSignal: controller.signal,
    content: text,
    media: mediaPaths.length ? mediaPaths : null,
    session_key: sessionKey,
    sessionKey,
    channel: "api",
    chat_id: API_CHAT_ID,
    chatId: API_CHAT_ID,
    // An explicit API model selects this server's configured default, overriding a stale session binding.
    ...(requestedModel && typeof context.agentLoop?.modelPreset === "string"
      ? { metadata: { model_preset: context.agentLoop.modelPreset } } : {}),
  };

  const invoke = (args: Record<string, any>) => withMemmatePermission(permission, () => callAgent(context, args));
  const endPermission = () => { if (permission) permission.active = false; permissionAbort.abort(); };

  if (stream) {
    const chunkId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
    const encoder = new TextEncoder();
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        let emitted = false;
        const write = (chunk: string): void => {
          if (closed) return;
          try {
            streamController.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        if (permission) permission.onEvent = event => write(`data: ${JSON.stringify({ memmy_event: event })}\n\n`);
        const close = (): void => {
          if (closed) return;
          closed = true;
          try {
            streamController.close();
          } catch {
            // The client may have already disconnected.
          }
        };
        void (async () => {
          let failed = false;
          const onStream = async (token: string) => {
            if (controller.signal.aborted) return;
            if (token) requestTiming("api.first_content", true);
            if (token) emitted = true;
            write(sseChunk(token, context.modelName, chunkId));
          };
          const onProgress = withProgressCapabilities(async (content: string, options: Record<string, any> = {}) => {
            if (controller.signal.aborted) return;
            if (options.reasoning && content) requestTiming("api.first_reasoning", true);
            if (options.reasoning && content) write(sseMemmyEvent("thinking_delta", { text: content }, context.modelName, chunkId));
            if (options.reasoningEnd) write(sseMemmyEvent("thinking_end", {}, context.modelName, chunkId));
            for (const event of options.toolEvents ?? []) {
              const phase = String(event?.phase ?? "");
              if (phase === "start") {
                if (!permission) write(sseMemmyEvent("tool_call", {
                  callId: String(event.call_id ?? event.ui_tool_call_id ?? "call"),
                  name: String(event.name ?? "tool"),
                  input: event.arguments ?? {},
                }, context.modelName, chunkId));
              } else if (phase === "end" || phase === "error") {
                if (!permission) write(sseMemmyEvent("tool_result", {
                  callId: String(event.call_id ?? event.ui_tool_call_id ?? "call"),
                  name: String(event.name ?? "tool"),
                  output: phase === "error" ? event.error ?? "Tool execution failed" : event.result ?? null,
                  ok: phase === "end",
                }, context.modelName, chunkId));
                for (const media of mediaFromToolEvent(event)) {
                  write(sseMemmyEvent("media", { media: [media] }, context.modelName, chunkId));
                }
              }
            }
          }, { reasoning: true, toolEvents: true });
          const onStreamEnd = async () => undefined;
          try {
            await withSessionLock(context, sessionKey, async () => {
              controller.signal.throwIfAborted();
              requestTiming("api.session_lock_acquired");
              // Model and tool calls own their deadlines; a whole turn has none.
              const response = await invoke({
                ...baseArgs,
                onProgress,
                onStream,
                onStreamEnd,
              });
              controller.signal.throwIfAborted();
              const failure = modelFailure(response);
              if (failure) {
                write(`data: ${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n\n`);
                failed = true;
              } else if (!emitted) {
                const finalText = responseText(response);
                if (finalText.trim()) write(sseChunk(finalText, context.modelName, chunkId));
              }
            });
          } catch (error) {
            requestTiming("api.error");
            failed = true;
            const selectionUnavailable = error instanceof Error && error.message === "model_selection_unavailable";
            write(`data: ${JSON.stringify({ error: {
              code: controller.signal.aborted ? "cancelled" : selectionUnavailable ? "model_selection_unavailable" : "server_error",
              message: controller.signal.aborted ? "Task cancelled by user." : selectionUnavailable ? "会话绑定的模型已不可用，请重新选择模型。" : "Memmy runtime failed while processing the request.",
            } })}\n\n`);
          } finally {
            endPermission();
            if (!failed) {
              write(sseChunk("", context.modelName, chunkId, "stop"));
              write(SSE_DONE);
            }
            requestTiming("api.finished");
            close();
            finishRequest();
          }
        })();
      },
      cancel() {
        closed = true;
        endPermission();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  try {
    const reply = await withSessionLock(context, sessionKey, async () => {
      controller.signal.throwIfAborted();
      const first = await invoke(baseArgs);
      controller.signal.throwIfAborted();
      const firstFailure = modelFailure(first);
      if (firstFailure) return { text: "", usage: responseUsage(first), failure: firstFailure };
      let textResponse = responseText(first);
      let usage = responseUsage(first);
      if (!textResponse.trim()) {
        const retry = await invoke(baseArgs);
        controller.signal.throwIfAborted();
        const retryFailure = modelFailure(retry);
        if (retryFailure) return { text: "", usage: mergeUsageRecords(usage, responseUsage(retry)), failure: retryFailure };
        textResponse = responseText(retry);
        usage = mergeUsageRecords(usage, responseUsage(retry));
        if (!textResponse.trim()) textResponse = EMPTY_FINAL_RESPONSE_MESSAGE;
      }
      return { text: textResponse, usage, failure: null };
    });
    if (reply.failure) return errorJson(502, reply.failure.message, "server_error");
    return Response.json(chatCompletionResponse(reply.text, context.modelName, reply.usage));
  } catch {
    if (controller.signal.aborted) return errorJson(409, "Task cancelled by user.", "cancelled");
    return errorJson(500, "Internal server error", "server_error");
  } finally {
    endPermission();
    finishRequest();
  }
}

async function handleCancel(request: Request, ctx: ApiContext): Promise<Response> {
  if (memmatePermissionRequired() && !authenticateMemmateRuntime(request)) return errorJson(401, "MemMate runtime authentication required");
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, "Invalid JSON body");
  }
  if (typeof body?.session_id !== "string" || !body.session_id.trim()
    || typeof body?.request_id !== "string" || !body.request_id.trim()) {
    return errorJson(400, "session_id and request_id are required");
  }
  const key = JSON.stringify([`api:${body.session_id}`, body.request_id]);
  const active = ctx.activeRequests.get(key);
  if (!active) return errorJson(404, "Running request not found");
  active.controller.abort();
  await active.done;
  return Response.json({ status: "cancelled" });
}

function mediaFromToolEvent(event: Record<string, any>): Array<Record<string, string>> {
  const media: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  const push = (item: Record<string, string>): void => {
    const key = `${item.kind}:${item.url ?? item.path ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    media.push(item);
  };
  const add = (value: any): void => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "resource_link" && typeof value.uri === "string" && value.uri.trim()) {
      const mime = typeof value.mimeType === "string" ? value.mimeType : "";
      const kind = mime.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg)$/iu.test(value.uri) ? "image" : "file";
      push({ kind, ...(value.uri.startsWith("http") || value.uri.startsWith("data:") ? { url: value.uri } : { path: value.uri }), ...(typeof value.name === "string" && value.name ? { name: value.name } : {}) });
      return;
    }
    if (value.type === "image_url" && typeof value.image_url?.url === "string" && value.image_url.url.trim()) {
      push({ kind: "image", url: value.image_url.url });
      return;
    }
    for (const child of [value.files, value.embeds, value.content, value.result]) add(child);
  };
  for (const file of event.files ?? []) {
    if (typeof file === "string" && file.trim()) add({ type: "resource_link", uri: file });
  }
  add(event.embeds);
  add(event.result);
  return media;
}

export async function handleModels(request?: Request, ctx?: Pick<ApiContext, "modelName">): Promise<Response> {
  void request;
  const model = ctx?.modelName ?? "memmy";
  return Response.json({
    object: "list",
    data: [{ id: model, object: "model", created: 0, owned_by: "memmy-agent" }],
  });
}

export async function handleHealth(): Promise<Response> {
  return Response.json({ status: "ok", ...(memmatePermissionRequired() ? { memmatePermissionProtocol: 1, memmateExecutionProtocol: 2, memmatePermissionRequired: true, memmateMacosSandbox: process.env.MEMMATE_MACOS_SANDBOX === "1" } : {}) });
}

export function createApp(
  agentLoopOrConfig: any = null,
  modelName = "memmy",
  // Accepted for callers built against older runtimes; never limits a turn.
  _legacyRequestTimeout?: number,
): { fetch: (request: Request) => Promise<Response>; context: ApiContext } {
  const agentLoop = agentLoopOrConfig instanceof Config || agentLoopOrConfig == null ? null : agentLoopOrConfig;
  const ctx: ApiContext = {
    agentLoop,
    modelName,
    sessionLocks: new Map<string, Promise<void>>(),
    activeRequests: new Map(),
  };
  return {
    context: ctx,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return handleHealth();
      if (url.pathname === "/v1/models" && request.method === "GET") return handleModels(request, ctx);
      if (url.pathname === "/v1/chat/cancel" && request.method === "POST") return handleCancel(request, ctx);
      if (url.pathname === "/v1/chat/completions" && request.method === "POST") return handleChatCompletions(request, ctx);
      return errorJson(404, "not found");
    },
  };
}
