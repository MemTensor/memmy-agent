/** Shared workspace artifact browser and preview. */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Folder,
  FolderSearch,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  X
} from "lucide-react";
import type {
  WorkspaceFileEntry,
  WorkspaceFilesListing,
  WorkspaceFilesScope
} from "../api/memmy-agent-client.js";
import { FileTypeIcon } from "../components/file-type-icon.js";
import { useTranslation } from "../i18n/use-translation.js";
import { writeComposerReferenceDrag } from "../lib/composer-file-reference.js";
import type { ComposerContextReference } from "../state/agent-composer-state.js";
import { startBrowserDownload } from "./agent-message-content.js";
import { FilePreview } from "./file-preview/file-preview.js";
import type { FilePreviewResource, FilePreviewViewState } from "./file-preview/file-preview-types.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

const WORKSPACE_ARTIFACT_WIDTH_STORAGE_KEY = "memmy.workspaceArtifact.previewWidth";
const WORKSPACE_ARTIFACT_BROWSER_WIDTH_STORAGE_KEY = "memmy.workspaceArtifact.fileBrowserWidth";
const ROOT_DIRECTORY_KEY = "";

interface PreviewTabsState {
  paths: string[];
  activePath: string | null;
}

type PreviewTabsAction =
  | { type: "select"; path: string }
  | { type: "activate"; path: string }
  | { type: "close"; path: string }
  | { type: "reset" };

function previewTabsReducer(state: PreviewTabsState, action: PreviewTabsAction): PreviewTabsState {
  if (action.type === "reset") return { paths: [], activePath: null };
  if (action.type === "select") {
    return {
      paths: state.paths.includes(action.path) ? state.paths : [...state.paths, action.path],
      activePath: action.path
    };
  }
  if (action.type === "activate") {
    return state.paths.includes(action.path) ? { ...state, activePath: action.path } : state;
  }
  const closedIndex = state.paths.indexOf(action.path);
  if (closedIndex < 0) return state;
  const paths = state.paths.filter((path) => path !== action.path);
  return {
    paths,
    activePath: state.activePath === action.path
      ? paths[Math.min(closedIndex, paths.length - 1)] ?? null
      : state.activePath
  };
}

export type WorkspaceArtifactEntry = WorkspaceFileEntry;

export interface WorkspaceArtifactPanelProps {
  /** Identifies the active session/project whose root is authoritative. */
  scope: WorkspaceFilesScope;
  /** Fallback label until the gateway returns its authoritative root label. */
  rootLabel: string;
  /** Loads one real directory level. An empty relative path means the root. */
  loadDirectory: (scope: WorkspaceFilesScope, relativePath: string) => Promise<WorkspaceFilesListing>;
  /** Loads one validated scope-relative file as renderer-safe bytes. */
  loadFile: (relativePath: string, signal?: AbortSignal) => Promise<Blob>;
  openFile?: (relativePath: string) => Promise<void>;
  revealFile?: (relativePath: string) => Promise<void>;
  /** Receives the same session-relative path reference produced by dragging. */
  onAddToChat: (reference: ComposerContextReference) => void;
  /** Bump when a completed turn may have generated new workspace files. */
  refreshKey?: string | number;
  /** Reports the persisted outer pane width to layouts that anchor overlays beside it. */
  onWidthChange?: (width: number) => void;
  /** Hides the pane without unmounting it, preserving open tabs and view state. */
  hidden?: boolean;
  /** Controls rendered at the far right of the native file-tab toolbar. */
  toolbarEnd?: ReactNode;
  emptyLabel?: string;
  emptyDetail?: string;
  truncatedLabel?: string;
}

function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function fileReference(path: string, name: string): ComposerContextReference {
  return { kind: "path", id: path, label: name };
}

/**
 * Directory data is loaded lazily from the active scope. The component never
 * creates mock files or accepts a renderer-controlled workspace root.
 */
