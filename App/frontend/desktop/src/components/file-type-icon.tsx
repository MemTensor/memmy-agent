import type { DesktopSystemFolderIconKind } from "@memmy/desktop-interface";
import { useEffect, useState } from "react";
import { resolveFileType, type FileDisplayKind } from "../lib/file-type.js";

export type FileTypeIconSurface = "inline" | "row" | "card";

const systemFileIconCache = new Map<string, string | null>();
const pendingSystemFileIcons = new Map<string, Promise<string | null>>();
const systemFolderIconCache = new Map<DesktopSystemFolderIconKind, string | null>();
const pendingSystemFolderIcons = new Map<DesktopSystemFolderIconKind, Promise<string | null>>();

function requestSystemFileIcon(filePath: string): Promise<string | null> {
  if (systemFileIconCache.has(filePath)) {
    return Promise.resolve(systemFileIconCache.get(filePath) ?? null);
  }
  const pending = pendingSystemFileIcons.get(filePath);
  if (pending) return pending;
  const request = window.memmy?.getSystemFileIcon(filePath)
    .catch(() => null)
    .then((icon) => {
      systemFileIconCache.set(filePath, icon);
      pendingSystemFileIcons.delete(filePath);
      return icon;
    }) ?? Promise.resolve(null);
  pendingSystemFileIcons.set(filePath, request);
  return request;
}

function useSystemFileIcon(filePath?: string): string | null {
  const [icon, setIcon] = useState<string | null>(() => (
    filePath && systemFileIconCache.has(filePath)
      ? systemFileIconCache.get(filePath) ?? null
      : null
  ));

  useEffect(() => {
    if (!filePath || typeof window === "undefined" || !window.memmy) {
      setIcon(null);
      return;
    }
    let active = true;
    setIcon(systemFileIconCache.get(filePath) ?? null);
    void requestSystemFileIcon(filePath).then((nextIcon) => {
      if (active) setIcon(nextIcon);
    });
    return () => {
      active = false;
    };
  }, [filePath]);

  return icon;
}

function requestSystemFolderIcon(kind: DesktopSystemFolderIconKind): Promise<string | null> {
  if (systemFolderIconCache.has(kind)) {
    return Promise.resolve(systemFolderIconCache.get(kind) ?? null);
  }
  const pending = pendingSystemFolderIcons.get(kind);
  if (pending) return pending;
  const request = window.memmy?.getSystemFolderIcon(kind)
    .catch(() => null)
    .then((icon) => {
      systemFolderIconCache.set(kind, icon);
      pendingSystemFolderIcons.delete(kind);
      return icon;
    }) ?? Promise.resolve(null);
  pendingSystemFolderIcons.set(kind, request);
  return request;
}

function useSystemFolderIcon(kind: DesktopSystemFolderIconKind | null): string | null {
  const [icon, setIcon] = useState<string | null>(() => (
    kind && systemFolderIconCache.has(kind) ? systemFolderIconCache.get(kind) ?? null : null
  ));

  useEffect(() => {
    if (!kind || typeof window === "undefined" || !window.memmy) {
      setIcon(null);
      return;
    }
    let active = true;
    setIcon(systemFolderIconCache.get(kind) ?? null);
    void requestSystemFolderIcon(kind).then((nextIcon) => {
      if (active) setIcon(nextIcon);
    });
    return () => {
      active = false;
    };
  }, [kind]);

  return icon;
}

function FileKindGlyph({ kind, compact }: { kind: FileDisplayKind; compact: boolean }) {
  const commonProps = {
    className: "file-type-icon__glyph",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: compact ? 1.65 : 1.35
  };
  switch (kind) {
    case "pdf":
      return (
        <path
          {...commonProps}
          d="M12.8 29c2.6-3.8 4.6-8.9 5.2-13.2.8 4.8 2.8 8.7 5.4 11.4-4.2-.9-8-.2-10.6 1.8Z"
        />
      );
    case "word":
      return (
        <g {...commonProps}>
          <path d="M12.5 18.5h11M12.5 22.5h11M12.5 26.5h8" />
          {!compact ? <path d="M10 18.5v8" /> : null}
        </g>
      );
    case "spreadsheet":
      return (
        <g {...commonProps}>
          <rect x="11.5" y="17.5" width="13" height="11" rx="1.2" />
          <path d="M16 17.5v11M20.5 17.5v11M11.5 21.2h13M11.5 24.8h13" />
        </g>
      );
    case "presentation":
      return (
        <g {...commonProps}>
          <rect x="11.5" y="17.5" width="13" height="10.5" rx="1.2" />
          <path d="M18 19.8v5.4h4.8M18 19.8a5.4 5.4 0 0 1 4.8 5.4" />
        </g>
      );
    case "markdown":
      return (
        <g {...commonProps}>
          <path d="M11.8 27v-8l3.3 4 3.3-4v8M22 19v8M19.8 24.8 22 27l2.2-2.2" />
        </g>
      );
    case "code":
      return (
        <g {...commonProps}>
          <path d="m15.2 19-3.5 4 3.5 4M20.8 19l3.5 4-3.5 4" />
          {!compact ? <path d="m19.3 17.8-2.6 10.4" /> : null}
        </g>
      );
    case "image":
      return (
        <g {...commonProps}>
          <rect x="11.5" y="17.5" width="13" height="11" rx="1.5" />
          <path d="m13.5 26 3.2-3.3 2.4 2.2 1.8-1.8 2.1 2.9" />
          <circle cx="20.9" cy="20.7" r="1" fill="currentColor" stroke="none" />
        </g>
      );
    case "video":
      return (
        <g {...commonProps}>
          <rect x="11.5" y="17.5" width="13" height="11" rx="1.5" />
          <path d="m16.5 20.4 5.2 2.6-5.2 2.6Z" fill="currentColor" stroke="none" />
        </g>
      );
    case "audio":
      return (
        <g {...commonProps}>
          <path d="M21.8 18.5v7.2M21.8 18.5l-6 1.4v7.2" />
          <ellipse cx="13.8" cy="27.2" rx="2" ry="1.4" fill="currentColor" stroke="none" />
          <ellipse cx="19.8" cy="25.8" rx="2" ry="1.4" fill="currentColor" stroke="none" />
        </g>
      );
    case "archive":
      return (
        <g {...commonProps}>
          <path d="M17 16.5h3v3h-3zM17 19.5h3v3h-3zM17 22.5h3v3h-3z" />
          <path d="M16 28.5h5v-3h-5z" />
        </g>
      );
    case "text":
    case "generic":
      return (
        <g {...commonProps}>
          <path d="M12.5 19h11M12.5 23h11M12.5 27h7.5" />
        </g>
      );
  }
}

