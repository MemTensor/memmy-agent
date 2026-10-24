/** Queued WebUI message list displayed above the chat composer. */
import { useEffect, useRef, type ReactNode } from "react";
import { Monitor, SquareTerminal } from "lucide-react";
import { OverflowTooltipText } from "../components/overflow-tooltip-text.js";
import { Tooltip } from "../components/tooltip.js";
import {
  AgentQueueChannelIcon,
  agentChannelDisplay,
} from "../integrations/integration-meta.js";
import type { AgentQueuedMessage } from "../state/agent-chat-slice.js";

export interface AgentQueuedMessageListProps {
  items: AgentQueuedMessage[];
  label: string;
  removeLabel: string;
  editLabel: string;
  steerLabel: string;
  canSteer: boolean;
  attachmentOnlyLabel: (count: number) => string;
  sourceLabels: {
    gui: string;
    tui: string;
    im: (channelName: string) => string;
    unknownIm: string;
  };
  onRemove: (clientRequestId: string) => void;
  onEdit: (clientRequestId: string) => void;
  onSteer: (clientRequestId: string) => void;
}

export type QueuedComposerEditDecision = "restore" | "blocked" | "ignore";

export function canEditQueuedMessage(
  item: Pick<AgentQueuedMessage, "source" | "media" | "content">
): boolean {
  return item.source.kind === "gui"
    && item.media.length === 0
    && item.content.trim().length > 0
    && !item.content.trimStart().startsWith("/");
}

export function queuedComposerEditDecision(input: {
  item: Pick<AgentQueuedMessage, "source" | "media" | "content" | "status"> | null;
  composerDraft: string;
  pendingAttachmentCount: number;
}): QueuedComposerEditDecision {
  if (!input.item || input.item.status !== "queued" || !canEditQueuedMessage(input.item)) {
    return "ignore";
  }
  if (input.composerDraft.length > 0 || input.pendingAttachmentCount > 0) {
    return "blocked";
  }
  return "restore";
}

function queueSourceLabel(
  item: AgentQueuedMessage,
  labels: AgentQueuedMessageListProps["sourceLabels"]
): string {
  if (item.source.kind === "gui") return labels.gui;
  if (item.source.kind === "tui") return labels.tui;
  const display = agentChannelDisplay(item.source.channel);
  return display ? labels.im(display.name) : labels.unknownIm;
}

function QueueSourceIcon({ item }: { item: AgentQueuedMessage }) {
  if (item.source.kind === "gui") {
    return <Monitor className="agent-queue-item__source-mark" size={16} aria-hidden="true" />;
  }
  if (item.source.kind === "tui") {
    return <SquareTerminal className="agent-queue-item__source-mark" size={16} aria-hidden="true" />;
  }
  return (
    <AgentQueueChannelIcon
      channel={item.source.channel}
      className="agent-queue-item__source-mark agent-queue-item__source-image"
    />
  );
}

function queuedMessageLabel(
  item: AgentQueuedMessage,
  attachmentOnlyLabel: (count: number) => string
): string {
  const normalized = item.content.replace(/\s+/gu, " ").trim();
  return normalized || attachmentOnlyLabel(item.media.length);
}

export function AgentQueuedMessageList(props: AgentQueuedMessageListProps) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const previousCountRef = useRef(props.items.length);

  useEffect(() => {
    if (props.items.length > previousCountRef.current) {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    }
    previousCountRef.current = props.items.length;
  }, [props.items.length]);

  if (!props.items.length) return null;

  return (
    <section className="agent-queue-panel" aria-label={props.label}>
      <ol ref={listRef} className="agent-queue-list" aria-live="polite">
        {props.items.map((item) => {
          const text = queuedMessageLabel(item, props.attachmentOnlyLabel);
          const controlPending = item.status !== "queued";
          const showSteer = item.queueSurface === "chat_composer"
            && item.source.kind === "gui"
            && !item.content.trimStart().startsWith("/");
          const showEdit = canEditQueuedMessage(item);
          const showSource = item.source.kind !== "gui";
          const sourceLabel = queueSourceLabel(item, props.sourceLabels);
          return (
            <li className="agent-queue-item" key={item.clientRequestId}>
              {showSource ? (
                <Tooltip content={sourceLabel}>
                  <span
                    className="agent-queue-item__source"
                    role="img"
                    aria-label={sourceLabel}
                  >
                    <QueueSourceIcon item={item} />
                  </span>
                </Tooltip>
              ) : null}
              <OverflowTooltipText className="agent-queue-item__text" text={text} />
              <div className="agent-queue-item__actions">
                {showSteer ? (
                  <Tooltip content={props.steerLabel}>
                    <button
                      type="button"
                      className="agent-queue-item__steer"
                      aria-label={props.steerLabel}
                      disabled={controlPending || !props.canSteer}
                      onClick={() => props.onSteer(item.clientRequestId)}
                    >
                      <QueueSteerIcon />
                    </button>
                  </Tooltip>
                ) : null}
                {showEdit ? (
                  <Tooltip content={props.editLabel}>
                    <button
                      type="button"
                      className="agent-queue-item__edit"
                      aria-label={props.editLabel}
                      disabled={controlPending}
                      onClick={() => props.onEdit(item.clientRequestId)}
                    >
                      <QueueEditIcon />
                    </button>
                  </Tooltip>
                ) : null}
                <Tooltip content={props.removeLabel}>
                  <button
                    type="button"
                    className="agent-queue-item__remove"
                    aria-label={props.removeLabel}
                    disabled={controlPending}
                    onClick={() => props.onRemove(item.clientRequestId)}
                  >
                    <QueueRemoveIcon />
                  </button>
                </Tooltip>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function QueueIcon(props: { name: string; children: ReactNode }) {
  return (
    <svg
      data-icon={props.name}
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function QueueSteerIcon() {
  return (
    <QueueIcon name="queue-steer">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M9.2 3.45h5.85c2.5 0 4.3 1.72 4.3 4.05v3.05c0 2.32-1.8 4.05-4.3 4.05H11.7l-3.45 3.05c-.3.26-.78.05-.78-.34v-2.71h-.42c-2.28 0-3.95-1.73-3.95-4.05V7.5c0-2.33 1.67-4.05 3.95-4.05H9.2Zm1.22 3.95h1.62v1.48h1.48v1.62h-1.48v1.48h-1.62v-1.48H8.94V8.88h1.48V7.4Z"
      />
    </QueueIcon>
  );
}

function QueueEditIcon() {
  return (
    <QueueIcon name="queue-edit">
      <g fill="currentColor" transform="rotate(-42 12 12)">
        <path d="M7.35 10.05 2.55 12 7.35 13.95Z" />
        <rect x="6.85" y="9.95" width="8.2" height="4.1" rx="0.75" />
        <rect x="16.55" y="9.65" width="3.7" height="4.7" rx="2.35" />
      </g>
    </QueueIcon>
  );
}

function QueueRemoveIcon() {
  return (
    <QueueIcon name="queue-remove">
      <g fill="currentColor">
        <rect x="10.2" y="3.85" width="3.6" height="1.7" rx="0.85" />
        <rect x="4.15" y="5.3" width="15.7" height="2.1" rx="1.05" />
        <path d="M6.85 7.95h10.3V14.7c0 2.15-1.7 3.9-3.85 3.9h-2.6c-2.15 0-3.85-1.75-3.85-3.9V7.95Z" />
      </g>
    </QueueIcon>
  );
}
