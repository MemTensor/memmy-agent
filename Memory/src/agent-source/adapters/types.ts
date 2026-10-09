/** Types module. Shared with the backend scanner. */
import type {
  ConversationMessage as CoreConversationMessage,
  SourceDescriptor as CoreSourceDescriptor,
  ScanOptions as CoreScanOptions,
  ScanProgress as CoreScanProgress,
  SourceAdapter as CoreSourceAdapter
} from "@memmy/agent-source-core";

/** Contract for source descriptor. */
export type SourceDescriptor = CoreSourceDescriptor;

/** Contract for conversation message. */
export type ConversationMessage = CoreConversationMessage;

/** Contract for scan progress. */
export type ScanProgress = CoreScanProgress;

/** Contract for scan result. */
export interface ScanResult {
  sourceId: string;
  discoveredConversations: number;
  emittedMessages: number;
  skipped: number;
  errors: ReadonlyArray<{ conversationId: string; reason: string }>;
}

/** Contract for source adapter. */
export type SourceAdapter = CoreSourceAdapter;

/** Contract for scan options. */
export type ScanOptions = CoreScanOptions;
