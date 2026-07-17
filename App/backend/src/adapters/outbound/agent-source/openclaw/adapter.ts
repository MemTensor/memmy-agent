/** Adapter module. */
import { access } from "node:fs/promises";
import { resolveOpenclawStateDirectory } from "../../agent-paths.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverOpenclawDatabases } from "./db-discovery.js";
import { readOpenclawDatabase, type RawOpenclawMessage } from "./db-reader.js";

const OPENCLAW_SOURCE_ID = "openclaw";

/** Contract for create openclaw source adapter deps. */
export interface CreateOpenclawSourceAdapterDeps {
  rootDirectory?: string;
  descriptor?: SourceDescriptor;
}

/** Creates create openclaw source adapter. */
export function createOpenclawSourceAdapter(deps: CreateOpenclawSourceAdapterDeps = {}): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveOpenclawStateDirectory();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: OPENCLAW_SOURCE_ID,
      displayName: "OpenClaw",
      builtin: true,
      dataPath: rootDirectory
    });

  return {
    descriptor,

    async detect() {
      return (await pathExists(rootDirectory)) || (await discoverOpenclawDatabases({ root: rootDirectory })).length > 0;
    },

    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: 0, total: 1 });
      const databases = (await discoverOpenclawDatabases({
        root: rootDirectory,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxDatabases: options.maxScanTargets
      })).filter((database) =>
        database.schemaKind === "conversation" || database.schemaKind === "memory"
      );
      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "discover",
        current: databases.length,
        total: databases.length
      });

      let emittedMessages = 0;
      for (const [databaseIndex, database] of databases.entries()) {
        throwIfAborted(options.signal);
        if (limitReached(emittedMessages, options.maxMessages)) {
          break;
        }
        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: databaseIndex,
          total: databases.length,
          message: database.databasePath
        });

        for await (const rawMessage of readOpenclawDatabase(database.databasePath)) {
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

/** Handles to conversation message. */
function toConversationMessage(sourceId: string, rawMessage: RawOpenclawMessage): ConversationMessage {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("OpenClaw source scan aborted", "AbortError");
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
    if (error instanceof Error && "code" in error) {
      return false;
    }

    throw error;
  }
}
