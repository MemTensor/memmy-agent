/** Pi source adapter module. */
import { access } from "node:fs/promises";
import { resolvePiSessionsDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverPiSessions } from "./session-discovery.js";
import { readPiSession, type RawPiMessage } from "./session-reader.js";

const PI_SOURCE_ID = "pi";

export interface CreatePiSourceAdapterDeps {
  sessionsRoot?: string;
  descriptor?: SourceDescriptor;
}

export function createPiSourceAdapter(deps: CreatePiSourceAdapterDeps = {}): SourceAdapter {
  const sessionsRoot = deps.sessionsRoot ?? resolvePiSessionsDirectory();
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: PI_SOURCE_ID,
    displayName: "Pi",
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
      const sessions = await discoverPiSessions({
        root: sessionsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: sessions.length, total: sessions.length });

      let emittedMessages = 0;
      for (const [sessionIndex, session] of sessions.entries()) {
        throwIfAborted(options.signal);
        if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) {
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
          readPiSession(session.sessionFilePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const rawMessage of messages) {
          throwIfAborted(options.signal);
          if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) {
            break;
          }
          emittedMessages += 1;
          yield toConversationMessage(descriptor.sourceId, rawMessage, session.workspacePath, session.gitRoot);
        }
      }
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emittedMessages, total: emittedMessages });
    }
  };
}

function toConversationMessage(
  sourceId: string,
  rawMessage: RawPiMessage,
  workspacePath: string | null,
  gitRoot: string | null
): ConversationMessage {
  return {
    ...rawMessage,
    sourceId,
    content: redactSecrets(rawMessage.content),
    workspacePath,
    gitRoot,
    rawMeta: Object.freeze({})
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Pi source scan aborted", "AbortError");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
