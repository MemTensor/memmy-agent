/** Queued WebUI message list displayed above the chat composer. */
import { useEffect, useRef } from "react";
import { CornerDownRight, MessageSquarePlus, Monitor, SquareTerminal, Trash2 } from "lucide-react";
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
  onSteer: (clientRequestId: string) => void;
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
          const sourceLabel = queueSourceLabel(item, props.sourceLabels);
          return (
            <li className="agent-queue-item" key={item.clientRequestId}>
              <CornerDownRight className="agent-queue-item__icon" size={14} aria-hidden="true" />
              <Tooltip content={sourceLabel}>
                <span
                  className="agent-queue-item__source"
                  role="img"
                  aria-label={sourceLabel}
                >
                  <QueueSourceIcon item={item} />
                </span>
              </Tooltip>
              <OverflowTooltipText className="agent-queue-item__text" text={text} />
              {showSteer ? (
                <Tooltip content={props.steerLabel}>
                  <button
                    type="button"
                    className="agent-queue-item__steer"
                    aria-label={props.steerLabel}
                    disabled={controlPending || !props.canSteer}
                    onClick={() => props.onSteer(item.clientRequestId)}
                  >
                    <MessageSquarePlus size={14} aria-hidden="true" />
                    <span>{props.steerLabel}</span>
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
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
