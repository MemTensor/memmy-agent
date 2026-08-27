/** Types module. */

/** Contract for source descriptor. */
export interface SourceDescriptor {
  sourceId: string;
  displayName: string;
  builtin: boolean;
  dataPath: string;
}

/** Contract for conversation message. */
export interface ConversationMessage {
  messageId: string;
  sourceId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
  rawMeta: Readonly<Record<string, unknown>>;
}

/** Contract for scan progress. */
export interface ScanProgress {
  sourceId: string;
  phase: "discover" | "read" | "redact" | "emit" | "scan" | "add" | "summarize" | "done" | "stopped";
  current: number;
  total: number;
  message?: string;
}

/** Contract for scan result. */
export interface ScanResult {
  sourceId: string;
  discoveredConversations: number;
  emittedMessages: number;
  skipped: number;
  errors: ReadonlyArray<{ conversationId: string; reason: string }>;
}

/** Contract for source adapter. */
export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  detect(): Promise<boolean>;
  scan(options: ScanOptions): AsyncIterable<ConversationMessage>;
}

/** Contract for scan options. */
export interface ScanOptions {
  since?: string;
  maxMessages?: number;
  maxScanTargets?: number;
  order?: "source_default" | "recent_first";
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}
