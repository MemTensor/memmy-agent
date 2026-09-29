import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDeepseekHarnessSessionsDirectories } from "../../agent-paths.js";
import { streamConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverDeepseekHarnessSessions } from "./session-discovery.js";
import { streamDeepseekHarnessSession, type RawDeepseekHarnessMessage } from "./session-reader.js";

const SOURCE_ID = "deepseek_harness";

export interface CreateDeepseekHarnessSourceAdapterDeps {
  rootDirectory?: string;
  sessionsRoot?: string;
  sessionsRoots?: readonly string[];
  descriptor?: SourceDescriptor;
}

export function createDeepseekHarnessSourceAdapter(
  deps: CreateDeepseekHarnessSourceAdapterDeps = {}
): SourceAdapter {
  const sessionsRoots = deps.sessionsRoot !== undefined
    ? [deps.sessionsRoot]
    : deps.rootDirectory !== undefined
      ? [join(deps.rootDirectory, "sessions")]
      : deps.sessionsRoots ?? resolveDeepseekHarnessSessionsDirectories();
  // Preserve detection of an installed home before the first session is created.
  const detectionDirectories = deps.sessionsRoot !== undefined || deps.sessionsRoots !== undefined
    ? sessionsRoots
    : sessionsRoots.map((path) => dirname(path));
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: SOURCE_ID,
    displayName: "DeepSeek Harness",
    builtin: true,
    get dataPath() {
      return sessionsRoots.find((path) => existsSync(path)) ?? sessionsRoots[0] ?? "";
    }
  });

  return {
    descriptor,
    async detect() {
      for (const directory of detectionDirectories) {
        try {
          if ((await stat(directory)).isDirectory()) return true;
        } catch (error) {
          if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
          throw error;
        }
      }
      return false;
    },
    async *scan(options: ScanOptions) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ sourceId: SOURCE_ID, phase: "discover", current: 0, total: 1 });
      const sessions = await discoverDeepseekHarnessSessions({
        root: sessionsRoots[0] ?? "",
        roots: sessionsRoots,
        signal: options.signal,
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
        for await (const rawMessage of streamConversationWindow(
          streamDeepseekHarnessSession(session.sessionFilePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages),
          options.fullHistory
        )) {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