function DocumentSheet({
  kind,
  surface,
  formatLabel
}: {
  kind: FileDisplayKind;
  surface: FileTypeIconSurface;
  formatLabel: string;
}) {
  const compact = surface === "inline";
  return (
    <svg viewBox="0 0 36 40" aria-hidden="true" focusable="false">
      <path className="file-type-icon__paper" d="M5.5 2.5h17l8 8v27H5.5Z" />
      <path className="file-type-icon__fold" d="M22.5 2.5v8h8" />
      <path className="file-type-icon__fold-edge" d="m22.5 2.5 8 8" />
      <FileKindGlyph kind={kind} compact={compact} />
      {surface === "card" ? (
        <text className="file-type-icon__format-label" x="18" y="34.4" textAnchor="middle">{formatLabel}</text>
      ) : null}
    </svg>
  );
}

function FolderSheet({ open, surface }: { open?: boolean; surface: FileTypeIconSurface }) {
  return (
    <svg viewBox="0 0 36 30" aria-hidden="true" focusable="false">
      {surface === "card" ? (
        <path className="file-type-icon__folder-shadow" d="M4.8 10.5h27.7v14.7c0 1.2-1 2.2-2.2 2.2H7c-1.2 0-2.2-1-2.2-2.2Z" />
      ) : null}
      <path
        className="file-type-icon__folder-back"
        d="M3.5 25.5V7.2c0-1.3 1-2.3 2.3-2.3h7.1l3 3.2h14.3c1.3 0 2.3 1 2.3 2.3v15.1Z"
      />
      {open ? <path className="file-type-icon__folder-paper" d="M9 8.5h17.5v13H9Z" /> : null}
      {open ? (
        <path className="file-type-icon__folder-front" d="M4.2 11.3h28.1l-3.1 13.9c-.2 1-1.1 1.8-2.2 1.8H7.3c-1.1 0-2-.8-2.2-1.9Z" />
      ) : (
        <path className="file-type-icon__folder-front" d="M3.5 10h29v14.2c0 1.3-1 2.3-2.3 2.3H5.8c-1.3 0-2.3-1-2.3-2.3Z" />
      )}
      <path className="file-type-icon__folder-highlight" d={open ? "M7 13.2h22" : "M6 12h24"} />
    </svg>
  );
}

export function FileTypeIcon(props: {
  name: string;
  mime?: string;
  filePath?: string;
  surface?: FileTypeIconSurface;
  className?: string;
}) {
  const resolved = resolveFileType(props.name, props.mime);
  const surface = props.surface ?? "row";
  const systemIcon = useSystemFileIcon(props.filePath);
  const formatLabel = resolved.shortLabel;
  return (
    <span
      className={[
        "file-type-icon",
        `file-type-icon--${surface}`,
        `file-type-icon--${resolved.kind}`,
        systemIcon ? "file-type-icon--native" : "",
        props.className ?? ""
      ].filter(Boolean).join(" ")}
      aria-label={resolved.label}
      data-file-kind={resolved.kind}
      data-testid={`file-type-icon-${resolved.kind}`}
    >
      {systemIcon ? (
        <img
          src={systemIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="file-type-icon__native-image"
        />
      ) : (
        <DocumentSheet kind={resolved.kind} surface={surface} formatLabel={formatLabel} />
      )}
    </span>
  );
}

export function FolderTypeIcon(props: {
  open?: boolean;
  /** Opt-in only so repeated folder rows do not trigger native icon IPC storms. */
  preferSystemIcon?: boolean;
  systemKind?: DesktopSystemFolderIconKind;
  surface?: FileTypeIconSurface;
  className?: string;
}) {
  const surface = props.surface ?? "row";
  const systemIcon = useSystemFolderIcon(
    props.preferSystemIcon ? (props.systemKind ?? "folder") : null
  );
  return (
    <span
      className={[
        "file-type-icon",
        "file-type-icon--folder",
        `file-type-icon--${surface}`,
        systemIcon ? "file-type-icon--native" : "",
        props.className ?? ""
      ].filter(Boolean).join(" ")}
      aria-label="Folder"
      data-file-kind="folder"
      data-testid="file-type-icon-folder"
    >
      {systemIcon ? (
        <img
          src={systemIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="file-type-icon__native-image"
        />
      ) : (
        <FolderSheet open={props.open} surface={surface} />
      )}
    </span>
  );
}
