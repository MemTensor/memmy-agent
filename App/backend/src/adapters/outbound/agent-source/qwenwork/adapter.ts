import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveQwenworkHomeDirectory, resolveQwenworkProjectsDirectory } from "../../agent-paths.js";
import { collectConversationWindow, remainingMessageCapacity } from "../conversation-window.js";
import { discoverJsonlSessionFiles } from "../jsonl-session-files.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { readQwenworkHistory } from "./history-reader.js";

const QWENWORK_SOURCE_ID = "qwenwork";

export interface CreateQwenworkSourceAdapterDeps {
  rootDirectory?: string;
  projectsRoot?: string;
  descriptor?: SourceDescriptor;
}

export function createQwenworkSourceAdapter(deps: CreateQwenworkSourceAdapterDeps = {}): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveQwenworkHomeDirectory();
  const projectsRoot = deps.projectsRoot ??
    (deps.rootDirectory ? join(rootDirectory, "projects") : resolveQwenworkProjectsDirectory());
  const descriptor = deps.descriptor ?? Object.freeze({
    sourceId: QWENWORK_SOURCE_ID,
    displayName: "qwenwork",
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
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      }
    },
    async *scan(options: ScanOptions) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: 0, total: 1 });
      const sessions = await discoverJsonlSessionFiles({
        root: projectsRoot,
        order: options.order === "recent_first" ? "recent_first" : "path_asc",
        maxSessions: options.maxScanTargets
      });
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "discover", current: sessions.length, total: sessions.length });

      let emittedMessages = 0;
      for (const [sessionIndex, session] of sessions.entries()) {
        options.signal?.throwIfAborted();
        if (options.maxMessages !== undefined && emittedMessages >= options.maxMessages) break;
        options.onProgress?.({
          sourceId: descriptor.sourceId,
          phase: "read",
          current: sessionIndex,
          total: sessions.length,
          message: session.sessionFilePath
        });
        const messages = await collectConversationWindow(
          readQwenworkHistory(session.sessionFilePath, options.signal),
          options.since,
          options.signal,
          remainingMessageCapacity(options.maxMessages, emittedMessages)
        );
        for (const rawMessage of messages) {
          emittedMessages += 1;
          options.onProgress?.({ sourceId: descriptor.sourceId, phase: "emit", current: emittedMessages, total: emittedMessages });
          yield {
            messageId: rawMessage.messageId,
            sourceId: descriptor.sourceId,
            conversationId: rawMessage.conversationId,
            role: rawMessage.role,
            content: redactSecrets(rawMessage.content),
            createdAt: rawMessage.createdAt,
            workspacePath: rawMessage.workspacePath,
            gitRoot: rawMessage.workspacePath ? findGitRoot(rawMessage.workspacePath) : null,
            rawMeta: Object.freeze({})
          } satisfies ConversationMessage;
        }
      }
      options.onProgress?.({ sourceId: descriptor.sourceId, phase: "done", current: emittedMessages, total: emittedMessages });
    }
  };
}

function findGitRoot(workspacePath: string): string | null {
  let current = workspacePath;
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    current = dirname(current);
  }
  return existsSync(join(current, ".git")) ? current : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
