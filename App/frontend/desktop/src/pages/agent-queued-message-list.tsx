/** Queued WebUI message list displayed above the chat composer. */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { CornerUpRight, FileImage, GripVertical, Monitor, Pencil, SquareTerminal, Trash2 } from "lucide-react";
import { FileTypeIcon } from "../components/file-type-icon.js";
import "./agent-queued-message-list.css";
import { OverflowTooltipText } from "../components/overflow-tooltip-text.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
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
  onReorder?: (orderedIds: string[]) => void;
}

export type QueuedComposerEditDecision = "restore" | "blocked" | "ignore";

export function canEditQueuedMessage(
  item: Pick<AgentQueuedMessage, "source" | "media" | "content">
): boolean {
  return item.source.kind === "gui"
    && (item.content.trim().length > 0 || item.media.length > 0)
    && !item.content.trimStart().startsWith("/")
    && item.media.every((media) => Boolean(media.path));
}

export function reorderQueuedMessageIds(ids: readonly string[], sourceId: string, targetId: string, after: boolean): string[] | null {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return null;
  const next = ids.filter((id) => id !== sourceId);
  const target = next.indexOf(targetId);
  next.splice(target + (after ? 1 : 0), 0, sourceId);
  return next.every((id, index) => id === ids[index]) ? null : next;
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
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement | null>(null);
  const previousCountRef = useRef(props.items.length);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const canReorder = Boolean(props.onReorder) && props.items.length > 1
    && props.items.every((item) => item.status === "queued");

  const reorder = (sourceId: string, targetId: string, after: boolean) => {
    const next = reorderQueuedMessageIds(props.items.map((item) => item.clientRequestId), sourceId, targetId, after);
    if (next) props.onReorder?.(next);
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, id: string) => {
    if (!canReorder || !draggedId || draggedId === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    setDropTarget({ id, after: event.clientY > rect.top + rect.height / 2 });
  };

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
            <li className={`agent-queue-item${draggedId === item.clientRequestId ? " agent-queue-item--dragging" : ""}${dropTarget?.id === item.clientRequestId ? ` agent-queue-item--drop-${dropTarget.after ? "after" : "before"}` : ""}`}
              key={item.clientRequestId}
              draggable={canReorder}
              onDragStart={(event) => {
                if (!canReorder) { event.preventDefault(); return; }
                setDraggedId(item.clientRequestId);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.clientRequestId);
              }}
              onDragOver={(event) => onDragOver(event, item.clientRequestId)}
              onDrop={(event) => {
                if (!canReorder || !draggedId || !dropTarget) return;
                event.preventDefault();
                reorder(draggedId, dropTarget.id, dropTarget.after);
                setDraggedId(null);
                setDropTarget(null);
              }}
              onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}>
              {canReorder ? <button type="button" className="agent-queue-item__handle"
                aria-label={t("home.queue.reorder", { text })}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  const index = props.items.findIndex((candidate) => candidate.clientRequestId === item.clientRequestId);
                  const target = props.items[index + (event.key === "ArrowUp" ? -1 : 1)];
                  if (target) reorder(item.clientRequestId, target.clientRequestId, event.key === "ArrowDown");
                }}><GripVertical size={14} aria-hidden="true" /></button>
                : <span className="agent-queue-item__handle agent-queue-item__handle--static" aria-hidden="true"><GripVertical size={14} /></span>}
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
              {item.media.length ? <QueueMediaPreview item={item} label={props.attachmentOnlyLabel(item.media.length)} /> : null}
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
                      <CornerUpRight data-icon="queue-steer" size={16} strokeWidth={2} aria-hidden="true" />
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
                      <Pencil data-icon="queue-edit" size={14} strokeWidth={1.8} aria-hidden="true" />
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
                    <Trash2 data-icon="queue-remove" size={16} strokeWidth={2} aria-hidden="true" />
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

function QueueMediaPreview({ item, label }: { item: AgentQueuedMessage; label: string }) {
  const first = item.media.find((media) => media.kind === "image") ?? item.media[0]!;
  return <span className="agent-queue-item__media" aria-label={label}>
    {first.kind === "image" && first.url
      ? <img src={first.url} alt="" />
      : first.kind === "image" ? <FileImage size={18} aria-hidden="true" />
        : <FileTypeIcon name={first.name || first.path || "attachment"} surface="card" />}
    {item.media.length > 1 ? <span className="agent-queue-item__media-count">+{item.media.length - 1}</span> : null}
  </span>;
}
