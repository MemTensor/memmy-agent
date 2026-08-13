import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import { X } from "lucide-react";
import { FileTypeIcon } from "../components/file-type-icon.js";
import { resolveFileType, type FileDisplayKind, type ResolvedFileType } from "../lib/file-type.js";

export type AgentFileDisplayKind = FileDisplayKind;
export type AgentFileVisual = ResolvedFileType;

export interface AgentAttachmentNameParts {
  displayName: string;
  extensionLabel: string;
}

export interface AgentAttachmentCardProps {
  kind: "image" | "file";
  name: string;
  mime?: string;
  filePath?: string;
  previewUrl?: string;
  subline?: string;
  busyLabel?: string;
  title?: string;
  removable?: boolean;
  removeLabel?: string;
  leading?: ReactNode;
  thumbnailOverlay?: ReactNode;
  onRemove?: () => void;
  onClick?: () => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  disabled?: boolean;
  error?: boolean;
  align?: "left" | "right";
}

export function resolveAgentFileVisual(name: string, mime?: string): AgentFileVisual {
  return resolveFileType(name, mime);
}

export function splitAgentAttachmentName(name: string, fallbackExtension?: string): AgentAttachmentNameParts {
  const base = basenameWithoutQuery(name).trim();
  const index = base.lastIndexOf(".");
  const hasExtension = index > 0 && index < base.length - 1;
  const displayName = hasExtension ? base.slice(0, index).trim() : base;
  const rawExtension = hasExtension ? base.slice(index + 1) : fallbackExtension?.replace(/^\./, "");
  return {
    displayName: displayName || "attachment",
    extensionLabel: (rawExtension || "file").slice(0, 8).toUpperCase(),
  };
}

export function AgentFileIconTile(props: {
  name: string;
  mime?: string;
  filePath?: string;
  size?: "sm" | "md";
}) {
  return (
    <FileTypeIcon
      name={props.name}
      mime={props.mime}
      filePath={props.filePath}
      surface={props.size === "md" ? "card" : "row"}
      className="agent-attachment-card__file-type-icon"
    />
  );
}

export function AgentAttachmentCard(props: AgentAttachmentCardProps) {
  const nameParts = splitAgentAttachmentName(props.name);
  const title = props.title ?? props.name;
  const primaryLabel = props.disabled && props.busyLabel ? props.busyLabel : nameParts.displayName;
  const subline = props.subline ?? nameParts.extensionLabel;
  const baseClassName = [
    "agent-attachment-card",
    props.align === "right" ? "agent-attachment-card--right" : "",
    props.error ? "agent-attachment-card--error" : "",
    props.onClick ? "agent-attachment-card--interactive" : "",
    props.disabled ? "agent-attachment-card--disabled" : ""
  ].filter(Boolean).join(" ");
  const metaClassName = [
    "agent-attachment-card__meta",
    props.error ? "agent-attachment-card__meta--error" : ""
  ].filter(Boolean).join(" ");
  const mainContent = (
    <>
      {props.leading ? props.leading : props.kind === "image" ? (
        <span className="agent-attachment-card__preview">
          {props.previewUrl ? (
            <img
              src={props.previewUrl}
              alt={props.name}
              loading="lazy"
              decoding="async"
              className="agent-attachment-card__preview-image"
              draggable={false}
            />
          ) : null}
          {props.thumbnailOverlay ? (
            <span className="agent-attachment-card__overlay">
              {props.thumbnailOverlay}
            </span>
          ) : null}
        </span>
      ) : (
        <AgentFileIconTile name={props.name} mime={props.mime} filePath={props.filePath} size="md" />
      )}
      <span className="agent-attachment-card__body">
        <span className="agent-attachment-card__name">
          {primaryLabel}
        </span>
        <span className={metaClassName}>
          {subline}
        </span>
      </span>
    </>
  );
  const removeButton = props.removable && props.onRemove ? (
    <button
      type="button"
      aria-label={`${props.removeLabel ?? "Remove"}: ${props.name}`}
      title={`${props.removeLabel ?? "Remove"}: ${props.name}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onRemove?.();
      }}
      className="agent-attachment-card__remove"
    >
      <X size={12} />
    </button>
  ) : null;

  if (props.onClick && removeButton) {
    return (
      <div
        title={title}
        data-testid={`agent-attachment-card-${props.kind}`}
        className={baseClassName}
      >
        <button
          type="button"
          aria-label={title}
          onClick={props.onClick}
          onContextMenu={props.onContextMenu}
          onKeyDown={props.onKeyDown}
          disabled={props.disabled}
          aria-busy={props.disabled && props.busyLabel ? true : undefined}
          className="agent-attachment-card__action"
        >
          {mainContent}
        </button>
        {removeButton}
      </div>
    );
  }

  const content = (
    <>
      {mainContent}
      {removeButton}
    </>
  );

  if (props.onClick) {
    return (
      <button
        type="button"
        title={title}
        onClick={props.onClick}
        onContextMenu={props.onContextMenu}
        onKeyDown={props.onKeyDown}
        disabled={props.disabled}
        aria-busy={props.disabled && props.busyLabel ? true : undefined}
        data-testid={`agent-attachment-card-${props.kind}`}
        className={baseClassName}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      title={title}
      onContextMenu={props.onContextMenu}
      onKeyDown={props.onKeyDown}
      data-testid={`agent-attachment-card-${props.kind}`}
      className={baseClassName}
    >
      {content}
    </div>
  );
}

function basenameWithoutQuery(name: string): string {
  const withoutQuery = (name || "").split(/[?#]/)[0] ?? name;
  return withoutQuery.split(/[\\/]/).pop() || withoutQuery || "";
}
