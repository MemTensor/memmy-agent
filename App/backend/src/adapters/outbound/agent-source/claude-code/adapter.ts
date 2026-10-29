/** Adapter module. */
import { access } from "node:fs/promises";
import { resolveClaudeCodeProjectsDirectory } from "../../agent-paths.js";
import { streamConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { readJsonlSessionTitle } from "../jsonl-session-title.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { discoverClaudeCodeSessions } from "./project-discovery.js";
import { readClaudeCodeTranscript, type RawClaudeCodeMessage } from "./transcript-reader.js";

const CLAUDE_CODE_SOURCE_ID = "claude_code";

export interface CreateClaudeCodeSourceAdapterDeps {
  /** Projects root. */
  projectsRoot?: string;
  /** Descriptor. */
  descriptor?: SourceDescriptor;
}

/** Creates create claude code source adapter. */
export function createClaudeCodeSourceAdapter(deps: CreateClaudeCodeSourceAdapterDeps = {}): SourceAdapter {
  const projectsRoot = deps.projectsRoot ?? resolveClaudeCodeProjectsDirectory();
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: CLAUDE_CODE_SOURCE_ID,
      displayName: "Claude Code",
      builtin: true,
      dataPath: projectsRoot
    });

  return {
    descriptor,

    async detect() {
      try {
        await access(projectsRoot);
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
      const sessions = await discoverClaudeCodeSessions({
        root: projectsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: sessions.length, total: sessions.length });

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

        // Claude Code keeps the conversation's own title next to its turns; reading it once per file
        // gives every message of the file the name the person sees in Claude Code.
        const sessionTitle = await readJsonlSessionTitle(session.sessionFilePath);
        for await (const rawMessage of streamConversationWindow(
          readClaudeCodeTranscript(session.sessionFilePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages),
          options.fullHistory
        )) {
          throwIfAborted(options.signal);
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "redact", current: emittedMessages, total: emittedMessages + 1 });
          emittedMessages += 1;
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "emit", current: emittedMessages, total: emittedMessages });
          yield toConversationMessage(descriptor.sourceId, rawMessage, session.workspacePath, session.gitRoot, sessionTitle);
        }
      }

      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emittedMessages, total: emittedMessages });
    }
  };
}

/** Handles to conversation message. */
function toConversationMessage(
  sourceId: string,
  rawMessage: RawClaudeCodeMessage,
  discoveredWorkspacePath: string | null,
  discoveredGitRoot: string | null,
  sessionTitle: string | null
): ConversationMessage {
  return {
    messageId: rawMessage.messageId,
    sourceId,
    conversationId: rawMessage.conversationId,
    role: rawMessage.role,
    content: redactSecrets(rawMessage.content),
    createdAt: rawMessage.createdAt,
    workspacePath: rawMessage.workspacePath ?? discoveredWorkspacePath,
    gitRoot: rawMessage.gitRoot ?? discoveredGitRoot,
    ordinal: rawMessage.ordinal,
    ...(sessionTitle ? { sessionTitle } : {}),
    rawMeta: rawMessage.rawMeta
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Claude Code source scan aborted", "AbortError");
  }
}

function limitReached(count: number, maxMessages: number | undefined): boolean {
  return maxMessages !== undefined && count >= maxMessages;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
