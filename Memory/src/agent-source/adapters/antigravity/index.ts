import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  ANTIGRAVITY_SOURCE_ID,
  antigravityAppDirectory,
  findAntigravityTranscript,
  readAntigravityTranscript
} from "@memmy/agent-source-core";
import { remainingMessageCapacity, streamConversationWindow } from "../conversation-window.js";
import { readDirectoryIfExists } from "../read-directory.js";
import { redactSecrets } from "../secret-redactor.js";
import type { SourceAdapter } from "../types.js";

interface TranscriptFile {
  conversationId: string;
  path: string;
  mtime: number;
}

interface ConversationSummary {
  title: string;
  workspace_uris: string;
  status: string;
  not_fully_idle: number;
}

export function createAntigravitySourceAdapter(dataPath = antigravityAppDirectory()): SourceAdapter {
  const sourceId = ANTIGRAVITY_SOURCE_ID;
  const brain = join(dataPath, "brain");
  return {
    descriptor: { sourceId, displayName: "Antigravity", builtin: true, dataPath },

    async detect() {
      return (await stat(dataPath).catch(ignoreMissingPath))?.isDirectory() === true;
    },

    async *scan(options) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ sourceId, phase: "discover", current: 0, total: 1 });
      const files: TranscriptFile[] = [];
      for (const entry of await readDirectoryIfExists(brain)) {
        options.signal?.throwIfAborted();
        if (!entry.isDirectory()) continue;
        const file = await findAntigravityTranscript(join(brain, entry.name, ".system_generated", "logs"));
        if (file) files.push({ conversationId: entry.name, ...file });
      }
      files.sort((left, right) =>
        (options.order === "recent_first" ? right.mtime - left.mtime : 0)
        || left.conversationId.localeCompare(right.conversationId)
      );
      const targets = files.slice(0, Math.min(options.maxScanTargets ?? files.length, options.maxConversations ?? files.length));
      options.onProgress?.({ sourceId, phase: "discover", current: targets.length, total: targets.length });
      const summaries = readSummaries(dataPath, targets);
      let emitted = 0;
      for (const [index, file] of targets.entries()) {
        options.signal?.throwIfAborted();
        const remaining = remainingMessageCapacity(options.maxMessages, emitted);
        if (remaining === 0) break;
        options.onProgress?.({ sourceId, phase: "read", current: index, total: targets.length, message: file.path });
        const summary = summaries.get(file.conversationId);
        const workspacePath = localWorkspacePath(summary?.workspace_uris);
        const title = summary?.title ? redactSecrets(summary.title) : undefined;
        const input = readAntigravityTranscript({
          transcriptPath: file.path,
          conversationId: file.conversationId,
          workspacePath,
          latestTurnRunning: !!summary && (summary.not_fully_idle !== 0
            || (!!summary.status && summary.status !== "CASCADE_RUN_STATUS_IDLE")),
          signal: options.signal
        });
        try {
          for await (const message of streamConversationWindow(input, options.since, options.signal, remaining, options.fullHistory)) {
            emitted += 1;
            yield { ...message, sourceId, workspacePath: workspacePath ?? null, gitRoot: null, ...(title ? { sessionTitle: title } : {}) };
          }
        } catch (error) {
          ignoreMissingPath(error);
        }
      }
      options.onProgress?.({ sourceId, phase: "done", current: emitted, total: emitted });
    }
  };
}

function readSummaries(dataPath: string, files: TranscriptFile[]): Map<string, ConversationSummary> {
  const summaries = new Map<string, ConversationSummary>();
  if (!files.length) return summaries;
  try {
    const db = new Database(join(dataPath, "conversation_summaries.db"), { readonly: true, fileMustExist: true, timeout: 100 });
    try {
      const lookup = db.prepare("SELECT title, workspace_uris, status, not_fully_idle FROM conversation_summaries WHERE conversation_id = ?");
      for (const { conversationId } of files) {
        const row = lookup.get(conversationId) as ConversationSummary | undefined;
        if (row) summaries.set(conversationId, row);
      }
    } finally {
      db.close();
    }
  } catch {
    // The transcript is authoritative. Older or temporarily busy indexes may not supply metadata.
  }
  return summaries;
}

function localWorkspacePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const paths: unknown = JSON.parse(value);
    const uri = Array.isArray(paths) && paths.find((entry): entry is string => typeof entry === "string" && entry.startsWith("file://"));
    return uri ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

function ignoreMissingPath(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
}
