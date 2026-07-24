import { Tool, type JsonSchema } from "../core/agent-runtime/tools/base.js";
import { RequestContext, RequestContextStore } from "../core/agent-runtime/tools/context.js";
import {
  extractCurrentUserRequestText,
  renderMemmyContextPacket,
} from "./protocol.js";
import type { MemmyMemoryClient } from "./client.js";
import type { JsonRecord, MemmyMemoryToolRuntime } from "./types.js";

type ToolSpec = {
  name: string;
  description: string;
  parameters: JsonSchema;
  readOnly?: boolean;
  execute: (client: MemmyMemoryClient, body: JsonRecord, runtime: MemmyMemoryToolRuntime, sessionKey: string | null) => Promise<any>;
};

function objectSchema(properties: JsonRecord, required: string[] = []): JsonSchema {
  return { type: "object", properties, required };
}

const searchShape = {
  query: { type: "string" },
  sessionId: { type: "string" },
  layers: { type: "array", items: { type: "string", enum: ["L1", "L2", "L3", "Skill"] } }
};

export const MEMOS_MEMORY_TOOL_SPECS: ToolSpec[] = [
  {
    name: "memmy_memory_search",
    description: "Search relevant Memmy memory traces, policies, world models, and skills for the current task.",
    parameters: objectSchema(searchShape, ["query"]),
    readOnly: true,
    execute: async (client, params, runtime, sessionKey) => {
      const body = withSearchRuntimeDefaults(params, runtime, sessionKey);
      return client.search(body);
    },
  },
  {
    name: "memmy_memory_get",
    description: "Read one Memmy memory detail by id. Use the same tool for trace_, policy_, world_, skill_, and episode_ ids; episode_ ids expand the task timeline.",
    parameters: objectSchema({
      id: { type: "string" },
    }, ["id"]),
    readOnly: true,
    execute: async (client, params) => client.getMemory(String(params.id)),
  },
];

export class MemmyMemoryTool extends Tool {
  private readonly requestContext = new RequestContextStore();

  constructor(
    private readonly spec: ToolSpec,
    private readonly client: MemmyMemoryClient,
    private readonly runtime: MemmyMemoryToolRuntime,
  ) {
    super();
  }

  get name(): string {
    return this.spec.name;
  }

  get description(): string {
    return this.spec.description;
  }

  get parameters(): JsonSchema {
    return this.spec.parameters;
  }

  override get readOnly(): boolean {
    return this.spec.readOnly ?? true;
  }

  setContext(ctx: RequestContext): void {
    this.requestContext.set(ctx);
  }

  async execute(params: JsonRecord = {}): Promise<string> {
    const sessionKey = this.requestContext.get()?.sessionKey ?? null;
    try {
      const result = await this.spec.execute(this.client, params, this.runtime, sessionKey);
      return formatMemmyToolResult(this.spec.name, result, params, this.runtime, sessionKey);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export function registerMemmyMemoryTools(registry: any, client: MemmyMemoryClient, runtime: MemmyMemoryToolRuntime): void {
  for (const spec of MEMOS_MEMORY_TOOL_SPECS) {
    if (typeof registry?.has === "function" && registry.has(spec.name)) continue;
    registry.register(new MemmyMemoryTool(spec, client, runtime));
  }
}

function withRuntimeDefaults(params: JsonRecord, runtime: MemmyMemoryToolRuntime, sessionKey: string | null): JsonRecord {
  const body: JsonRecord = {
    ...runtime.requestEnvelope(sessionKey),
    ...params,
  };
  body.sessionId = runtimeValue(body.sessionId, runtime.currentSessionId(sessionKey) ?? undefined);
  body.episodeId = runtimeValue(body.episodeId, runtime.currentEpisodeId(sessionKey) ?? undefined);
  body.turnId = runtimeValue(body.turnId, runtime.currentTurnId(sessionKey) ?? undefined);
  return compact(body);
}

function withSearchRuntimeDefaults(params: JsonRecord, runtime: MemmyMemoryToolRuntime, sessionKey: string | null): JsonRecord {
  const body = withRuntimeDefaults(params, runtime, sessionKey);
  const namespace = body.namespace && typeof body.namespace === "object" && !Array.isArray(body.namespace)
    ? body.namespace as JsonRecord
    : {};
  return compact({
    query: body.query,
    source: body.source ?? namespace.source,
    sessionId: body.sessionId,
    layers: body.layers
  });
}

function runtimeValue(value: unknown, fallback: string | undefined): unknown {
  if (typeof value !== "string") return value ?? fallback;
  return value.trim() ? value : fallback;
}

function compact<T extends JsonRecord>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "")) as T;
}

