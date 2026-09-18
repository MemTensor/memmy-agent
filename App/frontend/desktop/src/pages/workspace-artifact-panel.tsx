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
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
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
const WORKSPACE_ARTIFACT_BROWSER_WIDTH_STORAGE_KEY = "memmy.workspaceArtifact.fileBrowserWidth.v3";
const ROOT_DIRECTORY_KEY = "";

/** Marks a reducer entry that names an extra tab rather than a workspace file. */
const EXTRA_TAB_PREFIX = "extra:";
/** Chat/media attachments that are not scope-relative still open as preview tabs. */
const EXTERNAL_TAB_PREFIX = "external:";

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
  /**
   * Measured inline size of the row this pane shares with the chat.
   *
   * Passed only when the host owns that row; the pane then caps itself so the
   * chat stays visible instead of being pushed out of the row. Left undefined,
   * the pane keeps its own bounds.
   */
  sharedRowWidth?: number | null;
  /** Space the shared row always keeps for the chat beside this pane. */
  sharedRowReservedWidth?: number;
  /** Hides the pane without unmounting it, preserving open tabs and view state. */
  hidden?: boolean;
  /** Controls rendered at the far right of the native file-tab toolbar. */
  toolbarEnd?: ReactNode;
  emptyLabel?: string;
  emptyDetail?: string;
  truncatedLabel?: string;
  /**
   * A page that shares this panel's tab strip without being a file.
   *
   * The recording page belongs beside the previewed documents — a lawyer
   * records the interview and reads the contract in the same panel — but it has
   * no workspace path, so it cannot go through the file-tab machinery. It is
   * drawn as one more tab, keyed by {@link ExtraPreviewTab.id}.
   */
  extraTabs?: readonly ExtraPreviewTab[];
  /**
   * Opens a workspace-relative file from outside the panel (e.g. a chat
   * attachment card). `nonce` lets the same path be requested again.
   */
  focusFile?: { path: string; nonce: number } | null;
  /**
   * Opens a non-workspace artifact (typically a staged media attachment) in the
   * same preview tab strip. Used when chat cards resolve outside the session
   * cwd but still have bytes we can render in-app.
   */
  focusExternalFile?: {
    id: string;
    name: string;
    nonce: number;
    load: (signal?: AbortSignal) => Promise<Blob>;
    open?: () => Promise<void>;
    reveal?: () => Promise<void>;
  } | null;
}

type ExternalPreviewFile = {
  name: string;
  load: (signal?: AbortSignal) => Promise<Blob>;
  open?: () => Promise<void>;
  reveal?: () => Promise<void>;
};

