import fs from "node:fs";
import path from "node:path";
import type { InboundMessage, TurnSource } from "../../core/runtime-messages/events.js";
import type { GoalStatus } from "../../core/session/goal-state.js";
import type { ProviderErrorCategory } from "../../providers/provider-error-classifier.js";
import {
  readWebuiSessionBinding,
  type Session,
  type SessionManager,
  type WebuiSessionBinding,
} from "../../core/session/manager.js";
import {
  appendTranscriptObject,
  readTranscriptChunk,
  webuiTranscriptPath,
} from "./transcript.js";
import {
  GuiSessionProjection,
  isProjectableCanonicalSessionKey,
  toGuiChatId,
} from "./gui-session-projection.js";

type MirrorTurn = {
  sessionKey: string;
  chatId: string;
  turnId: string;
  source: TurnSource | null;
  clientRequestId: string | null;
};

type MonitorCursor = {
  inode: number;
  offset: number;
  size: number;
};

export type GatewayTranscriptRecordHandler = (
  record: Record<string, any>,
  canonicalSessionKey: string,
) => Promise<void> | void;

function guiSessionKey(sessionKey: string): string {
  return `websocket:${toGuiChatId(sessionKey)}`;
}

export class GuiTranscriptMirror {
  readonly sessions: SessionManager;
  readonly workspace: string;

  constructor(sessions: SessionManager, workspace: string) {
    this.sessions = sessions;
    this.workspace = fs.realpathSync(path.resolve(workspace));
  }

  sessionKeyForMessage(message: InboundMessage): string | null {
    if (message.channel === "websocket" || message.channel === "system") return null;
    const candidate = `${message.channel}:${message.chatId}`;
    return message.sessionKey === candidate
      && isProjectableCanonicalSessionKey(candidate)
      ? candidate
      : null;
  }

  prepareSession(
    message: InboundMessage,
    session: Session,
    sessionKey: string,
  ): WebuiSessionBinding | null {
    if (
      message.channel === "websocket"
      || !isProjectableCanonicalSessionKey(sessionKey)
    ) {
      return null;
    }
    if (sessionKey.startsWith("cli:")) {
      if (session.metadata?.webui !== true) return null;
      return readWebuiSessionBinding(session);
    }
    if (sessionKey !== `${message.channel}:${message.chatId}`) return null;
    const expected: WebuiSessionBinding = { projectId: null, cwd: this.workspace };
    if (session.metadata?.webui === true) {
      const binding = readWebuiSessionBinding(session);
      if (binding.projectId !== null || binding.cwd !== expected.cwd) {
        throw new Error("projected_session_binding_conflict");
      }
      return binding;
    }
    session.metadata.webui = true;
    session.metadata.webuiProjectId = null;
    session.metadata.webuiWorkspaceCwd = expected.cwd;
    this.sessions.save(session, { fsync: true });
    this.append(sessionKey, {
      event: "session_updated",
      chat_id: toGuiChatId(sessionKey),
      scope: "metadata",
    });
    return expected;
  }

  turn(
    sessionKey: string,
    turnId: string,
    source: TurnSource | null = null,
    clientRequestId: string | null = null,
  ): MirrorTurn | null {
    if (!isProjectableCanonicalSessionKey(sessionKey)) return null;
    try {
      return { sessionKey, chatId: toGuiChatId(sessionKey), turnId, source, clientRequestId };
    } catch {
      return null;
    }
  }

  append(sessionKey: string, record: Record<string, any>): number {
    return appendTranscriptObject(guiSessionKey(sessionKey), record);
  }

  private appendTurn(turn: MirrorTurn, record: Record<string, any>): number {
    return this.append(turn.sessionKey, {
      ...record,
      ...(turn.source ? { source: turn.source } : {}),
    });
  }

  sessionUpdated(sessionKey: string): void {
    const chatId = toGuiChatId(sessionKey);
    this.append(sessionKey, { event: "session_updated", chat_id: chatId, scope: "metadata" });
  }

  running(turn: MirrorTurn, startedAt: number): void {
    this.appendTurn(turn, {
      event: "run_status",
      chat_id: turn.chatId,
      status: "running",
      started_at: startedAt,
      turn_id: turn.turnId,
    });
  }

