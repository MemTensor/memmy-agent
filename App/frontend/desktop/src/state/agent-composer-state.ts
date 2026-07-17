/**
 * Agent composer draft and pending attachment state.
 *
 * This file contains only scope helpers and in-memory pending attachment
 * shapes. Browser object URLs and Blob/File values stay inside the current
 * renderer lifetime; they are not persisted to storage or backend state.
 */
import type { MessageKey } from "../i18n/messages.js";
import type { AgentImageMime } from "../lib/agent-image-encode.js";
import type { UploadedAgentMedia } from "../api/memmy-agent-client.js";

export type ComposerDraftValue = string | ((currentValue: string) => string);

export interface PendingAttachmentBase {
  id: string;
  sourceKey: string;
  fileName: string;
  kind: "image" | "file";
  status: "encoding" | "ready" | "error";
  originalBytes: number;
  errorKey?: MessageKey;
}

export interface PendingImage extends PendingAttachmentBase {
  kind: "image";
  previewUrl: string;
  encodedBlob?: Blob;
  encodedMime?: AgentImageMime;
  encodedBytes?: number;
  normalized?: boolean;
}

export interface PendingFileAttachment extends PendingAttachmentBase {
  kind: "file";
  status: "ready" | "error";
  uploadBlob?: Blob;
  uploadMime?: UploadedAgentMedia["mime"];
  uploadBytes?: number;
  extension: string;
}

export type PendingAttachment = PendingImage | PendingFileAttachment;

export function agentChatScopeKey(currentChatId: string | null, newChatRequestId: number): string {
  return currentChatId ?? `draft-${newChatRequestId}`;
}

export function updateComposerDraftForScope(
  drafts: Record<string, string>,
  scopeKey: string,
  value: ComposerDraftValue
): Record<string, string> {
  const currentValue = drafts[scopeKey] ?? "";
  const nextValue = typeof value === "function" ? value(currentValue) : value;
  if (!nextValue) {
    if (!(scopeKey in drafts)) {
      return drafts;
    }
    const nextDrafts = { ...drafts };
    delete nextDrafts[scopeKey];
    return nextDrafts;
  }
  if (currentValue === nextValue) {
    return drafts;
  }
  return { ...drafts, [scopeKey]: nextValue };
}