/** A non-file page in the preview panel's tab strip. */
export interface ExtraPreviewTab {
  id: string;
  label: string;
  icon: ReactNode;
  render(): ReactNode;
  onClose(): void;
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
  const [externalFiles, setExternalFiles] = useState<Record<string, ExternalPreviewFile>>({});
  const openPreviewTabsRef = useRef<string[]>([]);
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [collapsedPreviewFolders, setCollapsedPreviewFolders] = useState<Record<string, boolean>>({});
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
    resizeDirection: -1,
    availableWidth: props.sharedRowWidth ?? null,
    reservedPrimaryWidth: props.sharedRowReservedWidth
  });
  const fileBrowserResize = useResizableSidebar({
    storageKey: WORKSPACE_ARTIFACT_BROWSER_WIDTH_STORAGE_KEY,
    defaultWidth: 200,
    minWidth: 160,
    maxWidth: 360,
    resizeDirection: 1
  });

  useEffect(() => {
    // Report the rendered width, not the preference: the top-bar actions are
    // positioned against this value and must track the pane as it narrows.
    props.onWidthChange?.(previewResize.appliedWidth);
  }, [previewResize.appliedWidth, props.onWidthChange]);

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
  }, [props.refreshKey, props.scope.kind, props.scope.key, requestDirectory]);

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

  useEffect(() => {
    const focusPath = props.focusFile?.path?.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!focusPath || props.focusFile?.nonce == null) return;

    setFileTreeOpen(true);
    const parentDirs = focusPath.split("/").slice(0, -1).filter(Boolean);
    if (parentDirs.length) {
      setCollapsedPreviewFolders((state) => {
        const next = { ...state };
        let accumulated = "";
        for (const part of parentDirs) {
          accumulated = accumulated ? `${accumulated}/${part}` : part;
          next[accumulated] = false;
        }
        return next;
      });
    }

    const generation = requestGenerationRef.current;
    let cancelled = false;
    void (async () => {
      let parent = "";
      for (const part of parentDirs) {
        parent = parent ? `${parent}/${part}` : part;
        if (cancelled || requestGenerationRef.current !== generation) return;
        await requestDirectory(props.scope, parent, generation).catch(() => undefined);
      }
      if (cancelled || requestGenerationRef.current !== generation) return;
      dispatchPreviewTabs({ type: "select", path: focusPath });
    })();

    return () => {
      cancelled = true;
    };
  }, [props.focusFile?.nonce, props.focusFile?.path, props.scope.kind, props.scope.key, requestDirectory]);

  useEffect(() => {
    const focus = props.focusExternalFile;
    if (!focus || focus.nonce == null) return;
    const path = `${EXTERNAL_TAB_PREFIX}${focus.id}`;
    setExternalFiles((current) => ({
      ...current,
      [path]: {
        name: focus.name,
        load: focus.load,
        ...(focus.open ? { open: focus.open } : {}),
        ...(focus.reveal ? { reveal: focus.reveal } : {})
      }
    }));
    dispatchPreviewTabs({ type: "select", path });
  }, [props.focusExternalFile?.id, props.focusExternalFile?.name, props.focusExternalFile?.nonce]);

  function selectPreviewFile(path: string) {
    dispatchPreviewTabs({ type: "select", path });
  }

  function closePreviewTab(path: string) {
    dispatchPreviewTabs({ type: "close", path });
    if (path.startsWith(EXTERNAL_TAB_PREFIX)) {
      setExternalFiles((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    }
    setPreviewViewState((current) => {
      if (!(path in current)) return current;
      const nextState = { ...current };
      delete nextState[path];
      return nextState;
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
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
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
  const externalPreview = previewPath?.startsWith(EXTERNAL_TAB_PREFIX)
    ? externalFiles[previewPath] ?? null
    : null;
  const previewResource = useMemo<FilePreviewResource | null>(() => {
    if (!previewPath) return null;
    if (previewPath.startsWith(EXTERNAL_TAB_PREFIX)) {
      const external = externalFiles[previewPath];
      if (!external) return null;
      return {
        id: `${props.scope.kind}:${props.scope.key}:${previewPath}`,
        name: external.name,
        load: external.load,
        open: external.open,
        reveal: external.reveal,
        download: async () => {
          const blob = await external.load();
          const objectUrl = URL.createObjectURL(blob);
          startBrowserDownload(objectUrl, external.name);
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        }
      };
    }
    return {
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
    };
  }, [
    externalFiles,
    previewPath,
    props.loadFile,
    props.openFile,
    props.revealFile,
    props.scope.kind,
    props.scope.key
  ]);
  openPreviewTabsRef.current = openPreviewTabs;

  // An extra tab is opened by being offered: the top bar's toggle adds it and
  // removes it, so the panel follows the toggle rather than tracking its own
  // copy of the open state. A tab that is taken away has its entry dropped, or
  // closing it would leave a path in the strip that names nothing.
  const extraTabs = props.extraTabs ?? [];
  const extraIds = extraTabs.map((tab) => tab.id).join(",");
  useEffect(() => {
    const offered = new Set(extraTabs.map((tab) => tab.id));
    for (const tab of extraTabs) {
      dispatchPreviewTabs({ type: "select", path: `${EXTRA_TAB_PREFIX}${tab.id}` });
    }
    for (const path of openPreviewTabsRef.current) {
      if (path.startsWith(EXTRA_TAB_PREFIX) && !offered.has(path.slice(EXTRA_TAB_PREFIX.length))) {
        dispatchPreviewTabs({ type: "close", path });
      }
    }
  }, [extraIds]);

  if (props.hidden) return null;

  const extraFor = (path: string): ExtraPreviewTab | undefined => (
    path.startsWith(EXTRA_TAB_PREFIX)
      ? extraTabs.find((tab) => `${EXTRA_TAB_PREFIX}${tab.id}` === path)
      : undefined
  );
  const activeExtra = previewPath ? extraFor(previewPath) : undefined;

  return (
    <>
      <SidebarResizeHandle
        label={t("workspaceArtifact.resize")}
        width={previewResize.appliedWidth}
        minWidth={previewResize.appliedMinWidth}
        maxWidth={previewResize.appliedMaxWidth}
        isResizing={previewResize.isResizing}
        onResizeStart={previewResize.beginResize}
        onResizeBy={previewResize.resizeBy}
      />
      <aside className="workspace-artifact-preview-pane workspace-artifact-preview-pane--workspace workspace-artifact-preview-pane--lifted" style={previewResize.sidebarStyle}>
        <header className="workspace-artifact-preview-toolbar">
          {hasEntries && !activeExtra ? (
            <button
              type="button"
              className="workspace-artifact-file-browser__toggle"
              aria-label={t("workspaceArtifact.toggleFiles")}
              aria-expanded={fileTreeOpen}
              onClick={() => setFileTreeOpen((open) => !open)}
            >
              {fileTreeOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
          ) : null}
          <div className="workspace-artifact-file-tabs" role="tablist" aria-label={t("workspaceArtifact.openFiles")}>
            {openPreviewTabs.map((path) => {
              const active = previewPath === path;
              const extra = extraFor(path);
              const external = path.startsWith(EXTERNAL_TAB_PREFIX) ? externalFiles[path] : undefined;
              const label = extra?.label ?? external?.name ?? fileNameFromPath(path);
              return (
                <div key={path} className={`workspace-artifact-file-tab${active ? " workspace-artifact-file-tab--active" : ""}`} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={label}
                    onClick={() => dispatchPreviewTabs({ type: "activate", path })}
                  >
                    {extra ? <span className="workspace-artifact-file-tab__icon">{extra.icon}</span> : null}
                    {label}
                  </button>
                  <button
                    type="button"
                    className="workspace-artifact-file-tab__close"
                    aria-label={t("common.close")}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      extra ? extra.onClose() : closePreviewTab(path);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      extra ? extra.onClose() : closePreviewTab(path);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="workspace-artifact-preview-toolbar__actions">
            {props.toolbarEnd}
          </div>
        </header>
        <div className="workspace-artifact-preview-body">
          <aside
            className={`workspace-artifact-file-browser${fileTreeOpen && hasEntries && !activeExtra ? "" : " workspace-artifact-file-browser--collapsed"}`}
            style={fileBrowserResize.sidebarStyle}
          >
            {fileTreeOpen && hasEntries && !activeExtra ? (
              <nav className="workspace-artifact-file-list">
                {(rootListing?.entries ?? []).map(renderEntry)}
                {rootListing?.truncated ? (
                  <span className="workspace-artifact-file-item" title={props.truncatedLabel}>{props.truncatedLabel ?? "…"}</span>
                ) : null}
              </nav>
            ) : null}
          </aside>
          {fileTreeOpen && hasEntries && !activeExtra ? (
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
          <section className="workspace-artifact-preview-main">
            {activeExtra ? (
              activeExtra.render()
            ) : previewPath && previewResource ? (
              <>
                <div className="workspace-artifact-preview-crumb" aria-label={t("workspaceArtifact.breadcrumbs")}>
                  {resolvedRootLabel} › {externalPreview?.name ?? fileNameFromPath(previewPath)}
                </div>
                <FilePreview
                  resource={previewResource}
                  viewState={previewViewState[previewPath]}
                  onViewStateChange={(state) => setPreviewViewState((current) => ({ ...current, [previewPath]: state }))}
                />
              </>
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