  user(turn: MirrorTurn, text: string, mediaPaths: string[] = []): void {
    this.appendTurn(turn, {
      event: "user",
      chat_id: turn.chatId,
      text,
      turn_id: turn.turnId,
      ...(turn.clientRequestId ? { client_request_id: turn.clientRequestId } : {}),
      ...(mediaPaths.length ? { media_paths: mediaPaths } : {}),
    });
  }

  progress(turn: MirrorTurn, content: string, options: Record<string, any> = {}): void {
    if (options.reasoning || options.reasoningDelta) {
      this.appendTurn(turn, {
        event: "reasoning_delta",
        chat_id: turn.chatId,
        text: content,
        turn_id: turn.turnId,
      });
      return;
    }
    if (options.reasoningEnd) {
      this.appendTurn(turn, {
        event: "reasoning_end",
        chat_id: turn.chatId,
        turn_id: turn.turnId,
      });
      return;
    }
    const fileEditEvents = Array.isArray(options.fileEditEvents)
      ? options.fileEditEvents
      : [];
    if (fileEditEvents.length) {
      const cancellationTerminal = fileEditEvents.every(
        (event: any) => event?.cancellation_terminal === true,
      );
      this.appendTurn(turn, {
        event: "file_edit",
        chat_id: turn.chatId,
        turn_id: turn.turnId,
        edits: fileEditEvents,
        ...(cancellationTerminal ? { cancellation_terminal: true } : {}),
      });
    }
    if (!content && fileEditEvents.length && !options.toolEvents) return;
    this.appendTurn(turn, {
      event: "message",
      chat_id: turn.chatId,
      text: content,
      content,
      kind: options.toolHint ? "tool_hint" : "progress",
      turn_id: turn.turnId,
      ...(options.toolEvents ? { tool_events: options.toolEvents } : {}),
      ...(options.agentUi != null ? { agent_ui: options.agentUi } : {}),
    });
  }

  delta(turn: MirrorTurn, text: string, streamId: string): void {
    this.appendTurn(turn, {
      event: "delta",
      chat_id: turn.chatId,
      text,
      stream_id: streamId,
      turn_id: turn.turnId,
    });
  }

  streamEnd(turn: MirrorTurn, streamId: string, resuming = false): void {
    this.appendTurn(turn, {
      event: "stream_end",
      chat_id: turn.chatId,
      stream_id: streamId,
      turn_id: turn.turnId,
      ...(resuming ? { resuming: true } : {}),
    });
  }

  contextCompaction(
    turn: MirrorTurn,
    text: string,
    status: "running" | "done" | "error",
  ): void {
    this.appendTurn(turn, {
      event: "context_compaction",
      chat_id: turn.chatId,
      compaction_id: `context-compaction:${turn.turnId}`,
      status,
      text,
      content: text,
      turn_id: turn.turnId,
    });
  }

  retryWait(turn: MirrorTurn, text: string): void {
    this.appendTurn(turn, {
      event: "retry_wait",
      chat_id: turn.chatId,
      text,
      turn_id: turn.turnId,
    });
  }

  final(
    turn: MirrorTurn,
    text: string,
    latencyMs: number | null = null,
    agentUi: unknown = null,
    errorCategory: ProviderErrorCategory | null = null,
    modelError: {
      category: ProviderErrorCategory | "model_failed";
      detail?: string;
      presetId?: string;
      source?: "account" | "byok";
      provider?: string;
      model?: string;
      capability?: string;
      failedProvider?: string;
      failedModel?: string;
    } | null = null,
  ): void {
    this.appendTurn(turn, {
      event: "message",
      chat_id: turn.chatId,
      text,
      content: text,
      turn_id: turn.turnId,
      ...(latencyMs == null ? {} : { latency_ms: latencyMs }),
      ...(agentUi != null ? { agent_ui: agentUi } : {}),
      ...(modelError || errorCategory
        ? { model_error: modelError ?? { category: errorCategory } }
        : {}),
    });
  }

  ended(
    turn: MirrorTurn,
    latencyMs: number | null = null,
    goalId: string | null = null,
    goalOutcome: GoalStatus | null = null,
  ): void {
    this.appendTurn(turn, {
      event: "turn_end",
      chat_id: turn.chatId,
      turn_id: turn.turnId,
      ...(latencyMs == null ? {} : { latency_ms: latencyMs }),
      ...(goalId && goalOutcome ? { goal_id: goalId, goal_outcome: goalOutcome } : {}),
    });
    this.appendTurn(turn, {
      event: "run_status",
      chat_id: turn.chatId,
      status: "idle",
      turn_id: turn.turnId,
    });
    this.sessionUpdated(turn.sessionKey);
  }
}