export function WorkspaceArtifactPanel(props: WorkspaceArtifactPanelProps): ReactNode {
  const { t } = useTranslation();
  const loadDirectoryRef = useRef(props.loadDirectory);
  const rootLabelRef = useRef(props.rootLabel);
  const requestGenerationRef = useRef(0);
  const scopeIdentityRef = useRef<string | null>(null);
  loadDirectoryRef.current = props.loadDirectory;
  rootLabelRef.current = props.rootLabel;

  const [listingsByDirectory, setListingsByDirectory] = useState<
    Record<string, WorkspaceFilesListing | undefined>
  >({});
  const [loadingDirectories, setLoadingDirectories] = useState<Record<string, boolean>>({});
  const [treeLoadFailed, setTreeLoadFailed] = useState(false);
  const [{ paths: openPreviewTabs, activePath: previewPath }, dispatchPreviewTabs] = useReducer(
    previewTabsReducer,
    { paths: [], activePath: null }
  );
  const [previewViewState, setPreviewViewState] = useState<Record<string, FilePreviewViewState>>({});
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [collapsedPreviewFolders, setCollapsedPreviewFolders] = useState<Record<string, boolean>>({});
  const [internalRefreshKey, setInternalRefreshKey] = useState(0);
  const [fileContextMenu, setFileContextMenu] = useState<{
    reference: ComposerContextReference;
    x: number;
    y: number;
  } | null>(null);
  const previewResize = useResizableSidebar({
    storageKey: WORKSPACE_ARTIFACT_WIDTH_STORAGE_KEY,
    defaultWidth: 520,
    minWidth: 360,
    maxWidth: 760,
    resizeDirection: -1
  });
  const fileBrowserResize = useResizableSidebar({
    storageKey: WORKSPACE_ARTIFACT_BROWSER_WIDTH_STORAGE_KEY,
    defaultWidth: 180,
    minWidth: 140,
    maxWidth: 320,
    resizeDirection: -1
  });

  useEffect(() => {
    props.onWidthChange?.(previewResize.width);
  }, [previewResize.width, props.onWidthChange]);

  const requestDirectory = useCallback(async (
    scope: WorkspaceFilesScope,
    relativePath: string,
    generation: number
  ): Promise<WorkspaceFilesListing | null> => {
    if (requestGenerationRef.current !== generation) return null;
    setLoadingDirectories((state) => ({ ...state, [relativePath]: true }));
    try {
      const listing = await loadDirectoryRef.current(scope, relativePath);
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
    const scopeIdentity = `${props.scope.kind}:${props.scope.key}`;
    const scopeChanged = scopeIdentityRef.current !== scopeIdentity;
    scopeIdentityRef.current = scopeIdentity;
    setListingsByDirectory({});
    setLoadingDirectories({});
    setTreeLoadFailed(false);
    if (scopeChanged) {
      dispatchPreviewTabs({ type: "reset" });
      setPreviewViewState({});
      setCollapsedPreviewFolders({});
    }

    void requestDirectory(props.scope, ROOT_DIRECTORY_KEY, generation).catch(() => {
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
  }, [internalRefreshKey, props.refreshKey, props.scope.kind, props.scope.key, requestDirectory]);

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
    dispatchPreviewTabs({ type: "select", path });
  }

  function closePreviewTab(path: string) {
    dispatchPreviewTabs({ type: "close", path });
    setPreviewViewState((current) => {
      if (!(path in current)) return current;
      const nextState = { ...current };
      delete nextState[path];
      return nextState;
    });
  }

  function revealBreadcrumbDirectory(path: string) {
    setFileTreeOpen(true);
    if (!path) return;
    setCollapsedPreviewFolders((state) => ({ ...state, [path]: false }));
    if (listingsByDirectory[path] === undefined && !loadingDirectories[path]) {
      void requestDirectory(props.scope, path, requestGenerationRef.current).catch(() => undefined);
    }
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
      void requestDirectory(props.scope, entry.path, generation).catch(() => {
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
          className={`workspace-artifact-file-item${previewPath === entry.path ? " workspace-artifact-file-item--active" : ""}`}
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
      <div key={entry.path} className="workspace-artifact-file-folder">
        <button
          type="button"
          className="workspace-artifact-file-folder__toggle"
          aria-expanded={!collapsed}
          onClick={() => toggleDirectory(entry)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          <strong>{entry.name}</strong>
        </button>
        {!collapsed ? (
          <div className="workspace-artifact-file-folder__children">
            {loadingDirectories[entry.path] && childListing === undefined ? (
              <span className="workspace-artifact-file-item">{t("common.loading")}</span>
            ) : (
              <>
                {(childListing?.entries ?? []).map(renderEntry)}
                {childListing?.truncated ? (
                  <span className="workspace-artifact-file-item" title={props.truncatedLabel}>{props.truncatedLabel ?? "…"}</span>
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
  const emptyLabel = props.emptyLabel ?? t("workspaceArtifact.noFiles");
  const emptyDetail = props.emptyDetail ?? resolvedRootLabel;
  const previewResource = useMemo<FilePreviewResource | null>(() => previewPath ? {
    id: `${props.scope.kind}:${props.scope.key}:${previewPath}`,
    name: fileNameFromPath(previewPath),
    path: previewPath,
    load: (signal) => props.loadFile(previewPath, signal),
    open: props.openFile ? () => props.openFile!(previewPath) : undefined,
    reveal: props.revealFile ? () => props.revealFile!(previewPath) : undefined,
    download: async () => {
      const blob = await props.loadFile(previewPath);
      const objectUrl = URL.createObjectURL(blob);
      startBrowserDownload(objectUrl, fileNameFromPath(previewPath));
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    },
    openRelativePath: selectPreviewFile,
    loadRelativePath: (path, signal) => props.loadFile(path, signal)
  } : null, [
    previewPath,
    props.loadFile,
    props.openFile,
    props.revealFile,
    props.scope.kind,
    props.scope.key
  ]);
  const breadcrumbParts = previewPath?.replace(/\\/g, "/").split("/").filter(Boolean) ?? [];

  if (props.hidden) return null;

  return (
    <>
      <SidebarResizeHandle
        label={t("workspaceArtifact.resize")}
        width={previewResize.width}
        minWidth={previewResize.minWidth}
        maxWidth={previewResize.maxWidth}
        isResizing={previewResize.isResizing}
        onResizeStart={previewResize.beginResize}
        onResizeBy={previewResize.resizeBy}
      />
      <aside className="workspace-artifact-preview-pane workspace-artifact-preview-pane--workspace workspace-artifact-preview-pane--lifted" style={previewResize.sidebarStyle}>
        <header className="workspace-artifact-preview-toolbar">
          <div className="workspace-artifact-file-tabs" role="tablist" aria-label={t("workspaceArtifact.openFiles")}>
            {openPreviewTabs.map((path) => {
              const active = previewPath === path;
              return (
                <div key={path} className={`workspace-artifact-file-tab${active ? " workspace-artifact-file-tab--active" : ""}`} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={path}
                    onClick={() => dispatchPreviewTabs({ type: "activate", path })}
                  >
                    {fileNameFromPath(path)}
                  </button>
                  <button
                    type="button"
                    className="workspace-artifact-file-tab__close"
                    aria-label={t("common.close")}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      closePreviewTab(path);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
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
          <div className="workspace-artifact-preview-toolbar__actions">
            <button type="button" aria-label={t("filePreview.refresh")} title={t("filePreview.refresh")} onClick={() => setInternalRefreshKey((key) => key + 1)}><RotateCw size={14} /></button>
            {previewResource?.open ? <button type="button" aria-label={t("filePreview.open")} title={t("filePreview.open")} onClick={() => void previewResource.open?.()}><ExternalLink size={14} /></button> : null}
            {previewResource?.reveal ? <button type="button" aria-label={t("filePreview.reveal")} title={t("filePreview.reveal")} onClick={() => void previewResource.reveal?.()}><FolderSearch size={14} /></button> : null}
            {previewResource?.download ? <button type="button" aria-label={t("filePreview.download")} title={t("filePreview.download")} onClick={() => void previewResource.download?.()}><Download size={14} /></button> : null}
            {props.toolbarEnd}
          </div>
        </header>
        <div className="workspace-artifact-breadcrumb-bar">
          <nav className="workspace-artifact-breadcrumbs" aria-label={t("workspaceArtifact.breadcrumbs")}>
            <button type="button" title={resolvedRootLabel} onClick={() => revealBreadcrumbDirectory("")}>
              {resolvedRootLabel}
            </button>
            {breadcrumbParts.map((part, index) => {
              const isFile = index === breadcrumbParts.length - 1;
              const path = breadcrumbParts.slice(0, index + 1).join("/");
              return (
                <span key={path} className="workspace-artifact-breadcrumb">
                  <ChevronRight size={11} aria-hidden="true" />
                  {isFile
                    ? <strong title={path}>{part}</strong>
                    : <button type="button" title={path} onClick={() => revealBreadcrumbDirectory(path)}>{part}</button>}
                </span>
              );
            })}
          </nav>
          {hasEntries ? (
            <button
              type="button"
              className="workspace-artifact-file-browser__toggle"
              aria-label={t("workspaceArtifact.toggleFiles")}
              aria-expanded={fileTreeOpen}
              onClick={() => setFileTreeOpen((open) => !open)}
            >
              {fileTreeOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          ) : null}
        </div>
        <div className="workspace-artifact-preview-body">
          <section className="workspace-artifact-preview-main">
            {previewPath && previewResource ? (
              <FilePreview
                resource={previewResource}
                viewState={previewViewState[previewPath]}
                onViewStateChange={(state) => setPreviewViewState((current) => ({ ...current, [previewPath]: state }))}
              />
            ) : (
              <div className="workspace-artifact-preview-empty">
                <Folder size={28} aria-hidden="true" />
                <strong>
                  {rootLoading
                    ? t("common.loading")
                    : emptyLabel}
                </strong>
                <small>{treeLoadFailed ? resolvedRootLabel : emptyDetail}</small>
              </div>
            )}
          </section>
          {fileTreeOpen && hasEntries ? (
            <SidebarResizeHandle
              label={t("workspaceArtifact.resizeFiles")}
              width={fileBrowserResize.width}
              minWidth={fileBrowserResize.minWidth}
              maxWidth={fileBrowserResize.maxWidth}
              isResizing={fileBrowserResize.isResizing}
              onResizeStart={fileBrowserResize.beginResize}
              onResizeBy={fileBrowserResize.resizeBy}
            />
          ) : null}
          <aside
            className={`workspace-artifact-file-browser${fileTreeOpen && hasEntries ? "" : " workspace-artifact-file-browser--collapsed"}`}
            style={fileBrowserResize.sidebarStyle}
          >
            {fileTreeOpen && hasEntries ? (
              <nav className="workspace-artifact-file-list">
                <div className="workspace-artifact-file-root" title={resolvedRootLabel}>
                  {resolvedRootLabel}
                </div>
                {(rootListing?.entries ?? []).map(renderEntry)}
                {rootListing?.truncated ? (
                  <span className="workspace-artifact-file-item" title={props.truncatedLabel}>{props.truncatedLabel ?? "…"}</span>
                ) : null}
              </nav>
            ) : null}
          </aside>
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
