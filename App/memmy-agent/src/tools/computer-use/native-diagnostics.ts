import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';

export type NativeDiagnosticStage = 'request-context' | 'connect' | 'tool-discovery' | 'tool-schema'
  | 'ping' | 'list-apps' | 'installed-app-lookup' | 'dispatch' | 'finish-turn';
export type NativeDiagnostic = { id: string; stage: NativeDiagnosticStage; code: string };
const SAFE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'ETIMEDOUT', 'EINVAL', 'ERR_MCP_REQUEST_TIMEOUT', 'not-found', 'ambiguous', 'blocked',
  'unavailable', 'invalid-response', 'lookup-failed']);
const SAFE_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'McpError',
  'InstalledAppIdentityLookupError', 'ClosedResourceError', 'BrokenResourceError', 'EndOfStream',
  'BrokenPipeError', 'ConnectionResetError', 'ConnectionRefusedError', 'ConnectionAbortedError', 'ConnectionError']);
const CONTEXT_REASONS = new Set(['interactive-user-message', 'internal-message', 'background-source',
  'gui-source-unverified', 'background-context', 'user-message-id-missing']);

export class NativeConnectionStageError extends Error {
  constructor(readonly stage: NativeDiagnosticStage, cause: unknown) {
    super('Computer Use native connection failed', { cause });
  }
}

/** Keep document text, arguments, paths and raw provider messages out of logs. */
export function recordNativeFailure(stage: NativeDiagnosticStage, error: unknown,
  context?: RequestContext | null, dispatched = false): NativeDiagnostic {
  const underlying = error instanceof NativeConnectionStageError ? error.cause : error;
  const rawCode = (underlying as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'number' && [-32700, -32600, -32601, -32602, -32603, -32000, -32001].includes(rawCode) ? String(rawCode)
    : typeof rawCode === 'string' && SAFE_CODES.has(rawCode) ? rawCode : 'native-failure';
  const diagnostic = { id: randomUUID().slice(0, 8), stage, code };
  const rawName = (underlying as { name?: unknown } | null)?.name;
  const errorName = typeof rawName === 'string' && SAFE_NAMES.has(rawName) ? rawName : 'Error';
  const reason = context?.metadata.computerUseInteractiveReason;
  console.error('[memmy-computer-use]', JSON.stringify({ ...diagnostic, errorName, actionMayHaveBeenDispatched: dispatched,
    hasMessageId: Boolean(context?.messageId ?? context?.metadata.message_id ?? context?.metadata.messageId
      ?? context?.metadata.turnId ?? context?.metadata.turn_id),
    interactive: context?.metadata.computerUseInteractive !== false && Boolean(context),
    ...(typeof reason === 'string' && CONTEXT_REASONS.has(reason) ? { contextReason: reason } : {}),
  }));
  return diagnostic;
}
