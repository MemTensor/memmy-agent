/** Shared literature-review artifact preview for ordinary and workflow chats. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  X
} from "lucide-react";
import type { WorkspaceFileEntry, WorkspaceFilesListing } from "../api/memmy-agent-client.js";
import { FileTypeIcon } from "../components/file-type-icon.js";
import { useTranslation } from "../i18n/use-translation.js";
import { writeComposerReferenceDrag } from "../lib/composer-file-reference.js";
import type { ComposerContextReference } from "../state/agent-composer-state.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

const LITREV_PREVIEW_WIDTH_STORAGE_KEY = "memmy.literatureReview.previewWidth";
const LITREV_FILE_BROWSER_WIDTH_STORAGE_KEY = "memmy.literatureReview.fileBrowserWidth";
const ROOT_DIRECTORY_KEY = "";

export type LiteratureReviewPreviewEntry = WorkspaceFileEntry;

export interface LiteratureReviewPreviewSection {
  heading: string;
  body: string;
}

/** Renderer-safe preview produced from a session-scoped artifact. */
export interface LiteratureReviewPreviewContent {
  title: string;
  sections: LiteratureReviewPreviewSection[];
}

export interface LiteratureReviewPreviewPaneProps {
  /** Identifies the active session; the gateway resolves its project root/cwd. */
  sessionKey: string;
  /** Fallback label until the gateway returns its authoritative root label. */
  rootLabel: string;
  /** Loads one real directory level. An empty relative path means the root. */
  loadDirectory: (sessionKey: string, relativePath: string) => Promise<WorkspaceFilesListing>;
  /** Loads renderer-safe content for a selected session-relative file path. */
  loadPreview: (relativePath: string) => Promise<LiteratureReviewPreviewContent | null>;
  /** Receives the same session-relative path reference produced by dragging. */
  onAddToChat: (reference: ComposerContextReference) => void;
  /** Bump when a completed turn may have generated new workspace files. */
  refreshKey?: string | number;
  /** Reports the persisted outer pane width to layouts that anchor overlays beside it. */
  onWidthChange?: (width: number) => void;
  /** Controls rendered at the far right of the native file-tab toolbar. */
  toolbarEnd?: ReactNode;
  emptyLabel?: string;
  emptyDetail?: string;
  previewUnavailableLabel?: string;
  truncatedLabel?: string;
}

function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function fileReference(path: string, name: string): ComposerContextReference {
  return { kind: "path", id: path, label: name };
}

function firstFile(entries: WorkspaceFileEntry[]): WorkspaceFileEntry | null {
  return entries.find((entry) => entry.kind === "file") ?? null;
}

function shouldOpenByDefault(entry: WorkspaceFileEntry): boolean {
  return entry.kind === "directory" && (entry.name === "downloads" || entry.name === "outputs");
}

/**
 * Literature-review artifact browser shared by every chat.
 *
 * The shell mirrors the committed literature workflow (tabs, folder/file-tree
 * toggles, both resize handles, drag, and context-menu add to chat). Directory
 * data is loaded lazily from the active session; this module never creates mock
 * files or receives a renderer-controlled workspace root.
 */
