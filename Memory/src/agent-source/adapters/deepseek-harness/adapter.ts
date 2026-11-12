import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDeepseekHarnessHomeDirectory, resolveDeepseekHarnessSessionsDirectory, resolveDeepseekHarnessSessionDirectories } from "../../agent-paths.js";
import { collectConversationWindow } from "../conversation-window.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverDeepseekHarnessSessions } from "./session-discovery.js";
import { type RawDeepseekHarnessMessage } from "./session-reader.js";
import { createDeepseekHistoryReader, mergeDeepseekHistorySnapshots } from "./session-history.js";

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
  const sessionsRoots = deps.sessionsRoot || deps.rootDirectory
    ? [sessionsRoot]
    : resolveDeepseekHarnessSessionDirectories();
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: SOURCE_ID,
    displayName: "DeepSeek Harness",
    builtin: true,
    dataPath: sessionsRoot
  });

  const readHistory = createDeepseekHistoryReader();

  return {
    descriptor,
    async detect() {
      for (const directory of sessionsRoots) {
        try { await access(directory); return true; }
        catch (error) {
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
        roots: sessionsRoots,
        // Include rotations in incremental scans too: a new turn can rotate
        // before the next poll. The bounded reader cache avoids re-decoding
        // unchanged files while full scans still recover all unique history.
        includeBackups: true,
        signal: options.signal,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
      });
      options.onProgress?.({ sourceId: SOURCE_ID, phase: "discover", current: sessions.length, total: sessions.length });

      // The scan budget counts session directories, not copies of one session.
      // Discovery lists live generations first, then backup-only directories.
      const groups = new Map<string, string[]>();
      for (const session of sessions) {
        const directory = dirname(session.sessionFilePath);
        const files = groups.get(directory) ?? [];
        files.push(session.sessionFilePath);
        groups.set(directory, files);
      }
      let emittedMessages = 0;
      const targets = [...groups.values()].slice(0, options.maxScanTargets);
      for (const [sessionIndex, files] of targets.entries()) {
        options.signal?.throwIfAborted();
        if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) break;
        const snapshots: RawDeepseekHarnessMessage[][] = [];
        for (const file of files) {
          options.onProgress?.({ sourceId: SOURCE_ID, phase: "read", current: sessionIndex,
            total: targets.length, message: file });
          try { snapshots.push(await readHistory(file, options.signal)); }
          catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") continue;
            throw error;
          }
        }
        const merged = mergeDeepseekHistorySnapshots(snapshots);
        const input = (async function* () { yield* merged; })();
        // Select after deduplication. Never truncate a native turn at the budget.
        const selected = await collectConversationWindow(input,
          options.fullHistory ? undefined : options.since, options.signal,
          options.maxMessages === undefined ? undefined : options.maxMessages - emittedMessages);
        for (const message of selected) {
          options.signal?.throwIfAborted();
          emittedMessages += 1;
          options.onProgress?.({ sourceId: SOURCE_ID, phase: "emit", current: emittedMessages, total: emittedMessages });
          yield toConversationMessage(message, null);
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
  const workspacePath = typeof message.rawMeta.workspacePath === "string" ? message.rawMeta.workspacePath : null;
  return {
    ...message,
    sourceId: SOURCE_ID,
    content: redactSecrets(message.content),
    workspacePath,
    gitRoot: gitRoot ?? workspacePath
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
