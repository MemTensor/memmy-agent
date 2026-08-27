/** Adapter module. */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveHermesHomeDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { readHermesRollout, type RawHermesRolloutMessage } from "./rollout-reader.js";
import { discoverHermesSessions, type HermesSessionFile } from "./session-discovery.js";
import { readHermesStateDb, type RawHermesStateDbMessage } from "./state-db-reader.js";

const HERMES_SOURCE_ID = "hermes";

/** Contract for create hermes source adapter deps. */
export interface CreateHermesSourceAdapterDeps {
  rootDirectory?: string;
  descriptor?: SourceDescriptor;
}

type HermesScanTarget =
  | { kind: "jsonl"; session: HermesSessionFile }
  | { kind: "state_db"; stateDbPath: string };

/** Creates create hermes source adapter. */
export function createHermesSourceAdapter(deps: CreateHermesSourceAdapterDeps = {}): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveHermesHomeDirectory();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: HERMES_SOURCE_ID,
      displayName: "Hermes",
      builtin: true,
      dataPath: rootDirectory
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
      const targets = await discoverHermesTargets(rootDirectory, options);
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
          message: target.kind === "jsonl" ? target.session.sessionFilePath : target.stateDbPath
        });

        const iterable =
          target.kind === "jsonl"
            ? streamJsonlMessages(target.session, options.signal)
            : streamStateDbMessages(target.stateDbPath);

        const messages = await collectConversationWindow(
          iterable,
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const message of messages) {
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
          yield toConversationMessage(descriptor.sourceId, message);
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

async function discoverHermesTargets(rootDirectory: string, options: ScanOptions): Promise<HermesScanTarget[]> {
  const sessions = await discoverHermesSessions({
    root: rootDirectory,
    order: options.order === "recent_first" ? "recent_first" : "path_asc",
    maxSessions: options.maxScanTargets
  });
  const targets: HermesScanTarget[] = sessions.map((session) => ({ kind: "jsonl", session }));
  const stateDbPath = join(rootDirectory, "state.db");
  if (await pathExists(stateDbPath)) {
    targets.push({ kind: "state_db", stateDbPath });
  }

  return targets;
}

async function* streamJsonlMessages(session: HermesSessionFile, signal?: AbortSignal): AsyncIterable<RawHermesStateDbMessage> {
  for await (const rawMessage of readHermesRollout(session.sessionFilePath, signal)) {
    yield {
      ...rawMessage,
      workspacePath: session.workspacePath,
      gitRoot: session.gitRoot,
      rawMeta: Object.freeze({})
    };
  }
}

async function* streamStateDbMessages(stateDbPath: string): AsyncIterable<RawHermesStateDbMessage> {
  for await (const rawMessage of readHermesStateDb(stateDbPath)) {
    yield rawMessage;
  }
}

/** Handles to conversation message. */
function toConversationMessage(sourceId: string, rawMessage: RawHermesStateDbMessage): ConversationMessage {
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
    throw new DOMException("Hermes source scan aborted", "AbortError");
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