export function LiteratureReviewPreviewPane(props: LiteratureReviewPreviewPaneProps): ReactNode {
  const { t } = useTranslation();
  const loadDirectoryRef = useRef(props.loadDirectory);
  const loadPreviewRef = useRef(props.loadPreview);
  const rootLabelRef = useRef(props.rootLabel);
  const requestGenerationRef = useRef(0);
  loadDirectoryRef.current = props.loadDirectory;
  loadPreviewRef.current = props.loadPreview;
  rootLabelRef.current = props.rootLabel;

  const [listingsByDirectory, setListingsByDirectory] = useState<
    Record<string, WorkspaceFilesListing | undefined>
  >({});
  const [loadingDirectories, setLoadingDirectories] = useState<Record<string, boolean>>({});
  const [treeLoadFailed, setTreeLoadFailed] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [openPreviewTabs, setOpenPreviewTabs] = useState<string[]>([]);
  const [previewContent, setPreviewContent] = useState<LiteratureReviewPreviewContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [collapsedPreviewFolders, setCollapsedPreviewFolders] = useState<Record<string, boolean>>({});
  const [fileContextMenu, setFileContextMenu] = useState<{
    reference: ComposerContextReference;
    x: number;
    y: number;
  } | null>(null);
  const previewResize = useResizableSidebar({
    storageKey: LITREV_PREVIEW_WIDTH_STORAGE_KEY,
    defaultWidth: 520,
    minWidth: 360,
    maxWidth: 760,
    resizeDirection: -1
  });
  const fileBrowserResize = useResizableSidebar({
    storageKey: LITREV_FILE_BROWSER_WIDTH_STORAGE_KEY,
    defaultWidth: 200,
    minWidth: 160,
    maxWidth: 360
  });

  useEffect(() => {
    props.onWidthChange?.(previewResize.width);
  }, [previewResize.width, props.onWidthChange]);

  const requestDirectory = useCallback(async (
    sessionKey: string,
    relativePath: string,
    generation: number
  ): Promise<WorkspaceFilesListing | null> => {
    if (requestGenerationRef.current !== generation) return null;
    setLoadingDirectories((state) => ({ ...state, [relativePath]: true }));
    try {
      const listing = await loadDirectoryRef.current(sessionKey, relativePath);
      if (requestGenerationRef.current !== generation) return null;
      setListingsByDirectory((state) => ({ ...state, [relativePath]: listing }));
      return listing;
    } finally {
      if (requestGenerationRef.current === generation) {
        setLoadingDirectories((state) => ({ ...state, [relativePath]: false }));
      }
    }
  }, []);

  useEffect(() => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setListingsByDirectory({});
    setLoadingDirectories({});
    setTreeLoadFailed(false);
    setPreviewPath(null);
    setOpenPreviewTabs([]);
    setPreviewContent(null);
    setCollapsedPreviewFolders({});

    void requestDirectory(props.sessionKey, ROOT_DIRECTORY_KEY, generation).then(async (rootListing) => {
      if (!rootListing || requestGenerationRef.current !== generation) return;
      const rootFile = firstFile(rootListing.entries);
      if (rootFile) {
        setPreviewPath(rootFile.path);
        setOpenPreviewTabs([rootFile.path]);
      }
      const defaultOpenFolders = rootListing.entries.filter(shouldOpenByDefault);
      if (!defaultOpenFolders.length) return;
      setCollapsedPreviewFolders(Object.fromEntries(
        defaultOpenFolders.map((entry) => [entry.path, false])
      ));
      // Keep the committed downloads-before-outputs initial selection deterministic.
      for (const folder of defaultOpenFolders) {
        const listing = await requestDirectory(props.sessionKey, folder.path, generation).catch(() => null);
        if (requestGenerationRef.current !== generation) return;
        if (!listing) continue;
        if (!rootFile) {
          const initialFile = firstFile(listing.entries);
          if (initialFile) {
            setPreviewPath((current) => current ?? initialFile.path);
            setOpenPreviewTabs((tabs) => (
              tabs.length ? tabs : [initialFile.path]
            ));
          }
        }
      }
    }).catch(() => {
      if (requestGenerationRef.current !== generation) return;
      setListingsByDirectory((state) => ({
        ...state,
        [ROOT_DIRECTORY_KEY]: {
          root: { kind: "task", label: rootLabelRef.current },
          path: ROOT_DIRECTORY_KEY,
          entries: [],
          truncated: false
        }
      }));
      setTreeLoadFailed(true);
    });

    return () => {
      if (requestGenerationRef.current === generation) {
        requestGenerationRef.current += 1;
      }
    };
  }, [props.refreshKey, props.sessionKey, requestDirectory]);

  useEffect(() => {
    const generation = requestGenerationRef.current;
    let stale = false;
    setPreviewContent(null);
    if (!previewPath) {
      setPreviewLoading(false);
      return () => {
        stale = true;
      };
    }
    setPreviewLoading(true);
    void loadPreviewRef.current(previewPath).then((content) => {
      if (!stale && requestGenerationRef.current === generation) setPreviewContent(content);
    }).catch(() => {
      if (!stale && requestGenerationRef.current === generation) setPreviewContent(null);
    }).finally(() => {
      if (!stale && requestGenerationRef.current === generation) setPreviewLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [previewPath]);

  useEffect(() => {
    if (!fileContextMenu) return;
    const close = () => setFileContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [fileContextMenu]);

  function selectPreviewFile(path: string) {
    setPreviewPath(path);
    setOpenPreviewTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
  }

  function closePreviewTab(path: string) {
    setOpenPreviewTabs((tabs) => {
      const next = tabs.filter((tab) => tab !== path);
      if (previewPath === path) setPreviewPath(next[next.length - 1] ?? null);
      return next;
    });
  }

  function beginFileDrag(event: DragEvent<HTMLElement>, path: string, name: string) {
    writeComposerReferenceDrag(event.dataTransfer, fileReference(path, name));
  }

  function openFileContextMenu(event: MouseEvent<HTMLElement>, path: string, name: string) {
    event.preventDefault();
    setFileContextMenu({
      reference: fileReference(path, name),
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 52)
    });
  }

  function toggleDirectory(entry: WorkspaceFileEntry) {
    const collapsed = collapsedPreviewFolders[entry.path] !== false;
    setCollapsedPreviewFolders((state) => ({ ...state, [entry.path]: !collapsed }));
    if (collapsed && listingsByDirectory[entry.path] === undefined && !loadingDirectories[entry.path]) {
      const generation = requestGenerationRef.current;
      void requestDirectory(props.sessionKey, entry.path, generation).catch(() => {
        if (requestGenerationRef.current !== generation) return;
        setListingsByDirectory((state) => ({
          ...state,
          [entry.path]: {
            root: rootListing?.root ?? { kind: "task", label: rootLabelRef.current },
            path: entry.path,
            entries: [],
            truncated: false
          }
        }));
      });
    }
  }

  function renderEntry(entry: WorkspaceFileEntry): ReactNode {
    if (entry.kind === "file") {
      return (
        <button
          type="button"
          key={entry.path}
          className={`litrev-file-item${previewPath === entry.path ? " litrev-file-item--active" : ""}`}
          draggable
          onDragStart={(event) => beginFileDrag(event, entry.path, entry.name)}
          onContextMenu={(event) => openFileContextMenu(event, entry.path, entry.name)}
          onClick={() => selectPreviewFile(entry.path)}
        >
          <FileTypeIcon name={entry.name} surface="inline" /> <span>{entry.name}</span>
        </button>
      );
    }

    const collapsed = collapsedPreviewFolders[entry.path] !== false;
    const childListing = listingsByDirectory[entry.path];
    return (
      <div key={entry.path} className="litrev-file-folder">
        <button
          type="button"
          className="litrev-file-folder__toggle"
          aria-expanded={!collapsed}
          onClick={() => toggleDirectory(entry)}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <strong>{entry.name}</strong>
        </button>
        {!collapsed ? (
          <div className="litrev-file-folder__children">
            {loadingDirectories[entry.path] && childListing === undefined ? (
              <span className="litrev-file-item">{t("common.loading")}</span>
            ) : (
              <>
                {(childListing?.entries ?? []).map(renderEntry)}
                {childListing?.truncated ? (
                  <span className="litrev-file-item" title={props.truncatedLabel}>{props.truncatedLabel ?? "…"}</span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  const rootListing = listingsByDirectory[ROOT_DIRECTORY_KEY];
  const hasEntries = Boolean(rootListing?.entries.length);
  const rootLoading = rootListing === undefined;
  const resolvedRootLabel = rootListing?.root.label || props.rootLabel;
  const emptyLabel = props.emptyLabel ?? t("literatureReview.workspace.noFiles");
  const emptyDetail = props.emptyDetail ?? resolvedRootLabel;
  const previewUnavailableLabel = props.previewUnavailableLabel ?? t("common.preview");

  return (
    <>
      <SidebarResizeHandle
        label={t("litrev.workspace.resize")}
        width={previewResize.width}
        minWidth={previewResize.minWidth}
        maxWidth={previewResize.maxWidth}
        isResizing={previewResize.isResizing}
        onResizeStart={previewResize.beginResize}
        onResizeBy={previewResize.resizeBy}
      />
      <aside className="litrev-preview-pane litrev-preview-pane--lifted" style={previewResize.sidebarStyle}>
        <header className="litrev-preview-toolbar">
          {hasEntries ? (
            <button
              type="button"
              className="litrev-file-browser__toggle"
              aria-label={t("litrev.preview.toggleFiles")}
              aria-expanded={fileTreeOpen}
              onClick={() => setFileTreeOpen((open) => !open)}
            >
              {fileTreeOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
          ) : null}
          <div className="litrev-file-tabs" role="tablist" aria-label={t("litrev.preview.openFiles")}>
            {openPreviewTabs.map((path) => {
              const active = previewPath === path;
              return (
                <div key={path} className={`litrev-file-tab${active ? " litrev-file-tab--active" : ""}`} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={path}
                    onClick={() => setPreviewPath(path)}
                  >
                    {fileNameFromPath(path)}
                  </button>
                  <button
                    type="button"
                    className="litrev-file-tab__close"
                    aria-label={t("common.close")}
                    onClick={(event) => {
                      event.stopPropagation();
                      closePreviewTab(path);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          {props.toolbarEnd ? (
            <div className="litrev-preview-toolbar__actions">{props.toolbarEnd}</div>
          ) : null}
        </header>
        <div className="litrev-preview-body">
          <aside
            className={`litrev-file-browser${fileTreeOpen && hasEntries ? "" : " litrev-file-browser--collapsed"}`}
            style={fileBrowserResize.sidebarStyle}
          >
            {fileTreeOpen && hasEntries ? (
              <nav className="litrev-file-list">
                {(rootListing?.entries ?? []).map(renderEntry)}
                {rootListing?.truncated ? (
                  <span className="litrev-file-item" title={props.truncatedLabel}>{props.truncatedLabel ?? "…"}</span>
                ) : null}
              </nav>
            ) : null}
          </aside>
          {fileTreeOpen && hasEntries ? (
            <SidebarResizeHandle
              label={t("litrev.preview.resizeFiles")}
              width={fileBrowserResize.width}
              minWidth={fileBrowserResize.minWidth}
              maxWidth={fileBrowserResize.maxWidth}
              isResizing={fileBrowserResize.isResizing}
              onResizeStart={fileBrowserResize.beginResize}
              onResizeBy={fileBrowserResize.resizeBy}
            />
          ) : null}
          <section className="litrev-preview-main">
            {previewPath && previewContent ? (
              <article className="litrev-preview-document">
                <div className="litrev-preview-crumb">{resolvedRootLabel} › {fileNameFromPath(previewPath)}</div>
                <h2>{previewContent.title}</h2>
                {previewContent.sections.map((section) => (
                  <section key={section.heading}>
                    <h3>{section.heading}</h3>
                    <p>{section.body}</p>
                  </section>
                ))}
              </article>
            ) : (
              <div className="litrev-preview-empty">
                <Folder size={28} aria-hidden="true" />
                <strong>
                  {rootLoading || previewLoading
                    ? t("common.loading")
                    : previewPath
                      ? previewUnavailableLabel
                      : emptyLabel}
                </strong>
                <small>{treeLoadFailed ? resolvedRootLabel : emptyDetail}</small>
              </div>
            )}
          </section>
        </div>
      </aside>
      {fileContextMenu ? (
        <div
          className="composer-file-context-menu"
          role="menu"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onAddToChat(fileContextMenu.reference);
              setFileContextMenu(null);
            }}
          >
            {t("composer.addToChat")}
          </button>
        </div>
      ) : null}
    </>
  );
}
