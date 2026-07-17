import fs from "node:fs";
import path from "node:path";
import { Config } from "../../config/schema.js";
import { getMediaDir } from "../../config/paths.js";
import { InboundMessage } from "../../core/runtime-messages/events.js";
import { FileSizeExceeded, MAX_FILE_SIZE, saveBase64DataUrl } from "../../utils/media-decode.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../../utils/runtime.js";

export const API_SESSION_KEY = "api:default";
export const API_CHAT_ID = "default";
export const API_MAX_BODY_BYTES = 20 * 1024 * 1024;

export { FileSizeExceeded, MAX_FILE_SIZE, saveBase64DataUrl };

export class RequestBodyTooLarge extends Error {
  constructor(message = "Request body exceeds 20MB limit") {
    super(message);
    this.name = "RequestBodyTooLarge";
  }
}

type ApiContext = {
  agentLoop: any;
  modelName: string;
  requestTimeout: number;
  sessionLocks: Map<string, Promise<void>>;
};

export function errorJson(status: number, message: string, errType = "invalid_request_error"): Response {
  return Response.json({ error: { message, type: errType, code: status } }, { status });
}

export function chatCompletionResponse(content: string, model: string): Record<string, any> {
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
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function responseText(value: any): string {
  if (value == null) return "";
  if (typeof value?.content === "string") return value.content;
  return String(value);
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
      if (raw.length > MAX_FILE_SIZE) {
        throw new FileSizeExceeded(`File '${file.name || "upload.bin"}' exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
      }
      const dest = path.join(mediaDir, `${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_${safeFilename(file.name || "upload.bin")}`);
      fs.writeFileSync(dest, raw);
      mediaPaths.push(dest);
    }
  }

  if (!text) text = "请分析上传的文件";
  return [text, mediaPaths, sessionId, model];
}

async function withTimeout<T>(promise: Promise<T>, timeoutS: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => reject(new Error(`Request timed out after ${timeoutS}s`)), timeoutS * 1000);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withSessionLock<T>(ctx: ApiContext, sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = ctx.sessionLocks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  ctx.sessionLocks.set(sessionKey, previous.then(() => current, () => current));
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (ctx.sessionLocks.get(sessionKey) === current) ctx.sessionLocks.delete(sessionKey);
  }
}

async function callAgent(ctx: ApiContext, args: Record<string, any>): Promise<any> {
  const loop = ctx.agentLoop;
  const directOptions = {
    media: args.media ?? [],
    sessionKey: args.sessionKey ?? args.session_key,
    channel: args.channel,
    chatId: args.chatId ?? args.chat_id,
    onProgress: args.onProgress,
    onStream: args.onStream,
    onStreamEnd: args.onStreamEnd,
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
        sessionKey: args.session_key ?? args.sessionKey,
      }),
    );
  }
  if (typeof loop === "function") return loop(args);
  throw new Error("API agent loop does not expose processDirect/processMessage");
}

export async function handleChatCompletions(request: Request, ctx?: ApiContext): Promise<Response> {
  const context = ctx ?? {
    agentLoop: null,
    modelName: "memmy",
    requestTimeout: 120,
    sessionLocks: new Map<string, Promise<void>>(),
  };
  const contentType = request.headers.get("content-type") ?? "";
  let text = "";
  let mediaPaths: string[] = [];
  let sessionId: string | null | undefined;
  let requestedModel: string | null | undefined;
  let stream = false;

  try {
    if (contentType.startsWith("multipart/")) {
      [text, mediaPaths, sessionId, requestedModel] = await parseMultipart(request);
    } else {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return errorJson(400, "Invalid JSON body");
      }
      stream = Boolean(body.stream);
      requestedModel = body.model;
      [text, mediaPaths] = parseJsonContent(body);
      sessionId = body.session_id;
    }
  } catch (err) {
    if (err instanceof FileSizeExceeded) return errorJson(413, err.message);
    return errorJson(400, (err as Error).message);
  }

  if (requestedModel && requestedModel !== context.modelName) {
    return errorJson(400, `Only configured model '${context.modelName}' is available`);
  }

  const sessionKey = sessionId ? `api:${sessionId}` : API_SESSION_KEY;
  const baseArgs = {
    content: text,
    media: mediaPaths.length ? mediaPaths : null,
    session_key: sessionKey,
    sessionKey,
    channel: "api",
    chat_id: API_CHAT_ID,
    chatId: API_CHAT_ID,
  };

  if (stream) {
    const chunkId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
    const encoder = new TextEncoder();
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let emitted = false;
        const write = (chunk: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // The client may have already disconnected.
          }
        };
        void (async () => {
          let failed = false;
          const onStream = async (token: string) => {
            if (token) emitted = true;
            write(sseChunk(token, context.modelName, chunkId));
          };
          const onStreamEnd = async () => undefined;
          try {
            await withSessionLock(context, sessionKey, async () => {
              const response = await withTimeout(
                Promise.resolve(
                  callAgent(context, {
                    ...baseArgs,
                    onStream,
                    onStreamEnd,
                  }),
                ),
                context.requestTimeout,
              );
              if (!emitted) {
                const finalText = responseText(response);
                if (finalText.trim()) write(sseChunk(finalText, context.modelName, chunkId));
              }
            });
          } catch {
            failed = true;
          } finally {
            if (!failed) {
              write(sseChunk("", context.modelName, chunkId, "stop"));
              write(SSE_DONE);
            }
            close();
          }
        })();
      },
      cancel() {
        closed = true;
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
      const first = await withTimeout(Promise.resolve(callAgent(context, baseArgs)), context.requestTimeout);
      let textResponse = responseText(first);
      if (!textResponse.trim()) {
        const retry = await withTimeout(Promise.resolve(callAgent(context, baseArgs)), context.requestTimeout);
        textResponse = responseText(retry);
        if (!textResponse.trim()) textResponse = EMPTY_FINAL_RESPONSE_MESSAGE;
      }
      return textResponse;
    });
    return Response.json(chatCompletionResponse(reply, context.modelName));
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message.startsWith("Request timed out")) return errorJson(504, message);
    return errorJson(500, "Internal server error", "server_error");
  }
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
  return Response.json({ status: "ok" });
}

export function createApp(
  agentLoopOrConfig: any = null,
  modelName = "memmy",
  requestTimeout = 120,
): { fetch: (request: Request) => Promise<Response>; context: ApiContext } {
  const agentLoop = agentLoopOrConfig instanceof Config || agentLoopOrConfig == null ? null : agentLoopOrConfig;
  const ctx: ApiContext = {
    agentLoop,
    modelName,
    requestTimeout,
    sessionLocks: new Map<string, Promise<void>>(),
  };
  return {
    context: ctx,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return handleHealth();
      if (url.pathname === "/v1/models" && request.method === "GET") return handleModels(request, ctx);
      if (url.pathname === "/v1/chat/completions" && request.method === "POST") return handleChatCompletions(request, ctx);
      return errorJson(404, "not found");
    },
  };
}
