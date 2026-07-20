/** Home page module. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent, type SetStateAction, type UIEvent } from "react";
import { hydrateAgentThreadInBackground, refreshAgentTaskList, useAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useApiClients } from "../app/providers.js";
import { FOCUSED_AGENT_CHAT_STORAGE_KEY, clearFocusedAgentTarget, normalizeAgentChatId, readLaunchAgentChatId, removeLaunchAgentChatIdFromUrl } from "../app/routes.js";
import {
  MemmyAgentRequestError,
  type MemmyAgentClient,
  type MemmyAgentSlashCommand,
  type MemmyAgentUiLanguage,
  type MemmyAgentWebSocketConnection,
  type UploadAgentMediaInput,
  type UploadedAgentMedia
} from "../api/memmy-agent-client.js";
import type { AnalyticsEvent } from "../analytics/analytics-events.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { Memmy } from "../components/mascot/memmy.js";
import { formatMessage, type MessageKey, type MessageValues, zhCNMessages } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_FILE_TARGET_MAX_BYTES,
  agentAttachmentAccept,
  classifyAgentAttachmentFile,
  safeAgentAttachmentFilename,
  type AgentAttachmentClassification,
} from "../lib/agent-attachment.js";
import { encodeAgentImage, type AgentImageMime } from "../lib/agent-image-encode.js";
import { formatConversationTitleForDisplay } from "../lib/format-conversation-title.js";
import { useTaskBus, type TaskBusAgentMessage } from "../lib/task-bus.js";
import type { AppAction } from "../state/app-actions.js";
import { agentActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import {
  agentChatScopeKey,
  updateComposerDraftForScope,
  type PendingAttachment,
  type PendingAttachmentBase,
  type PendingFileAttachment,
  type PendingImage
} from "../state/agent-composer-state.js";
import {
  AgentCommandPalette,
  buildVisibleSlashCommands,
  filterSlashCommands,
  localizeSlashCommands,
  readRecentSlashCommands,
  slashQueryFromInput,
  updateRecentSlashCommands,
  writeRecentSlashCommands,
  type SlashCommandPaletteItem,
  type SlashCommandStorageLike
} from "./agent-command-palette.js";
import { AgentAttachmentCard, splitAgentAttachmentName } from "./agent-file-attachment-chip.js";
import { AgentThreadMessages, ChatImageLightbox } from "./agent-thread-messages.js";
import { AppFrame } from "./app-frame.js";
import { mergeVoiceTranscript, useAsrRecorder } from "./asr-recorder.js";
import { consumePendingFirstEncounterTaskLaunch } from "./first-encounter-task-launch.js";
import { HistoryDagPanel, type HistoryDagPanelState } from "./history-dag-panel.js";
import { Mic, Pause, Plus, Send } from "./memory/memory-prototype-icons.js";
import { ArrowDown, RotateCw, X } from "lucide-react";

export { agentChatScopeKey, updateComposerDraftForScope };
export { hydrateAgentThreadInBackground };
export { isComposingKeyboardEvent } from "../utils/keyboard.js";
export type { PendingAttachment, PendingAttachmentBase, PendingFileAttachment, PendingImage };

const COMPOSER_MEDIA_STRIP_STYLE = { maxHeight: "min(7.5rem, 28vh)" } satisfies CSSProperties;
const AGENT_WS_SAFE_FRAME_BYTES = 1024 * 1024;
const COMPOSER_HEIGHT_EPSILON = 2;
const COMPOSER_SINGLE_LINE_HEIGHT_PX = 52;
const AGENT_CONVERSATION_BOTTOM_EPSILON_PX = 4;
const SLASH_COMMAND_RETRY_DELAYS_MS = [300, 1000, 2500];
/**
 * How long a wheel/touch gesture counts as "the user just took over scrolling".
 * Only scroll events inside this window are allowed to turn auto-scroll off,
 * so a scroll event fired by our own `scrollTop` assignment (or one merely
 * racing with fast-streaming content growth) can never be mistaken for the
 * user grabbing the scrollbar. Reaching the bottom always re-arms auto-scroll
 * immediately, regardless of what triggered that scroll event.
 */
const AGENT_CONVERSATION_USER_SCROLL_INTENT_MS = 600;
/** Definition for agent error auto dismiss ms. */
export const AGENT_ERROR_AUTO_DISMISS_MS = 5000;
/** Definition for stop confirmation grace ms. */
export const STOP_CONFIRMATION_GRACE_MS = 8000;
/** Definition for composer error auto dismiss ms. */
export const COMPOSER_ERROR_AUTO_DISMISS_MS = 5000;
const TRANSLATABLE_AGENT_ERROR_KEYS = new Set<MessageKey>([
  "home.media.error.sendUnsupported",
  "home.media.error.sendSize",
  "home.media.error.sendFileSize",
  "home.media.error.sendTooManyImages",
  "home.media.error.sendTooManyAttachments",
  "home.media.error.sendReadFailed",
  "home.media.error.sendFailed",
  "home.media.error.messageTooBig"
]);
export const AGENT_ATTACHMENT_ACCEPT = agentAttachmentAccept();
export const AGENT_MEDIA_ACCEPT = AGENT_ATTACHMENT_ACCEPT;
export const AGENT_RESTART_STATE_STORAGE_KEY = "memmy-agent-restart-state";

export interface ComposerSubmitButtonProps {
  /** Is sending. */
  isSending: boolean;
  /** Disabled. */
  disabled: boolean;
  /** Send label. */
  sendLabel: string;
  /** Stop label. */
  stopLabel: string;
  /** Variant. */
  variant?: "empty" | "compact";
  /** On click. */
  onClick: () => void;
}
export type StatusPanelState =
  | { open: false }
  | { open: true; loading: boolean; content: string; error: string | null };

export interface StoredAgentRestartState {
  /** Chat id. */
  chatId: string;
  /** Started at. */
  startedAt: number;
  /** Saw disconnect. */
  sawDisconnect: boolean;
}

export interface RequestAgentRestartInput {
  /** Chat id. */
  chatId: string | null;
  /** Connection. */
  connection: Pick<MemmyAgentWebSocketConnection, "restart"> | null;
  /** Ensure chat subscription. */
  ensureChatSubscription?: (chatId: string) => void;
  /** Dispatch. */
  dispatch: (action: AppAction) => void;
  /** Track. */
  track: (event: AnalyticsEvent) => void;
  /** Storage. */
  storage?: SlashCommandStorageLike | null;
  /** Now. */
  now?: () => number;
}

export interface RequestAgentStatusInput {
  chatId: string | null;
  connection: Pick<MemmyAgentWebSocketConnection, "status"> | null;
  failedMessage: string;
  setStatusPanel: (state: StatusPanelState) => void;
}

export interface RequestNewSessionResetInput {
  chatId: string | null;
  connection: Pick<MemmyAgentWebSocketConnection, "sendMessage"> | null;
  ensureChatSubscription?: (chatId: string) => void;
  clearInput: () => void;
  clearPendingMedia: () => void;
  dismissSlashMenu: () => void;
  focusInput?: () => void;
}

