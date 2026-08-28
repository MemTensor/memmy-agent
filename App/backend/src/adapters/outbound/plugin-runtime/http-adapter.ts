/** HTTP/SSE plugin runtime adapter. */
import {
  CapabilityEventSchema,
  type CapabilityCall,
  type CapabilityEvent,
  type PluginRuntime
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { PluginAdapter, PluginRuntimeContext, PluginSession } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const BLOCKED_STATIC_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization"]);

const HttpRuntimeConfigSchema = z.object({
  baseUrl: z.string().url(),
  invokePath: z.string().min(1).default("/capabilities/{capabilityId}/invoke"),
  cancelPath: z.string().min(1).optional(),
  interactionPath: z.string().min(1).default("/calls/{callId}/interactions/{interactionId}"),
  headers: z.record(z.string(), z.string()).default({}),
  secretHeaders: z.record(z.string(), z.string().min(1)).default({}),
  timeoutMs: z.number().int().positive().max(3_600_000).default(DEFAULT_TIMEOUT_MS),
  maxResponseBytes: z.number().int().positive().max(ABSOLUTE_MAX_RESPONSE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES)
});
type HttpRuntimeConfig = z.infer<typeof HttpRuntimeConfigSchema>;

interface HttpPluginSession extends PluginSession {
  config: HttpRuntimeConfig;
  pluginConfig: Readonly<Record<string, unknown>>;
  headers: Record<string, string>;
  controllers: Map<string, AbortController>;
}

export interface CreateHttpPluginAdapterOptions {
  fetchFn?: typeof fetch;
}

export function createHttpPluginAdapter(options: CreateHttpPluginAdapterOptions = {}): PluginAdapter {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  return {
    id: "http",

    validate(runtime) {
      validateHttpConfig(runtime);
    },

    async activate(context) {
      const config = validateHttpConfig(context.plugin.manifest.runtime);
      const baseUrl = new URL(config.baseUrl);
      assertAllowedProtocol(baseUrl);
      assertNetworkPermission(context, baseUrl.hostname);
      const headers = resolveHeaders(config, context.secrets);
      return {
        pluginId: context.plugin.id,
        config,
        pluginConfig: context.config,
        headers,
        controllers: new Map()
      } satisfies HttpPluginSession;
    },

    async *invoke(rawSession, call) {
      const session = asHttpSession(rawSession);
      const controller = new AbortController();
      session.controllers.set(call.callId, controller);
      const timeoutMs = callTimeoutMs(session.config.timeoutMs, call.deadline);
      const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
      try {
        const response = await fetchFn(resolveEndpoint(session.config, session.config.invokePath, {
          capabilityId: call.capabilityId,
          callId: call.callId
        }), {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json, application/x-ndjson, text/event-stream", ...session.headers },
          body: JSON.stringify({
            callId: call.callId,
            conversationId: call.conversationId,
            input: call.input,
            deadline: call.deadline,
            config: session.pluginConfig
          }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Plugin HTTP request failed with ${response.status}`);
        yield* responseEvents(response, session.config.maxResponseBytes);
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        session.controllers.delete(call.callId);
      }
    },

    async cancel(rawSession, callId) {
      const session = asHttpSession(rawSession);
      session.controllers.get(callId)?.abort(Object.assign(new Error("Plugin call cancelled"), { name: "AbortError" }));
      if (!session.config.cancelPath) return;
      const response = await fetchFn(resolveEndpoint(session.config, session.config.cancelPath, { callId }), {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...session.headers },
        body: JSON.stringify({ callId }),
        signal: AbortSignal.timeout(Math.min(session.config.timeoutMs, 30_000))
      });
      if (!response.ok) throw new Error(`Plugin HTTP cancellation failed with ${response.status}`);
    },

    async respond(rawSession, callId, interactionId, responseBody) {
      const session = asHttpSession(rawSession);
      const response = await fetchFn(resolveEndpoint(session.config, session.config.interactionPath, {
        callId,
        interactionId
      }), {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...session.headers },
        body: JSON.stringify({ callId, interactionId, response: responseBody }),
        signal: AbortSignal.timeout(Math.min(session.config.timeoutMs, 30_000))
      });
      if (!response.ok) throw new Error(`Plugin HTTP interaction response failed with ${response.status}`);
    },

    async deactivate(rawSession) {
      const session = asHttpSession(rawSession);
      for (const controller of session.controllers.values()) controller.abort(new Error("Plugin disabled"));
      session.controllers.clear();
    }
  };
}

function validateHttpConfig(runtime: PluginRuntime): HttpRuntimeConfig {
  if (runtime.adapter !== "http") throw new Error(`Expected http runtime, got ${runtime.adapter}`);
  const config = HttpRuntimeConfigSchema.parse(runtime.config ?? {});
  for (const name of Object.keys(config.headers)) {
    if (BLOCKED_STATIC_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Sensitive HTTP header must use secretHeaders: ${name}`);
    }
  }
  return config;
}

function assertAllowedProtocol(url: URL): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin HTTP baseUrl must use HTTPS or loopback HTTP");
  }
}

function assertNetworkPermission(context: PluginRuntimeContext, hostname: string): void {
  const allowed = context.plugin.manifest.permissions.some((permission) =>
    permission.type === "network" && permission.hosts.includes(hostname)
  );
  if (!allowed) throw Object.assign(new Error(`Plugin network permission does not allow ${hostname}`), {
    code: "plugin_permission_denied"
  });
}

function resolveHeaders(config: HttpRuntimeConfig, secrets: Readonly<Record<string, string>>): Record<string, string> {
  const headers = { ...config.headers };
  for (const [header, key] of Object.entries(config.secretHeaders)) {
    const value = secrets[key];
    if (!value) throw new Error(`Missing plugin secret for HTTP header ${header}`);
    headers[header] = value;
  }
  return headers;
}

function resolveEndpoint(config: HttpRuntimeConfig, template: string, values: Record<string, string>): URL {
  const base = new URL(config.baseUrl);
  const path = Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, encodeURIComponent(value)),
    template
  );
  const endpoint = new URL(path, base);
  if (endpoint.origin !== base.origin) throw new Error("Plugin HTTP endpoint must stay on baseUrl origin");
  return endpoint;
}