export class GatewayTranscriptMonitor {
  readonly projection: GuiSessionProjection;
  readonly onRecord: GatewayTranscriptRecordHandler;
  readonly onRefresh: (guiChatId: string) => Promise<void> | void;
  private readonly cursors = new Map<string, MonitorCursor>();
  private interval: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private scanPromise: Promise<void> | null = null;

  constructor({
    projection,
    onRecord,
    onRefresh,
  }: {
    projection: GuiSessionProjection;
    onRecord: GatewayTranscriptRecordHandler;
    onRefresh: (guiChatId: string) => Promise<void> | void;
  }) {
    this.projection = projection;
    this.onRecord = onRecord;
    this.onRefresh = onRefresh;
  }

  start(): void {
    if (this.interval) return;
    let summaries: Record<string, any>[] = [];
    try {
      summaries = this.projection.snapshot();
    } catch {
      summaries = [];
    }
    for (const summary of summaries) {
      const key = String(summary.key);
      const file = webuiTranscriptPath(key);
      try {
        const stat = fs.statSync(file);
        this.cursors.set(key, {
          inode: Number(stat.ino),
          offset: stat.size,
          size: stat.size,
        });
      } catch {
        // New transcript files are consumed from offset zero.
      }
    }
    const directory = path.dirname(webuiTranscriptPath("websocket:monitor"));
    fs.mkdirSync(directory, { recursive: true });
    try {
      this.watcher = fs.watch(directory, () => void this.scan());
    } catch {
      this.watcher = null;
    }
    this.interval = setInterval(() => void this.scan(), 250);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  noteConsumed(projectedSessionKey: string, offset: number): void {
    const file = webuiTranscriptPath(projectedSessionKey);
    try {
      const stat = fs.statSync(file);
      this.cursors.set(projectedSessionKey, {
        inode: Number(stat.ino),
        offset,
        size: stat.size,
      });
    } catch {
      // The periodic scan will rebuild state if the file reappears.
    }
  }

  async scan(): Promise<void> {
    if (!this.scanPromise) {
      this.scanPromise = this.scanOnce().finally(() => {
        this.scanPromise = null;
      });
    }
    return this.scanPromise;
  }

  async drain(): Promise<void> {
    if (this.scanPromise) await this.scanPromise;
    await this.scan();
  }

  private async scanOnce(): Promise<void> {
    let summaries: Record<string, any>[];
    try {
      summaries = this.projection.snapshot();
    } catch {
      return;
    }
    for (const summary of summaries) {
      const projectedSessionKey = String(summary.key);
      const guiChatId = projectedSessionKey.slice("websocket:".length);
      let resolved;
      try {
        resolved = this.projection.resolve(projectedSessionKey);
      } catch {
        continue;
      }
      const previous = this.cursors.get(projectedSessionKey);
      const chunk = readTranscriptChunk(projectedSessionKey, previous?.offset ?? 0);
      if (!chunk) continue;
      if (
        previous
        && (previous.inode !== chunk.inode || chunk.size < previous.size)
      ) {
        this.cursors.set(projectedSessionKey, {
          inode: chunk.inode,
          offset: chunk.size,
          size: chunk.size,
        });
        await this.onRefresh(guiChatId);
        continue;
      }
      let malformed = false;
      for (const line of chunk.completeLines) {
        if (!line.trim()) continue;
        let record: Record<string, any>;
        try {
          record = JSON.parse(line);
        } catch {
          malformed = true;
          continue;
        }
        if (
          !record
          || typeof record !== "object"
          || Array.isArray(record)
          || record.chat_id !== guiChatId
        ) {
          malformed = true;
          continue;
        }
        this.projection.sessions.invalidate(resolved.canonicalSessionKey);
        await this.onRecord(record, resolved.canonicalSessionKey);
      }
      this.cursors.set(projectedSessionKey, {
        inode: chunk.inode,
        offset: chunk.nextOffset,
        size: chunk.size,
      });
      if (malformed) await this.onRefresh(guiChatId);
    }
  }
}