export interface SubmitAgentComposerMessageInput {
  chatId: string | null;
  connection: Pick<MemmyAgentWebSocketConnection, "newChat" | "sendMessage"> | null;
  ensureChatSubscription?: (chatId: string) => void;
  content: string;
  language?: MemmyAgentUiLanguage;
  pendingAttachments: PendingAttachment[];
  uploadAgentMedia: (attachments: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  dispatch: (action: AppAction) => void;
  track: (event: AnalyticsEvent) => void;
  setCreatingChat?: (value: boolean) => void;
  setComposerMediaError?: (message: string | null) => void;
  clearComposer: () => void;
  onNewChatMessageSent?: (chatId: string) => void;
}

export interface RequestAgentStopInput {
  chatId: string | null;
  connection: Pick<MemmyAgentWebSocketConnection, "stop"> | null;
  stopInFlightByChatId: Record<string, boolean>;
  stopRequestLocks: Set<string>;
  dispatch: (action: AppAction) => void;
  track: (event: AnalyticsEvent) => void;
}

export function requestAgentStop(input: RequestAgentStopInput): boolean {
  const { chatId, connection } = input;
  if (!chatId || !connection || input.stopInFlightByChatId[chatId] || input.stopRequestLocks.has(chatId)) {
    return false;
  }

  input.stopRequestLocks.add(chatId);
  try {
    input.track({ name: "agent_stop_generation", params: { page_path: "/main" }, consentTier: "basic" });
    input.dispatch(agentActions.stopRequested(chatId));
    connection.stop(chatId);
    return true;
  } catch (error) {
    input.stopRequestLocks.delete(chatId);
    throw error;
  }
}

export function isSingleLineComposerInput(element: HTMLTextAreaElement): boolean {
  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const singleLineHeight = (Number.isFinite(lineHeight) ? lineHeight : element.clientHeight) + paddingTop + paddingBottom;
  return element.scrollHeight <= singleLineHeight + COMPOSER_HEIGHT_EPSILON;
}

export function isAgentConversationAtBottom(element: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - AGENT_CONVERSATION_BOTTOM_EPSILON_PX;
}

export function hasActiveAgentConversation(currentChatId: string | null, messageCount: number): boolean {
  return Boolean(currentChatId) && messageCount > 0;
}

export function shouldAcceptAgentStatusResult(input: {
  pendingStatusChatId: string | null;
  subscribedChatId: string | null;
  resultChatId: string;
}): boolean {
  return input.pendingStatusChatId === input.resultChatId && input.subscribedChatId === input.resultChatId;
}

export function ComposerMediaPreviewStrip(props: {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
  removeLabel?: string;
  selectedLabel?: string;
  t?: HomeTranslate;
}) {
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const previewImages = props.items.filter((item): item is PendingImage => item.kind === "image");
  const previewImageIndex = previewImageId == null
    ? -1
    : previewImages.findIndex((item) => item.id === previewImageId);

  if (!props.items.length) {
    return null;
  }
  const removeLabel = props.removeLabel ?? "Remove";
  const translate = props.t ?? defaultHomeTranslate;

  return (
    <>
      <div className="composer-media-preview-strip" style={COMPOSER_MEDIA_STRIP_STYLE} aria-label={props.selectedLabel ?? "Selected media"}>
        {props.items.map((item) => (
          item.kind === "image" ? (
            <ComposerImageAttachmentChip
              key={item.id}
              item={item}
              onPreview={setPreviewImageId}
              onRemove={props.onRemove}
              removeLabel={removeLabel}
              t={translate}
            />
          ) : (
            <ComposerFileAttachmentChip
              key={item.id}
              item={item}
              onRemove={props.onRemove}
              removeLabel={removeLabel}
            />
          )
        ))}
      </div>
      {previewImageIndex < 0 ? null : (
        <ChatImageLightbox
          images={previewImages.map((item) => ({ url: item.previewUrl, name: item.fileName }))}
          index={previewImageIndex}
          onIndexChange={(index) => setPreviewImageId(previewImages[index]?.id ?? null)}
          onClose={() => setPreviewImageId(null)}
        />
      )}
    </>
  );
}

export function ComposerImageAttachmentChip(props: {
  item: PendingImage;
  onPreview: (id: string) => void;
  onRemove: (id: string) => void;
  removeLabel: string;
  t: HomeTranslate;
}) {
  const { item, t } = props;
  const extensionLabel = splitAgentAttachmentName(item.fileName, item.encodedMime ? `.${item.encodedMime.slice("image/".length)}` : undefined).extensionLabel;
  const subline = item.status === "error"
    ? t(item.errorKey ?? "home.media.error.sendReadFailed")
    : `${extensionLabel} · ${formatBytes(item.originalBytes)}`;

  return (
    <AgentAttachmentCard
      kind="image"
      name={item.fileName}
      previewUrl={item.previewUrl}
      subline={subline}
      removable
      removeLabel={props.removeLabel}
      title={item.fileName}
      onClick={() => props.onPreview(item.id)}
      onRemove={() => props.onRemove(item.id)}
      error={item.status === "error"}
      thumbnailOverlay={item.status === "encoding" ? <RotateCw size={13} className="animate-spin" /> : null}
    />
  );
}

export function ComposerFileAttachmentChip(props: {
  item: PendingFileAttachment;
  onRemove: (id: string) => void;
  removeLabel: string;
}) {
  const { item } = props;
  const extensionLabel = splitAgentAttachmentName(item.fileName, item.extension).extensionLabel;
  return (
    <AgentAttachmentCard
      kind="file"
      name={item.fileName}
      mime={item.uploadMime}
      subline={`${extensionLabel} · ${formatBytes(item.uploadBytes ?? item.originalBytes)}`}
      removable
      removeLabel={props.removeLabel}
      title={item.fileName}
      onRemove={() => props.onRemove(item.id)}
      error={item.status === "error"}
    />
  );
}

/**
 * Renders the send/stop button on the right side of the input box.
 *
 * @param props Button state, label, style variant, and action.
 * @returns While sending, renders only stop; when idle, renders only send.
 */
export function ComposerSubmitButton(props: ComposerSubmitButtonProps) {
  const isCompact = props.variant === "compact";
  const squareSize = isCompact ? 10 : 11;
  const sendIconSize = isCompact ? 13 : 14;
  const baseClassName = "inline-flex shrink-0 items-center justify-center leading-none rounded-full w-7 h-7 transition-colors";
  const stateClassName = props.disabled
    ? "bg-text-ink/25 text-white cursor-not-allowed"
    : "bg-action-sky text-white hover:bg-action-sky-hover shadow-sm cursor-pointer";
  const className = `${baseClassName} ${stateClassName}`;

  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.isSending ? props.stopLabel : props.sendLabel}
      title={props.isSending ? props.stopLabel : props.sendLabel}
      className={className}
    >
      {props.isSending ? (
        <span className="inline-flex items-center justify-center">
          <span
            className="block shrink-0 bg-white"
            style={{ width: squareSize, height: squareSize, borderRadius: 2 }}
            aria-hidden
          />
          <span className="sr-only">{props.stopLabel}</span>
        </span>
      ) : (
        <span className="inline-flex items-center justify-center">
          <Send size={sendIconSize} className="translate-y-[1px]" />
          <span className="sr-only">{props.sendLabel}</span>
        </span>
      )}
    </button>
  );
}

export function AgentStatusPanel(props: { state: StatusPanelState; closeLabel: string; loadingLabel: string; onClose: () => void }) {
  if (!props.state.open) {
    return null;
  }
  const content = props.state.loading ? props.loadingLabel : props.state.error ?? props.state.content;
  return (
    <div role="status" className="rounded-card border border-border-stone/40 bg-background-paper shadow-xl p-3">
      <div className="flex items-start gap-3">
        <pre className={`min-w-0 flex-1 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 font-mono ${props.state.error ? "text-status-error" : "text-text-ink/70"}`}>{content}</pre>
        <button
          type="button"
          aria-label={props.closeLabel}
          title={props.closeLabel}
          onClick={props.onClose}
          className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-btn text-text-ink/45 hover:bg-canvas-oat/70 hover:text-text-ink/70 transition-all cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function parseStoredAgentRestartState(raw: string | null): StoredAgentRestartState | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
    const startedAt = typeof record.startedAt === "number" ? record.startedAt : NaN;
    const sawDisconnect = record.sawDisconnect === true;
    return chatId && Number.isFinite(startedAt) ? { chatId, startedAt, sawDisconnect } : null;
  } catch {
    return null;
  }
}

export function readStoredAgentRestartState(storage: SlashCommandStorageLike | null = browserStorage()): StoredAgentRestartState | null {
  return storage ? parseStoredAgentRestartState(storage.getItem(AGENT_RESTART_STATE_STORAGE_KEY)) : null;
}

export function writeStoredAgentRestartState(state: StoredAgentRestartState, storage: SlashCommandStorageLike | null = browserStorage()): void {
  storage?.setItem(AGENT_RESTART_STATE_STORAGE_KEY, JSON.stringify(state));
}

export function clearStoredAgentRestartState(storage: SlashCommandStorageLike | null = browserStorage()): void {
  if (!storage) {
    return;
  }
  if (storage.removeItem) {
    storage.removeItem(AGENT_RESTART_STATE_STORAGE_KEY);
    return;
  }
  storage.setItem(AGENT_RESTART_STATE_STORAGE_KEY, "");
}

export function requestAgentRestart(input: RequestAgentRestartInput): boolean {
  if (!input.chatId || !input.connection) {
    return false;
  }
  const startedAt = input.now?.() ?? Date.now();
  writeStoredAgentRestartState({ chatId: input.chatId, startedAt, sawDisconnect: false }, input.storage);
  input.track({ name: "agent_restart_requested", params: { page_path: "/main" }, consentTier: "basic" });
  input.dispatch(agentActions.restartRequested(startedAt));
  input.ensureChatSubscription?.(input.chatId);
  input.connection.restart(input.chatId);
  return true;
}

export function requestAgentStatusPanel(input: RequestAgentStatusInput): boolean {
  if (!input.chatId || !input.connection) {
    input.setStatusPanel({ open: true, loading: false, content: "", error: input.failedMessage });
    return false;
  }
  input.setStatusPanel({ open: true, loading: true, content: "", error: null });
  input.connection.status(input.chatId);
  return true;
}

export function requestNewSessionReset(input: RequestNewSessionResetInput): boolean {
  input.clearInput();
  input.clearPendingMedia();
  input.dismissSlashMenu();

  if (!input.chatId || !input.connection) {
    input.focusInput?.();
    return false;
  }

  input.ensureChatSubscription?.(input.chatId);
  input.connection.sendMessage({ chatId: input.chatId, content: "/new" });
  input.focusInput?.();
  return true;
}

export async function submitAgentComposerMessage(input: SubmitAgentComposerMessageInput): Promise<boolean> {
  const text = input.content.trim();
  if ((!text && !input.pendingAttachments.length) || !input.connection) {
    return false;
  }
  if (input.pendingAttachments.some((item) => !isPendingAttachmentReadyForUpload(item))) {
    input.setComposerMediaError?.("home.media.error.sendReadFailed");
    return false;
  }

  let chatId = input.chatId;
  const createdNewChat = !chatId;
  if (!chatId) {
    input.setCreatingChat?.(true);
    try {
      chatId = await input.connection.newChat();
    } catch (error) {
      input.dispatch(agentActions.failed(readableError(error)));
      return false;
    } finally {
      input.setCreatingChat?.(false);
    }
  }

  const uploadInputs = input.pendingAttachments.map((item) => ({
    blob: uploadBlobForPendingAttachment(item),
    name: safeAgentAttachmentFilename(item.fileName, uploadClassificationForPendingAttachment(item)),
    kind: item.kind,
    mime: uploadMimeForPendingAttachment(item)
  }));
  let uploadedAttachments: UploadedAgentMedia[];
  try {
    uploadedAttachments = uploadInputs.length ? await input.uploadAgentMedia(uploadInputs) : [];
  } catch (error) {
    if (createdNewChat && chatId) {
      input.dispatch(agentActions.transientSendFailed(chatId));
    }
    const uploadErrorKey = error instanceof MemmyAgentRequestError && error.status === 413
      ? input.pendingAttachments.some((item) => item.kind === "file")
        ? "home.media.error.sendFileSize"
        : "home.media.error.sendSize"
      : "home.media.error.sendFailed";
    input.setComposerMediaError?.(uploadErrorKey);
    return false;
  }

  const payload = {
    type: "message",
    chat_id: chatId,
    content: text,
    webui: true,
    ...(input.language ? { language: input.language } : {}),
    ...(uploadedAttachments.length ? { media_paths: uploadedAttachments.map((item) => item.path) } : {})
  };
  if (encodedPayloadBytes(payload) > AGENT_WS_SAFE_FRAME_BYTES) {
    if (createdNewChat && chatId) {
      input.dispatch(agentActions.transientSendFailed(chatId));
    }
    input.setComposerMediaError?.("home.media.error.messageTooBig");
    return false;
  }

  input.track({ name: "agent_send_message", params: { page_path: "/main" }, consentTier: "basic" });
  if (createdNewChat) {
    input.dispatch(agentActions.newChatCreated(chatId));
  }
  input.dispatch(agentActions.userMessageQueued({
    chatId,
    content: text,
    media: uploadedAttachments.map((item) => ({ url: item.url, name: item.name, kind: item.kind, path: item.path }))
  }));
  input.ensureChatSubscription?.(chatId);
  input.connection.sendMessage({
    chatId,
    content: text,
    ...(input.language ? { language: input.language } : {}),
    media: uploadedAttachments
  });
  input.clearComposer();
  if (createdNewChat) {
    input.onNewChatMessageSent?.(chatId);
  }
  return true;
}

