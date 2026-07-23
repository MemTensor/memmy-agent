/**
 * Agent chat message rendering.
 *
 * Trace rows are intermediate agent activity, not conversational replies. This
 * component keeps activity grouped and renders the complete trace list returned
 * by live WebSocket events and /webui-thread history.
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type SVGProps } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Compass,
  FileCode2,
  FilePlus2,
  FileText,
  Globe,
  Image as ImageIcon,
  ListTree,
  Notebook,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  AgentMessageContent,
  AttachmentActionError,
  isLikelyExpensiveAgentMarkdown,
  runAttachmentAction,
  startBrowserDownload,
  writeClipboardText,
  type AgentArtifactClient,
  type AttachmentDownloadStarter,
  type AttachmentCopyTarget,
} from "./agent-message-content.js";
import { Memmy } from "../components/mascot/memmy.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
import type { MessageKey, MessageValues, ResolvedLanguage } from "../i18n/messages.js";
import { WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE } from "../theme/window-controls-overlay.js";
import type { AgentChatMediaAttachment, AgentChatMessage, AgentCompactionStatus, AgentRetryWaitStatus } from "../state/agent-chat-slice.js";
import {
  formatToolCallTrace,
  summarizeToolCall,
  type AgentFileEdit,
  type AgentToolProgressEvent,
  type ToolTraceSummary,
  type ToolTraceCategory,
} from "../state/agent-tool-traces.js";
import { AgentAttachmentCard, splitAgentAttachmentName } from "./agent-file-attachment-chip.js";
import {
  formatAgentModelError,
  formatRetryWaitStatus,
  isAgentModelErrorContent,
  shouldSuppressRetryWaitStatus,
} from "./agent-model-error.js";

interface AgentThreadMessagesProps {
  messages: AgentChatMessage[];
  afterMessageId?: string | null;
  afterMessageContent?: ReactNode;
  /** Shows standard reply actions on the final text reply when a supplement follows activity. */
  forceMessageActionsForMessageId?: string | null;
  retryWaitStatus?: AgentRetryWaitStatus | null;
  artifactClient?: AgentArtifactClient | null;
  chatScopeKey: string;
  historyVersion?: number;
  isSending?: boolean;
  sanitizePlatformApiErrors?: boolean;
  accountMode?: boolean;
}

export type AgentDisplayUnit =
  | {
      type: "activity";
      messages: AgentChatMessage[];
      activityKey: string;
      bodyId: string;
      segmentId: string | null;
      isRunning: boolean;
      isCurrentTurnActivity: boolean;
      stoppedByUser: boolean;
    }
  | { type: "retry_wait"; status: AgentRetryWaitStatus }
  | { type: "single"; message: AgentChatMessage };

const ASSISTANT_IMAGE_FRAME_STYLE = { maxWidth: "min(100%, 34rem)" } satisfies CSSProperties;
const ASSISTANT_IMAGE_STYLE = { width: "100%", height: "auto", maxHeight: "36rem", objectFit: "contain" } satisfies CSSProperties;
const LEGACY_VIDEO_FRAME_STYLE = { maxWidth: "min(100%, 32rem)" } satisfies CSSProperties;
const LEGACY_VIDEO_STYLE = { width: "100%", maxHeight: "26rem" } satisfies CSSProperties;
const MESSAGE_COPY_RESET_MS = 1200;
const AGENT_IMMEDIATE_RENDER_UNIT_COUNT = 4;
const AGENT_DEFERRED_RENDER_STEP_MS = 90;
const AGENT_DEFERRED_RENDER_START_MS = 120;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ACTIVITY_CONTEXT_LINE_CLASS = "mb-0.5 min-w-0 break-words px-0 py-0.5 text-[13px] leading-[1.55] text-text-ink/55";
export const CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS = "absolute right-4 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full bg-background-paper text-text-ink shadow-lg transition-all hover:bg-canvas-oat focus:outline-none focus:ring-2 focus:ring-action-sky/40";
export const CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS = "absolute top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-background-paper text-text-ink shadow-lg transition-all hover:bg-canvas-oat focus:outline-none focus:ring-2 focus:ring-action-sky/40";
const IMAGE_CONTEXT_MENU_WIDTH = 144;
const IMAGE_CONTEXT_MENU_HEIGHT = 76;
const IMAGE_CONTEXT_MENU_MARGIN = 8;
const IMAGE_CONTEXT_MENU_CLOSE_MS = 720;

interface ChatImageActionTarget {
  url: string;
  name?: string;
}

type ImageMenuStatus = "idle" | "copying" | "copied" | "copy-error" | "saving" | "save-error";

interface ChatImageContextMenuState {
  x: number;
  y: number;
  image: ChatImageActionTarget;
  status: ImageMenuStatus;
}

type ClipboardWriter = Pick<Clipboard, "write">;
type ClipboardItemConstructor = {
  new(items: Record<string, Blob>): ClipboardItem;
  supports?: (type: string) => boolean;
};

export const AgentThreadMessages = memo(function AgentThreadMessages(props: AgentThreadMessagesProps) {
  const units = useMemo(
    () => buildAgentDisplayUnits(props.messages, { chatScopeKey: props.chatScopeKey, retryWaitStatus: props.retryWaitStatus ?? null }),
    [props.chatScopeKey, props.messages, props.retryWaitStatus]
  );
  const finalAssistantAnswerIndex = useMemo(() => findFinalAssistantAnswerUnitIndex(units, { isSending: props.isSending }), [props.isSending, units]);
  const [manualOpenByActivityKey, setManualOpenByActivityKey] = useState<Record<string, boolean | undefined>>({});
  const previousRunningByActivityKey = useRef<Record<string, boolean>>({});
  const activityRunningByKey = useMemo(() => {
    const next: Record<string, boolean> = {};
    for (const unit of units) {
      if (unit.type === "activity") {
        next[unit.activityKey] = isActivityAutoOpenRunning(unit, props.isSending);
      }
    }
    return next;
  }, [props.isSending, units]);

  useEffect(() => {
    setManualOpenByActivityKey({});
    previousRunningByActivityKey.current = {};
  }, [props.chatScopeKey, props.historyVersion]);

  useEffect(() => {
    setManualOpenByActivityKey((current) => {
      let changed = false;
      const next = { ...current };
      for (const unit of units) {
        if (unit.type !== "activity") {
          continue;
        }
        const isAutoOpenRunning = activityRunningByKey[unit.activityKey] === true;
        const wasRunning = previousRunningByActivityKey.current[unit.activityKey] === true;
        if (!isAutoOpenRunning && (wasRunning || current[unit.activityKey] === undefined)) {
          // Cursor-style: after an activity finishes streaming, collapse it by default.
          // Only user-stopped runs stay open so the last visible state is preserved.
          const nextOpen = unit.stoppedByUser;
          if (current[unit.activityKey] !== nextOpen) {
            next[unit.activityKey] = nextOpen;
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
    previousRunningByActivityKey.current = activityRunningByKey;
  }, [activityRunningByKey, units]);

  return (
    <>
      {units.map((unit, index) => {
        if (unit.type === "retry_wait") {
          return <RetryWaitStatusLine key={unit.status.id} status={unit.status} />;
        }
        if (unit.type === "activity") {
          const isAutoOpenRunning = activityRunningByKey[unit.activityKey] === true;
          const manualOpen = manualOpenByActivityKey[unit.activityKey];
          const open = isAutoOpenRunning ? manualOpen ?? true : manualOpen ?? unit.stoppedByUser;
          return (
            <Fragment key={unit.activityKey}>
              <AgentActivityCluster
                activityKey={unit.activityKey}
                bodyId={unit.bodyId}
                messages={unit.messages}
                isRunning={isAutoOpenRunning}
                stoppedByUser={unit.stoppedByUser}
                open={open}
                onToggle={() => setManualOpenByActivityKey((current) => ({ ...current, [unit.activityKey]: !open }))}
                artifactClient={props.artifactClient}
              />
              {unit.messages.some((message) => message.id === props.afterMessageId) ? props.afterMessageContent : null}
            </Fragment>
          );
        }
        const messageKey = unit.message.id || `${unit.message.role}-${index}`;
        return (
          <Fragment key={messageKey}>
            <SingleMessage
              message={unit.message}
              artifactClient={props.artifactClient}
              chatScopeKey={props.chatScopeKey}
              unitIndex={index}
              isFinalAssistantAnswer={index === finalAssistantAnswerIndex}
              forceMessageActions={unit.message.id === (props.forceMessageActionsForMessageId ?? props.afterMessageId)}
              deferContentRender={shouldDeferAgentMessageContent(unit, index, units.length)}
              deferredRevealDelayMs={deferredAgentMessageRevealDelay(index, units.length)}
              sanitizePlatformApiErrors={props.sanitizePlatformApiErrors === true}
              accountMode={props.accountMode === true}
            />
            {unit.message.id === props.afterMessageId ? props.afterMessageContent : null}
          </Fragment>
        );
      })}
      {shouldShowThinkingPlaceholder(props.messages, props.isSending) && (
        <ThinkingPlaceholder />
      )}
    </>
  );
}, areAgentThreadMessagesPropsEqual);

function areAgentThreadMessagesPropsEqual(previous: AgentThreadMessagesProps, next: AgentThreadMessagesProps): boolean {
  return previous.messages === next.messages
    && previous.afterMessageId === next.afterMessageId
    && previous.afterMessageContent === next.afterMessageContent
    && previous.forceMessageActionsForMessageId === next.forceMessageActionsForMessageId
    && previous.artifactClient === next.artifactClient
    && previous.chatScopeKey === next.chatScopeKey
    && previous.historyVersion === next.historyVersion
    && previous.isSending === next.isSending
    && previous.retryWaitStatus === next.retryWaitStatus
    && previous.sanitizePlatformApiErrors === next.sanitizePlatformApiErrors
    && previous.accountMode === next.accountMode;
}

export function buildAgentDisplayUnits(messages: AgentChatMessage[], options: { chatScopeKey: string; retryWaitStatus?: AgentRetryWaitStatus | null }): AgentDisplayUnit[] {
  const units: AgentDisplayUnit[] = [];
  const lastUserIndex = findLastMessageIndex(messages, "user");
  // A turn's activity (reasoning excerpts + tool-call batches) is ONE single
  // collapsible unit, matching Cursor's "Worked for Xm Ys" / "Thought for Xs"
  // wrapper. Inside that single unit we preserve the exact chronological
  // sequence of messages so the render layer can alternate thought/tool
  // sub-sections naturally — splitting into per-category clusters (one
  // earlier iteration's mistake) breaks that natural flow into a wall of
  // disconnected collapsed rows. Only a genuine visible-content message
  // (a real reply, not just activity) breaks the run, which is exactly the
  // "body" block in the reasoning/tool/body alternation.
  const appendActivityUnit = (activity: AgentChatMessage[], firstMessageIndex: number) => {
    if (!activity.length) {
      return;
    }
    const previous = units.at(-1);
    const isCurrentTurnActivity = firstMessageIndex > lastUserIndex;
    if (previous?.type === "activity") {
      previous.messages = [...previous.messages, ...activity];
      previous.isRunning = previous.messages.some(isActivityMessageRunningForDisplay);
      previous.isCurrentTurnActivity = previous.isCurrentTurnActivity || isCurrentTurnActivity;
      previous.stoppedByUser = previous.messages.some((item) => item.stoppedByUser);
      return;
    }
    const segmentId = activity.find((item) => item.activitySegmentId)?.activitySegmentId ?? null;
    const activityKey = activityUiKey({
      chatScopeKey: options.chatScopeKey,
      unitIndex: units.length,
      segmentId,
      firstMessageId: activity[0]?.id ?? null
    });
    units.push({
      type: "activity",
      messages: activity,
      activityKey,
      bodyId: activityBodyId(activityKey),
      segmentId,
      isRunning: activity.some(isActivityMessageRunningForDisplay),
      isCurrentTurnActivity,
      stoppedByUser: activity.some((item) => item.stoppedByUser)
    });
  };
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message && isAgentActivityMessage(message)) {
      const activity: AgentChatMessage[] = [];
      const firstActivityMessageIndex = index;
      while (
        index < messages.length
        && isAgentActivityMessage(messages[index]!)
      ) {
        activity.push(messages[index]!);
        index += 1;
      }
      appendActivityUnit(activity, firstActivityMessageIndex);
      continue;
    }

    if (message) {
      if (shouldSplitAssistantReasoningForDisplay(message)) {
        appendActivityUnit([assistantReasoningActivityMessage(message)], index);
        units.push({ type: "single", message: assistantAnswerMessageWithoutReasoning(message) });
      } else {
        units.push({ type: "single", message });
      }
    }
    index += 1;
  }
  insertRetryWaitUnit(units, messages, options.retryWaitStatus ?? null);
  return units;
}

function insertRetryWaitUnit(units: AgentDisplayUnit[], messages: AgentChatMessage[], status: AgentRetryWaitStatus | null): void {
  if (!status || shouldSuppressRetryWaitStatus(status, messages)) {
    return;
  }

  const anchorMessageId = status.anchorMessageId && messages.some((message) => message.id === status.anchorMessageId)
    ? status.anchorMessageId
    : lastUserMessageId(messages);
  const retryUnit: Extract<AgentDisplayUnit, { type: "retry_wait" }> = { type: "retry_wait", status };
  if (!anchorMessageId) {
    units.push(retryUnit);
    return;
  }

  const anchorUnitIndex = units.findIndex((unit) => unit.type === "single" && unit.message.id === anchorMessageId);
  if (anchorUnitIndex < 0) {
    units.push(retryUnit);
    return;
  }
  units.splice(anchorUnitIndex + 1, 0, retryUnit);
}

function lastUserMessageId(messages: AgentChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.id;
    }
  }
  return null;
}

function isActivityAutoOpenRunning(unit: Extract<AgentDisplayUnit, { type: "activity" }>, isSending: boolean | undefined): boolean {
  return Boolean(unit.isRunning || (isSending && unit.isCurrentTurnActivity && !unit.stoppedByUser));
}

/**
 * Locate the index of the last "single" unit that is a finalized assistant
 * answer. While the current turn is still sending, assistant text after the
 * latest user message is treated as continuation text, because the agent may
 * still alternate body → tool → reasoning → tool before the actual final answer.
 */
function findFinalAssistantAnswerUnitIndex(units: AgentDisplayUnit[], options: { isSending?: boolean } = {}): number {
  const lastUserUnitIndex = findLastUserUnitIndex(units);
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit?.type !== "single") continue;
    if (options.isSending && index > lastUserUnitIndex) continue;
    const message = unit.message;
    if (message.role === "assistant"
      && message.kind !== "trace"
      && message.kind !== "narration"
      && message.kind !== "context_compaction"
      && message.content.trim().length > 0) {
      return index;
    }
  }
  return -1;
}

