/** Windsurf source adapter.
 *
 * Windsurf (by Codeium) stores conversation history as JSON files
 * under ``~/.codeium/windsurf/conversations/``.
 */

import { access } from "node:fs/promises";
import { resolveWindsurfDataDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverWindsurfConversations } from "./session-discovery.js";
import { readWindsurfConversation, type RawWindsurfMessage } from "./transcript-reader.js";

const WINDSURF_SOURCE_ID = "windsurf";

export interface CreateWindsurfSourceAdapterDeps {
  dataDirectory?: string;
  descriptor?: SourceDescriptor;
}

export function createWindsurfSourceAdapter(deps: CreateWindsurfSourceAdapterDeps = {}): SourceAdapter {
  const dataDirectory = deps.dataDirectory ?? resolveWindsurfDataDirectory();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: WINDSURF_SOURCE_ID,
      displayName: "Windsurf",
      builtin: true,
      dataPath: dataDirectory,
    });

  return {
    descriptor,

    async detect() {
      try {
        await access(dataDirectory);
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

      const conversations = await discoverWindsurfConversations({
        root: dataDirectory,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets,
      });

      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "discover",
        current: conversations.length,
        total: conversations.length,
      });

      let emitted = 0;
      for (const [i, conv] of conversations.entries()) {
        throwIfAborted(options.signal);
        if (limitReached(emitted, options.maxMessages)) break;

        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: i,
          total: conversations.length,
          message: conv.filePath,
        });

        const messages = await collectConversationWindow(
          readWindsurfConversation(conv.filePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emitted),
        );

        for (const raw of messages) {
          throwIfAborted(options.signal);
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "redact", current: emitted, total: emitted + 1 });
          emitted += 1;
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "emit", current: emitted, total: emitted });
          yield toConversationMessage(descriptor.sourceId, raw, conv.workspacePath, conv.gitRoot);
        }
      }

      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emitted, total: emitted });
    },
  };
}

function toConversationMessage(
  sourceId: string,
  raw: RawWindsurfMessage,
  discoveredWorkspacePath: string | null,
  discoveredGitRoot: string | null,
): ConversationMessage {
  return {
    messageId: raw.messageId,
    sourceId,
    conversationId: raw.conversationId,
    role: raw.role,
    content: redactSecrets(raw.content),
    createdAt: raw.createdAt,
    workspacePath: raw.workspacePath ?? discoveredWorkspacePath,
    gitRoot: raw.gitRoot ?? discoveredGitRoot,
    rawMeta: Object.freeze({}),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Windsurf source scan aborted", "AbortError");
}

function limitReached(count: number, max: number | undefined): boolean {
  return max !== undefined && count >= max;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