function formatMemmyToolResult(
  toolName: string,
  result: any,
  params: JsonRecord,
  runtime: MemmyMemoryToolRuntime,
  sessionKey: string | null,
): string {
  const currentUserRequest = runtime.currentUserText(sessionKey)
    ?? (typeof params.query === "string" ? params.query : "")
    ?? "";
  if (toolName === "memmy_memory_search") {
    return renderMemmyContextPacket(markdownFromSearchResult(result), "tool_search", currentUserRequest);
  }
  if (toolName === "memmy_memory_get") {
    return renderMemmyContextPacket(markdownFromMemoryDetail(result), "tool_get", currentUserRequest);
  }
  return extractCurrentUserRequestText(JSON.stringify(result, null, 2));
}

function markdownFromSearchResult(result: any): string {
  const injected = result?.injectedContext;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  if (typeof injected?.markdown === "string" && injected.markdown.trim()) return injected.markdown.trim();
  const hits = Array.isArray(result?.hits) ? result.hits : Array.isArray(result?.debug?.hits) ? result.debug.hits : [];
  if (hits.length) {
    const renderedHits = hits.flatMap((hit: any, index: number) => {
      const title = stringValue(hit?.title) || stringValue(hit?.id) || "memory";
      const layer = stringValue(hit?.memoryLayer) || "memory";
      if (layer === "L1") return [];
      const snippet = stringValue(hit?.snippet);
      return [[`${index + 1}. [${layer}] ${title}`, snippet].filter(Boolean).join("\n")];
    });
    if (renderedHits.length) return renderedHits.join("\n\n");
  }
  return "No relevant Memmy memories found.";
}

function markdownFromMemoryDetail(result: any): string {
  const id = stringValue(result?.id) || "memory";
  const layer = stringValue(result?.memoryLayer) || stringValue(result?.layer) || "memory";
  const kind = stringValue(result?.kind) || "memory";
  const title = stringValue(result?.title) || id;
  const summary = stringValue(result?.summary);
  const content = compactMemoryGetContent(result);
  const isL1 = layer === "L1";
  return [
    `id: ${id}`,
    `kind: ${kind}`,
    `layer: ${layer}`,
    ...(isL1 ? [] : [`title: ${title}`]),
    "",
    content || (isL1 ? "" : (summary && summary !== title ? summary : JSON.stringify(result, null, 2))),
  ].filter(Boolean).join("\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactMemoryGetContent(result: any): string {
  const rawTurn = rawTurnRecord(result);
  if (rawTurn) return compactRawTurnContent(rawTurn);
  if (stringValue(result?.memoryLayer) === "L1" || stringValue(result?.layer) === "L1") return "";
  return compactMemoryBody(stringValue(result?.body) || stringValue(result?.content));
}

function compactRawTurnContent(rawTurn: JsonRecord): string {
  const parts: string[] = [];
  const userText = stringValue(rawTurn.userText);
  const assistantText = stringValue(rawTurn.assistantText);
  if (userText) parts.push(`User:\n${userText}`);
  if (assistantText) parts.push(`Assistant:\n${assistantText}`);
  return parts.join("\n\n");
}

function compactMemoryBody(body: string): string {
  const hasConversation = /^\s*(User|Agent|Assistant|Tool calls):/im.test(body);
  return body
    .split(/\r?\n/)
    .filter((line) => !isInternalMemoryBodyLine(line, hasConversation))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isInternalMemoryBodyLine(line: string, hasConversation: boolean): boolean {
  if (/^\s*(RawTurn|TraceStep|Alpha|Value|Priority):/i.test(line)) return true;
  return hasConversation && /^\s*Summary:/i.test(line);
}

function rawTurnRecord(result: any): JsonRecord | undefined {
  const refs = recordValue(result?.refs) ?? recordValue(recordValue(result?.metadata)?.refs);
  const rawTurn = refs ? recordValue(refs.rawTurn) : undefined;
  if (rawTurn) return rawTurn;

  const item = recordValue(result?.item);
  const itemRefs = item ? recordValue(item.refs) ?? recordValue(recordValue(item.metadata)?.refs) : undefined;
  return itemRefs ? recordValue(itemRefs.rawTurn) : undefined;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
