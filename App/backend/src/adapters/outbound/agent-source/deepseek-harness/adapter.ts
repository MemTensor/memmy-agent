import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveDeepseekHarnessHomeDirectory, resolveDeepseekHarnessSessionsDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverDeepseekHarnessSessions } from "./session-discovery.js";
import { readDeepseekHarnessSession, type RawDeepseekHarnessMessage } from "./session-reader.js";

const SOURCE_ID = "deepseek_harness";

export interface CreateDeepseekHarnessSourceAdapterDeps {
  rootDirectory?: string;
  sessionsRoot?: string;
  descriptor?: SourceDescriptor;
}

export function createDeepseekHarnessSourceAdapter(
  deps: CreateDeepseekHarnessSourceAdapterDeps = {}
): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveDeepseekHarnessHomeDirectory();
  const sessionsRoot = deps.sessionsRoot ?? (deps.rootDirectory
    ? join(rootDirectory, "sessions")
    : resolveDeepseekHarnessSessionsDirectory());
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: SOURCE_ID,
    displayName: "DeepSeek Harness",
    builtin: true,
    dataPath: sessionsRoot
  });

  return {
    descriptor,
    async detect() {
      try {
        await access(rootDirectory);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      }
    },
    async *scan(options: ScanOptions) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ sourceId: SOURCE_ID, phase: "discover", current: 0, total: 1 });
      const sessions = await discoverDeepseekHarnessSessions({
        root: sessionsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({ sourceId: SOURCE_ID, phase: "discover", current: sessions.length, total: sessions.length });

      let emittedMessages = 0;
      for (const [sessionIndex, session] of sessions.entries()) {
        options.signal?.throwIfAborted();
        if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) break;
        options.onProgress?.({
          sourceId: SOURCE_ID,
          phase: "read",
          current: sessionIndex,
          total: sessions.length,
          message: session.sessionFilePath
        });
        const messages = await collectConversationWindow(
          toAsyncIterable(await readDeepseekHarnessSession(session.sessionFilePath, options.signal)),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const rawMessage of messages) {
          options.signal?.throwIfAborted();
          emittedMessages += 1;
          options.onProgress?.({ sourceId: SOURCE_ID, phase: "emit", current: emittedMessages, total: emittedMessages });
          yield toConversationMessage(rawMessage, session.gitRoot);
        }
      }
      options.onProgress?.({ sourceId: SOURCE_ID, phase: "done", current: emittedMessages, total: emittedMessages });
    }
  };
}

function toConversationMessage(
  message: RawDeepseekHarnessMessage,
  gitRoot: string | null
): ConversationMessage {
  return {
    ...message,
    sourceId: SOURCE_ID,
    content: redactSecrets(message.content),
    gitRoot
  };
}

async function* toAsyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) yield value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
