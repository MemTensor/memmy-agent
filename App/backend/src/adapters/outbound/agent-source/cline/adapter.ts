/** Cline source adapter.
 *
 * Cline (VS Code extension) stores conversations as JSON files under
 * the VS Code globalStorage directory.
 *
 * Path (macOS): ``~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/``
 * Path (Linux): ``~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/``
 * Path (Windows): ``%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/``
 */

import { access } from "node:fs/promises";
import { resolveClineDataDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverClineSessions } from "./session-discovery.js";
import { readClineConversation, type RawClineMessage } from "./transcript-reader.js";

const CLINE_SOURCE_ID = "cline";

export interface CreateClineSourceAdapterDeps {
  dataDirectory?: string;
  descriptor?: SourceDescriptor;
}

export function createClineSourceAdapter(deps: CreateClineSourceAdapterDeps = {}): SourceAdapter {
  const dataDirectory = deps.dataDirectory ?? resolveClineDataDirectory();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: CLINE_SOURCE_ID,
      displayName: "Cline",
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
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      }
    },

    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: 0, total: 1 });

      const sessions = await discoverClineSessions({
        root: dataDirectory,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets,
      });

      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "discover",
        current: sessions.length,
        total: sessions.length,
      });

      let emitted = 0;
      for (const [i, session] of sessions.entries()) {
        throwIfAborted(options.signal);
        if (limitReached(emitted, options.maxMessages)) break;

        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: i,
          total: sessions.length,
          message: session.filePath,
        });

        const messages = await collectConversationWindow(
          readClineConversation(session.filePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emitted),
        );

        for (const raw of messages) {
          throwIfAborted(options.signal);
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "redact", current: emitted, total: emitted + 1 });
          emitted += 1;
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "emit", current: emitted, total: emitted });
          yield toConversationMessage(descriptor.sourceId, raw, session.workspacePath, session.gitRoot);
        }
      }

      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emitted, total: emitted });
    },
  };
}

function toConversationMessage(
  sourceId: string,
  raw: RawClineMessage,
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
  if (signal?.aborted) throw new DOMException("Cline source scan aborted", "AbortError");
}

function limitReached(count: number, max: number | undefined): boolean {
  return max !== undefined && count >= max;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
