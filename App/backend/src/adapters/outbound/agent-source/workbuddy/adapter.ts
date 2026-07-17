import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveWorkbuddyHomeDirectory,
  resolveWorkbuddyProjectsDirectory
} from "../../agent-paths.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { readWorkbuddyHistory, type RawWorkbuddyMessage } from "./history-reader.js";
import { discoverWorkbuddySessions } from "./session-discovery.js";

const WORKBUDDY_SOURCE_ID = "workbuddy";

export interface CreateWorkbuddySourceAdapterDeps {
  rootDirectory?: string;
  projectsRoot?: string;
  descriptor?: SourceDescriptor;
}

export function createWorkbuddySourceAdapter(deps: CreateWorkbuddySourceAdapterDeps = {}): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveWorkbuddyHomeDirectory();
  const projectsRoot = deps.projectsRoot ??
    (deps.rootDirectory ? join(rootDirectory, "projects") : resolveWorkbuddyProjectsDirectory());
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: WORKBUDDY_SOURCE_ID,
    displayName: "WorkBuddy",
    builtin: true,
    dataPath: projectsRoot
  });

  return {
    descriptor,

    async detect() {
      try {
        await access(rootDirectory);
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
      const sessions = await discoverWorkbuddySessions({
        projectsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "discover",
        current: sessions.length,
        total: sessions.length
      });

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

        for await (const rawMessage of readWorkbuddyHistory(session.sessionFilePath, options.signal)) {
          throwIfAborted(options.signal);
          if (limitReached(emittedMessages, options.maxMessages)) {
            break;
          }
          if (options.since && rawMessage.createdAt < options.since) {
            continue;
          }

          options.onProgress?.({
            sourceId: descriptor.sourceId,
            phase: "redact",
            current: emittedMessages,
            total: emittedMessages + 1
          });
          emittedMessages += 1;
          options.onProgress?.({
            sourceId: descriptor.sourceId,
            phase: "emit",
            current: emittedMessages,
            total: emittedMessages
          });
          yield toConversationMessage(descriptor.sourceId, rawMessage, session.workspacePath, session.gitRoot);
        }
      }

      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "done",
        current: emittedMessages,
        total: emittedMessages
      });
    }
  };
}

function toConversationMessage(
  sourceId: string,
  rawMessage: RawWorkbuddyMessage,
  discoveredWorkspacePath: string | null,
  gitRoot: string | null
): ConversationMessage {
  return {
    messageId: rawMessage.messageId,
    sourceId,
    conversationId: rawMessage.conversationId,
    role: rawMessage.role,
    content: redactSecrets(rawMessage.content),
    createdAt: rawMessage.createdAt,
    workspacePath: rawMessage.workspacePath ?? discoveredWorkspacePath,
    gitRoot,
    rawMeta: Object.freeze({ eventType: rawMessage.eventType, ...(rawMessage.toolName ? { toolName: rawMessage.toolName } : {}) })
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("WorkBuddy source scan aborted", "AbortError");
  }
}

function limitReached(count: number, maxMessages: number | undefined): boolean {
  return maxMessages !== undefined && count >= maxMessages;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
