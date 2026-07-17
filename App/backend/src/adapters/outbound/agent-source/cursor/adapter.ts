/** Adapter module. */
import { access } from "node:fs/promises";
import { resolveCursorDataPaths } from "../../agent-paths.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, ScanOptions, SourceAdapter, SourceDescriptor } from "../types.js";
import { readCursorVscdb, type RawCursorMessage } from "./vscdb-reader.js";
import { discoverCursorWorkspaces, type CursorWorkspace } from "./workspace-discovery.js";

const CURSOR_SOURCE_ID = "cursor";

/** Contract for create cursor source adapter deps. */
export interface CreateCursorSourceAdapterDeps {
  storageRoot?: string;
  globalStateDbPath?: string;
  descriptor?: SourceDescriptor;
}

interface CursorScanTarget {
  /** Storage hash. */
  storageHash: string;
  /** State db path. */
  stateDbPath: string;
  /** Workspace path. */
  workspacePath: string | null;
  /** Git root. */
  gitRoot: string | null;
}

/** Creates create cursor source adapter. */
export function createCursorSourceAdapter(deps: CreateCursorSourceAdapterDeps = {}): SourceAdapter {
  const defaultPaths = resolveCursorDataPaths();
  const storageRoot = deps.storageRoot ?? defaultPaths.workspaceStorageDirectory;
  const globalStateDbPath = deps.globalStateDbPath ?? (deps.storageRoot ? undefined : defaultPaths.globalStateDbPath);
  const descriptor =
    deps.descriptor ??
    Object.freeze({
      sourceId: CURSOR_SOURCE_ID,
      displayName: "Cursor",
      builtin: true,
      dataPath: storageRoot
    });

  return {
    descriptor,

    async detect() {
      return await pathExists(storageRoot) || await optionalPathExists(globalStateDbPath);
    },

    async *scan(options: ScanOptions) {
      throwIfAborted(options.signal);
      options.onProgress?.({
        sourceId: descriptor.sourceId,
        phase: "discover",
        current: 0,
        total: 1,
        message: "Discovering Cursor workspaces"
      });

      const workspaces = await discoverAvailableCursorWorkspaces(storageRoot, options);
      const targets = [
        ...workspaces.map(toWorkspaceScanTarget),
        ...(await discoverGlobalStateTarget(globalStateDbPath))
      ];
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
          message: target.storageHash
        });

        for await (const rawMessage of readCursorVscdb(target.stateDbPath)) {
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

          const message = toConversationMessage(descriptor.sourceId, target, rawMessage);
          emittedMessages += 1;
          options.onProgress?.({
            sourceId: descriptor.sourceId,
            phase: "emit",
            current: emittedMessages,
            total: emittedMessages
          });
          yield message;
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

/** Handles discover available cursor workspaces. */
async function discoverAvailableCursorWorkspaces(storageRoot: string, options: ScanOptions): Promise<CursorWorkspace[]> {
  if (!(await pathExists(storageRoot))) {
    return [];
  }

  return await discoverCursorWorkspaces({
    storageRoot,
    order: options.order === "recent_first" ? "recent_first" : "hash_asc",
    maxWorkspaces: options.maxScanTargets
  });
}

/** Handles discover global state target. */
async function discoverGlobalStateTarget(stateDbPath: string | undefined): Promise<CursorScanTarget[]> {
  if (!stateDbPath || !(await pathExists(stateDbPath))) {
    return [];
  }

  return [
    {
      storageHash: "globalStorage",
      stateDbPath,
      workspacePath: null,
      gitRoot: null
    }
  ];
}

/** Handles to workspace scan target. */
function toWorkspaceScanTarget(workspace: CursorWorkspace): CursorScanTarget {
  return {
    storageHash: workspace.storageHash,
    stateDbPath: workspace.stateDbPath,
    workspacePath: workspace.workspacePath,
    gitRoot: workspace.gitRoot
  };
}

/** Handles to conversation message. */
function toConversationMessage(
  sourceId: string,
  target: CursorScanTarget,
  rawMessage: RawCursorMessage
): ConversationMessage {
  return {
    messageId: rawMessage.messageId,
    sourceId,
    conversationId: rawMessage.conversationId,
    role: rawMessage.role,
    content: redactSecrets(rawMessage.content),
    createdAt: rawMessage.createdAt,
    workspacePath: target.workspacePath,
    gitRoot: target.gitRoot,
    rawMeta: Object.freeze({
      ...rawMessage.rawMeta,
      cursorStorageHash: target.storageHash
    })
  };
}

/** Handles throw if aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Cursor source scan aborted", "AbortError");
  }
}

function limitReached(count: number, maxMessages: number | undefined): boolean {
  return maxMessages !== undefined && count >= maxMessages;
}

/** Handles path exists. */
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

/** Handles optional path exists. */
async function optionalPathExists(path: string | undefined): Promise<boolean> {
  return path ? await pathExists(path) : false;
}

/** Checks is node error. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
