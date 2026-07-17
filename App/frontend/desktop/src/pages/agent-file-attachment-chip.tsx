import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import { BookText, FileSpreadsheet, FileText, NotepadText, Presentation, X, type LucideIcon } from "lucide-react";

export type AgentFileDisplayKind = "pdf" | "docx" | "xlsx" | "pptx" | "file";

export interface AgentFileVisual {
  kind: AgentFileDisplayKind;
  label: string;
  shortLabel: "PDF" | "DOC" | "XLS" | "PPT" | "FILE";
  typeLabel: string;
  icon: LucideIcon;
  tileClassName: string;
  labelClassName: string;
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
  const Icon = visual.icon;
  const sizeClassName = props.size === "md" ? "agent-attachment-card__file-tile--md" : "agent-attachment-card__file-tile--sm";
  const iconSize = props.size === "md" ? 16 : 14;
  return (
    <span
      className={`agent-attachment-card__file-tile ${sizeClassName} ${visual.tileClassName}`}
      aria-label={visual.label}
      data-testid={`agent-file-icon-${visual.kind}`}
    >
      <Icon size={iconSize} strokeWidth={2.1} aria-hidden={true} />
      <span className={visual.labelClassName}>
        {visual.shortLabel}
      </span>
    </span>
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

function visualForKind(kind: AgentFileDisplayKind, typeLabel: string): AgentFileVisual {
  switch (kind) {
    case "pdf":
      return {
        kind,
        label: "PDF file",
        shortLabel: "PDF",
        typeLabel,
        icon: FileText,
        tileClassName: "agent-attachment-card__file-tile--pdf",
        labelClassName: "agent-attachment-card__file-label"
      };
    case "docx":
      return {
        kind,
        label: "Word document",
        shortLabel: "DOC",
        typeLabel,
        icon: BookText,
        tileClassName: "agent-attachment-card__file-tile--docx",
        labelClassName: "agent-attachment-card__file-label"
      };
    case "xlsx":
      return {
        kind,
        label: "Spreadsheet file",
        shortLabel: "XLS",
        typeLabel,
        icon: FileSpreadsheet,
        tileClassName: "agent-attachment-card__file-tile--xlsx",
        labelClassName: "agent-attachment-card__file-label"
      };
    case "pptx":
      return {
        kind,
        label: "Presentation file",
        shortLabel: "PPT",
        typeLabel,
        icon: Presentation,
        tileClassName: "agent-attachment-card__file-tile--pptx",
        labelClassName: "agent-attachment-card__file-label"
      };
    case "file":
    default:
      return {
        kind: "file",
        label: "File attachment",
        shortLabel: "FILE",
        typeLabel,
        icon: NotepadText,
        tileClassName: "agent-attachment-card__file-tile--file",
        labelClassName: "agent-attachment-card__file-label"
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
