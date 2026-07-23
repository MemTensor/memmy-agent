/** Adapter module. */
import { access } from "node:fs/promises";
import { resolveCodexSessionsDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { readCodexRollout, type RawCodexMessage } from "./rollout-reader.js";
import { discoverCodexSessions } from "./session-discovery.js";

const CODEX_SOURCE_ID = "codex";

export interface CreateCodexSourceAdapterDeps {
  /** Sessions root. */
  sessionsRoot?: string;
  descriptor?: SourceDescriptor;
}

/** Creates create codex source adapter. */
export function createCodexSourceAdapter(deps: CreateCodexSourceAdapterDeps = {}): SourceAdapter {
  const sessionsRoot = deps.sessionsRoot ?? resolveCodexSessionsDirectory();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: CODEX_SOURCE_ID,
      displayName: "Codex",
      builtin: true,
      dataPath: sessionsRoot
    });

  return {
    descriptor,

    async detect() {
      try {
        await access(sessionsRoot);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return false;
        }

        throw error;
      }
    },

    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: 0, total: 1 });
      const sessions = await discoverCodexSessions({
        root: sessionsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: sessions.length, total: sessions.length });

      let emittedMessages = 0;
      for (const [sessionIndex, session] of sessions.entries()) {
        throwIfAborted(options.signal);
        if (limitReached(emittedMessages, options.maxMessages)) {
          break;
        }
        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: sessionIndex,
          total: sessions.length,
          message: session.sessionFilePath
        });

        const messages = await collectConversationWindow(
          readCodexRollout(session.sessionFilePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const rawMessage of messages) {
          throwIfAborted(options.signal);
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "redact", current: emittedMessages, total: emittedMessages + 1 });
          emittedMessages += 1;
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "emit", current: emittedMessages, total: emittedMessages });
          yield toConversationMessage(descriptor.sourceId, rawMessage, session.workspacePath, session.gitRoot);
        }
      }

      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emittedMessages, total: emittedMessages });
    }
  };
}

function toConversationMessage(
  sourceId: string,
  rawMessage: RawCodexMessage,
  workspacePath: string | null,
  gitRoot: string | null
): ConversationMessage {
  return {
    messageId: rawMessage.messageId,
    sourceId,
    conversationId: rawMessage.conversationId,
    role: rawMessage.role,
    content: redactSecrets(rawMessage.content),
    createdAt: rawMessage.createdAt,
    workspacePath,
    gitRoot,
    rawMeta: Object.freeze({})
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Codex source scan aborted", "AbortError");
  }
}

function limitReached(count: number, maxMessages: number | undefined): boolean {
  return maxMessages !== undefined && count >= maxMessages;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
