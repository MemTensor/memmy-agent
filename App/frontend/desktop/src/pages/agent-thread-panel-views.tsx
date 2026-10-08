import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, FileDiff, Folder, LayoutGrid, LoaderCircle } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import type { MessageKey } from "../i18n/messages.js";
import { ThreadFileIcon, ThreadFolderIcon } from "./agent-thread-file-icon.js";
import {
  normalizeThreadPath,
  sumThreadFileChanges,
  THREAD_OVERVIEW_ARTIFACT_LIMIT,
  type ThreadArtifact,
  type ThreadFileChange,
  type ThreadPanelView,
} from "./agent-thread-panel-model.js";

export type ThreadViewVariant = "panel" | "popover";
export const THREAD_FILE_DRAG_TYPE = "application/x-memmy-thread-file";

const VIEW_OPTIONS: Array<{ id: ThreadPanelView; label: MessageKey; icon: ReactNode }> = [
  { id: "overview", label: "home.threadPanel.overview", icon: <LayoutGrid size={16} aria-hidden="true" /> },
  { id: "files", label: "home.threadPanel.files", icon: <Folder size={16} aria-hidden="true" /> },
  { id: "changes", label: "home.threadPanel.changes", icon: <FileDiff size={16} aria-hidden="true" /> },
];
const VIEW_MENU_GAP = 6;
const TREE_INDENT = 12;
const TREE_BASE_PADDING = 12;