function findLastUserUnitIndex(units: AgentDisplayUnit[]): number {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit?.type === "single" && unit.message.role === "user") {
      return index;
    }
  }
  return -1;
}

interface SingleMessageProps {
  message: AgentChatMessage;
  artifactClient?: AgentArtifactClient | null;
  chatScopeKey: string;
  unitIndex: number;
  isFinalAssistantAnswer?: boolean;
  forceMessageActions?: boolean;
  deferContentRender?: boolean;
  deferredRevealDelayMs?: number;
  sanitizePlatformApiErrors?: boolean;
  accountMode?: boolean;
}

const SingleMessage = memo(function SingleMessage(props: SingleMessageProps) {
  const { message } = props;
  const { language, t } = useTranslation();
  if (message.kind === "context_compaction") {
    return <ContextCompactionDivider message={message} />;
  }

  if (message.role === "user") {
    const hasContent = message.content.trim().length > 0;
    const timestamp = messageTimestamp(message.createdAt, language, t);
    return (
      <div className="agent-user-turn flex min-w-0 justify-end">
        <div className="flex min-w-0 max-w-[75%] flex-col items-end gap-2">
          {message.media?.length ? (
            <UserMediaPreviewGrid media={message.media} artifactClient={props.artifactClient} />
          ) : null}
          {hasContent ? (
            <div className="agent-chat-bubble-frame agent-chat-bubble-frame--user max-w-full min-w-0">
              <div className="agent-chat-bubble agent-chat-bubble--user max-w-full min-w-0 overflow-hidden px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {message.content}
              </div>
              <MessageBubbleCopyButton text={message.content} align="right" timestamp={timestamp} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (message.kind === "trace" || message.role === "tool") {
    const activityKey = activityUiKey({
      chatScopeKey: props.chatScopeKey,
      unitIndex: props.unitIndex,
      segmentId: message.activitySegmentId ?? null,
      firstMessageId: message.id || null
    });
    return (
      <AgentActivityCluster
        activityKey={activityKey}
        bodyId={activityBodyId(activityKey)}
        messages={[message]}
        isRunning={isActivityMessageRunningForDisplay(message)}
        stoppedByUser={Boolean(message.stoppedByUser)}
        open={Boolean(isActivityMessageRunningForDisplay(message) || message.stoppedByUser)}
        onToggle={() => undefined}
        artifactClient={props.artifactClient}
      />
    );
  }

  if (isAgentModelErrorContent(message.content) && !isTechnicalPlatformApiError(message.content)) {
    return (
      <div className="flex min-w-0 justify-start">
        <AgentModelErrorNotice content={message.content} accountMode={props.accountMode === true} />
      </div>
    );
  }

  const isFinalAnswer = props.isFinalAssistantAnswer !== false || props.forceMessageActions === true;
  const assistantCopyReady = isFinalAnswer && isAssistantMessageCopyReady(message);
  const displayedContent = resolveAgentMessageDisplayContent(message, {
    sanitizePlatformApiErrors: props.sanitizePlatformApiErrors === true,
    fallback: t("home.agent.platformApiFallback")
  });
  const timestamp = assistantCopyReady ? messageTimestamp(message.createdAt, language, t) : null;
  const reasoningKey = assistantReasoningUiKey({
    chatScopeKey: props.chatScopeKey,
    unitIndex: props.unitIndex,
    messageId: message.id || null
  });
  return (
    <div className="flex min-w-0 justify-start">
      <div className="min-w-0 w-full space-y-2">
        {message.reasoning ? (
          <AssistantReasoningPanel
            reasoning={message.reasoning}
            isLive={Boolean(message.reasoningStreaming)}
            reasoningKey={reasoningKey}
            bodyId={assistantReasoningBodyId(reasoningKey)}
          />
        ) : null}
        <div className="agent-chat-bubble-frame agent-chat-bubble-frame--assistant max-w-full min-w-0">
          <div className="agent-chat-bubble agent-chat-bubble--assistant w-full max-w-full min-w-0 overflow-hidden">
            <AgentMessageContent
              content={displayedContent}
              isStreaming={message.isStreaming}
              artifactClient={props.artifactClient}
              deferRender={props.deferContentRender}
              deferredRevealDelayMs={props.deferredRevealDelayMs}
            />
            {message.media?.length ? (
              <AssistantMediaAttachmentList media={message.media} artifactClient={props.artifactClient} />
            ) : null}
          </div>
          <MessageBubbleCopyButton text={displayedContent} align="left" available={assistantCopyReady} timestamp={timestamp} />
        </div>
      </div>
    </div>
  );
}, areSingleMessagePropsEqual);

function contextCompactionFallbackText(status: AgentCompactionStatus): string {
  if (status === "running") return "Summarizing chat context";
  if (status === "error") return "Context summary failed";
  return "Context summary complete";
}

function contextCompactionStatus(message: AgentChatMessage): AgentCompactionStatus {
  if (message.compactionStatus === "running" || message.compactionStatus === "done" || message.compactionStatus === "error") {
    return message.compactionStatus;
  }
  return message.isStreaming ? "running" : "done";
}

function ContextCompactionDivider(props: { message: AgentChatMessage }) {
  const status = contextCompactionStatus(props.message);
  const isRunning = status === "running";
  const label = props.message.content.trim() || contextCompactionFallbackText(status);
  return (
    <div
      className={`agent-context-compaction-divider agent-context-compaction-divider--${status}`}
      aria-live={isRunning ? "polite" : undefined}
      aria-busy={isRunning || undefined}
    >
      <span className="agent-context-compaction-divider__line" aria-hidden="true" />
      <span className="agent-context-compaction-divider__label">{label}</span>
      <span className="agent-context-compaction-divider__line" aria-hidden="true" />
    </div>
  );
}

function RetryWaitStatusLine(props: { status: AgentRetryWaitStatus }) {
  const { t } = useTranslation();
  const label = formatRetryWaitStatus(props.status.text, t);
  return (
    <div
      className={`agent-retry-wait-line${props.status.isRunning ? " agent-retry-wait-line--running" : ""}`}
      aria-live="polite"
      aria-busy={props.status.isRunning || undefined}
    >
      <span className="agent-retry-wait-line__label">{label}</span>
    </div>
  );
}

function AgentModelErrorNotice(props: { content: string; accountMode?: boolean }) {
  const { t } = useTranslation();
  const [showDetail, setShowDetail] = useState(false);
  const { title, detail } = formatAgentModelError(props.content, t, { accountMode: props.accountMode === true });

  return (
    <div className="agent-model-error-notice" role="alert">
      <div className="agent-model-error-notice__header">
        <AlertCircle size={15} className="agent-model-error-notice__icon" aria-hidden="true" />
        <p className="agent-model-error-notice__title">{title}</p>
      </div>
      {detail ? (
        <>
          <button
            type="button"
            className="agent-model-error-notice__toggle"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((current) => !current)}
          >
            {showDetail ? t("agent.error.hideDetails") : t("agent.error.showDetails")}
          </button>
          {showDetail ? <p className="agent-model-error-notice__detail">{detail}</p> : null}
        </>
      ) : null}
    </div>
  );
}

function isAssistantMessageCopyReady(message: AgentChatMessage): boolean {
  return message.role === "assistant"
    && !message.isStreaming
    && !message.reasoningStreaming
    && message.content.trim().length > 0;
}

interface MessageTimestamp {
  label: string;
  dateTime: string;
}

type Translate = (key: MessageKey, values?: MessageValues) => string;

function messageTimestamp(createdAt: number | undefined, language: ResolvedLanguage, t: Translate, now = new Date()): MessageTimestamp | null {
  if (createdAt == null) {
    return null;
  }
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return {
    label: formatMessageTimestamp(date, now, language, t),
    dateTime: date.toISOString()
  };
}

function formatMessageTimestamp(date: Date, now: Date, language: ResolvedLanguage, t: Translate): string {
  const time = `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
  if (isSameLocalDay(date, now)) {
    return time;
  }
  const ageMs = now.getTime() - date.getTime();
  if (ageMs < ONE_WEEK_MS) {
    return t("agent.message.time.weekday", {
      weekday: new Intl.DateTimeFormat(language, { weekday: "long" }).format(date),
      time
    });
  }
  if (ageMs >= ONE_YEAR_MS) {
    return t("agent.message.time.yearMonthDay", {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      time
    });
  }
  return t("agent.message.time.monthDay", {
    month: date.getMonth() + 1,
    day: date.getDate(),
    time
  });
}

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function areSingleMessagePropsEqual(previous: SingleMessageProps, next: SingleMessageProps): boolean {
  return previous.message === next.message
    && previous.artifactClient === next.artifactClient
    && previous.chatScopeKey === next.chatScopeKey
    && previous.unitIndex === next.unitIndex
    && previous.isFinalAssistantAnswer === next.isFinalAssistantAnswer
    && previous.forceMessageActions === next.forceMessageActions
    && previous.deferContentRender === next.deferContentRender
    && previous.deferredRevealDelayMs === next.deferredRevealDelayMs
    && previous.sanitizePlatformApiErrors === next.sanitizePlatformApiErrors
    && previous.accountMode === next.accountMode;
}

export function resolveAgentMessageDisplayContent(message: AgentChatMessage, input: { sanitizePlatformApiErrors: boolean; fallback: string }): string {
  if (!input.sanitizePlatformApiErrors || message.role !== "assistant" || !isTechnicalPlatformApiError(message.content)) {
    return message.content;
  }
  return input.fallback;
}

function isTechnicalPlatformApiError(content: string): boolean {
  const normalized = content.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) {
    return false;
  }

  return /^error:\s*/iu.test(normalized) && (
    normalized.includes("api returned empty choices")
    || normalized.includes("empty choices")
    || normalized.includes("chat/completions")
    || normalized.includes("model request failed")
    || normalized.includes("api request failed")
    || normalized.includes("api error")
  );
}

function shouldDeferAgentMessageContent(unit: AgentDisplayUnit, index: number, totalUnits: number): boolean {
  if (unit.type !== "single" || index >= totalUnits - AGENT_IMMEDIATE_RENDER_UNIT_COUNT) {
    return false;
  }
  const message = unit.message;
  return message.role === "assistant"
    && message.kind !== "trace"
    && !message.isStreaming
    && !message.reasoningStreaming
    && isLikelyExpensiveAgentMarkdown(message.content);
}

function deferredAgentMessageRevealDelay(index: number, totalUnits: number): number {
  const distanceFromImmediateTail = Math.max(0, totalUnits - AGENT_IMMEDIATE_RENDER_UNIT_COUNT - index - 1);
  return AGENT_DEFERRED_RENDER_START_MS + distanceFromImmediateTail * AGENT_DEFERRED_RENDER_STEP_MS;
}

function AssistantReasoningPanel(props: {
  reasoning: string;
  isLive: boolean;
  reasoningKey: string;
  bodyId: string;
}) {
  const { t } = useTranslation();
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const previousReasoningKeyRef = useRef(props.reasoningKey);
  const wasLiveRef = useRef(props.isLive);

  useEffect(() => {
    if (previousReasoningKeyRef.current !== props.reasoningKey) {
      previousReasoningKeyRef.current = props.reasoningKey;
      wasLiveRef.current = props.isLive;
      setManualOpen(null);
      return;
    }
    if (wasLiveRef.current && !props.isLive) {
      setManualOpen(false);
    }
    wasLiveRef.current = props.isLive;
  }, [props.isLive, props.reasoningKey]);

  const open = manualOpen ?? props.isLive;
  const Chevron = open ? ChevronDown : ChevronRight;
  const label = props.isLive
    ? t("agent.reasoning.live")
    : open
      ? t("agent.reasoning.hide")
      : t("agent.reasoning.show");

  return (
    <div className={`agent-reasoning-panel max-w-full min-w-0 overflow-hidden${props.isLive ? " agent-reasoning-panel--live" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={props.bodyId}
        data-reasoning-key={props.reasoningKey}
        onClick={() => setManualOpen((current) => !(current ?? props.isLive))}
        className="agent-reasoning-panel__toggle inline-flex max-w-full min-w-0 items-center gap-1.5 py-1 text-left text-[13px] font-normal text-text-ink/55"
      >
        <span className="min-w-0 truncate">{label}</span>
        <Chevron data-icon={open ? "chevron-down" : "chevron-right"} size={12} className="shrink-0 text-text-ink/40" aria-hidden="true" />
      </button>
      {open ? (
        <div id={props.bodyId} className="agent-reasoning-panel__body min-w-0 overflow-hidden px-0">
          <ReasoningMarkdown text={props.reasoning} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Reasoning bodies used to render as a single `<p>` which dropped every bit of
 * markdown formatting (models like o1/o3 like to emit `**bullet**` or code
 * fences even inside the internal monologue). We reuse `AgentMessageContent`
 * so headings, lists, links, and inline code render correctly, but wrap it in
 * a `--reasoning` variant class so we keep the compact 13px muted style
 * instead of the assistant answer's 14px main-column typography.
 */
function ReasoningMarkdown(props: { text: string; isStreaming?: boolean }) {
  const trimmed = normalizeReasoningMarkdown(props.text);
  if (!trimmed) return null;
  return (
    <AgentMessageContent
      content={trimmed}
      isStreaming={props.isStreaming}
      className="agent-message-content--reasoning agent-reasoning-panel__text"
    />
  );
}

function normalizeReasoningMarkdown(text: string): string {
  const trimmed = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!trimmed) {
    return "";
  }
  const output: string[] = [];
  let plainBuffer: string[] = [];
  let inFence = false;
  const flushPlain = () => {
    if (!plainBuffer.length) return;
    output.push(plainBuffer.map((line) => line.trim()).filter(Boolean).join(" "));
    plainBuffer = [];
  };
  for (const line of trimmed.split("\n")) {
    const current = line.trimEnd();
    const structural = isReasoningMarkdownStructuralLine(current, inFence);
    if (/^\s*```/.test(current)) {
      if (!inFence) flushPlain();
      output.push(current);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(current);
      continue;
    }
    if (!current.trim()) {
      flushPlain();
      if (output.at(-1) !== "") output.push("");
      continue;
    }
    if (structural) {
      flushPlain();
      output.push(current);
      continue;
    }
    plainBuffer.push(current);
  }
  flushPlain();
  return output.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function isReasoningMarkdownStructuralLine(line: string, inFence: boolean): boolean {
  if (inFence) return true;
  const trimmed = line.trim();
  return /^#{1,6}\s+\S/u.test(trimmed)
    || /^>\s?/u.test(trimmed)
    || /^[-*+]\s+\S/u.test(trimmed)
    || /^\d+[.)]\s+\S/u.test(trimmed)
    || /^[-*_]{3,}\s*$/u.test(trimmed)
    || /^\|.+\|$/u.test(trimmed)
    || /^\s{2,}\S/u.test(line);
}

function assistantReasoningUiKey(input: {
  chatScopeKey: string;
  unitIndex: number;
  messageId: string | null;
}): string {
  return [
    input.chatScopeKey,
    "reasoning",
    String(input.unitIndex),
    input.messageId ?? "anonymous"
  ].join("::");
}

function assistantReasoningBodyId(reasoningKey: string): string {
  return `agent-reasoning-${sanitizeDomId(reasoningKey)}-body`;
}

function MessageBubbleCopyButton(props: {
  text: string;
  align: "left" | "right";
  available?: boolean;
  timestamp?: MessageTimestamp | null;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  if (props.available === false || props.text.trim().length === 0) {
    return null;
  }

  const label = copied ? t("agent.message.copied") : t("agent.message.copy");

  const copyMessage = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    try {
      const didCopy = await writeClipboardText(props.text);
      if (!didCopy) {
        return;
      }
      setCopied(true);
      resetTimerRef.current = setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, MESSAGE_COPY_RESET_MS);
    } catch {
      // Clipboard failures should not interrupt chat rendering or nearby actions.
    }
  };

  return (
    <div className={`agent-message-copy-cluster agent-message-copy-cluster--${props.align}`}>
      {props.timestamp ? (
        <time className="agent-message-time-label" dateTime={props.timestamp.dateTime}>{props.timestamp.label}</time>
      ) : null}
      <Tooltip content={label}>
        <button
          type="button"
          aria-label={label}
          className={`agent-message-copy-button agent-message-copy-button--${props.align}`}
          onClick={(event) => void copyMessage(event)}
        >
          {copied ? <CodexCheckIcon aria-hidden="true" /> : <CodexCopyIcon aria-hidden="true" />}
        </button>
      </Tooltip>
    </div>
  );
}

function CodexCopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M13.468 11.1216C13.468 10.4107 13.468 9.91717 13.4367 9.53369C13.4137 9.25191 13.3758 9.0622 13.3244 8.91846L13.2687 8.78858C13.1148 8.48652 12.8803 8.23344 12.593 8.05713L12.466 7.98584C12.308 7.90546 12.0963 7.84854 11.7209 7.81787C11.3374 7.78656 10.8439 7.78662 10.133 7.78662H7.29999C6.58895 7.78662 6.09562 7.78654 5.7121 7.81787C5.43015 7.84091 5.24064 7.87872 5.09686 7.93018L4.96698 7.98584C4.66487 8.13977 4.41184 8.37419 4.23554 8.66162L4.16522 8.78858C4.08477 8.94657 4.02794 9.15811 3.99725 9.53369C3.96594 9.91718 3.96503 10.4107 3.96503 11.1216V13.9546C3.96503 14.6656 3.96592 15.159 3.99725 15.5425C4.02796 15.9182 4.08471 16.1296 4.16522 16.2876L4.23554 16.4136C4.41185 16.7012 4.66472 16.9353 4.96698 17.0894L5.09686 17.146C5.24061 17.1974 5.43024 17.2343 5.7121 17.2573C6.09562 17.2887 6.58895 17.2896 7.29999 17.2896H10.133C10.8439 17.2896 11.3374 17.2886 11.7209 17.2573C12.0965 17.2266 12.308 17.1698 12.466 17.0894L12.593 17.019C12.8804 16.8427 13.1148 16.5897 13.2687 16.2876L13.3244 16.1577C13.3759 16.0139 13.4137 15.8244 13.4367 15.5425C13.468 15.159 13.468 14.6656 13.468 13.9546V11.1216ZM14.798 13.1196C15.2528 13.118 15.6011 13.1147 15.8879 13.0913C16.2634 13.0606 16.475 13.0038 16.633 12.9233L16.759 12.8521C17.0466 12.6757 17.2808 12.4228 17.4348 12.1206L17.4914 11.9907C17.5428 11.847 17.5797 11.6572 17.6027 11.3755C17.634 10.992 17.6349 10.4985 17.6349 9.7876V6.95459C17.6349 6.24355 17.6341 5.75022 17.6027 5.3667C17.5797 5.08484 17.5428 4.89522 17.4914 4.75147L17.4348 4.62158C17.2807 4.31933 17.0466 4.06645 16.759 3.89014L16.633 3.81982C16.475 3.73932 16.2636 3.68256 15.8879 3.65186C15.5044 3.62052 15.011 3.61963 14.3 3.61963H11.467C10.7561 3.61963 10.2626 3.62054 9.87909 3.65186C9.59738 3.67487 9.40759 3.71179 9.26386 3.76318L9.13397 3.81982C8.83175 3.97382 8.57885 4.20802 8.40253 4.49561L8.33124 4.62158C8.25079 4.77957 8.19396 4.99114 8.16327 5.3667C8.13984 5.65352 8.13561 6.00178 8.13397 6.45654H10.133C10.822 6.45654 11.3791 6.4559 11.8293 6.49268C12.2873 6.5301 12.6937 6.6093 13.0705 6.80127L13.2883 6.92334C13.7839 7.22739 14.1878 7.66313 14.4533 8.18408L14.5197 8.32666C14.6642 8.66318 14.7291 9.02433 14.7619 9.42529C14.7987 9.8755 14.798 10.4326 14.798 11.1216V13.1196ZM18.965 9.7876C18.965 10.4766 18.9657 11.0337 18.9289 11.4839C18.8961 11.8848 18.8311 12.246 18.6867 12.5825L18.6203 12.7251C18.3548 13.246 17.9509 13.6818 17.4553 13.9858L17.2365 14.1079C16.8599 14.2998 16.4541 14.3791 15.9963 14.4165C15.6592 14.444 15.2624 14.4481 14.7951 14.4497C14.7935 14.917 14.7894 15.3138 14.7619 15.6509C14.7292 16.0516 14.664 16.4122 14.5197 16.7485L14.4533 16.8911C14.1878 17.4122 13.7841 17.8487 13.2883 18.1528L13.0705 18.2749C12.6937 18.4669 12.2873 18.5461 11.8293 18.5835C11.3791 18.6203 10.822 18.6196 10.133 18.6196H7.29999C6.6109 18.6196 6.05394 18.6203 5.6037 18.5835C5.20305 18.5508 4.84233 18.4855 4.50604 18.3413L4.36347 18.2749C3.84243 18.0094 3.40584 17.6056 3.10175 17.1099L2.97968 16.8911C2.78787 16.5145 2.70849 16.1087 2.67108 15.6509C2.6343 15.2006 2.63495 14.6437 2.63495 13.9546V11.1216C2.63495 10.4326 2.63431 9.8755 2.67108 9.42529C2.7085 8.96729 2.78771 8.56084 2.97968 8.18408L3.10175 7.96631C3.40585 7.47049 3.84235 7.06679 4.36347 6.80127L4.50604 6.73486C4.84236 6.59059 5.20302 6.52542 5.6037 6.49268C5.9405 6.46516 6.33707 6.4601 6.80389 6.4585C6.8055 5.99167 6.81056 5.5951 6.83807 5.2583C6.87549 4.80047 6.95482 4.39471 7.14667 4.01807L7.26874 3.79932C7.5728 3.30371 8.00855 2.89973 8.52948 2.63428L8.67206 2.56787C9.00854 2.42345 9.36978 2.35844 9.77069 2.32568C10.2209 2.28891 10.778 2.28955 11.467 2.28955H14.3C14.9891 2.28955 15.546 2.2889 15.9963 2.32568C16.4541 2.3631 16.8599 2.44247 17.2365 2.63428L17.4553 2.75635C17.951 3.06044 18.3548 3.49703 18.6203 4.01807L18.6867 4.16065C18.8309 4.49694 18.8962 4.85765 18.9289 5.2583C18.9657 5.70854 18.965 6.2655 18.965 6.95459V9.7876Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CodexCheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 17 17"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M12.8961 3.64101C13.1297 3.41418 13.4984 3.37523 13.7779 3.56581C14.0571 3.75635 14.1554 4.11331 14.0299 4.41347L13.9615 4.53847L7.71151 13.7045C7.59411 13.8767 7.4063 13.9877 7.19881 14.0072C6.99136 14.0267 6.78564 13.9533 6.63826 13.806L2.88826 10.056L2.79842 9.9457C2.6192 9.67407 2.64927 9.30496 2.88826 9.06581C3.12738 8.82669 3.49647 8.79676 3.76815 8.97597L3.8785 9.06581L7.03084 12.2182L12.8053 3.74941L12.8961 3.64101Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ThinkingPlaceholder() {
  const { t } = useTranslation();
  // The waiting gap (before any activity arrives) is the one spot in the
  // thread quiet AND large enough for the mascot to stay legible — a gentle
  // 26px bobbing rice grain, never squeezed into 12px icon slots.
  return (
    <div className="flex min-w-0 justify-start" aria-live="polite" aria-busy="true">
      <div className="agent-thinking-placeholder inline-flex max-w-full min-w-0 items-center gap-2 overflow-hidden text-[13px] font-normal text-text-ink/55">
        <Memmy pose="think" size={26} className="agent-thinking-placeholder__mascot shrink-0" />
        <span className="min-w-0 truncate">{t("agent.message.thinking")}</span>
      </div>
    </div>
  );
}

function shouldShowThinkingPlaceholder(messages: AgentChatMessage[], isSending: boolean | undefined): boolean {
  if (!isSending) {
    return false;
  }

  if (hasCurrentTurnRunningContextCompaction(messages)) {
    return false;
  }

  const lastUserIndex = findLastMessageIndex(messages, "user");

  // If the current turn already has any activity/reasoning/tool trace showing,
  // an activity cluster header already renders "Thinking" — do not stack a
  // duplicate placeholder below it. Context-compaction dividers are separate
  // affordances and never suppress the placeholder here.
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.kind === "context_compaction") {
      continue;
    }
    if (message.role === "assistant" && message.kind !== "trace") {
      if (message.content.trim() || message.media?.length) {
        return false;
      }
      if (message.reasoning || message.reasoningStreaming || message.isStreaming) {
        return false;
      }
    }
    if (message.kind === "trace" || message.role === "tool") {
      return false;
    }
  }

  return true;
}

function hasCurrentTurnRunningContextCompaction(messages: AgentChatMessage[]): boolean {
  const lastUserIndex = findLastMessageIndex(messages, "user");
  return messages.some((message, index) => (
    index > lastUserIndex
    && message.kind === "context_compaction"
    && contextCompactionStatus(message) === "running"
  ));
}

function findLastMessageIndex(messages: AgentChatMessage[], role: AgentChatMessage["role"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

function mediaAttachmentKey(item: AgentChatMediaAttachment, index: number): string {
  return item.path ?? item.url ?? item.name ?? `${item.kind}-${index}`;
}

function attachmentDisplayName(item: AgentChatMediaAttachment): string {
  const value = item.name ?? item.path ?? item.url ?? "attachment";
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  return withoutQuery.split(/[\\/]/).pop() || value;
}

function UserMediaPreviewGrid(props: {
  media: AgentChatMediaAttachment[];
  artifactClient?: AgentArtifactClient | null;
}) {
  const images = props.media.filter((item) => item.kind === "image" && item.url);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const imageMenu = useChatImageContextMenu();
  return (
    <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-2">
      {images.map((item, index) => (
        <UserImageCell
          key={mediaAttachmentKey(item, index)}
          item={item}
          onOpen={() => setLightboxIndex(index)}
          onContextMenu={imageMenu.open}
        />
      ))}
      {props.media.map((item, index) => {
        if (item.kind === "image" && item.url) return null;
        if (item.kind === "video" && item.url) {
          return <AssistantVideoCell key={mediaAttachmentKey(item, index)} item={item} />;
        }
        return (
          <UserFileAttachmentCell
            key={mediaAttachmentKey(item, index)}
            item={item}
            artifactClient={props.artifactClient}
          />
        );
      })}
      {lightboxIndex == null ? null : (
        <ChatImageLightbox
          images={images.map((item) => ({ url: item.url!, name: item.name }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      {imageMenu.menu ? (
        <ChatImageContextMenu
          menu={imageMenu.menu}
          onStatusChange={imageMenu.setStatus}
          onClose={imageMenu.close}
        />
      ) : null}
    </div>
  );
}

function UserFileAttachmentCell(props: {
  item: AgentChatMediaAttachment;
  artifactClient?: AgentArtifactClient | null;
}) {
  const [actionState, setActionState] = useState<"idle" | "working" | "error">("idle");
  const [copiedTarget, setCopiedTarget] = useState<AttachmentCopyTarget | null>(null);
  const { t } = useTranslation();
  const label = attachmentDisplayName(props.item);
  const extensionLabel = splitAgentAttachmentName(label).extensionLabel;

  const handleAttachmentAction = async () => {
    if (actionState === "working") return;
    setActionState("working");
    setCopiedTarget(null);
    const result = await runAttachmentAction({
      path: props.item.path,
      url: props.item.url,
      name: props.item.name,
      label,
      artifactClient: props.artifactClient,
    });
    setActionState(result === "failed" ? "error" : "idle");
  };

  const handleCopy = async (target: AttachmentCopyTarget, value: string) => {
    const copied = await writeClipboardText(value);
    if (copied) setCopiedTarget(target);
  };

  return (
    <span className="inline-flex max-w-full min-w-0 flex-col items-end" data-testid="user-file-attachment">
      <AgentAttachmentCard
        kind="file"
        name={label}
        subline={extensionLabel}
        title={props.item.path ?? props.item.name ?? props.item.url ?? undefined}
        onClick={() => void handleAttachmentAction()}
        disabled={actionState === "working"}
        busyLabel={t("agent.attachment.opening")}
        error={actionState === "error"}
        align="right"
      />
      {actionState === "error" ? (
        <AttachmentActionError path={props.item.path} url={props.item.url} copiedTarget={copiedTarget} onCopy={(target, value) => void handleCopy(target, value)} />
      ) : null}
    </span>
  );
}

function UserImageCell(props: {
  item: AgentChatMediaAttachment;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, image: ChatImageActionTarget) => void;
}) {
  const image = imageTargetFromMedia(props.item);
  return (
    <AgentAttachmentCard
      kind="image"
      name={props.item.name ?? "image"}
      previewUrl={props.item.url}
      subline={splitAgentAttachmentName(props.item.name ?? props.item.url ?? "image").extensionLabel}
      onClick={props.onOpen}
      onContextMenu={(event) => props.onContextMenu(event, image)}
      onKeyDown={(event) => handleImageCopyShortcut(event, image)}
      title={props.item.name ?? "Open image"}
      align="right"
    />
  );
}

function AssistantMediaAttachmentList(props: {
  media: AgentChatMediaAttachment[];
  artifactClient?: AgentArtifactClient | null;
}) {
  const images = props.media.filter((item) => item.kind === "image" && item.url);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const imageMenu = useChatImageContextMenu();
  return (
    <div className="mt-3 space-y-3">
      {images.length ? (
        <div className="flex max-w-full flex-col items-start gap-3">
          {images.map((item, index) => (
            <AssistantImageCell
              key={mediaAttachmentKey(item, index)}
              item={item}
              onOpen={() => setLightboxIndex(index)}
              onContextMenu={imageMenu.open}
            />
          ))}
        </div>
      ) : null}
      {props.media.map((item, index) => {
        if (item.kind === "image" && item.url) return null;
        if (item.kind === "video" && item.url) {
          return <AssistantVideoCell key={mediaAttachmentKey(item, index)} item={item} />;
        }
        return <StructuredMediaAttachment key={mediaAttachmentKey(item, index)} item={item} artifactClient={props.artifactClient} />;
      })}
      {lightboxIndex == null ? null : (
        <ChatImageLightbox
          images={images.map((item) => ({ url: item.url!, name: item.name }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      {imageMenu.menu ? (
        <ChatImageContextMenu
          menu={imageMenu.menu}
          onStatusChange={imageMenu.setStatus}
          onClose={imageMenu.close}
        />
      ) : null}
    </div>
  );
}

function AssistantImageCell(props: {
  item: AgentChatMediaAttachment;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, image: ChatImageActionTarget) => void;
}) {
  const image = imageTargetFromMedia(props.item);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      onContextMenu={(event) => props.onContextMenu(event, image)}
      onKeyDown={(event) => handleImageCopyShortcut(event, image)}
      className="block overflow-hidden rounded-[20px] border-0 bg-canvas-oat/35 p-0 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-action-sky/35 cursor-zoom-in"
      style={ASSISTANT_IMAGE_FRAME_STYLE}
      aria-label={props.item.name ?? "Open image"}
    >
      <img
        src={props.item.url}
        alt={props.item.name ?? ""}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="block"
        style={ASSISTANT_IMAGE_STYLE}
      />
    </button>
  );
}

function AssistantVideoCell(props: { item: AgentChatMediaAttachment }) {
  return (
    <figure className="mt-3 overflow-hidden rounded-[16px] bg-black shadow-sm" style={LEGACY_VIDEO_FRAME_STYLE}>
      <video
        src={props.item.url}
        controls
        preload="metadata"
        className="block bg-black"
        style={LEGACY_VIDEO_STYLE}
      />
      {props.item.name ? (
        <figcaption className="bg-background-paper px-3 py-1.5 text-xs text-text-ink/55">{props.item.name}</figcaption>
      ) : null}
    </figure>
  );
}

export function ChatImageLightbox(props: {
  images: ChatImageActionTarget[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const imageMenu = useChatImageContextMenu();
  const current = props.images[props.index] ?? props.images[0] ?? null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      } else if (event.key === "ArrowLeft") {
        props.onIndexChange((props.index - 1 + props.images.length) % props.images.length);
      } else if (event.key === "ArrowRight") {
        props.onIndexChange((props.index + 1) % props.images.length);
      } else if (current && isImageCopyKeyboardEvent(event) && !hasSelectedText()) {
        event.preventDefault();
        void copyImageToClipboard(current);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [current, props]);

  if (typeof document === "undefined" || !current) {
    return null;
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
      onClick={props.onClose}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
        className={CHAT_IMAGE_LIGHTBOX_CLOSE_BUTTON_CLASS}
        style={WINDOW_CONTROLS_OVERLAY_SAFE_TOP_STYLE}
      >
        <X size={18} aria-hidden="true" />
      </button>
      {props.images.length > 1 ? (
        <button
          type="button"
          aria-label="Previous image"
          onClick={(event) => {
            event.stopPropagation();
            props.onIndexChange((props.index - 1 + props.images.length) % props.images.length);
          }}
          className={CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS + " left-4"}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
      ) : null}
      <div
        className="relative max-w-full"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => imageMenu.open(event, current)}
      >
        <img
          src={current.url}
          alt={current.name ?? ""}
          className="block rounded-[18px] object-contain shadow-2xl"
          style={{ maxWidth: "calc(100vw - 64px)", maxHeight: "calc(100vh - 120px)" }}
          draggable={false}
        />
      </div>
      {imageMenu.menu ? (
        <ChatImageContextMenu
          menu={imageMenu.menu}
          onStatusChange={imageMenu.setStatus}
          onClose={imageMenu.close}
        />
      ) : null}
      {props.images.length > 1 ? (
        <button
          type="button"
          aria-label="Next image"
          onClick={(event) => {
            event.stopPropagation();
            props.onIndexChange((props.index + 1) % props.images.length);
          }}
          className={CHAT_IMAGE_LIGHTBOX_NAV_BUTTON_CLASS + " right-4"}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      ) : null}
    </div>,
    document.body
  );
}

function useChatImageContextMenu(): {
  menu: ChatImageContextMenuState | null;
  open: (event: MouseEvent<HTMLElement>, image: ChatImageActionTarget) => void;
  close: () => void;
  setStatus: (status: ImageMenuStatus) => void;
} {
  const [menu, setMenu] = useState<ChatImageContextMenuState | null>(null);

  useEffect(() => {
    if (!menu || typeof document === "undefined") {
      return undefined;
    }
    const close = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  return {
    menu,
    open(event, image) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, image, status: "idle" });
    },
    close() {
      setMenu(null);
    },
    setStatus(status) {
      setMenu((current) => current ? { ...current, status } : current);
    }
  };
}

function ChatImageContextMenu(props: {
  menu: ChatImageContextMenuState;
  onStatusChange: (status: ImageMenuStatus) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  if (typeof document === "undefined") {
    return null;
  }

  const position = contextMenuPosition(props.menu);
  const copyLabel =
    props.menu.status === "copying"
      ? t("agent.image.copying")
      : props.menu.status === "copied"
        ? t("agent.image.copied")
        : t("agent.image.copy");
  const downloadLabel = props.menu.status === "saving" ? t("agent.image.saving") : t("agent.image.download");
  const busy = props.menu.status === "copying" || props.menu.status === "saving";

  const handleDownload = async () => {
    if (busy) {
      return;
    }
    props.onStatusChange("saving");
    const result = await saveImageToFile(props.menu.image);
    if (result === "failed") {
      props.onStatusChange("save-error");
      return;
    }
    props.onClose();
  };

  const handleCopy = async () => {
    if (busy) {
      return;
    }
    props.onStatusChange("copying");
    const copied = await copyImageToClipboard(props.menu.image);
    props.onStatusChange(copied ? "copied" : "copy-error");
    if (copied) {
      closeTimerRef.current = setTimeout(props.onClose, IMAGE_CONTEXT_MENU_CLOSE_MS);
    }
  };

  return createPortal(
    <div
      role="menu"
      aria-label={t("agent.image.menu")}
      className="agent-image-context-menu"
      style={{ left: position.left, top: position.top }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className="agent-image-context-menu__item"
        onClick={() => void handleDownload()}
        disabled={busy}
      >
        {downloadLabel}
      </button>
      <button
        type="button"
        role="menuitem"
        className="agent-image-context-menu__item"
        onClick={() => void handleCopy()}
        disabled={busy}
      >
        {copyLabel}
      </button>
      {props.menu.status === "copy-error" || props.menu.status === "save-error" ? (
        <span className="agent-image-context-menu__error">{props.menu.status === "save-error" ? t("agent.image.saveFailed") : t("agent.image.copyFailed")}</span>
      ) : null}
    </div>,
    document.body
  );
}

type ImageSaveStatus = "saved" | "canceled" | "failed";

export async function saveImageToFile(input: ChatImageActionTarget & {
  startDownload?: AttachmentDownloadStarter;
}): Promise<ImageSaveStatus> {
  const desktopSaveImage = !input.startDownload && typeof window !== "undefined" ? window.memmy?.saveImage : undefined;
  if (desktopSaveImage) {
    try {
      // The renderer shares same-origin auth with the displayed image, so fetch the bytes first and hand them to the main process to write to disk, avoiding the 401 the main process would hit accessing gateway media.
      const bytes = await fetchDesktopImageBytes(input.url);
      const result = await desktopSaveImage(bytes
        ? { url: input.url, name: input.name, data: bytes.data, mime: bytes.mime }
        : { url: input.url, name: input.name });
      return result.canceled ? "canceled" : "saved";
    } catch {
      return "failed";
    }
  }

  const downloaded = (input.startDownload ?? startBrowserDownload)(input.url, imageDownloadName(input));
  return downloaded ? "saved" : "failed";
}

async function fetchDesktopImageBytes(url: string): Promise<{ data: Uint8Array; mime?: string } | null> {
  if (typeof fetch !== "function" || !url) {
    return null;
  }
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      return null;
    }
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) {
      return null;
    }
    return {
      data: new Uint8Array(buffer),
      mime: clipboardImageMime(response.headers.get("content-type") ?? undefined) ?? undefined
    };
  } catch {
    return null;
  }
}

export async function copyImageToClipboard(input: ChatImageActionTarget & {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  clipboard?: ClipboardWriter;
  clipboardItemCtor?: ClipboardItemConstructor;
}): Promise<boolean> {
  const desktopCopyImage = !input.fetcher && !input.clipboard && !input.clipboardItemCtor && typeof window !== "undefined"
    ? window.memmy?.copyImageToClipboard
    : undefined;
  if (desktopCopyImage) {
    try {
      // Prefer fetching the bytes in the renderer and handing them to the main process to write the system clipboard; the main process hitting gateway media directly would 401.
      const bytes = await fetchDesktopImageBytes(input.url);
      await desktopCopyImage(bytes
        ? { url: input.url, name: input.name, data: bytes.data, mime: bytes.mime }
        : { url: input.url, name: input.name });
      return true;
    } catch {
      return false;
    }
  }

  const fetcher = input.fetcher ?? (typeof fetch === "function" ? fetch : undefined);
  const clipboard = input.clipboard ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
  const ClipboardItemCtor = input.clipboardItemCtor ?? (typeof ClipboardItem === "undefined" ? undefined : ClipboardItem);
  if (!fetcher || !clipboard?.write || !ClipboardItemCtor) {
    return false;
  }

  try {
    const response = await fetcher(input.url, { credentials: "include" });
    if (!response.ok) {
      return false;
    }
    const blob = await response.blob();
    const mime = clipboardImageMime(blob.type) ?? imageMimeFromName(input.name);
    if (!mime || (ClipboardItemCtor.supports && !ClipboardItemCtor.supports(mime))) {
      return false;
    }
    const clipboardBlob = blob.type === mime ? blob : blob.slice(0, blob.size, mime);
    await clipboard.write([new ClipboardItemCtor({ [mime]: clipboardBlob })]);
    return true;
  } catch {
    return false;
  }
}

function imageTargetFromMedia(item: AgentChatMediaAttachment): ChatImageActionTarget {
  return { url: item.url ?? "", name: item.name };
}

function imageDownloadName(image: ChatImageActionTarget): string {
  const raw = image.name || image.url.split(/[?#]/u)[0]?.split(/[\\/]/u).pop() || "image";
  return /\.[a-z0-9]{2,5}$/iu.test(raw) ? raw : `${raw}.png`;
}

function clipboardImageMime(type: string | undefined): string | null {
  const mime = String(type ?? "").split(";")[0]?.trim().toLowerCase();
  return mime?.startsWith("image/") ? mime : null;
}

function imageMimeFromName(name: string | undefined): string | null {
  const extension = name?.split(/[?#]/u)[0]?.toLowerCase().match(/\.(png|jpe?g|webp|gif)$/u)?.[1];
  if (!extension) return null;
  if (extension === "jpg") return "image/jpeg";
  return `image/${extension}`;
}

function contextMenuPosition(menu: ChatImageContextMenuState): { left: number; top: number } {
  if (typeof window === "undefined") {
    return { left: menu.x, top: menu.y };
  }
  return {
    left: Math.max(IMAGE_CONTEXT_MENU_MARGIN, Math.min(menu.x, window.innerWidth - IMAGE_CONTEXT_MENU_WIDTH - IMAGE_CONTEXT_MENU_MARGIN)),
    top: Math.max(IMAGE_CONTEXT_MENU_MARGIN, Math.min(menu.y, window.innerHeight - IMAGE_CONTEXT_MENU_HEIGHT - IMAGE_CONTEXT_MENU_MARGIN))
  };
}

function handleImageCopyShortcut(event: ReactKeyboardEvent<HTMLElement>, image: ChatImageActionTarget) {
  if (!isImageCopyKeyboardEvent(event) || hasSelectedText()) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void copyImageToClipboard(image);
}

function isImageCopyKeyboardEvent(event: Pick<KeyboardEvent | ReactKeyboardEvent<HTMLElement>, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c";
}

function hasSelectedText(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(window.getSelection()?.toString());
}

function StructuredMediaAttachment(props: {
  item: AgentChatMediaAttachment;
  artifactClient?: AgentArtifactClient | null;
  tone?: "assistant" | "user";
}) {
  const [actionState, setActionState] = useState<"idle" | "working" | "error">("idle");
  const [copiedTarget, setCopiedTarget] = useState<AttachmentCopyTarget | null>(null);
  const { t } = useTranslation();
  const label = attachmentDisplayName(props.item);
  const extensionLabel = splitAgentAttachmentName(label).extensionLabel;
  const handleAttachmentAction = async () => {
    if (actionState === "working") return;
    setActionState("working");
    setCopiedTarget(null);
    const result = await runAttachmentAction({
      path: props.item.path,
      url: props.item.url,
      name: props.item.name,
      label,
      artifactClient: props.artifactClient,
    });
    setActionState(result === "failed" ? "error" : "idle");
  };

  const handleCopy = async (target: AttachmentCopyTarget, value: string) => {
    const copied = await writeClipboardText(value);
    if (copied) setCopiedTarget(target);
  };

  return (
    <span className="inline-flex max-w-full min-w-0 flex-col items-start overflow-hidden">
      <AgentAttachmentCard
        kind="file"
        name={label}
        subline={extensionLabel}
        title={props.item.path ?? props.item.name ?? props.item.url ?? undefined}
        onClick={() => void handleAttachmentAction()}
        disabled={actionState === "working"}
        busyLabel={t("agent.attachment.opening")}
        error={actionState === "error"}
        align={props.tone === "user" ? "right" : "left"}
      />
      {actionState === "error" ? (
        <AttachmentActionError path={props.item.path} url={props.item.url} copiedTarget={copiedTarget} onCopy={(target, value) => void handleCopy(target, value)} />
      ) : null}
    </span>
  );
}

function AgentActivityCluster(props: {
  activityKey: string;
  bodyId: string;
  messages: AgentChatMessage[];
  isRunning: boolean;
  stoppedByUser: boolean;
  open: boolean;
  onToggle: () => void;
  artifactClient?: AgentArtifactClient | null;
}) {
  const { t } = useTranslation();
  const segments = useMemo(() => buildActivitySegments(props.messages, t), [props.messages, t]);
  const headerLabel = activityHeaderLabel(props.messages, props.isRunning, props.stoppedByUser, t);
  const Chevron = props.open ? ChevronDown : ChevronRight;

  return (
    <div className={`agent-activity-cluster flex min-w-0 justify-start${props.isRunning ? " agent-activity-cluster--running" : ""}${props.open ? " agent-activity-cluster--open" : ""}`}>
      <div className="min-w-0 w-full">
        <button
          type="button"
          aria-expanded={props.open}
          aria-controls={props.bodyId}
          data-activity-key={props.activityKey}
          onClick={props.onToggle}
          className="agent-activity-cluster__toggle inline-flex max-w-full min-w-0 cursor-pointer list-none items-center gap-1.5 text-left text-[13px] font-normal text-text-ink/55"
        >
          <span className="min-w-0 truncate">{headerLabel}</span>
          <Chevron data-icon={props.open ? "chevron-down" : "chevron-right"} size={12} className="shrink-0 text-text-ink/40" />
        </button>
        {props.open && (
          <div id={props.bodyId} className="agent-activity-cluster__body min-w-0">
            {/* Segments preserve chronological order (thought → tool-group →
                draft → ...) inside ONE collapsible body per process run,
                matching Cursor's "Worked for Xm" wrapper: while the turn runs
                everything reads in place with its own natural style (thoughts
                muted, tool rows one-liners, drafts in answer typography); when
                the turn ends the single header folds the whole run. Superseded
                thoughts and tool groups auto-fold to one line as the loop
                moves past them — nothing is ever deleted. */}
            {segments.map((segment, index) => (
              <ActivitySegmentBlock
                key={segment.key}
                segment={segment}
                t={t}
                isLive={props.isRunning && index === segments.length - 1}
                isOnlySegment={segments.length === 1}
                artifactClient={props.artifactClient}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivitySegmentBlock(props: {
  segment: ActivitySegment;
  t: Translate;
  isLive?: boolean;
  isOnlySegment?: boolean;
  artifactClient?: AgentArtifactClient | null;
}) {
  const { segment } = props;
  if (segment.type === "thought") {
    return <ThoughtSegmentBlock text={segment.text} isLive={props.isLive === true} isOnlySegment={props.isOnlySegment === true} t={props.t} />;
  }
  if (segment.type === "narration") {
    return <NarrationSegmentBlock text={segment.text} isLive={props.isLive === true} artifactClient={props.artifactClient} />;
  }
  return <ToolGroupSegmentBlock segment={segment} t={props.t} isLive={props.isLive === true} />;
}

/**
 * Thought prose flows in full while it is the live step; once the loop moves
 * past it in a multi-segment run, it folds to the one-line "Thought briefly"
 * row. A single thought reuses the cluster toggle instead of nesting a second
 * identical control.
 */
function ThoughtSegmentBlock(props: { text: string; isLive: boolean; isOnlySegment: boolean; t: Translate }) {
  const followAlong = useFollowAlongOpen(props.isLive);
  const open = props.isOnlySegment || followAlong.open;
  const showToggle = !props.isOnlySegment && (!props.isLive || !open);
  return (
    <div className="agent-activity-segment agent-activity-segment--thought">
      {showToggle ? (
        <button
          type="button"
          aria-expanded={open}
          className="agent-narration-block__toggle"
          onClick={() => followAlong.onToggle(!open)}
        >
          <span className="agent-narration-block__label">{props.t("agent.activity.thoughtBriefly")}</span>
          {open
            ? <ChevronDown size={12} aria-hidden="true" className="agent-narration-block__chevron" />
            : <ChevronRight size={12} aria-hidden="true" className="agent-narration-block__chevron" />}
        </button>
      ) : null}
      {open ? (
        <div className="agent-activity-segment__body">
          <ReasoningMarkdown text={props.text} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Follow-along expansion: a segment is expanded while it is the turn's live
 * (latest) step, then auto-collapses once a newer segment supersedes it —
 * unless the user has toggled it manually. This mirrors the cluster-level
 * auto-collapse behavior so the running turn reads top-down like Cursor:
 * current step open, past steps folded to one line.
 */
function useFollowAlongOpen(isLive: boolean): { open: boolean; onToggle: (next: boolean) => void } {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const wasLiveRef = useRef(isLive);

  useEffect(() => {
    if (wasLiveRef.current && !isLive) {
      setManualOpen(null);
    }
    wasLiveRef.current = isLive;
  }, [isLive]);

  return {
    open: manualOpen ?? isLive,
    onToggle: (next: boolean) => setManualOpen(next)
  };
}

const NARRATION_COLLAPSE_MIN_CHARS = 420;
const NARRATION_COLLAPSE_MIN_LINES = 7;

/**
 * Cumulative progress reports (the agent rewriting its whole plan each round)
 * are the only drafts worth folding — short transitional lines must stay
 * readable in place, because collapsing text the user just read is far more
 * jarring than the few lines it saves.
 */
function isLongNarration(text: string): boolean {
  return text.length > NARRATION_COLLAPSE_MIN_CHARS || text.split("\n").length > NARRATION_COLLAPSE_MIN_LINES;
}

/**
 * A mid-turn draft, rendered exactly where and how it streamed: full answer
 * typography, no dimming, no movement while it is the live step. Long drafts
 * (the agent writing half an answer, then abandoning it for more tool work)
 * fold only AFTER the loop moves past them — same follow-along rhythm as
 * thoughts, so text never collapses while the user is still reading it. The
 * fold row is nothing but the draft's own first line: no badges, no meta
 * commentary — the content speaks for itself.
 */
function NarrationSegmentBlock(props: { text: string; isLive: boolean; artifactClient?: AgentArtifactClient | null }) {
  const { open: followOpen, onToggle } = useFollowAlongOpen(props.isLive);
  const long = isLongNarration(props.text);
  const open = !long || followOpen;
  return (
    <div className="agent-activity-segment agent-activity-segment--narration">
      {long && !props.isLive && !open ? (
        // Collapsed: the draft's own first line is the whole affordance. Once
        // expanded there is NO residual header row — the prose stands alone
        // (fold the whole "Worked for" cluster to tuck it away again).
        <button
          type="button"
          aria-expanded={false}
          className="agent-narration-block__toggle"
          onClick={() => onToggle(true)}
        >
          <span className="agent-narration-block__preview">{narrationPreviewLine(props.text)}</span>
          <ChevronRight size={12} aria-hidden="true" className="agent-narration-block__chevron" />
        </button>
      ) : null}
      {open ? (
        <AgentMessageContent content={props.text} artifactClient={props.artifactClient} />
      ) : null}
    </div>
  );
}

function narrationPreviewLine(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const plain = firstLine.replace(/[*_#>`]/gu, "").trim();
  return plain || "…";
}

function ToolGroupSegmentBlock(props: { segment: ActivityToolGroupSegment; t: Translate; isLive: boolean }) {
  const { segment } = props;
  const { open, onToggle } = useFollowAlongOpen(props.isLive);
  const content = (
    <div className="agent-activity-segment__items">
      {segment.items.map((item) => {
        if (item.type === "context") {
          return <ActivityContextLine key={item.key} text={item.text} />;
        }
        if (item.type === "toolStep") {
          return <TraceLine key={item.key} item={item} t={props.t} />;
        }
        return <FileEditLine key={item.key} edit={item.edit} t={props.t} />;
      })}
    </div>
  );

  if (segment.items.length <= 1) {
    // A group header exists to summarize and collapse MANY steps. For a single
    // step the row itself is the summary (icon + verb + detail + its own
    // expandable details), so a header above it would just duplicate the row.
    return (
      <div className="agent-activity-segment agent-activity-segment--tool-group">
        {content}
      </div>
    );
  }

  return (
    <details
      className="agent-activity-segment agent-activity-segment--tool-group agent-activity-tool-group-details"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) onToggle(next);
      }}
    >
      <summary className="agent-activity-tool-group-details__summary">
        <ToolGroupSegmentLabel segment={segment} />
        <ChevronRight size={12} aria-hidden="true" className="agent-activity-tool-group-details__chevron" />
      </summary>
      <div className="agent-activity-tool-group-details__body">
        {content}
      </div>
    </details>
  );
}

/**
 * Icon policy, one rule: fold/meta rows (cluster header, thought label, group
 * summaries, draft previews) are plain text; only concrete action rows (each
 * tool call / file edit) carry a category icon. Icons mark real actions.
 */
function ToolGroupSegmentLabel(props: { segment: ActivityToolGroupSegment }) {
  const { segment } = props;
  return (
      <p className="agent-activity-segment__label">
        <span>{segment.label}</span>
        {segment.added > 0 || segment.deleted > 0 ? (
          <span className="agent-activity-diff ml-2 inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
            {segment.added > 0 ? <span className="text-status-success">+{segment.added}</span> : null}
            {segment.deleted > 0 ? <span className="text-status-error">-{segment.deleted}</span> : null}
          </span>
        ) : null}
      </p>
  );
}

/**
 * Expanded tool payload. The clickable row above is already the summary, so
 * the card only shows raw input/output as one bordered code card — arguments
 * dimmed, result normal, errors tinted — with no form labels. This single
 * generic shape works for any tool, however exotic its payload.
 */
function ToolDetailRows(props: { item: ActivityToolStepItem }) {
  const sections = props.item.details.filter((detail) => detail.value.trim().length > 0);
  if (!sections.length) {
    return null;
  }
  return (
    <div className="agent-activity-tool-card">
      {sections.map((detail, index) => (
        <div
          key={`${detail.label}:${index}`}
          data-detail={detail.label.toLowerCase()}
          className={`agent-activity-tool-card__section${detail.tone === "error" ? " agent-activity-tool-card__section--error" : ""}`}
        >
          <pre className="agent-activity-tool-card__value">{detail.value}</pre>
        </div>
      ))}
    </div>
  );
}

function clusterHasToolActivity(messages: AgentChatMessage[]): boolean {
  return messages.some((message) => (
    Boolean(message.toolEvents?.length)
    || Boolean(message.fileEdits?.length)
    || (message.kind === "trace" && Boolean(message.traces?.length))
    // Drafts are produced work, not just thinking — a run containing them
    // reads "Worked for Xs", never "Thought for Xs".
    || message.kind === "narration"
  ));
}

function activityHeaderLabel(
  messages: AgentChatMessage[],
  isRunning: boolean,
  stoppedByUser: boolean,
  t: Translate
): string {
  if (isRunning) {
    // "Thinking" is reserved for pure reasoning; as soon as the run contains
    // tools or drafts it is genuinely working, and the label says so.
    return clusterHasToolActivity(messages) ? t("agent.activity.working") : t("agent.activity.thinking");
  }
  if (stoppedByUser) {
    return t("agent.activity.stopped");
  }
  const hasToolActivity = clusterHasToolActivity(messages);
  const timestamps = messages
    .map((message) => message.createdAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const elapsedMs = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  if (elapsedMs < 1000) {
    return hasToolActivity ? t("agent.activity.workedBriefly") : t("agent.activity.thoughtBriefly");
  }
  const duration = formatActivityDuration(elapsedMs);
  return hasToolActivity ? t("agent.activity.workedFor", { duration }) : t("agent.activity.thoughtFor", { duration });
}

function formatActivityDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function ActivityContextLine(props: { text: string }) {
  return (
    <div className={`agent-activity-timeline-item agent-activity-timeline-item--thought ${ACTIVITY_CONTEXT_LINE_CLASS}`}>
      <ReasoningMarkdown text={props.text} />
    </div>
  );
}

const TRACE_CATEGORY_ICONS: Record<ToolTraceCategory, ComponentType<SVGProps<SVGSVGElement> & { size?: number }>> = {
  shell: Terminal,
  read: FileText,
  grep: Search,
  glob: Compass,
  list: ListTree,
  edit: Pencil,
  write: FilePlus2,
  delete: Trash2,
  search: Search,
  web: Globe,
  browser: Globe,
  task: FileCode2,
  mcp: Wand2,
  image: ImageIcon,
  notebook: Notebook,
  generic: Wand2
};

function TraceLine(props: { item: ActivityToolStepItem; t: Translate }) {
  void props.t;
  const phase = props.item.event.phase;
  const isError = phase === "error";
  const category = props.item.category;
  const Icon = TRACE_CATEGORY_ICONS[category] ?? Wand2;
  const summary = (
    <>
      <Icon size={13} aria-hidden="true" className="agent-activity-timeline-item__icon" />
      <div className="agent-activity-timeline-item__body">
        <p className="agent-activity-timeline-item__line">
          {props.item.verb ? <span className="agent-activity-timeline-item__verb">{props.item.verb}</span> : null}
          {props.item.detail ? <span className="agent-activity-timeline-item__detail">{props.item.detail}</span> : null}
        </p>
        {isError && props.item.event?.error != null && (
          <p className="agent-activity-timeline-item__error">{formatToolDetailValue(props.item.event.error)}</p>
        )}
      </div>
    </>
  );
  const className = `agent-activity-timeline-item agent-activity-timeline-item--tool agent-activity-timeline-item--${category}${isError ? " agent-activity-timeline-item--error" : ""}`;
  if (props.item.details.length > 0) {
    return (
      <details className={`${className} agent-activity-tool-details`}>
        <summary className="agent-activity-tool-details__summary">
          {summary}
          <ChevronRight size={12} aria-hidden="true" className="agent-activity-tool-details__chevron" />
        </summary>
        <ToolDetailRows item={props.item} />
      </details>
    );
  }
  return (
    <div className={className}>
      {summary}
    </div>
  );
}

function FileEditLine(props: { edit: AgentFileEdit; t: Translate }) {
  const status = props.edit.status ?? "editing";
  const isError = status === "error";
  const isDone = status === "done";
  const labelKey = isError ? "agent.activity.failed" : isDone ? "agent.activity.edited" : "agent.activity.editing";
  const target = props.edit.path || "pending file edit";
  const added = props.edit.added ?? 0;
  const deleted = props.edit.deleted ?? 0;
  const hasDiff = !props.edit.binary && (added > 0 || deleted > 0);
  return (
    <div className={`agent-activity-timeline-item agent-activity-timeline-item--file-edit agent-activity-timeline-item--edit${isError ? " agent-activity-timeline-item--error" : ""}`}>
      <Pencil size={13} aria-hidden="true" className="agent-activity-timeline-item__icon" />
      <div className="agent-activity-timeline-item__body">
        <p className="agent-activity-timeline-item__line">
          <span className="agent-activity-timeline-item__verb">{props.t(labelKey, { item: target })}</span>
          {hasDiff ? (
            <span className="agent-activity-diff ml-2 inline-flex items-center gap-1 whitespace-nowrap font-normal tabular-nums">
              {added > 0 ? <span className="text-status-success">+{added}</span> : null}
              {deleted > 0 ? <span className="text-status-error">-{deleted}</span> : null}
            </span>
          ) : null}
          {props.edit.binary ? <span className="ml-2 text-text-ink/40">binary</span> : null}
        </p>
        <p className="agent-activity-timeline__status sr-only">{status} · {props.edit.binary ? "binary" : `+${added} / -${deleted}`}</p>
        {props.edit.error && <p className="agent-activity-timeline-item__error">{props.edit.error}</p>}
      </div>
    </div>
  );
}

type ActivityRenderItem = ActivityContextItem | ActivityToolStepItem | ActivityFileEditItem;

interface ActivityContextItem {
  type: "context";
  source: "reasoning" | "content";
  text: string;
  key: string;
}

interface ActivityToolStepItem {
  type: "toolStep";
  line: string;
  verb: string;
  detail: string;
  category: ToolTraceCategory;
  event: AgentToolProgressEvent;
  details: ActivityToolDetail[];
  key: string;
}

interface ActivityToolDetail {
  label: string;
  value: string;
  tone?: "error";
}

interface ActivityFileEditItem {
  type: "fileEdit";
  edit: AgentFileEdit;
  key: string;
}

interface ActivityThoughtSegment {
  type: "thought";
  key: string;
  text: string;
}

/**
 * Mid-turn assistant draft (`kind: "narration"`): part of the per-run process
 * timeline, rendered verbatim in answer typography where it streamed.
 */
interface ActivityNarrationSegment {
  type: "narration";
  key: string;
  text: string;
}

interface ActivityToolGroupSegment {
  type: "toolGroup";
  key: string;
  label: string;
  added: number;
  deleted: number;
  items: ActivityRenderItem[];
}

type ActivitySegment = ActivityThoughtSegment | ActivityNarrationSegment | ActivityToolGroupSegment;

/**
 * Walk activity messages in chronological (arrival) order and emit alternating
 * "thought" / "tool group" segments — this is the concrete implementation of
 * Cursor's reasoning→tool→reasoning→tool alternation. Splitting the underlying
 * `AgentDisplayUnit` by category (an earlier, wrong approach) instead produced
 * a wall of disconnected collapsed headers; this keeps everything inside ONE
 * cluster body so the natural sequence reads as continuous prose.
 */
function buildActivitySegments(messages: AgentChatMessage[], t: Translate): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  messages.forEach((message, messageIndex) => {
    const messageKey = message.id || `message-${messageIndex}`;
    if (message.reasoning) {
      segments.push({ type: "thought", key: `${messageKey}:thought`, text: message.reasoning });
    }
    if (message.kind === "narration") {
      if (message.content.trim()) {
        segments.push({ type: "narration", key: `${messageKey}:narration`, text: message.content });
      }
      return;
    }
    const toolItems = traceRenderItemsForMessage(message, messageKey);
    const fileEditItems: ActivityFileEditItem[] = (message.fileEdits ?? []).map((edit, index) => ({
      type: "fileEdit",
      edit,
      key: `${messageKey}:file-edit:${edit.call_id}:${edit.path}:${index}`
    }));
    const items = [...toolItems, ...fileEditItems];
    if (items.length) {
      appendToolGroupSegment(segments, `${messageKey}:toolgroup`, items, t);
    }
  });
  return segments;
}

function appendToolGroupSegment(
  segments: ActivitySegment[],
  key: string,
  items: ActivityRenderItem[],
  t: Translate
): void {
  const previous = segments.at(-1);
  const mergedItems = previous?.type === "toolGroup" ? [...previous.items, ...items] : items;
  const summary = toolGroupLabel(mergedItems, t);
  if (previous?.type === "toolGroup") {
    previous.key = `${previous.key}+${key}`;
    previous.label = summary.text;
    previous.added = summary.added;
    previous.deleted = summary.deleted;
    previous.items = mergedItems;
    return;
  }
  segments.push({
    type: "toolGroup",
    key,
    label: summary.text,
    added: summary.added,
    deleted: summary.deleted,
    items
  });
}

const EXPLORE_TOOL_NAME_PATTERN = /^(read|grep|search|web_search|fetch|browse|list_dir|find|glob|ls|cat|view|look)/i;

function toolEventName(event: AgentToolProgressEvent): string {
  if (typeof event.name === "string" && event.name) return event.name;
  if (typeof event.function?.name === "string" && event.function.name) return event.function.name;
  return "";
}

function toolGroupLabel(items: ActivityRenderItem[], t: Translate): { text: string; added: number; deleted: number } {
  let edited = 0;
  let addedTotal = 0;
  let deletedTotal = 0;
  let explored = 0;
  let other = 0;
  for (const item of items) {
    if (item.type === "fileEdit") {
      edited += 1;
      addedTotal += item.edit.added ?? 0;
      deletedTotal += item.edit.deleted ?? 0;
      continue;
    }
    if (item.type === "toolStep") {
      if (EXPLORE_TOOL_NAME_PATTERN.test(toolEventName(item.event))) {
        explored += 1;
      } else {
        other += 1;
      }
    }
    // Plain "context" narration lines (no matched tool event) don't count
    // toward any step tally — they read as prose, not an action.
  }
  // Category labels only when the whole group IS that category — a mixed
  // group labeled "Explored 1 item" while holding 2 rows misreports the count.
  // Mixed groups always fall back to the total step tally.
  const total = edited + explored + other;
  if (edited > 0 && edited === total) {
    const text = edited === 1 ? t("agent.activity.group.editedOne") : t("agent.activity.group.edited", { count: edited });
    return { text, added: addedTotal, deleted: deletedTotal };
  }
  if (explored > 0 && explored === total) {
    const text = explored === 1 ? t("agent.activity.group.exploredOne") : t("agent.activity.group.explored", { count: explored });
    return { text, added: addedTotal, deleted: deletedTotal };
  }
  const countable = Math.max(total, 1);
  const text = countable === 1 ? t("agent.activity.stepsDoneOne") : t("agent.activity.stepsDone", { count: countable });
  return { text, added: addedTotal, deleted: deletedTotal };
}

function traceRenderItemsForMessage(message: AgentChatMessage, messageKey: string): ActivityRenderItem[] {
  const lines = traceLinesForActivity(message);
  const events = message.toolEvents ?? [];

  // When both traces (persisted human summaries) and structured toolEvents
  // (raw call payloads) are present, we prefer the structured events for the
  // visible text: `summarizeToolCall` turns raw `exec({"command": "echo ..."})`
  // into "Ran echo …", so this covers both live streams and older transcripts
  // that persisted the raw JSON. Traces without a matching event fall back to
  // their persisted string so we still surface something even if the event
  // stream was lost.
  if (lines.length) {
    const items: ActivityRenderItem[] = [];
    const usedEventIndexes = new Set<number>();
    for (const [lineIndex, line] of lines.entries()) {
      let matchedEventIndex = -1;
      for (let index = 0; index < events.length; index += 1) {
        if (usedEventIndexes.has(index)) continue;
        const event = events[index]!;
        const eventLine = formatToolCallTrace(event) ?? "";
        if (traceLineMatchesEvent(line, eventLine)) {
          matchedEventIndex = index;
          break;
        }
      }
      // Positional fallback so we don't lose the relationship for compactly
      // persisted JSON whose format no longer matches the new summariser.
      if (matchedEventIndex < 0 && events[lineIndex] && !usedEventIndexes.has(lineIndex)) {
        matchedEventIndex = lineIndex;
      }
      if (matchedEventIndex >= 0) {
        usedEventIndexes.add(matchedEventIndex);
        items.push(activityToolStepItem(messageKey, events[matchedEventIndex]!, matchedEventIndex, line));
      } else {
        items.push(legacyToolStepItem(messageKey, line, lineIndex) ?? activityContextItem(messageKey, "content", line, `content:${lineIndex}`));
      }
    }
    for (let index = 0; index < events.length; index += 1) {
      if (usedEventIndexes.has(index)) continue;
      items.push(activityToolStepItem(messageKey, events[index]!, index));
    }
    return items;
  }

  if (!events.length) {
    return [];
  }
  return events.map((event, index) => activityToolStepItem(messageKey, event, index));
}

function traceLineMatchesEvent(line: string, eventLine: string): boolean {
  if (line === eventLine) {
    return true;
  }
  return normalizeTraceLineForMatch(line) === normalizeTraceLineForMatch(eventLine);
}

function normalizeTraceLineForMatch(line: string): string {
  return line.replace(/:\s+/g, ":").replace(/,\s+/g, ",");
}

function activityContextItem(messageKey: string, source: ActivityContextItem["source"], text: string, suffix: string): ActivityContextItem {
  return {
    type: "context",
    source,
    text,
    key: `${messageKey}:context:${suffix}`
  };
}

function activityToolStepItem(
  messageKey: string,
  event: AgentToolProgressEvent,
  eventIndex: number,
  legacyLine?: string
): ActivityToolStepItem {
  const eventKey = typeof event.call_id === "string" && event.call_id ? event.call_id : `event-${eventIndex}`;
  const summary = summarizeToolCall(event);
  const fallbackLine = legacyLine?.trim() || toolEventFallbackLine(event);
  const line = summary?.line || fallbackLine;
  const verb = summary?.verb ?? "";
  const detail = summary?.detail ?? (summary ? "" : fallbackLine);
  const category: ToolTraceCategory = summary?.category ?? "generic";
  const details = toolDetailRows(event, legacyLine, line);
  return {
    type: "toolStep",
    line,
    verb,
    detail,
    category,
    event,
    details,
    key: `${messageKey}:tool-step:${eventKey}:${eventIndex}`
  };
}

function legacyToolStepItem(messageKey: string, line: string, lineIndex: number): ActivityToolStepItem | null {
  const summary = summarizeLegacyTraceLine(line);
  if (!summary) {
    return null;
  }
  const detail = summary.fullDetail && summary.fullDetail !== summary.detail
    ? [{ label: summary.detailLabel, value: summary.fullDetail }]
    : [];
  return {
    type: "toolStep",
    line: summary.summary.line,
    verb: summary.summary.verb,
    detail: summary.summary.detail,
    category: summary.summary.category,
    event: { phase: "end", name: summary.summary.toolName },
    details: detail,
    key: `${messageKey}:legacy-tool-step:${summary.summary.toolName}:${lineIndex}`
  };
}

function summarizeLegacyTraceLine(line: string): { summary: ToolTraceSummary; detail: string; fullDetail?: string; detailLabel: string } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const ranMatch = /^Ran\s+([\s\S]+)$/u.exec(trimmed);
  if (ranMatch?.[1]) {
    const command = collapseActivityWhitespace(ranMatch[1]);
    const detail = truncateActivityDetail(command, 140);
    return {
      summary: { line: `Ran ${detail}`, verb: "Ran", detail, category: "shell", toolName: "exec" },
      detail,
      fullDetail: command.length > detail.length ? command : undefined,
      detailLabel: "Command"
    };
  }
  const calledMatch = /^Called\s+([\s\S]+)$/u.exec(trimmed);
  if (calledMatch?.[1]) {
    const detail = collapseActivityWhitespace(calledMatch[1]);
    return {
      summary: { line: `Called ${detail}`, verb: "Called", detail, category: "generic", toolName: detail },
      detail,
      detailLabel: "Trace"
    };
  }
  const knownSummary = summarizeKnownLegacyTraceSummary(trimmed);
  if (knownSummary) {
    return knownSummary;
  }
  const callMatch = /^([A-Za-z_][\w.-]*)\(([\s\S]*)\)$/u.exec(trimmed);
  if (callMatch?.[1]) {
    const args = parseLegacyTraceArguments(callMatch[2] ?? "");
    const summary = summarizeToolCall({ phase: "end", name: callMatch[1], arguments: args });
    if (summary) {
      return {
        summary,
        detail: summary.detail,
        fullDetail: trimmed,
        detailLabel: "Trace"
      };
    }
  }
  return null;
}

function summarizeKnownLegacyTraceSummary(line: string): { summary: ToolTraceSummary; detail: string; fullDetail?: string; detailLabel: string } | null {
  const matchers: Array<{ pattern: RegExp; verb: string; category: ToolTraceCategory; toolName: string }> = [
    { pattern: /^Read\s+([\s\S]+)$/u, verb: "Read", category: "read", toolName: "read_file" },
    { pattern: /^Grepped\s+([\s\S]+)$/u, verb: "Grepped", category: "grep", toolName: "grep" },
    { pattern: /^Globbed\s+([\s\S]+)$/u, verb: "Globbed", category: "glob", toolName: "glob" },
    { pattern: /^Listed\s+([\s\S]+)$/u, verb: "Listed", category: "list", toolName: "list_dir" },
    { pattern: /^Edited\s+([\s\S]+)$/u, verb: "Edited", category: "edit", toolName: "edit_file" },
    { pattern: /^Wrote\s+([\s\S]+)$/u, verb: "Wrote", category: "write", toolName: "write_file" },
    { pattern: /^Deleted\s+([\s\S]+)$/u, verb: "Deleted", category: "delete", toolName: "delete_file" },
    { pattern: /^Fetched\s+([\s\S]+)$/u, verb: "Fetched", category: "web", toolName: "web_fetch" },
    { pattern: /^Searched web for\s*([\s\S]*)$/u, verb: "Searched web for", category: "search", toolName: "web_search" },
    { pattern: /^Used browser\s*([\s\S]*)$/u, verb: "Used browser", category: "browser", toolName: "browser_use" },
    { pattern: /^Updated notebook\s+([\s\S]+)$/u, verb: "Updated notebook", category: "notebook", toolName: "notebook_edit" }
  ];
  for (const matcher of matchers) {
    const match = matcher.pattern.exec(line);
    if (!match) continue;
    const detail = collapseActivityWhitespace(match[1] ?? "");
    const summaryLine = detail ? `${matcher.verb} ${detail}` : matcher.verb;
    return {
      summary: { line: summaryLine, verb: matcher.verb, detail, category: matcher.category, toolName: matcher.toolName },
      detail,
      fullDetail: line.length > summaryLine.length ? line : undefined,
      detailLabel: "Trace"
    };
  }
  return null;
}

function parseLegacyTraceArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function toolDetailRows(event: AgentToolProgressEvent, legacyLine: string | undefined, summaryLine: string): ActivityToolDetail[] {
  const rows: ActivityToolDetail[] = [];
  const rawArguments = isRecord(event.function) && "arguments" in event.function ? event.function.arguments : event.arguments;
  appendToolDetailRow(rows, "Arguments", rawArguments);
  appendToolDetailRow(rows, "Result", event.result);
  appendToolDetailRow(rows, "Files", event.files);
  appendToolDetailRow(rows, "Embeds", event.embeds);
  appendToolDetailRow(rows, "Error", event.error, "error");
  const trace = legacyLine?.trim();
  if (trace && trace !== summaryLine) {
    rows.push({ label: "Trace", value: truncateToolDetailValue(trace) });
  }
  return rows;
}

function appendToolDetailRow(rows: ActivityToolDetail[], label: string, value: unknown, tone?: ActivityToolDetail["tone"]): void {
  if (value == null) {
    return;
  }
  if (Array.isArray(value) && value.length === 0) {
    return;
  }
  if (isRecord(value) && Object.keys(value).length === 0) {
    return;
  }
  const formatted = formatToolDetailValue(value);
  if (!formatted.trim()) {
    return;
  }
  rows.push({ label, value: formatted, tone });
}

function toolEventFallbackLine(event: AgentToolProgressEvent): string {
  const name = typeof event.name === "string" && event.name
    ? event.name
    : typeof event.function?.name === "string" && event.function.name
      ? event.function.name
      : "tool";
  return `Called ${name}`;
}

function traceLinesForActivity(message: AgentChatMessage): string[] {
  if (message.traces?.length) {
    return message.traces;
  }
  if (message.fileEdits?.length) {
    return [];
  }
  return message.content ? [message.content] : [];
}

function isAgentActivityMessage(message: AgentChatMessage): boolean {
  // The whole loop process — thoughts, tools, and mid-turn drafts (narration)
  // — belongs to ONE per-run "Worked for" cluster, exactly like Cursor: while
  // the turn runs it reads chronologically in place, and when the turn ends
  // everything folds behind the single header. Deliverables (media messages,
  // the final answer) stay outside and permanently visible.
  if (message.kind === "trace" || message.kind === "narration") {
    return true;
  }
  return message.role === "assistant" && !message.content.trim() && Boolean(message.reasoning || message.reasoningStreaming || message.isStreaming);
}

function shouldSplitAssistantReasoningForDisplay(message: AgentChatMessage): boolean {
  return message.role === "assistant"
    && message.kind !== "trace"
    && message.content.trim().length > 0
    && Boolean(message.reasoning);
}

function assistantReasoningActivityMessage(message: AgentChatMessage): AgentChatMessage {
  return {
    ...message,
    id: `${message.id}::reasoning`,
    content: "",
    media: undefined,
    reasoningStreaming: Boolean(message.reasoningStreaming),
    isStreaming: Boolean(message.reasoningStreaming)
  };
}

function assistantAnswerMessageWithoutReasoning(message: AgentChatMessage): AgentChatMessage {
  return {
    ...message,
    reasoning: undefined,
    reasoningStreaming: undefined,
    activitySegmentId: undefined
  };
}

function isActivityMessageRunningForDisplay(message: AgentChatMessage): boolean {
  if (!message.isStreaming && !message.reasoningStreaming) {
    return false;
  }
  if (message.kind === "trace" && areDisplayActivityEventsComplete(message)) {
    return false;
  }
  return true;
}

function areDisplayActivityEventsComplete(message: AgentChatMessage): boolean {
  const hasToolEvents = Boolean(message.toolEvents?.length);
  const hasFileEdits = Boolean(message.fileEdits?.length);
  if (!hasToolEvents && !hasFileEdits) {
    return false;
  }
  return (!hasToolEvents || message.toolEvents!.every((event) => event.phase === "end" || event.phase === "error"))
    && (!hasFileEdits || message.fileEdits!.every((edit) => edit.status === "done" || edit.status === "error"));
}

function activityUiKey(input: {
  chatScopeKey: string;
  unitIndex: number;
  segmentId: string | null;
  firstMessageId: string | null;
}): string {
  return [
    input.chatScopeKey,
    "activity",
    String(input.unitIndex),
    input.segmentId ?? input.firstMessageId ?? "anonymous"
  ].join("::");
}

function activityBodyId(activityKey: string): string {
  return `agent-activity-${sanitizeDomId(activityKey)}-body`;
}

function sanitizeDomId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "activity";
}

function formatToolDetailValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return truncateToolDetailValue(formatStructuredToolDetail(JSON.parse(trimmed)));
    } catch {
      return truncateToolDetailValue(trimmed.replace(/\n{3,}/gu, "\n\n"));
    }
  }
  try {
    return truncateToolDetailValue(formatStructuredToolDetail(value));
  } catch {
    return truncateToolDetailValue(String(value));
  }
}

function formatStructuredToolDetail(value: unknown): string {
  const compact = JSON.stringify(value);
  if (compact == null) {
    return "";
  }
  if (compact.length <= 180 && !compact.includes("\n")) {
    return compact;
  }
  return JSON.stringify(value, null, 2);
}

function truncateToolDetailValue(value: string): string {
  const maxLength = 4000;
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function collapseActivityWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateActivityDetail(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