/**
 * Renders the chat home page.
 *
 * @returns The chat home page node.
 */
export function HomePage() {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { language, t } = useTranslation();
  const { track } = useAnalytics();
  const { syncAgentConversation } = useTaskBus();
  const { connection, ensureChatSubscription } = useAgentRuntimeBridge();
  const [slashCommands, setSlashCommands] = useState<MemmyAgentSlashCommand[]>([]);
  const slashCommandsRef = useRef<MemmyAgentSlashCommand[]>([]);
  const slashCommandsInFlightRef = useRef(false);
  const slashCommandsRequestIdRef = useRef(0);
  const slashCommandsRetryTimerRef = useRef<number | null>(null);
  const slashCommandsAttemptRef = useRef(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [recentSlashCommands, setRecentSlashCommands] = useState<string[]>(() => readRecentSlashCommands());
  const [statusPanel, setStatusPanel] = useState<StatusPanelState>({ open: false });
  const [lastCompactionPanel, setLastCompactionPanel] = useState<StatusPanelState>({ open: false });
  const [historyDagPanel, setHistoryDagPanel] = useState<HistoryDagPanelState>({ open: false });
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [isComposerSingleLine, setIsComposerSingleLine] = useState(true);
  const composerDrafts = state.agent.composerDraftsByScope;
  const pendingAttachmentsByScope = state.agent.composerPendingAttachmentsByScope;
  const composerMediaErrorByScope = state.agent.composerMediaErrorByScope;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingStatusChatRef = useRef<string | null>(null);
  const pendingLastCompactionChatRef = useRef<string | null>(null);
  const pendingHistoryDagChatRef = useRef<string | null>(null);
  const lastCompactionRequestIdRef = useRef(0);
  const lastChatScopeKeyRef = useRef<string | null>(null);
  const shouldAutoScrollAgentConversationRef = useRef(true);
  const isProgrammaticAgentScrollRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const [showScrollToBottomFab, setShowScrollToBottomFab] = useState(false);
  const lastNewChatRequestRef = useRef(state.agent.newChatRequestId);
  const initialFocusedChatLoadedRef = useRef(false);
  const composerDraftsRef = useRef<Record<string, string>>(composerDrafts);
  const pendingAttachmentsRef = useRef<Record<string, PendingAttachment[]>>(pendingAttachmentsByScope);
  const stopRequestLocksRef = useRef<Set<string>>(new Set());
  const asrRecorder = useAsrRecorder(clients?.asr, { emptyAudioMessage: t("home.asrEmptyAudio") });
  const chatScopeKey = agentChatScopeKey(state.agent.currentChatId, state.agent.newChatRequestId);
  const input = composerDrafts[chatScopeKey] ?? "";
  const pendingAttachments = pendingAttachmentsByScope[chatScopeKey] ?? [];
  const composerMediaError = composerMediaErrorByScope[chatScopeKey] ?? null;
  const currentHistoryVersion = state.agent.currentChatId
    ? state.agent.historyVersionByChatId[state.agent.currentChatId] ?? 0
    : state.agent.newChatRequestId;
  const hasActiveConversation = hasActiveAgentConversation(state.agent.currentChatId, state.agent.messages.length);
  const activeConversationTitle = state.agent.currentSessionKey
    ? state.agent.tasks.find((task) => task.sessionKey === state.agent.currentSessionKey)?.title.trim() || t("home.title")
    : t("home.title");
  const activeConversationTitleDisplay = formatConversationTitleForDisplay(activeConversationTitle);
  const isCurrentAgentRunning = Boolean(
    state.agent.currentChatId &&
    (
      state.agent.isSending ||
      // The run lifecycle is the source of truth for running state; the message streaming flag is only for rendering and may lag behind the completion event.
      state.agent.runStartedAtByChatId[state.agent.currentChatId] ||
      state.agent.optimisticSendingByChatId[state.agent.currentChatId]
    )
  );

  useEffect(() => {
    const stored = readStoredAgentRestartState();
    if (stored) {
      dispatch(agentActions.restartRestored(stored));
    }
  }, [dispatch]);

  useEffect(() => {
    if (!state.agent.currentChatId) {
      return;
    }

    const sessionIds = [
      state.agent.currentChatId,
      ...(state.agent.currentSessionKey ? [state.agent.currentSessionKey] : [])
    ];
    const messages: TaskBusAgentMessage[] = state.agent.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.createdAt == null ? {} : { createdAt: message.createdAt }),
      ...(message.isStreaming == null ? {} : { isStreaming: message.isStreaming })
    }));

    syncAgentConversation({
      sessionIds,
      messages,
      isRunning: isCurrentAgentRunning
    });
  }, [isCurrentAgentRunning, state.agent.currentChatId, state.agent.currentSessionKey, state.agent.messages, syncAgentConversation]);

  const setSlashCommandsSnapshot = useCallback((commands: MemmyAgentSlashCommand[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  const clearSlashCommandsRetryTimer = useCallback(() => {
    if (slashCommandsRetryTimerRef.current) {
      window.clearTimeout(slashCommandsRetryTimerRef.current);
      slashCommandsRetryTimerRef.current = null;
    }
  }, []);

  const loadSlashCommands = useCallback((options: { resetAttempts?: boolean } = {}) => {
    const client = clients?.memmyAgent;
    if (!client) {
      return;
    }
    if (slashCommandsInFlightRef.current) {
      return;
    }

    clearSlashCommandsRetryTimer();

    if (options.resetAttempts) {
      slashCommandsAttemptRef.current = 0;
    }

    slashCommandsRequestIdRef.current += 1;
    const requestId = slashCommandsRequestIdRef.current;
    slashCommandsInFlightRef.current = true;

    void client.listSlashCommands()
      .then((commands) => {
        if (requestId !== slashCommandsRequestIdRef.current) {
          return;
        }
        slashCommandsInFlightRef.current = false;
        slashCommandsAttemptRef.current = 0;
        setSlashCommandsSnapshot(commands);
      })
      .catch(() => {
        if (requestId !== slashCommandsRequestIdRef.current) {
          return;
        }
        slashCommandsInFlightRef.current = false;

        if (slashCommandsRef.current.length > 0) {
          return;
        }
        const delay = SLASH_COMMAND_RETRY_DELAYS_MS[slashCommandsAttemptRef.current];
        if (delay == null) {
          return;
        }
        slashCommandsAttemptRef.current += 1;
        slashCommandsRetryTimerRef.current = window.setTimeout(() => {
          slashCommandsRetryTimerRef.current = null;
          loadSlashCommands();
        }, delay);
      });
  }, [clients?.memmyAgent, clearSlashCommandsRetryTimer, setSlashCommandsSnapshot]);

  useEffect(() => {
    if (!clients?.memmyAgent) {
      clearSlashCommandsRetryTimer();
      setSlashCommandsSnapshot([]);
      slashCommandsInFlightRef.current = false;
      slashCommandsAttemptRef.current = 0;
      return undefined;
    }

    loadSlashCommands({ resetAttempts: true });

    return () => {
      clearSlashCommandsRetryTimer();
      slashCommandsInFlightRef.current = false;
      slashCommandsRequestIdRef.current += 1;
    };
  }, [clients?.memmyAgent, clearSlashCommandsRetryTimer, loadSlashCommands, setSlashCommandsSnapshot]);

  useEffect(() => {
    if (!clients?.memmyAgent || initialFocusedChatLoadedRef.current) {
      return;
    }

    initialFocusedChatLoadedRef.current = true;
    if (state.agent.blankDraftActive) {
      clearFocusedAgentTarget(
        typeof window === "undefined" ? undefined : window.sessionStorage,
        typeof window === "undefined" ? undefined : window.location,
        typeof window === "undefined" ? undefined : window.history
      );
      return;
    }

    const focusedChatId = readFocusedAgentChatId();
    if (focusedChatId) {
      loadAgentThread(clients.memmyAgent, dispatch, focusedChatId, undefined, { tolerateMissingThread: true });
    }
  }, [clients, dispatch, state.agent.blankDraftActive]);

  useEffect(() => {
    if (!clients?.memmyAgent || !connection || state.agent.connectionStatus === "error") {
      return;
    }

    const memmyAgent = clients.memmyAgent;
    const pendingPrompt = consumePendingFirstEncounterTaskLaunch(typeof window === "undefined" ? undefined : window.sessionStorage);
    if (!pendingPrompt) {
      return;
    }

    void submitAgentComposerMessage({
      chatId: null,
      connection,
      ensureChatSubscription,
      content: pendingPrompt,
      language,
      pendingAttachments: [],
      uploadAgentMedia: (attachments) => memmyAgent.uploadAgentMedia(attachments),
      dispatch,
      track,
      setCreatingChat: setIsCreatingChat,
      clearComposer: () => undefined,
      onNewChatMessageSent: (chatId) => refreshAgentTaskList(memmyAgent, dispatch, { expectedChatId: chatId, reason: "new-chat" })
    });
  }, [clients, connection, dispatch, ensureChatSubscription, language, state.agent.connectionStatus, track]);

  useEffect(() => {
    if (lastChatScopeKeyRef.current === null) {
      lastChatScopeKeyRef.current = chatScopeKey;
      return;
    }
    if (lastChatScopeKeyRef.current === chatScopeKey) {
      return;
    }
    lastChatScopeKeyRef.current = chatScopeKey;
    resetTransientConversationUi();
  }, [chatScopeKey]);

  useEffect(() => {
    if (state.agent.newChatRequestId <= lastNewChatRequestRef.current) {
      return;
    }

    lastNewChatRequestRef.current = state.agent.newChatRequestId;
    resetNewChatLocalUi();
  }, [state.agent.newChatRequestId]);

  useEffect(() => {
    if (!state.agent.currentChatId) {
      pendingStatusChatRef.current = null;
      pendingLastCompactionChatRef.current = null;
      pendingHistoryDagChatRef.current = null;
      lastCompactionRequestIdRef.current += 1;
      setStatusPanel({ open: false });
      setLastCompactionPanel({ open: false });
      setHistoryDagPanel({ open: false });
    }
  }, [state.agent.currentChatId]);

  useEffect(() => {
    if (!connection) {
      return;
    }

    return connection.onStatusResult((chatId, content) => {
      if (!shouldAcceptAgentStatusResult({
        pendingStatusChatId: pendingStatusChatRef.current,
        subscribedChatId: state.agent.currentChatId,
        resultChatId: chatId
      })) {
        return;
      }
      pendingStatusChatRef.current = null;
      setStatusPanel({ open: true, loading: false, content, error: null });
    });
  }, [connection, state.agent.currentChatId]);

  useEffect(() => {
    if (!connection) {
      return;
    }

    return connection.onHistoryDagResult((chatId, content, payload) => {
      if (pendingHistoryDagChatRef.current && pendingHistoryDagChatRef.current !== chatId) {
        return;
      }
      if (state.agent.currentChatId && state.agent.currentChatId !== chatId) {
        return;
      }
      pendingHistoryDagChatRef.current = null;
      setHistoryDagPanel({ open: true, loading: false, content, error: null, payload });
    });
  }, [connection, state.agent.currentChatId]);

  useEffect(() => {
    for (const chatId of Array.from(stopRequestLocksRef.current)) {
      if (!state.agent.stopInFlightByChatId[chatId]) {
        stopRequestLocksRef.current.delete(chatId);
      }
    }
  }, [state.agent.stopInFlightByChatId]);

  // Stop self-healing: if the runtime's stop confirmation (stop_result /
  // turn_end) never arrives — socket died mid-interrupt, gateway crashed —
  // release the in-flight lock after a grace period so the composer never
  // stays permanently unsendable.
  useEffect(() => {
    const pendingChatIds = Object.keys(state.agent.stopInFlightByChatId).filter(
      (chatId) => state.agent.stopInFlightByChatId[chatId]
    );
    if (!pendingChatIds.length) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      for (const chatId of pendingChatIds) {
        dispatch(agentActions.stopUnconfirmed(chatId));
      }
    }, STOP_CONFIRMATION_GRACE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [dispatch, state.agent.stopInFlightByChatId]);

  // NOTE: deliberately NO auto-focus on running->idle transitions. A global
  // state-driven focus() steals the keyboard from whatever the user is doing
  // (any other input field, mid-IME composition) whenever the running flag
  // flips — and stale session snapshots can flip it repeatedly. Focus must
  // only ever move on the user's own click/keys.

  useEffect(() => {
    if (state.agent.isRestarting && state.agent.currentChatId && state.agent.restartStartedAt != null) {
      writeStoredAgentRestartState({
        chatId: state.agent.currentChatId,
        startedAt: state.agent.restartStartedAt,
        sawDisconnect: state.agent.restartSawDisconnect
      });
      return;
    }
    if (!state.agent.isRestarting && (state.agent.restartCompletedAt != null || state.agent.restartError)) {
      clearStoredAgentRestartState();
    }
  }, [
    state.agent.currentChatId,
    state.agent.isRestarting,
    state.agent.restartCompletedAt,
    state.agent.restartError,
    state.agent.restartSawDisconnect,
    state.agent.restartStartedAt
  ]);

  const stopSlashCommand: SlashCommandPaletteItem = {
    command: "/stop",
    title: t("home.command.stopTitle"),
    description: t("home.command.stopDescription"),
    icon: "square",
    argHint: "",
    synthetic: true
  };
  const lastCompactionSlashCommand: SlashCommandPaletteItem = {
    command: "/last-compaction",
    title: t("home.command.lastCompactionTitle"),
    description: t("home.command.lastCompactionDescription"),
    icon: "book-open",
    argHint: "",
    synthetic: true
  };
  const slashQuery = slashMenuDismissed ? null : slashQueryFromInput(input);
  const localizedSlashCommands = localizeSlashCommands(slashCommands, language, t);
  const slashCommandsWithLocal = [
    lastCompactionSlashCommand,
    ...localizedSlashCommands.filter((command) => command.command !== "/last-compaction")
  ];
  const visibleSlashCommands = buildVisibleSlashCommands(slashCommandsWithLocal, state.agent.isSending, stopSlashCommand);
  const filteredSlashCommands = slashQuery == null ? [] : filterSlashCommands(visibleSlashCommands, slashQuery, recentSlashCommands);
  const slashMenuOpen = filteredSlashCommands.length > 0;
  const statusText = agentStatusText(state.agent.connectionStatus, state.agent.modelName, t);
  const agentError = agentErrorText(state.agent.error, t);
  const isAccountMode = state.bootstrap?.app.userMode === "account";
  const sanitizePlatformApiErrors = isAccountMode;
  const hasBlockedPendingMedia = pendingAttachments.some((item) => item.status !== "ready");
  const hasComposerPayload = Boolean(input.trim() || pendingAttachments.some((item) => item.status === "ready"));
  const stopInFlight = state.agent.currentChatId ? Boolean(state.agent.stopInFlightByChatId[state.agent.currentChatId]) : false;
  const composerSubmitDisabled = isCurrentAgentRunning
    ? stopInFlight
    : stopInFlight || !hasComposerPayload || hasBlockedPendingMedia || !connection || isCreatingChat || state.agent.connectionStatus === "error";
  const centerComposerControls = isComposerSingleLine && pendingAttachments.length === 0;

  // Agent channel errors only clear the notice text without changing the connection state, to avoid misjudging the current channel status.
  useEffect(() => {
    const currentError = state.agent.error;
    if (!currentError) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      dispatch(agentActions.errorDismissed(currentError));
    }, AGENT_ERROR_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [dispatch, state.agent.error]);

  // Local composer errors are cleared per session so a voice-permission error does not pollute other sessions.
  useEffect(() => {
    const currentError = composerMediaError;
    if (!currentError) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (composerMediaErrorByScope[chatScopeKey] === currentError) {
        dispatch(agentActions.composerMediaErrorUpdated(chatScopeKey, null));
      }
    }, COMPOSER_ERROR_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [chatScopeKey, composerMediaError, composerMediaErrorByScope, dispatch]);

  useEffect(() => {
    if (selectedCommandIndex >= filteredSlashCommands.length) {
      setSelectedCommandIndex(0);
    }
  }, [filteredSlashCommands.length, selectedCommandIndex]);

  useEffect(() => {
    composerDraftsRef.current = composerDrafts;
  }, [composerDrafts]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachmentsByScope;
  }, [pendingAttachmentsByScope]);

  // Layout effect (not a regular effect) so the scroll adjustment commits
  // synchronously in the same browser frame as the new message content —
  // this closes the race where fast-streaming tokens grow scrollHeight while
  // a deferred native "scroll" event from our own assignment is still in
  // flight, which could otherwise be misread as the user scrolling away.
  useLayoutEffect(() => {
    if (shouldAutoScrollAgentConversationRef.current) {
      scrollAgentConversationToBottom();
    }
  }, [chatScopeKey, state.agent.messages]);

  function scrollAgentConversationToBottom() {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    isProgrammaticAgentScrollRef.current = true;
    element.scrollTop = element.scrollHeight;
    // A single requestAnimationFrame is not always enough: browsers can
    // dispatch the "scroll" event for a programmatic scrollTop assignment on
    // a later frame than the one that follows immediately. A short timeout
    // gives that event room to arrive and be safely ignored below.
    window.setTimeout(() => {
      isProgrammaticAgentScrollRef.current = false;
    }, 120);
  }

  /** Marks that the user just took over scrolling via wheel/touch; only scroll events within a short window may turn off auto-scroll. */
  function markAgentConversationUserScrollIntent() {
    userScrollIntentUntilRef.current = Date.now() + AGENT_CONVERSATION_USER_SCROLL_INTENT_MS;
  }

  function resumeAgentConversationAutoScroll() {
    shouldAutoScrollAgentConversationRef.current = true;
    setShowScrollToBottomFab(false);
    scrollAgentConversationToBottom();
  }

  /**
   * Sends one round of a live Agent conversation.
   */
  async function sendMessage() {
    if (runExactLocalSlashCommand(input)) {
      return;
    }
    const sendScopeKey = chatScopeKey;
    await submitAgentComposerMessage({
      chatId: state.agent.currentChatId,
      connection,
      ensureChatSubscription,
      content: input,
      language,
      pendingAttachments,
      uploadAgentMedia: (attachments) => clients!.memmyAgent.uploadAgentMedia(attachments),
      dispatch,
      track,
      setCreatingChat: setIsCreatingChat,
      setComposerMediaError: (message) => setComposerMediaErrorForScope(sendScopeKey, message),
      clearComposer: () => clearComposerAfterSend(sendScopeKey),
      onNewChatMessageSent: clients?.memmyAgent
        ? (chatId) => refreshAgentTaskList(clients.memmyAgent, dispatch, { expectedChatId: chatId, reason: "new-chat" })
        : undefined
    });
  }

  function runExactLocalSlashCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (pendingAttachments.length > 0) return false;
    if (normalized === "/last-compaction") {
      rememberSlashCommand("/last-compaction");
      setCurrentComposerDraft("");
      requestLastCompactionPanel();
      inputRef.current?.focus();
      return true;
    }
    if (normalized === "/history-dag") {
      rememberSlashCommand("/history-dag");
      setCurrentComposerDraft("");
      requestHistoryDagPanel();
      inputRef.current?.focus();
      return true;
    }
    if (normalized === "/status") {
      rememberSlashCommand("/status");
      setCurrentComposerDraft("");
      requestStatusPanel();
      inputRef.current?.focus();
      return true;
    }
    return false;
  }

  /**
   * Stops the current Agent turn.
   */
  function stopCurrentTurn() {
    requestAgentStop({
      chatId: state.agent.currentChatId,
      connection,
      stopInFlightByChatId: state.agent.stopInFlightByChatId,
      stopRequestLocks: stopRequestLocksRef.current,
      dispatch,
      track
    });
  }

  /**
   * Updates the input draft for the given session scope.
   *
   * @param scopeKey The session or new-draft scope.
   * @param value The latest input content, or an updater function based on the previous value.
   */
  function setComposerDraftForScope(scopeKey: string, value: SetStateAction<string>) {
    const currentValue = composerDraftsRef.current[scopeKey] ?? "";
    const nextValue = typeof value === "function" ? value(currentValue) : value;
    const nextDrafts = updateComposerDraftForScope(composerDraftsRef.current, scopeKey, nextValue);
    if (nextDrafts === composerDraftsRef.current) {
      return;
    }
    composerDraftsRef.current = nextDrafts;
    dispatch(agentActions.composerDraftUpdated(scopeKey, nextValue));
  }

  /**
   * Updates the input draft for the current session scope.
   *
   * @param value The latest input content, or an updater function based on the previous value.
   */
  function setCurrentComposerDraft(value: SetStateAction<string>) {
    setComposerDraftForScope(chatScopeKey, value);
  }

  function setPendingAttachmentsForScope(scopeKey: string, value: SetStateAction<PendingAttachment[]>) {
    const currentMap = pendingAttachmentsRef.current;
    const currentValue = currentMap[scopeKey] ?? [];
    const nextValue = typeof value === "function" ? value(currentValue) : value;
    if (currentValue === nextValue) {
      return;
    }

    const nextMap = { ...currentMap };
    if (nextValue.length) {
      nextMap[scopeKey] = nextValue;
    } else {
      delete nextMap[scopeKey];
    }
    pendingAttachmentsRef.current = nextMap;
    dispatch(agentActions.composerPendingAttachmentsUpdated(scopeKey, nextValue));
  }

  function setCurrentPendingAttachments(value: SetStateAction<PendingAttachment[]>) {
    setPendingAttachmentsForScope(chatScopeKey, value);
  }

  function setComposerMediaErrorForScope(scopeKey: string, message: string | null) {
    dispatch(agentActions.composerMediaErrorUpdated(scopeKey, message));
  }

  function setCurrentComposerMediaError(message: string | null) {
    setComposerMediaErrorForScope(chatScopeKey, message);
  }

  /**
   * Updates the input box content and resets the slash command selection state.
   *
   * @param value The latest input box content.
   */
  function updateComposerInput(value: string) {
    setCurrentComposerDraft(value);
    setSlashMenuDismissed(false);
    setSelectedCommandIndex(0);
    if (
      slashQueryFromInput(value) != null &&
      clients?.memmyAgent &&
      slashCommandsRef.current.length === 0 &&
      !slashCommandsInFlightRef.current
    ) {
      loadSlashCommands({ resetAttempts: true });
    }
  }


  /**
   * Automatically shrinks or expands the input box height.
   *
   * @param element The textarea whose height should be adjusted.
   */
  function resizeComposerInput(element: HTMLTextAreaElement) {
    element.style.height = "auto";
    const isSingleLine = isSingleLineComposerInput(element);
    setIsComposerSingleLine(isSingleLine);
    element.style.height = isSingleLine
      ? `${COMPOSER_SINGLE_LINE_HEIGHT_PX}px`
      : `${element.scrollHeight}px`;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  /**
   * Resets the input box height after sending, so the next empty input does not inherit the previous height.
   */
  function resetComposerHeight() {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setIsComposerSingleLine(true);
  }

  function clearComposerAfterSend(scopeKey: string) {
    resetComposerDraftUi(scopeKey);
    resetTransientConversationUi();
  }

  function resetComposerDraftUi(scopeKey = chatScopeKey) {
    for (const item of pendingAttachmentsRef.current[scopeKey] ?? []) {
      revokePendingAttachment(item);
    }
    const nextDrafts = { ...composerDraftsRef.current };
    const nextPendingAttachments = { ...pendingAttachmentsRef.current };
    delete nextDrafts[scopeKey];
    delete nextPendingAttachments[scopeKey];
    composerDraftsRef.current = nextDrafts;
    pendingAttachmentsRef.current = nextPendingAttachments;
    dispatch(agentActions.composerScopeCleared(scopeKey));
    resetComposerHeight();
  }

  function closeLastCompactionPanel() {
    lastCompactionRequestIdRef.current += 1;
    pendingLastCompactionChatRef.current = null;
    setLastCompactionPanel({ open: false });
  }

  function resetTransientConversationUi() {
    setSlashMenuDismissed(true);
    setSelectedCommandIndex(0);
    setStatusPanel({ open: false });
    closeLastCompactionPanel();
    setHistoryDagPanel({ open: false });
    pendingStatusChatRef.current = null;
    pendingHistoryDagChatRef.current = null;
    shouldAutoScrollAgentConversationRef.current = true;
    setShowScrollToBottomFab(false);
  }

  function resetNewChatLocalUi() {
    resetComposerDraftUi();
    resetTransientConversationUi();
    setSlashMenuDismissed(false);
    setIsCreatingChat(false);
  }

  /**
   * Records the most recently used slash command.
   *
   * @param command The slash command text.
   */
  function rememberSlashCommand(command: string) {
    const nextRecent = updateRecentSlashCommands(command, recentSlashCommands);
    setRecentSlashCommands(nextRecent);
    writeRecentSlashCommands(nextRecent);
  }

  /**
   * Requests and opens the Agent status panel.
   */
  function requestStatusPanel() {
    const chatId = state.agent.currentChatId;
    setSlashMenuDismissed(true);
    closeLastCompactionPanel();
    setHistoryDagPanel({ open: false });
    pendingHistoryDagChatRef.current = null;
    pendingStatusChatRef.current = chatId;
    const requested = requestAgentStatusPanel({
      chatId,
      connection,
      failedMessage: t("home.agent.failed"),
      setStatusPanel
    });
    if (!requested) {
      pendingStatusChatRef.current = null;
    }
  }

  /**
   * Requests and opens the current conversation's latest compaction summary panel.
   */
  function requestLastCompactionPanel() {
    const client = clients?.memmyAgent;
    const chatId = state.agent.currentChatId;
    setSlashMenuDismissed(true);
    setStatusPanel({ open: false });
    setHistoryDagPanel({ open: false });
    pendingStatusChatRef.current = null;
    pendingHistoryDagChatRef.current = null;
    lastCompactionRequestIdRef.current += 1;
    const requestId = lastCompactionRequestIdRef.current;
    pendingLastCompactionChatRef.current = chatId;

    if (!client) {
      pendingLastCompactionChatRef.current = null;
      setLastCompactionPanel({ open: true, loading: false, content: "", error: t("home.lastCompaction.loadFailed") });
      return;
    }
    if (!chatId) {
      pendingLastCompactionChatRef.current = null;
      setLastCompactionPanel({ open: true, loading: false, content: t("home.lastCompaction.noSummary"), error: null });
      return;
    }

    const sessionKey = state.agent.currentSessionKey ?? client.chatIdToSessionKey(chatId);
    setLastCompactionPanel({ open: true, loading: true, content: "", error: null });
    void client.readLastCompaction(sessionKey)
      .then((payload) => {
        if (requestId !== lastCompactionRequestIdRef.current || pendingLastCompactionChatRef.current !== chatId) {
          return;
        }
        pendingLastCompactionChatRef.current = null;
        setLastCompactionPanel({
          open: true,
          loading: false,
          content: payload.available ? payload.text : t("home.lastCompaction.noSummary"),
          error: null
        });
      })
      .catch(() => {
        if (requestId !== lastCompactionRequestIdRef.current || pendingLastCompactionChatRef.current !== chatId) {
          return;
        }
        pendingLastCompactionChatRef.current = null;
        setLastCompactionPanel({ open: true, loading: false, content: "", error: t("home.lastCompaction.loadFailed") });
      });
  }

  /**
   * Requests and opens the current conversation's history DAG panel.
   */
  function requestHistoryDagPanel() {
    const chatId = state.agent.currentChatId;
    setSlashMenuDismissed(true);
    setStatusPanel({ open: false });
    closeLastCompactionPanel();
    pendingStatusChatRef.current = null;
    pendingHistoryDagChatRef.current = chatId;
    if (!chatId || !connection) {
      pendingHistoryDagChatRef.current = null;
      setHistoryDagPanel({ open: true, loading: false, content: "", error: t("home.agent.failed"), payload: null });
      return;
    }
    setHistoryDagPanel({ open: true, loading: true, content: "", error: null, payload: null });
    ensureChatSubscription?.(chatId);
    connection.historyDag(chatId);
  }

  /**
   * Applies the command selected in the slash command palette.
   *
   * @param command The command item the user selected.
   */
  function selectSlashCommand(command: SlashCommandPaletteItem) {
    if (command.command === "/stop") {
      if (state.agent.isSending) {
        stopCurrentTurn();
      }
      setCurrentComposerDraft("");
      setSlashMenuDismissed(true);
      return;
    }

    if (command.command === "/status") {
      rememberSlashCommand(command.command);
      setCurrentComposerDraft("");
      requestStatusPanel();
      inputRef.current?.focus();
      return;
    }

    if (command.command === "/last-compaction") {
      rememberSlashCommand(command.command);
      setCurrentComposerDraft("");
      requestLastCompactionPanel();
      inputRef.current?.focus();
      return;
    }

    if (command.command === "/history-dag") {
      rememberSlashCommand(command.command);
      setCurrentComposerDraft("");
      requestHistoryDagPanel();
      inputRef.current?.focus();
      return;
    }

    if (command.command === "/new") {
      rememberSlashCommand(command.command);
      requestNewSessionReset({
        chatId: state.agent.currentChatId,
        connection,
        ensureChatSubscription,
        clearInput: () => setCurrentComposerDraft(""),
        clearPendingMedia: clearPendingAttachments,
        dismissSlashMenu: () => setSlashMenuDismissed(true),
        focusInput: () => inputRef.current?.focus()
      });
      return;
    }

    rememberSlashCommand(command.command);
    setCurrentComposerDraft(command.argHint ? `${command.command} ` : command.command);
    setSlashMenuDismissed(true);
    inputRef.current?.focus();
  }

  /**
   * Opens the system media file picker.
   */
  function openMediaFilePicker() {
    fileInputRef.current?.click();
  }

  /**
   * Starts voice input on the main interface.
   */
  function startVoiceInput() {
    inputRef.current?.focus();
    void asrRecorder.start().catch((error: unknown) => {
      setCurrentComposerMediaError(toReadableAsrError(error, t));
    });
  }

  /**
   * Ends voice input on the main interface and merges in the transcribed text.
   */
  async function finishVoiceInput() {
    try {
      const transcript = await asrRecorder.finishAndTranscribe();
      setCurrentComposerDraft((current) => mergeVoiceTranscript(current, transcript.text));
      setSlashMenuDismissed(false);
      setSelectedCommandIndex(0);
      window.requestAnimationFrame(() => {
        if (inputRef.current) {
          resizeComposerInput(inputRef.current);
          inputRef.current.focus();
        }
      });
    } catch (error: unknown) {
      setCurrentComposerMediaError(toReadableAsrError(error, t));
    }
  }

  /**
   * Toggles the voice input state.
   */
  function toggleVoiceInput() {
    if (asrRecorder.isRecording) {
      void finishVoiceInput();
      return;
    }
    startVoiceInput();
  }


  /**
   * Handles keyboard interaction in the input box, including slash command navigation and Enter to send.
   *
   * @param event The textarea keyboard event.
   */
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposingKeyboardEvent(event) && (event.key === "Enter" || event.key === "Tab")) {
      return;
    }

    if (slashMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedCommandIndex((index) => (index + 1) % filteredSlashCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedCommandIndex((index) => (index - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const command = filteredSlashCommands[selectedCommandIndex] ?? filteredSlashCommands[0];
        if (command) {
          selectSlashCommand(command);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }

    if (event.key === "Escape" && historyDagPanel.open) {
      event.preventDefault();
      setHistoryDagPanel({ open: false });
      return;
    }

    if (event.key === "Escape" && lastCompactionPanel.open) {
      event.preventDefault();
      closeLastCompactionPanel();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (!state.agent.isSending && !composerSubmitDisabled) {
      void sendMessage();
    }
  }

  function handleAgentConversationScroll(event: UIEvent<HTMLDivElement>) {
    if (isProgrammaticAgentScrollRef.current) {
      return;
    }
    const atBottom = isAgentConversationAtBottom(event.currentTarget);
    if (atBottom) {
      // Reaching the bottom is always safe to treat as "resume auto-scroll",
      // regardless of what caused this particular scroll event.
      shouldAutoScrollAgentConversationRef.current = true;
      setShowScrollToBottomFab(false);
      return;
    }
    // The control reflects the actual scroll position even when the user moved
    // with the scrollbar or keyboard. Only a scroll event that follows a real
    // wheel/touch gesture is allowed to turn auto-scroll off, so a scroll event
    // racing with streaming content growth cannot disable it.
    setShowScrollToBottomFab(true);
    if (Date.now() > userScrollIntentUntilRef.current) {
      return;
    }
    shouldAutoScrollAgentConversationRef.current = false;
  }

  /**
   * Validates and stages the images selected by the user.
   *
   * @param event The file input change event.
   */
  async function selectMedia(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    try {
      await attachMediaFilesToScope(chatScopeKey, files);
    } finally {
      event.target.value = "";
    }
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardImageFilesFromDataTransfer(event.clipboardData);
    if (!files.length) {
      return;
    }

    event.preventDefault();
    void attachMediaFilesToScope(chatScopeKey, files);
  }

  function handleComposerDragOver(event: DragEvent<HTMLElement>) {
    if (!dataTransferHasAttachmentFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleComposerDrop(event: DragEvent<HTMLElement>) {
    if (!dataTransferHasAttachmentFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    const files = attachmentFilesFromDataTransfer(event.dataTransfer);
    if (!files.length) {
      return;
    }

    void attachMediaFilesToScope(chatScopeKey, files).then(() => {
      inputRef.current?.focus();
    });
  }

  async function attachMediaFilesToScope(scopeKey: string, files: File[]) {
    if (!files.length) {
      return;
    }

    try {
      const validation = await validateAgentMediaFiles(files, t, pendingAttachmentsRef.current[scopeKey] ?? []);
      const validFiles = validation.files;
      if (!validFiles.length) {
        setComposerMediaErrorForScope(scopeKey, t("home.media.error.duplicateAttachment"));
        return;
      }
      const nextPending = validFiles.map((item) => fileToPendingAttachment(item.file, item.sourceKey, item.classification));
      setPendingAttachmentsForScope(scopeKey, (current) => [...current, ...nextPending]);
      setComposerMediaErrorForScope(scopeKey, null);
      for (const [index, pending] of nextPending.entries()) {
        if (pending.kind === "image") {
          void updatePendingImageEncoding(scopeKey, pending.id, validFiles[index]!.file);
        }
      }
      track({ name: "agent_media_attached", params: { page_path: "/main", media_type: mediaTypeForAnalytics(nextPending) }, consentTier: "basic" });
    } catch (error) {
      setComposerMediaErrorForScope(scopeKey, error instanceof Error ? error.message : String(error));
    }
  }

  async function updatePendingImageEncoding(scopeKey: string, id: string, file: File) {
    try {
      const encoded = await encodePendingAgentImage(file);
      setPendingAttachmentsForScope(scopeKey, (current) => current.map((item) => item.id === id && item.kind === "image"
        ? {
            ...item,
            status: "ready",
            encodedBlob: encoded.blob,
            encodedMime: encoded.mime,
            encodedBytes: encoded.bytes,
            normalized: encoded.normalized,
            errorKey: undefined
          }
        : item));
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "home.media.error.sendReadFailed";
      setPendingAttachmentsForScope(scopeKey, (current) => current.map((item) => item.id === id
        ? { ...item, status: "error", errorKey: isMessageKey(message) ? message : "home.media.error.sendReadFailed" }
        : item));
    }
  }

  function removePendingMedia(id: string) {
    setCurrentPendingAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed) {
        revokePendingAttachment(removed);
      }
      return current.filter((item) => item.id !== id);
    });
    setCurrentComposerMediaError(null);
    inputRef.current?.focus();
  }

  function clearPendingAttachments() {
    setCurrentPendingAttachments((current) => {
      for (const item of current) {
        revokePendingAttachment(item);
      }
      return [];
    });
  }

  return (
    <AppFrame
      title={t("home.title")}
      topBar={hasActiveConversation ? (
        <h1 className="agent-conversation-title" title={activeConversationTitle}>
          {activeConversationTitleDisplay}
        </h1>
      ) : null}
      topBarBorder={hasActiveConversation}
    >
      {!hasActiveConversation ? (
        <section className="app-frame-page-content home-empty-screen flex flex-col items-center justify-center h-full">
          <div className="text-center mb-8">
            <div className="home-empty-brand-mascot flex justify-center">
              <Memmy pose="think" size={165} className="memmy-bob" />
            </div>
            <h1 className="text-2xl font-bold text-text-ink">{t("home.subtitle")}</h1>
          </div>
          <div className="w-full max-w-2xl">
            <div
              className="relative home-empty-composer agent-composer-shell rounded-card-lg"
              onDragOver={handleComposerDragOver}
              onDrop={handleComposerDrop}
            >
              {slashMenuOpen && (
                <div className="absolute left-0 bottom-full mb-3 z-40" style={{ width: "min(448px, 100%)" }}>
                  <AgentCommandPalette commands={filteredSlashCommands} heading={t("home.commandPalette.commands")} selectedIndex={selectedCommandIndex} onSelect={selectSlashCommand} />
                </div>
              )}
              {lastCompactionPanel.open && !slashMenuOpen && (
                <div className="absolute left-0 bottom-full mb-3 z-30 w-full" style={{ right: 0 }}>
                  <AgentStatusPanel state={lastCompactionPanel} closeLabel={t("common.close")} loadingLabel={t("home.agent.connecting")} onClose={closeLastCompactionPanel} />
                </div>
              )}
              <ComposerMediaPreviewStrip
                items={pendingAttachments}
                onRemove={removePendingMedia}
                removeLabel={t("common.remove")}
                selectedLabel={t("home.media.addPhotoFile")}
                t={t}
              />
              <textarea
                ref={inputRef}
                value={input}
                placeholder={t("home.input")}
                rows={3}
                onChange={(event) => {
                  updateComposerInput(event.target.value);
                  resizeComposerInput(event.target);
                }}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleComposerPaste}
                className="w-full px-5 pt-4 pb-12 text-sm resize-none focus:outline-none rounded-card-lg bg-background-paper placeholder:text-text-ink/40"
              />
              <div className="absolute bottom-3 right-4 flex items-center gap-2 z-10">
                <button
                  type="button"
                  aria-label={t("home.media.menu")}
                  title={t("home.media.menu")}
                  onClick={openMediaFilePicker}
                  className="p-1.5 inline-flex items-center justify-center rounded-lg text-text-ink/45 hover:bg-canvas-oat/60 hover:text-text-ink/65 transition-all cursor-pointer"
                >
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  aria-label={t("home.voiceInput")}
                  title={t("home.voiceInput")}
                  disabled={asrRecorder.isTranscribing || asrRecorder.isStarting}
                  onClick={toggleVoiceInput}
                  className={`p-1.5 hover:bg-canvas-oat/60 rounded-lg transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${asrRecorder.isRecording ? "text-action-sky" : "text-text-ink/45 hover:text-text-ink/65"}`}
                >
                  {asrRecorder.isRecording ? <Pause size={15} /> : <Mic size={15} />}
                </button>
                <ComposerSubmitButton
                  isSending={isCurrentAgentRunning}
                  disabled={composerSubmitDisabled}
                  sendLabel={t("home.send")}
                  stopLabel={t("home.stop")}
                  onClick={isCurrentAgentRunning ? stopCurrentTurn : () => void sendMessage()}
                />
              </div>
            </div>
            <div className="home-empty-status-area">
              {composerMediaError && <p role="alert" className="text-center text-xs text-status-error mt-3">{agentErrorText(composerMediaError, t)}</p>}
              {agentError && <p className="text-center text-xs text-status-error mt-4">{agentError}</p>}
              {statusText && <p className="text-center text-xs text-text-ink/45 mt-4">{statusText}</p>}
              <p className="text-center text-[11px] text-text-ink/40 mt-4">{t("home.notice")}</p>
            </div>
            <input ref={fileInputRef} type="file" accept={AGENT_MEDIA_ACCEPT} multiple hidden className="hidden" onChange={(event) => void selectMedia(event)} />
          </div>
        </section>
      ) : (
        <section className="agent-conversation-panel flex flex-col h-full">
          <div
            ref={scrollRef}
            className="app-frame-page-content agent-conversation-scroll flex-1 overflow-y-auto"
            onScroll={handleAgentConversationScroll}
            onWheel={markAgentConversationUserScrollIntent}
            onTouchMove={markAgentConversationUserScrollIntent}
          >
            <div className="max-w-3xl mx-auto space-y-3">
              {state.agent.connectionStatus !== "connected" && (
                <div className="text-center">
                  <span className="inline-flex text-[11px] px-3 py-1 rounded-tag bg-background-paper text-text-ink/55 border border-border-stone/30">
                    {agentStatusText(state.agent.connectionStatus, state.agent.modelName, t)}
                  </span>
                </div>
              )}
              <AgentThreadMessages
                key={chatScopeKey}
                chatScopeKey={chatScopeKey}
                historyVersion={currentHistoryVersion}
                messages={state.agent.messages}
                retryWaitStatus={state.agent.currentChatId ? state.agent.retryWaitStatusByChatId[state.agent.currentChatId] ?? null : null}
                isSending={state.agent.isSending}
                sanitizePlatformApiErrors={sanitizePlatformApiErrors}
                accountMode={isAccountMode}
                artifactClient={clients?.memmyAgent ?? null}
              />
            </div>
          </div>
          {showScrollToBottomFab ? (
            <button
              type="button"
              className="agent-scroll-to-bottom-fab"
              aria-label={t("home.scrollToLatest")}
              title={t("home.scrollToLatest")}
              onClick={resumeAgentConversationAutoScroll}
            >
              <ArrowDown size={16} aria-hidden="true" />
            </button>
          ) : null}
          <div className="agent-conversation-composer">
            <div className="max-w-3xl mx-auto">
              <div
                className="relative agent-composer-shell rounded-card-lg"
                onDragOver={handleComposerDragOver}
                onDrop={handleComposerDrop}
              >
                {slashMenuOpen && (
                  <div className="absolute left-0 bottom-full mb-3 z-40" style={{ width: "min(448px, 100%)" }}>
                    <AgentCommandPalette commands={filteredSlashCommands} heading={t("home.commandPalette.commands")} selectedIndex={selectedCommandIndex} onSelect={selectSlashCommand} />
                  </div>
                )}
                {statusPanel.open && !slashMenuOpen && (
                  <div className="absolute left-0 bottom-full mb-3 z-30 w-full" style={{ right: 0 }}>
                    <AgentStatusPanel state={statusPanel} closeLabel={t("common.close")} loadingLabel={t("home.agent.connecting")} onClose={() => setStatusPanel({ open: false })} />
                  </div>
                )}
                {lastCompactionPanel.open && !statusPanel.open && !slashMenuOpen && (
                  <div className="absolute left-0 right-0 bottom-full mb-3 z-30 w-full">
                    <AgentStatusPanel state={lastCompactionPanel} closeLabel={t("common.close")} loadingLabel={t("home.agent.connecting")} onClose={closeLastCompactionPanel} />
                  </div>
                )}
                {historyDagPanel.open && !statusPanel.open && !lastCompactionPanel.open && !slashMenuOpen && (
                  <div className="absolute left-0 right-0 bottom-full mb-3 z-30 w-full">
                    <HistoryDagPanel
                      state={historyDagPanel}
                      closeLabel={t("common.close")}
                      loadingLabel={t("home.agent.connecting")}
                      labels={{
                        currentTask: t("home.historyDag.currentTask"),
                        nodeCount: t("home.historyDag.nodeCount"),
                        edgeCount: t("home.historyDag.edgeCount"),
                        activePath: t("home.historyDag.activePath"),
                        none: t("home.historyDag.none"),
                        noDag: t("home.historyDag.noDag"),
                        selectNode: t("home.historyDag.selectNode"),
                        refs: t("home.historyDag.refs"),
                        noRefs: t("home.historyDag.noRefs"),
                        finishTitle: t("home.historyDag.finishTitle")
                      }}
                      onClose={() => setHistoryDagPanel({ open: false })}
                    />
                  </div>
                )}
                <ComposerMediaPreviewStrip
                  items={pendingAttachments}
                  onRemove={removePendingMedia}
                  removeLabel={t("common.remove")}
                  selectedLabel={t("home.media.addPhotoFile")}
                  t={t}
                />
                <textarea
                  ref={inputRef}
                  value={input}
                  placeholder={t("home.input")}
                  rows={1}
                  onChange={(event) => {
                    updateComposerInput(event.target.value);
                    resizeComposerInput(event.target);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={handleComposerPaste}
                  className={`${isComposerSingleLine ? "agent-composer-input--single " : ""}block w-full pl-4 pr-20 py-3 text-sm resize-none focus:outline-none rounded-card-lg bg-background-paper placeholder:text-text-ink/40`}
                />
                <div className={`absolute right-2.5 flex items-center gap-1 z-10 ${centerComposerControls ? "top-1/2 -translate-y-1/2" : "bottom-2"}`}>
                  <button
                    type="button"
                    aria-label={t("home.media.menu")}
                    title={t("home.media.menu")}
                    onClick={openMediaFilePicker}
                    className="p-1.5 text-text-ink/45 hover:text-text-ink/65 hover:bg-canvas-oat/60 rounded-lg transition-all cursor-pointer"
                  >
                    <Plus size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("home.voiceInput")}
                    title={t("home.voiceInput")}
                    disabled={asrRecorder.isTranscribing || asrRecorder.isStarting}
                    onClick={toggleVoiceInput}
                    className={`p-1.5 hover:bg-canvas-oat/60 rounded-lg transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${asrRecorder.isRecording ? "text-action-sky" : "text-text-ink/45 hover:text-text-ink/65"}`}
                  >
                    {asrRecorder.isRecording ? <Pause size={15} /> : <Mic size={15} />}
                  </button>
                  <ComposerSubmitButton
                    isSending={isCurrentAgentRunning}
                    disabled={composerSubmitDisabled}
                    sendLabel={t("home.send")}
                    stopLabel={t("home.stop")}
                    variant="compact"
                    onClick={isCurrentAgentRunning ? stopCurrentTurn : () => void sendMessage()}
                  />
                </div>
              </div>
              {composerMediaError && <p role="alert" className="text-center text-xs text-status-error mt-2">{agentErrorText(composerMediaError, t)}</p>}
              {agentError && <p className="text-center text-xs text-status-error mt-2">{agentError}</p>}
              <p className="text-center text-[11px] text-text-ink/40 mt-2">{t("home.notice")}</p>
              <input ref={fileInputRef} type="file" accept={AGENT_MEDIA_ACCEPT} multiple hidden className="hidden" onChange={(event) => void selectMedia(event)} />
            </div>
          </div>
        </section>
      )}
    </AppFrame>
  );
}

type HomeTranslate = (key: MessageKey, values?: MessageValues) => string;

const defaultHomeTranslate: HomeTranslate = (key, values) => formatMessage(zhCNMessages[key], values);

export function agentErrorText(error: string | null, t: HomeTranslate = defaultHomeTranslate): string | null {
  if (!error) {
    return null;
  }
  if (TRANSLATABLE_AGENT_ERROR_KEYS.has(error as MessageKey)) {
    return t(error as MessageKey);
  }
  return error;
}

export function agentStatusText(status: string, modelName: string | null, t: HomeTranslate): string | null {
  if (status === "connected") {
    return null;
  }
  if (status === "error") {
    return t("home.agent.failed");
  }
  if (status === "reconnecting") {
    return t("home.agent.reconnecting");
  }
  return t("home.agent.connecting");
}

function loadAgentThread(
  client: MemmyAgentClient,
  dispatch: (action: AppAction) => void,
  chatId: string,
  sessionKey = client.chatIdToSessionKey(chatId),
  options: { tolerateMissingThread?: boolean } = {}
): void {
  const requestId = nextAgentHistoryRequestId(chatId);
  const sessionsRequestId = nextAgentSessionsRequestId("thread");
  dispatch(agentActions.historyLoading(sessionKey, chatId, requestId));
  dispatch(agentActions.sessionsLoading(sessionsRequestId));
  void Promise.all([
    client.readWebuiThread(sessionKey).catch((error: unknown) => {
      if (options.tolerateMissingThread && error instanceof MemmyAgentRequestError && error.status === 404) {
        return { schemaVersion: 1, sessionKey, messages: [] };
      }
      throw error;
    }),
    client.listSessions(),
    client.readSidebarState()
  ])
    .then(([thread, sessions, sidebarState]) => {
      dispatch(agentActions.historyLoaded(thread, requestId));
      dispatch(agentActions.sidebarStateLoaded(sidebarState));
      dispatch(agentActions.sessionsLoaded(sessions, sessionsRequestId));
    })
    .catch((error) => dispatch(agentActions.failed(error instanceof Error ? error.message : String(error))));
}

let agentHistoryRequestCounter = 0;
let agentSessionsRequestCounter = 0;

function nextAgentHistoryRequestId(chatId: string): string {
  agentHistoryRequestCounter += 1;
  return `${chatId}-${agentHistoryRequestCounter}`;
}

function nextAgentSessionsRequestId(reason: "thread"): string {
  agentSessionsRequestCounter += 1;
  return `sessions-${reason}-${Date.now()}-${agentSessionsRequestCounter}`;
}

export function readFocusedAgentChatId(
  search: string | undefined = typeof window === "undefined" ? undefined : window.location.search,
  storage: SlashCommandStorageLike | null = typeof window === "undefined" ? null : window.sessionStorage,
  locationLike: Pick<Location, "href"> | null = typeof window === "undefined" ? null : window.location,
  historyLike: Pick<History, "replaceState" | "state"> | null = typeof window === "undefined" ? null : window.history
): string | null {
  const launchChatId = readLaunchAgentChatId(search);
  if (launchChatId) {
    clearFocusedAgentChatStorage(storage);
    if (locationLike && historyLike) {
      try {
        removeLaunchAgentChatIdFromUrl(locationLike, historyLike);
      } catch {
        // URL cleanup is best-effort; the focused chat id was already read.
      }
    }
    return launchChatId;
  }

  const storedChatId = normalizeAgentChatId(storage?.getItem(FOCUSED_AGENT_CHAT_STORAGE_KEY));
  clearFocusedAgentChatStorage(storage);
  return storedChatId;
}

function clearFocusedAgentChatStorage(storage: SlashCommandStorageLike | null): void {
  if (!storage) {
    return;
  }
  if (storage.removeItem) {
    storage.removeItem(FOCUSED_AGENT_CHAT_STORAGE_KEY);
    return;
  }
  storage.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, "");
}

function browserStorage(): SlashCommandStorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/**
 * Produces an ASR error message for the main interface.
 *
 * @param error An unknown exception.
 * @returns Error text that can be shown to the user.
 */
function toReadableAsrError(error: unknown, t: HomeTranslate = defaultHomeTranslate): string {
  return error instanceof Error && error.message
    ? t("home.asrFailedWithMessage", { message: error.message })
    : t("home.asrFailed");
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isPendingAttachmentReadyForUpload(item: PendingAttachment): boolean {
  if (item.status !== "ready") {
    return false;
  }
  return item.kind === "image"
    ? Boolean(item.encodedBlob && item.encodedMime)
    : Boolean(item.uploadBlob && item.uploadMime);
}

function uploadBlobForPendingAttachment(item: PendingAttachment): Blob {
  return item.kind === "image" ? item.encodedBlob! : item.uploadBlob!;
}

function uploadMimeForPendingAttachment(item: PendingAttachment): UploadedAgentMedia["mime"] {
  return item.kind === "image" ? item.encodedMime! : item.uploadMime!;
}

function uploadClassificationForPendingAttachment(item: PendingAttachment): AgentAttachmentClassification {
  if (item.kind === "image") {
    return {
      kind: "image",
      mime: item.encodedMime!,
      extension: item.encodedMime === "image/jpeg" ? ".jpg" : `.${item.encodedMime!.slice("image/".length)}`,
    };
  }
  return {
    kind: "file",
    mime: item.uploadMime!,
    extension: item.extension,
  };
}

function mediaTypeForAnalytics(items: PendingAttachment[]): "image" | "file" | "mixed" {
  const kinds = new Set(items.map((item) => item.kind));
  if (kinds.size > 1) {
    return "mixed";
  }
  return kinds.has("file") ? "file" : "image";
}

export interface ValidatedAgentMediaFile {
  file: File;
  classification: AgentAttachmentClassification;
  sourceKey: string;
}

export interface AgentMediaValidationResult {
  files: ValidatedAgentMediaFile[];
  duplicateCount: number;
}

type ClipboardFileItem = Pick<DataTransferItem, "kind" | "type" | "getAsFile">;
type DragFileItem = Pick<DataTransferItem, "kind" | "getAsFile">;

export interface ClipboardImageSource {
  items?: ArrayLike<ClipboardFileItem> | Iterable<ClipboardFileItem>;
  files?: ArrayLike<File> | Iterable<File>;
}

export interface AttachmentDropSource {
  items?: ArrayLike<DragFileItem> | Iterable<DragFileItem>;
  files?: ArrayLike<File> | Iterable<File>;
  types?: ArrayLike<string> | Iterable<string>;
}

export function clipboardImageFilesFromDataTransfer(source: ClipboardImageSource | null | undefined): File[] {
  const files: File[] = [];
  const seen = new Set<File>();
  const addImageFile = (file: File | null | undefined) => {
    if (!file || !String(file.type ?? "").toLowerCase().startsWith("image/") || seen.has(file)) {
      return;
    }
    seen.add(file);
    files.push(file);
  };

  for (const item of arrayLikeToArray<ClipboardFileItem>(source?.items)) {
    if (item.kind === "file" && String(item.type ?? "").toLowerCase().startsWith("image/")) {
      addImageFile(item.getAsFile());
    }
  }
  if (files.length > 0) {
    return files;
  }
  for (const file of arrayLikeToArray<File>(source?.files)) {
    addImageFile(file);
  }

  return files;
}

export function attachmentFilesFromDataTransfer(source: AttachmentDropSource | null | undefined): File[] {
  const files: File[] = [];
  const seen = new Set<File>();
  const addFile = (file: File | null | undefined) => {
    if (!file || seen.has(file)) {
      return;
    }
    seen.add(file);
    files.push(file);
  };

  for (const item of arrayLikeToArray<DragFileItem>(source?.items)) {
    if (item.kind === "file") {
      addFile(item.getAsFile());
    }
  }
  for (const file of arrayLikeToArray<File>(source?.files)) {
    addFile(file);
  }

  return files;
}

export function dataTransferHasAttachmentFiles(source: AttachmentDropSource | null | undefined): boolean {
  if (arrayLikeToArray<DragFileItem>(source?.items).some((item) => item.kind === "file")) {
    return true;
  }
  if (arrayLikeToArray<File>(source?.files).length > 0) {
    return true;
  }
  return arrayLikeToArray<string>(source?.types).some((type) => type.toLowerCase() === "files");
}

export async function hashAgentAttachmentFile(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("home.media.error.sendReadFailed");
  }
  try {
    const buffer = await file.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new Error("home.media.error.sendReadFailed");
  }
}

export function agentAttachmentSourceKey(file: Pick<File, "name" | "size" | "lastModified">, classification: AgentAttachmentClassification, sha256: string): string {
  return JSON.stringify([
    "content-metadata-v1",
    classification.kind,
    classification.mime,
    file.name || "",
    file.size,
    Number.isFinite(file.lastModified) ? file.lastModified : 0,
    sha256
  ]);
}

export async function validateAgentMediaFiles(files: File[], t?: HomeTranslate, existingAttachments: readonly PendingAttachment[] = []): Promise<AgentMediaValidationResult> {
  const translate = t ?? defaultHomeTranslate;
  const classifications = files.map((file) => classifyAgentAttachmentFile(file));

  if (classifications.some((item) => !item)) {
    throw new Error(translate("home.media.error.unsupported"));
  }
  for (const [index] of classifications.entries()) {
    if (files[index]!.size > AGENT_FILE_TARGET_MAX_BYTES) {
      throw new Error(translate("home.media.error.fileTooLarge"));
    }
  }

  const seenSourceKeys = new Set(existingAttachments.map((item) => item.sourceKey));
  const resultFiles: ValidatedAgentMediaFile[] = [];
  let duplicateCount = 0;

  for (const [index, file] of files.entries()) {
    const classification = classifications[index]!;
    const sha256 = await hashAgentAttachmentFile(file);
    const sourceKey = agentAttachmentSourceKey(file, classification, sha256);
    if (seenSourceKeys.has(sourceKey)) {
      duplicateCount += 1;
      continue;
    }
    seenSourceKeys.add(sourceKey);
    resultFiles.push({ file, classification, sourceKey });
    if (existingAttachments.length + resultFiles.length > AGENT_ATTACHMENT_MAX_COUNT) {
      throw new Error(translate("home.media.error.tooManyAttachments"));
    }
  }

  return { files: resultFiles, duplicateCount };
}

export function fileToPendingAttachment(file: File, sourceKey: string, classificationInput?: AgentAttachmentClassification): PendingAttachment {
  const classification = classificationInput ?? classifyAgentAttachmentFile(file);
  if (!classification) {
    throw new Error("home.media.error.sendUnsupported");
  }
  if (classification.kind === "file") {
    return {
      id: randomPendingAttachmentId("file"),
      sourceKey,
      fileName: file.name || `attachment${classification.extension}`,
      kind: "file",
      status: "ready",
      originalBytes: file.size,
      uploadBlob: file,
      uploadMime: classification.mime as UploadedAgentMedia["mime"],
      uploadBytes: file.size,
      extension: classification.extension,
    };
  }
  return {
    id: randomPendingAttachmentId("image"),
    sourceKey,
    fileName: file.name || "image",
    kind: "image",
    previewUrl: createPreviewUrl(file),
    status: "encoding",
    originalBytes: file.size
  };
}

async function encodePendingAgentImage(file: File): Promise<{ blob: Blob; mime: AgentImageMime; bytes: number; normalized: boolean }> {
  if (typeof Worker === "undefined") {
    return encodeAgentImage(file);
  }

  return new Promise((resolve, reject) => {
    const id = randomPendingImageId();
    const worker = new Worker(new URL("../workers/agent-image-encode.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      if (event.data.id !== id) {
        return;
      }
      cleanup();
      if (event.data.ok === true) {
        resolve({
          blob: event.data.blob as Blob,
          mime: event.data.mime as AgentImageMime,
          bytes: Number(event.data.bytes),
          normalized: event.data.normalized === true
        });
        return;
      }
      reject(new Error(typeof event.data.error === "string" ? event.data.error : "home.media.error.sendReadFailed"));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("home.media.error.sendReadFailed"));
    };
    worker.postMessage({ id, file });
  });
}

function createPreviewUrl(file: File): string {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(file);
  }
  return "";
}

function revokePendingAttachment(item: PendingAttachment): void {
  if (item.kind === "image" && item.previewUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function randomPendingAttachmentId(kind: "image" | "file"): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function randomPendingImageId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function arrayLikeToArray<T>(value: ArrayLike<T> | Iterable<T> | null | undefined): T[] {
  return value ? Array.from(value) : [];
}

function encodedPayloadBytes(payload: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(zhCNMessages, value);
}