async function* responseEvents(response: Response, maxBytes: number): AsyncIterable<CapabilityEvent> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Plugin HTTP response exceeded size limit");
  }
  if (contentType === "application/x-ndjson" || contentType === "application/ndjson" || contentType === "text/event-stream") {
    if (!response.body) throw new Error("Plugin HTTP response body is empty");
    let bytes = 0;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error("Plugin HTTP response exceeded size limit");
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = eventData(line, contentType);
        if (data) yield CapabilityEventSchema.parse(JSON.parse(data));
      }
    }
    buffer += decoder.decode();
    const data = eventData(buffer.trim(), contentType);
    if (data) yield CapabilityEventSchema.parse(JSON.parse(data));
    return;
  }

  const bytes = await readResponseBytes(response, maxBytes);
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (Array.isArray(body?.events)) {
    for (const event of body.events) yield CapabilityEventSchema.parse(event);
  } else if (isCapabilityEvent(body)) {
    yield CapabilityEventSchema.parse(body);
  } else {
    yield { type: "result", output: body };
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("Plugin HTTP response exceeded size limit");
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function eventData(line: string, contentType: string | undefined): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (contentType === "text/event-stream") return trimmed.startsWith("data:") ? trimmed.slice(5).trim() : null;
  return trimmed;
}

function isCapabilityEvent(value: unknown): value is CapabilityEvent {
  return Boolean(value && typeof value === "object" && "type" in value);
}

function callTimeoutMs(configured: number, deadline: string | undefined): number {
  if (!deadline) return configured;
  return Math.max(1, Math.min(configured, Date.parse(deadline) - Date.now()));
}

function timeoutError(): Error {
  return Object.assign(new Error("Plugin HTTP request timed out"), { code: "plugin_timeout" });
}

function asHttpSession(session: PluginSession): HttpPluginSession {
  if (!("controllers" in session)) throw new Error("Invalid HTTP plugin session");
  return session as HttpPluginSession;
}
