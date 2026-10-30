import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";

type ManagedTool = { name: string; description: string; inputSchema: Record<string, unknown> };
type ManagedExecutionScope = { tools: ManagedTool[]; url: string; token: string; active: boolean; signal: AbortSignal; onEvent?: (event: Record<string, unknown>) => void };
const scopes = new AsyncLocalStorage<ManagedExecutionScope>();
const fileCalls = new AsyncLocalStorage<string>();

export function withManagedFileCall<T>(callId: string, run: () => T): T {
  return fileCalls.run(callId, run);
}

/** Traversal grants never cover descendants: check every path before returning or reading it. */
export async function withAuthorizedReadPath<T>(path: string, read: () => Promise<T>): Promise<T> {
  if (!managedExecutionRequired()) return read();
  const parentCallId = fileCalls.getStore();
  if (!parentCallId) throw new Error("Managed runtime file access context is missing");
  const callId = randomUUID();
  emitManagedToolEvent({ type: "tool_call", callId, name: "read_file", input: { path } });
  try {
    await executeManagedTool("authorize_read_path", { path }, undefined, callId, parentCallId);
    const result = await read();
    const scope = scopes.getStore();
    if (!scope?.active || scope.signal.aborted) throw new Error("Managed runtime run has ended");
    emitManagedToolEvent({ type: "tool_result", callId, name: "read_file", ok: true, output: "File access completed" });
    return result;
  } catch (error) {
    emitManagedToolEvent({ type: "tool_result", callId, name: "read_file", ok: false,
      output: `Error: ${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

class PathDeniedError extends Error {}

/** One batch owns its skipped-path count; a denied root never becomes a partial success. */
export class AuthorizedReadBatch {
  deniedPaths = 0;
  constructor(private readonly root: string) {}

  async read<T>(path: string, read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await withAuthorizedReadPath(path, read);
    } catch (error) {
      if (path === this.root || !(error instanceof PathDeniedError)) throw error;
      this.deniedPaths += 1;
      return undefined;
    }
  }

  format(result: string): string {
    if (!this.deniedPaths) return result;
    return `Partial results: skipped ${this.deniedPaths} denied path(s). The results below cover authorized paths only; counts are not the directory total. Do not retry denied paths. Other authorized files remain usable.\n\n${result}`;
  }
}

export function managedExecutionRequired(): boolean {
  return process.env.AGENT_MANAGED_EXECUTION_REQUIRED === "1";
}

export function authenticateAgentRuntime(request: Request): boolean {
  const expected = process.env.AGENT_RUNTIME_TOKEN ?? "";
  const actual = request.headers.get("x-agent-runtime-token") ?? "";
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expected.length >= 32 && actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function createManagedExecutionScope(value: unknown, signal: AbortSignal): ManagedExecutionScope {
  if (!value || typeof value !== "object") throw new Error("Managed runtime approval connection is required");
  const input = value as { protocol?: unknown; tools?: unknown; url?: unknown; token?: unknown };
  if (input.protocol !== 2 || !Array.isArray(input.tools) || !input.tools.length || input.tools.some(tool =>
    !tool || typeof tool.name !== "string" || typeof tool.description !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object")) {
    throw new Error("Managed execution protocol 2 and tool definitions are required");
  }
  if (typeof input.url !== "string" || typeof input.token !== "string" || !/^[a-f0-9]{64}$/u.test(input.token)) {
    throw new Error("Invalid managed runtime approval connection");
  }
  const url = new URL(input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.pathname !== "/authorize" || url.username || url.password || url.search || url.hash) {
    throw new Error("Managed runtime approval connection must be local");
  }
  return { url: url.href, token: input.token, tools: structuredClone(input.tools), active: true, signal };
}

export function managedToolDefinitions(): Record<string, unknown>[] {
  const scope = scopes.getStore();
  if (!scope?.active || scope.signal.aborted) return [];
  return scope.tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

export class ManagedExecutionError extends Error {
  constructor(readonly detail: { kind: "permission" | "execution"; code: string }) {
    super(`Managed runtime ${detail.kind === "permission" ? "did not authorize this operation" : "execution failed"}: ${detail.code}`);
  }
}

export function withManagedExecution<T>(scope: ManagedExecutionScope | undefined, run: () => T): T {
  return scope ? scopes.run(scope, run) : run();
}

/** Outside the authenticated request scope, managed runtimes cannot execute tools. */
export async function executeManagedTool(name: string, args: unknown, signal?: AbortSignal | null, callId: string = randomUUID(), parentCallId?: string): Promise<{ args: unknown; result?: string }> {
  const scope = scopes.getStore();
  if (!scope) {
    if (managedExecutionRequired()) throw new Error("Managed runtime approval context is missing");
    return { args };
  }
  if (!scope.active || scope.signal.aborted || signal?.aborted) throw new Error("Managed runtime run has ended");
  // A detached copy prevents a hook or parallel caller from changing approved parameters.
  const approvedArgs = JSON.parse(JSON.stringify(args));
  if (!parentCallId) emitManagedToolEvent({ type: "tool_call", callId, name, input: approvedArgs });
  // Six Host hops may each wait 120s for approval and 15s for IO, plus transport grace.
  const response = await fetch(scope.url, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${scope.token}` },
    body: JSON.stringify({ callId, toolName: name, args: approvedArgs,
      ...(["read_file", "list_dir", "find_files", "grep", "authorize_read_path"].includes(name) ? { fileAccessProtocol: 1 } : {}),
      ...(parentCallId ? { parentCallId } : {}) }),
    signal: AbortSignal.any([scope.signal, ...(signal ? [signal] : []), AbortSignal.timeout(["web_fetch", "web_search"].includes(name) ? 815_000 : 125_000)])
  });
  if (!response.ok) throw new Error("Managed runtime approval service is unavailable");
  const result = await response.json() as { decision?: string; reason?: string; result?: unknown; error?: { kind?: unknown; code?: unknown } };
  if (!scope.active || scope.signal.aborted || signal?.aborted) throw new Error("Managed runtime run has ended");
  if (result.error && ["permission", "execution"].includes(String(result.error.kind))
    && typeof result.error.code === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/u.test(result.error.code)) {
    throw new ManagedExecutionError({ kind: result.error.kind as "permission" | "execution", code: result.error.code });
  }
  if (result.decision !== "allow") {
    const message = `Managed runtime denied this operation: ${result.reason ?? "denied"}`;
    if (result.decision === "deny" && ["operator_rejected", "denied_by_policy", "policy_denied", "unconfigured_deny"].includes(result.reason ?? "")) {
      throw new PathDeniedError(message);
    }
    throw new Error(message);
  }
  if (typeof result.result !== "string") throw new Error("Managed runtime execution result is missing");
  return { args: approvedArgs, ...(typeof result.result === "string" ? { result: result.result } : {}) };
}

export function emitManagedToolEvent(event: Record<string, unknown>): void {
  const scope = scopes.getStore();
  if (scope?.active && !scope.signal.aborted) scope.onEvent?.(event);
}