export function ThreadViewSelector(props: {
  value: ThreadPanelView;
  variant: ThreadViewVariant;
  onChange: (view: ThreadPanelView) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const { onOpenChange } = props;
  const selected = VIEW_OPTIONS.find((option) => option.id === props.value) ?? VIEW_OPTIONS[0]!;

  const setMenuOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + VIEW_MENU_GAP, left: rect.left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, setMenuOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`thread-view-pill thread-view-pill--${props.variant}${open ? " thread-view-pill--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(selected.label)}
        onClick={() => setMenuOpen(!open)}
      >
        <span className="thread-view-pill__label">{t(selected.label)}</span>
        <span className="thread-view-pill__chevron" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.5} />
        </span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
          <div
            ref={menuRef}
            className="thread-view-menu"
            role="menu"
            data-thread-popover-layer=""
            style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
          >
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={option.id === props.value}
                className={`thread-view-menu__item${option.id === props.value ? " thread-view-menu__item--selected" : ""}`}
                onClick={() => {
                  setMenuOpen(false);
                  if (option.id !== props.value) props.onChange(option.id);
                }}
              >
                <span className="thread-view-menu__icon">{option.icon}</span>
                <span className="thread-view-menu__label">{t(option.label)}</span>
                {option.id === props.value ? (
                  <span className="thread-view-menu__check" aria-hidden="true">
                    <Check size={16} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}

export function ThreadOverviewView(props: {
  artifacts: ThreadArtifact[];
  activeKey: string | null;
  collapsed: boolean;
  variant: ThreadViewVariant;
  onToggleCollapsed: () => void;
  onSelect: (artifact: ThreadArtifact) => void;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? props.artifacts : props.artifacts.slice(0, THREAD_OVERVIEW_ARTIFACT_LIMIT);
  const hidden = props.artifacts.length - visible.length;

  return (
    <div className={`thread-overview thread-overview--${props.variant}`}>
      <section className="thread-overview__section">
        <button
          type="button"
          className="thread-overview__title"
          aria-expanded={!props.collapsed}
          onClick={props.onToggleCollapsed}
        >
          <span className="thread-overview__title-label">{t("home.threadPanel.artifacts")}</span>
          <span className={`thread-overview__toggle${props.collapsed ? " thread-overview__toggle--collapsed" : ""}`} aria-hidden="true">
            <ChevronDown size={14} strokeWidth={1.5} />
          </span>
        </button>
        {props.collapsed ? null : props.artifacts.length ? (
          <div className="thread-overview__items" role="list">
            {visible.map((artifact) => (
              <ThreadListItem
                key={artifact.key}
                name={artifact.name}
                title={artifact.path ?? artifact.name}
                selected={artifact.key === props.activeKey}
                dragPath={artifact.path}
                icon={<ThreadFileIcon name={artifact.name} />}
                onSelect={() => props.onSelect(artifact)}
              />
            ))}
            {hidden > 0 ? (
              <button type="button" className="thread-overview__more" onClick={() => setShowAll(true)}>
                +{hidden}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="thread-panel-empty">{t("home.threadPanel.empty")}</p>
        )}
      </section>
    </div>
  );
}

export function ThreadChangesView(props: {
  changes: ThreadFileChange[];
  activeKey: string | null;
  variant: ThreadViewVariant;
  onSelect: (change: ThreadFileChange) => void;
}) {
  const { t } = useTranslation();
  const total = sumThreadFileChanges(props.changes);
  if (!props.changes.length) {
    return (
      <div className={`thread-changes thread-changes--${props.variant}`}>
        <p className="thread-panel-empty">{t("home.threadPanel.changes.empty")}</p>
      </div>
    );
  }
  return (
    <div className={`thread-changes thread-changes--${props.variant}`}>
      <div className="thread-changes__header">
        <span className="thread-changes__label">{t("home.threadPanel.changes.header")}</span>
        <span className="thread-changes__added">+{total.added}</span>
        <span className="thread-changes__removed">-{total.deleted}</span>
      </div>
      <div className="thread-changes__list" role="list">
        {props.changes.map((change) => (
          <div
            key={change.key}
            role="listitem"
            className={`thread-changes__item${change.key === props.activeKey ? " thread-changes__item--selected" : ""}`}
          >
            <button
              type="button"
              className="thread-changes__button"
              title={change.absolutePath ?? change.path}
              onClick={() => props.onSelect(change)}
            >
              <span className="thread-changes__main">
                <ThreadFileIcon name={change.name} />
                <span className="thread-changes__name">{change.name}</span>
              </span>
              <span className="thread-changes__stats">
                {change.added > 0 ? <span className="thread-changes__stat-added">+{change.added}</span> : null}
                {change.deleted > 0 ? <span className="thread-changes__stat-removed">-{change.deleted}</span> : null}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type DirectoryState = {
  status: "loading" | "loaded" | "error";
  entries: MemmyWorkspaceDirectoryEntry[];
  truncated: boolean;
};

export function ThreadFilesView(props: {
  rootPath: string | null;
  activeKey: string | null;
  refreshToken: string;
  variant: ThreadViewVariant;
  onOpenFile: (entry: MemmyWorkspaceDirectoryEntry) => void;
}) {
  const { t } = useTranslation();
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const generationRef = useRef(0);
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const reader = typeof window === "undefined" ? undefined : window.memmy?.readWorkspaceDirectory;
  const rootPath = props.rootPath;

  const load = useCallback(async (relativePath: string, generation: number, quiet: boolean) => {
    if (!reader || !rootPath) return;
    if (!quiet) {
      setDirectories((current) => ({
        ...current,
        [relativePath]: { status: "loading", entries: current[relativePath]?.entries ?? [], truncated: false },
      }));
    }
    try {
      const result = await reader(rootPath, relativePath);
      if (generation !== generationRef.current) return;
      setDirectories((current) => ({
        ...current,
        [relativePath]: { status: "loaded", entries: result.entries, truncated: result.truncated },
      }));
    } catch {
      if (generation !== generationRef.current) return;
      setDirectories((current) => ({
        ...current,
        [relativePath]: { status: "error", entries: [], truncated: false },
      }));
    }
  }, [reader, rootPath]);

  useEffect(() => {
    const generation = ++generationRef.current;
    setDirectories({});
    setExpanded(new Set());
    void load("", generation, false);
  }, [load]);

  useEffect(() => {
    const generation = generationRef.current;
    for (const relativePath of Object.keys(directoriesRef.current)) {
      void load(relativePath, generation, true);
    }
  }, [load, props.refreshToken]);

  if (!reader) {
    return <p className={`thread-panel-empty thread-panel-empty--${props.variant}`}>{t("home.threadPanel.files.unavailable")}</p>;
  }
  if (!rootPath) {
    return <p className={`thread-panel-empty thread-panel-empty--${props.variant}`}>{t("home.threadPanel.files.noWorkspace")}</p>;
  }

  function toggle(entry: MemmyWorkspaceDirectoryEntry) {
    const next = new Set(expanded);
    if (next.has(entry.relativePath)) {
      next.delete(entry.relativePath);
    } else {
      next.add(entry.relativePath);
      const loaded = directoriesRef.current[entry.relativePath];
      if (!loaded || loaded.status === "error") void load(entry.relativePath, generationRef.current, false);
    }
    setExpanded(next);
  }

  function renderDirectory(relativePath: string, depth: number): ReactNode {
    const state = directories[relativePath];
    const indent = { "--thread-tree-depth": depth } as CSSProperties;
    if (!state || (state.status === "loading" && !state.entries.length)) {
      return (
        <div className="thread-tree__status" style={indent}>
          <LoaderCircle size={14} className="thread-panel-spin" aria-hidden="true" />
          <span>{t("home.threadPanel.preview.loading")}</span>
        </div>
      );
    }
    if (state.status === "error") {
      return <div className="thread-tree__status thread-tree__status--error" style={indent}>{t("home.threadPanel.files.loadFailed")}</div>;
    }
    if (!state.entries.length) {
      return <div className="thread-tree__status" style={indent}>{t("home.threadPanel.files.empty")}</div>;
    }
    return (
      <>
        {state.entries.map((entry) => {
          const isDirectory = entry.kind === "directory";
          const isOpen = isDirectory && expanded.has(entry.relativePath);
          const selected = !isDirectory && normalizeThreadPath(entry.path) === props.activeKey;
          return (
            <div key={entry.path} role="none">
              <button
                type="button"
                role="treeitem"
                aria-expanded={isDirectory ? isOpen : undefined}
                aria-selected={isDirectory ? undefined : selected}
                className={`thread-tree__node ${isDirectory ? "thread-tree__node--folder" : "thread-tree__node--file"}${selected ? " thread-tree__node--selected" : ""}`}
                style={{ paddingLeft: TREE_BASE_PADDING + depth * TREE_INDENT }}
                title={entry.path}
                draggable={!isDirectory}
                onDragStart={isDirectory ? undefined : (event) => writeThreadFileDrag(event, entry.path, entry.name)}
                onClick={() => (isDirectory ? toggle(entry) : props.onOpenFile(entry))}
              >
                <span className="thread-tree__icon">{isDirectory ? <ThreadFolderIcon /> : <ThreadFileIcon name={entry.name} />}</span>
                <span className="thread-tree__name">{entry.name}</span>
                {isDirectory ? (
                  <span className="thread-tree__suffix" aria-hidden="true">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                ) : null}
              </button>
              {isOpen ? renderDirectory(entry.relativePath, depth + 1) : null}
            </div>
          );
        })}
        {state.truncated ? <div className="thread-tree__status" style={indent}>{t("home.threadPanel.files.truncated")}</div> : null}
      </>
    );
  }

  return (
    <div className={`thread-tree thread-tree--${props.variant}`} role="tree" aria-label={t("home.threadPanel.files")}>
      {renderDirectory("", 0)}
    </div>
  );
}

function ThreadListItem(props: {
  name: string;
  title: string;
  selected: boolean;
  icon: ReactNode;
  dragPath?: string;
  onSelect: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onSelect();
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      className={`thread-overview-item${props.selected ? " thread-overview-item--selected" : ""}`}
      title={props.title}
      draggable={Boolean(props.dragPath)}
      onDragStart={props.dragPath ? (event) => writeThreadFileDrag(event, props.dragPath!, props.name) : undefined}
      onClick={props.onSelect}
      onKeyDown={handleKeyDown}
    >
      <span className="thread-overview-item__icon">{props.icon}</span>
      <span className="thread-overview-item__title">{props.name}</span>
    </div>
  );
}

function writeThreadFileDrag(event: DragEvent<HTMLElement>, path: string, name: string) {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(THREAD_FILE_DRAG_TYPE, JSON.stringify({ path, name }));
  event.dataTransfer.setData("text/plain", path);
}
