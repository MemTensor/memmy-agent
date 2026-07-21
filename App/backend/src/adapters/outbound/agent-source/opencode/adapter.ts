/** Adapter module. */
import { access } from "node:fs/promises";
import { resolveOpencodeDatabasePath } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { readOpencodeDatabase, type RawOpencodeDatabaseMessage } from "./db-reader.js";

const OPENCODE_SOURCE_ID = "opencode";

/** Contract for create opencode source adapter deps. */
export interface CreateOpencodeSourceAdapterDeps {
  databasePath?: string;
  descriptor?: SourceDescriptor;
}

/** Creates create opencode source adapter. */
export function createOpencodeSourceAdapter(deps: CreateOpencodeSourceAdapterDeps = {}): SourceAdapter {
  const databasePath = deps.databasePath ?? resolveOpencodeDatabasePath();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: OPENCODE_SOURCE_ID,
      displayName: "Opencode",
      builtin: true,
      dataPath: databasePath
    });

  return {
    descriptor,

    async detect() {
      return pathExists(databasePath);
    },

    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: 0, total: 1 });
      const targets = await discoverOpencodeTargets(databasePath);
      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "discover",
        current: targets.length,
        total: targets.length
      });

      let emittedMessages = 0;
      for (const [targetIndex, target] of targets.entries()) {
        throwIfAborted(options.signal);
        if (limitReached(emittedMessages, options.maxMessages)) {
          break;
        }
        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: targetIndex,
          total: targets.length,
          message: target.databasePath
        });

        const messages = await collectConversationWindow(
          readOpencodeDatabase(target.databasePath),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const rawMessage of messages) {
          throwIfAborted(options.signal);
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
          yield toConversationMessage(descriptor.sourceId, rawMessage);
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

async function discoverOpencodeTargets(databasePath: string): Promise<Array<{ databasePath: string }>> {
  return (await pathExists(databasePath)) ? [{ databasePath }] : [];
}

/** Handles to conversation message. */
function toConversationMessage(
  sourceId: string,
  rawMessage: RawOpencodeDatabaseMessage
): ConversationMessage {
  return {
    messageId: rawMessage.messageId,
    sourceId,
    conversationId: rawMessage.conversationId,
    role: rawMessage.role,
    content: redactSecrets(rawMessage.content),
    createdAt: rawMessage.createdAt,
    workspacePath: rawMessage.workspacePath,
    gitRoot: rawMessage.gitRoot,
    rawMeta: rawMessage.rawMeta
  };
}

/** Handles throw if aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Opencode source scan aborted", "AbortError");
  }
}

function limitReached(count: number, maxMessages: number | undefined): boolean {
  return maxMessages !== undefined && count >= maxMessages;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/** Checks is node error. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
