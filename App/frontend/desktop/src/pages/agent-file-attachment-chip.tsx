import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import { X } from "lucide-react";

export type AgentFileDisplayKind = "pdf" | "docx" | "xlsx" | "pptx" | "file";

export interface AgentFileVisual {
  kind: AgentFileDisplayKind;
  label: string;
  shortLabel: "PDF" | "DOC" | "XLS" | "PPT" | "FILE";
  typeLabel: string;
  tileClassName: string;
}

export interface AgentAttachmentNameParts {
  displayName: string;
  extensionLabel: string;
}

export interface AgentAttachmentCardProps {
  kind: "image" | "file";
  name: string;
  mime?: string;
  previewUrl?: string;
  subline?: string;
  busyLabel?: string;
  title?: string;
  removable?: boolean;
  removeLabel?: string;
  thumbnailOverlay?: ReactNode;
  onRemove?: () => void;
  onClick?: () => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  disabled?: boolean;
  error?: boolean;
  align?: "left" | "right";
}

const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
]);

export function resolveAgentFileVisual(name: string, mime?: string): AgentFileVisual {
  const extension = fileExtension(name);
  const normalizedMime = String(mime ?? "").toLowerCase();
  const kind: AgentFileDisplayKind =
    extension === ".pdf" || normalizedMime === "application/pdf"
      ? "pdf"
      : extension === ".docx" || normalizedMime.includes("wordprocessingml")
        ? "docx"
        : extension === ".xlsx" || normalizedMime.includes("spreadsheetml")
          ? "xlsx"
          : extension === ".pptx" || normalizedMime.includes("presentationml")
            ? "pptx"
            : TEXT_FILE_EXTENSIONS.has(extension)
              ? "file"
              : "file";

  return visualForKind(kind, attachmentTypeLabel(name));
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
  size?: "sm" | "md";
}) {
  const visual = resolveAgentFileVisual(props.name, props.mime);
  const sizeClassName = props.size === "md" ? "agent-attachment-card__file-tile--md" : "agent-attachment-card__file-tile--sm";
  return (
    <span
      className={`agent-attachment-card__file-tile ${sizeClassName} ${visual.tileClassName}`}
      aria-label={visual.label}
      data-testid={`agent-file-icon-${visual.kind}`}
    >
      <FileTypeMark kind={visual.kind} />
    </span>
  );
}

export function AgentAttachmentCard(props: AgentAttachmentCardProps) {
  const nameParts = splitAgentAttachmentName(props.name);
  const title = props.title ?? props.name;
  const fileLabel = basenameWithoutQuery(props.name) || nameParts.displayName;
  const primaryLabel = props.disabled && props.busyLabel
    ? props.busyLabel
    : props.kind === "file"
      ? fileLabel
      : nameParts.displayName;
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
      {props.kind === "image" ? (
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
        <AgentFileIconTile name={props.name} mime={props.mime} size="md" />
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

function FileTypeMark(props: { kind: AgentFileDisplayKind }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      {props.kind === "pdf" ? <path fill="#fff" d="M16 6.5 25.5 24h-19L16 6.5Zm0 6.2-3.2 7.3h6.4L16 12.7Z" /> : null}
      {props.kind === "xlsx" ? <path fill="#fff" d="M8 9.2h4.6v4H8v-4Zm5.7 0h4.6v4h-4.6v-4Zm5.7 0H24v4h-4.6v-4ZM8 14.4h4.6v4H8v-4Zm5.7 0h4.6v4h-4.6v-4Zm5.7 0H24v4h-4.6v-4ZM8 19.6h4.6V23H8v-3.4Zm5.7 0h4.6V23h-4.6v-3.4Zm5.7 0H24V23h-4.6v-3.4Z" /> : null}
      {props.kind === "docx" ? <path fill="#fff" d="M8.2 11.2h15.6v1.8H8.2v-1.8Zm0 4h15.6v1.8H8.2v-1.8Zm0 4h10.4v1.8H8.2V19.2Z" /> : null}
      {props.kind === "pptx" ? (
        <>
          <rect x="7" y="9" width="18" height="12" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.7" />
          <path fill="#fff" d="M12.8 21.6h6.4v1.7h-6.4z" />
        </>
      ) : null}
      {props.kind === "file" ? (
        <>
          <path fill="#fff" d="M11 7.5h6.2L22.5 13v11.2a1.3 1.3 0 0 1-1.3 1.3H11a1.3 1.3 0 0 1-1.3-1.3V8.8A1.3 1.3 0 0 1 11 7.5Z" />
          <path fill="currentColor" d="M16.8 7.8v4.4h4.4" />
          <path fill="currentColor" d="M12.2 16.4h7.2v1.3h-7.2v-1.3Zm0 2.6h7.2v1.3h-7.2v-1.3Zm0 2.6h4.8v1.3h-4.8v-1.3Z" />
        </>
      ) : null}
    </svg>
  );
}

function visualForKind(kind: AgentFileDisplayKind, typeLabel: string): AgentFileVisual {
  switch (kind) {
    case "pdf":
      return {
        kind,
        label: "PDF file",
        shortLabel: "PDF",
        typeLabel,
        tileClassName: "agent-attachment-card__file-tile--pdf"
      };
    case "docx":
      return {
        kind,
        label: "Word document",
        shortLabel: "DOC",
        typeLabel,
        tileClassName: "agent-attachment-card__file-tile--docx"
      };
    case "xlsx":
      return {
        kind,
        label: "Spreadsheet file",
        shortLabel: "XLS",
        typeLabel,
        tileClassName: "agent-attachment-card__file-tile--xlsx"
      };
    case "pptx":
      return {
        kind,
        label: "Presentation file",
        shortLabel: "PPT",
        typeLabel,
        tileClassName: "agent-attachment-card__file-tile--pptx"
      };
    case "file":
    default:
      return {
        kind: "file",
        label: "File attachment",
        shortLabel: "FILE",
        typeLabel,
        tileClassName: "agent-attachment-card__file-tile--file"
      };
  }
}

function attachmentTypeLabel(name: string): string {
  return fileExtension(name).replace(/^\./, "").slice(0, 4).toUpperCase() || "FILE";
}

function fileExtension(name: string): string {
  const base = basenameWithoutQuery(name);
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index).toLowerCase() : "";
}

function basenameWithoutQuery(name: string): string {
  const withoutQuery = (name || "").split(/[?#]/)[0] ?? name;
  return withoutQuery.split(/[\\/]/).pop() || withoutQuery || "";
}
