/**
 * Knowledge base workspace (design-complete mock).
 *
 * Walks the full journey defined by the interaction prototype: first-run
 * folder authorization -> knowledge base dashboard (recent bases + all synced
 * files) -> base detail with document management. All data lives in
 * `knowledge-demo-data.ts`; no backend calls are made.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  FolderPlus,
  FolderSync,
  LibraryBig,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { AppFrame } from "./app-frame.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { FileTypeIcon, FolderTypeIcon } from "../components/file-type-icon.js";
import { Memmy } from "../components/mascot/memmy.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  AGENT_MANAGED_FILES_CHANGED_EVENT,
  readAgentManagedFiles,
  type AgentManagedFile
} from "../lib/agent-managed-files.js";
import { mergeComposerContextReferences, writeComposerReferenceDrag } from "../lib/composer-file-reference.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { agentChatScopeKey, type ComposerContextReference } from "../state/agent-composer-state.js";
import { useAppState } from "../state/app-state.js";
import {
  buildInitialKnowledgeBases,
  buildDemoLibraryFiles,
  buildDemoSourceFolders,
  kbDefaultImportRoot,
  kbImportedFileMock,
  moveFilesToKnowledgeFolder,
  readKbOnboarded,
  writeKbOnboarded,
  type KbFileStatus,
  type KbKnowledgeBase,
  type KbKnowledgeFolder,
  type KbLibraryFile,
  type KbSourceFolder
} from "./knowledge-demo-data.js";

const RECENT_BASE_LIMIT = 3;
const FILES_PAGE_SIZE = 8;
const ROOT_DROP_TARGET = "__root__";

interface NameModalState {
  kind: "create" | "create-from-selection" | "rename";
  value: string;
  baseId?: string;
}

interface KbFileActionMenuState {
  reference: ComposerContextReference;
  fileIds: string[];
  path: string;
  kind: "file" | "folder";
  context: "library" | "detail";
  virtualFolderId?: string;
  virtualFolderName?: string;
  submenuSide: "left" | "right";
  x: number;
  y: number;
}

type KbFileActionTarget = Omit<KbFileActionMenuState, "submenuSide" | "x" | "y">;

interface DeleteFolderState {
  id: string;
  name: string;
  fileIds: string[];
}

type KbBrowseEntry =
  | {
      kind: "folder";
      path: string;
      name: string;
      fileIds: string[];
      itemCount: number;
      allowFileActions?: boolean;
      moveTargetId?: string;
    }
  | { kind: "file"; file: KbLibraryFile };

function entriesAtBrowsePath(files: KbLibraryFile[], browsePath: string): KbBrowseEntry[] {
  const prefix = browsePath ? `${browsePath}/` : "";
  const folders = new Map<string, { name: string; path: string; fileIds: Set<string>; childNames: Set<string> }>();
  const directFiles: KbLibraryFile[] = [];

  for (const file of files) {
    if (browsePath && !file.path.startsWith(prefix)) continue;
    const rest = browsePath ? file.path.slice(prefix.length) : file.path;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      directFiles.push(file);
      continue;
    }
    const name = rest.slice(0, slash);
    const path = browsePath ? `${browsePath}/${name}` : name;
    let folder = folders.get(path);
    if (!folder) {
      folder = { name, path, fileIds: new Set(), childNames: new Set() };
      folders.set(path, folder);
    }
    folder.fileIds.add(file.id);
    const next = rest.slice(slash + 1);
    const nextSlash = next.indexOf("/");
    folder.childNames.add(nextSlash === -1 ? next : next.slice(0, nextSlash));
  }

  const folderEntries: KbBrowseEntry[] = [...folders.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    .map((folder) => ({
      kind: "folder" as const,
      path: folder.path,
      name: folder.name,
      fileIds: [...folder.fileIds],
      itemCount: folder.childNames.size
    }));
  const fileEntries: KbBrowseEntry[] = directFiles
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    .map((file) => ({ kind: "file" as const, file }));
  return [...folderEntries, ...fileEntries];
}

function entriesInKnowledgeFolder(
  base: KbKnowledgeBase,
  files: KbLibraryFile[],
  folderId: string
): KbBrowseEntry[] {
  const filesById = new Map(files.map((file) => [file.id, file]));
  if (folderId) {
    const folder = base.folders.find((item) => item.id === folderId);
    return (folder?.fileIds ?? [])
      .map((id) => filesById.get(id))
      .filter((file): file is KbLibraryFile => Boolean(file))
      .map((file) => ({ kind: "file" as const, file }));
  }

  const filedIds = new Set(base.folders.flatMap((folder) => folder.fileIds));
  const folders: KbBrowseEntry[] = base.folders.map((folder) => ({
    kind: "folder",
    path: folder.id,
    name: folder.name,
    fileIds: folder.fileIds,
    itemCount: folder.fileIds.length,
    allowFileActions: false,
    moveTargetId: folder.id
  }));
  const unfiled: KbBrowseEntry[] = base.fileIds
    .filter((id) => !filedIds.has(id))
    .map((id) => filesById.get(id))
    .filter((file): file is KbLibraryFile => Boolean(file))
    .map((file) => ({ kind: "file", file }));
  return [...folders, ...unfiled];
}

function agentManagedFileToLibraryFile(file: AgentManagedFile): KbLibraryFile {
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    size: file.size,
    updated: file.updated,
    status: "processed",
    source: file.source
  };
}

export function KnowledgePage() {
  const { t } = useTranslation();
  const { state: appState, dispatch } = useAppState();
  const desktopPlatform = typeof window === "undefined" ? undefined : window.memmy?.platform;
  const [onboarded, setOnboarded] = useState(() => readKbOnboarded(typeof window === "undefined" ? undefined : window.sessionStorage));
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1);
  const [onboardingBaseName, setOnboardingBaseName] = useState("");
  const [onboardingFileIds, setOnboardingFileIds] = useState<string[]>([]);
  const [sourceFolders, setSourceFolders] = useState<KbSourceFolder[]>(() => buildDemoSourceFolders(desktopPlatform));
  const [libraryFiles, setLibraryFiles] = useState<KbLibraryFile[]>(() => [
    ...buildDemoLibraryFiles(desktopPlatform),
    ...readAgentManagedFiles(typeof window === "undefined" ? undefined : window.localStorage)
      .map(agentManagedFileToLibraryFile)
  ]);
  const [bases, setBases] = useState<KbKnowledgeBase[]>(() => buildInitialKnowledgeBases(
    readKbOnboarded(typeof window === "undefined" ? undefined : window.sessionStorage)
  ));
  const [activeBaseId, setActiveBaseId] = useState<string | null>(null);
  const [showAllBases, setShowAllBases] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [detailBrowsePath, setDetailBrowsePath] = useState("");
  const [libraryPage, setLibraryPage] = useState(1);
  const [detailPage, setDetailPage] = useState(1);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [joinMenuOpen, setJoinMenuOpen] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [detailSearch, setDetailSearch] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<"all" | KbFileStatus>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [baseMenuId, setBaseMenuId] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<NameModalState | null>(null);
  const [inlineFolderDraft, setInlineFolderDraft] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; value: string } | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [contextJoinMenuOpen, setContextJoinMenuOpen] = useState(false);
  const [deleteBaseId, setDeleteBaseId] = useState<string | null>(null);
  const [removeFileIds, setRemoveFileIds] = useState<string[] | null>(null);
  const [deleteFileIds, setDeleteFileIds] = useState<string[] | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<DeleteFolderState | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<KbFileActionMenuState | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const inlineFolderInputRef = useRef<HTMLInputElement | null>(null);
  const folderNameInputRef = useRef<HTMLInputElement | null>(null);
  const draggedKbFileIdsRef = useRef<string[]>([]);
  const syncFolderPickerRef = useRef<HTMLInputElement | null>(null);

  const activeBase = activeBaseId ? bases.find((base) => base.id === activeBaseId) ?? null : null;
  const selectedSourceRoots = sourceFolders.filter((folder) => folder.selected).map((folder) => folder.root);
  const visibleFiles = useMemo(() => {
    const inSources = libraryFiles.filter((file) => (
      file.source != null
      || selectedSourceRoots.some((root) => file.path === root || file.path.startsWith(`${root}/`))
    ));
    if (libraryFilter === "all") return inSources;
    return inSources.filter((file) => file.status === libraryFilter);
  }, [libraryFiles, libraryFilter, selectedSourceRoots]);

  useEffect(() => {
    const refreshManagedFiles = () => {
      const managed = readAgentManagedFiles(window.localStorage).map(agentManagedFileToLibraryFile);
      setLibraryFiles((files) => [
        ...files.filter((file) => file.source == null),
        ...managed
      ]);
    };
    window.addEventListener(AGENT_MANAGED_FILES_CHANGED_EVENT, refreshManagedFiles);
    return () => window.removeEventListener(AGENT_MANAGED_FILES_CHANGED_EVENT, refreshManagedFiles);
  }, []);
  const activeBaseDocs = useMemo(
    () => (activeBase ? activeBase.fileIds.map((id) => libraryFiles.find((file) => file.id === id)).filter((file): file is KbLibraryFile => Boolean(file)) : []),
    [activeBase, libraryFiles]
  );
  const activeVirtualFolder = activeBase?.folders.find((folder) => folder.id === detailBrowsePath) ?? null;
  const browseEntries = useMemo(() => entriesAtBrowsePath(visibleFiles, browsePath), [visibleFiles, browsePath]);
  const detailBrowseEntries = useMemo(
    () => (activeBase ? entriesInKnowledgeFolder(activeBase, activeBaseDocs, detailBrowsePath) : []),
    [activeBase, activeBaseDocs, detailBrowsePath]
  );
  const browseCrumbs = useMemo(() => (browsePath ? browsePath.split("/") : []), [browsePath]);
  const detailBrowseCrumbs = useMemo(() => (activeVirtualFolder ? [activeVirtualFolder.name] : []), [activeVirtualFolder]);

  useEffect(() => {
    if (!browsePath) return;
    const stillVisible = visibleFiles.some((file) => file.path === browsePath || file.path.startsWith(`${browsePath}/`));
    if (!stillVisible) setBrowsePath("");
  }, [browsePath, visibleFiles]);

  useEffect(() => {
    if (!detailBrowsePath) return;
    const stillVisible = activeBase?.folders.some((folder) => folder.id === detailBrowsePath) ?? false;
    if (!stillVisible) setDetailBrowsePath("");
  }, [activeBase, detailBrowsePath]);

  useEffect(() => {
    setDetailBrowsePath("");
    setDetailSearch("");
    setDetailPage(1);
    setSelectedFileIds([]);
    setInlineFolderDraft(null);
    setRenamingFolder(null);
  }, [activeBaseId]);

  useEffect(() => {
    setLibraryPage(1);
  }, [browsePath, libraryFilter, librarySearch]);

  useEffect(() => {
    setDetailPage(1);
  }, [detailBrowsePath, detailSearch]);

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
    if (inlineFolderDraft == null) return;
    inlineFolderInputRef.current?.focus();
    inlineFolderInputRef.current?.select();
  }, [inlineFolderDraft == null]);

  useEffect(() => {
    if (!renamingFolder) return;
    folderNameInputRef.current?.focus();
    folderNameInputRef.current?.select();
  }, [renamingFolder?.id]);

  function composerReferenceForFile(file: KbLibraryFile): ComposerContextReference {
    return { kind: "path", id: file.path, label: file.name };
  }

  function beginFileDrag(event: DragEvent<HTMLElement>, file: KbLibraryFile, internalFileIds: string[] = []) {
    writeComposerReferenceDrag(event.dataTransfer, composerReferenceForFile(file));
    draggedKbFileIdsRef.current = internalFileIds;
    if (internalFileIds.length) {
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData("application/x-memmy-kb-file-ids+json", JSON.stringify(internalFileIds));
    }
  }

  function openFileContextMenu(
    event: MouseEvent<HTMLElement>,
    target: KbFileActionTarget
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const fromContextMenu = event.type === "contextmenu";
    const anchorX = fromContextMenu ? event.clientX : rect.right;
    const anchorY = fromContextMenu ? event.clientY : rect.bottom + 4;
    const menuWidth = 182;
    const menuX = Math.max(
      8,
      Math.min(anchorX - (fromContextMenu ? 0 : menuWidth), window.innerWidth - menuWidth - 8)
    );
    const submenuSide = menuX + menuWidth * 2 + 6 <= window.innerWidth ? "right" : "left";
    setFileContextMenu({
      ...target,
      submenuSide,
      x: menuX,
      y: Math.max(8, Math.min(anchorY, window.innerHeight - 280))
    });
    setContextJoinMenuOpen(false);
  }

  function showActionTargetInFolder(menu: KbFileActionMenuState) {
    setFileContextMenu(null);
    void window.memmy?.showItemInFolder(menu.path);
  }

  function addReferenceToChat(reference: ComposerContextReference) {
    const createDraft = !appState.agent.currentChatId && !appState.agent.blankDraftActive;
    const scopeKey = agentChatScopeKey(
      appState.agent.currentChatId,
      appState.agent.newChatRequestId + (createDraft ? 1 : 0)
    );
    const current = appState.agent.composerContextReferencesByScope[scopeKey] ?? [];
    if (createDraft) {
      dispatch(agentActions.newChatRequested());
    }
    dispatch(agentActions.composerContextReferencesUpdated(
      scopeKey,
      mergeComposerContextReferences(current, [reference])
    ));
    dispatch(appActions.navigate("/main"));
  }

  function fileById(id: string): KbLibraryFile | undefined {
    return libraryFiles.find((file) => file.id === id);
  }

  function continueOnboarding(skipSync: boolean) {
    if (skipSync) {
      setSourceFolders((folders) => folders.map((folder) => ({ ...folder, selected: false })));
    }
    setOnboardingFileIds([]);
    setOnboardingStep(2);
  }

  function finishOnboarding() {
    writeKbOnboarded(typeof window === "undefined" ? undefined : window.sessionStorage);
    setOnboarded(true);
  }

  function createFirstKnowledgeBase() {
    const name = onboardingBaseName.trim();
    if (!name) return;
    setBases([{
      id: `kb-${Date.now()}`,
      name,
      updated: t("kb.updatedJustNow"),
      fileIds: [...onboardingFileIds],
      folders: []
    }]);
    finishOnboarding();
  }

  function skipFirstKnowledgeBase() {
    setBases([]);
    finishOnboarding();
  }

  function toggleOnboardingFile(id: string) {
    setOnboardingFileIds((ids) => (
      ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
    ));
  }

  function toggleSourceFolder(id: string) {
    setSourceFolders((folders) => folders.map((folder) => (folder.id === id ? { ...folder, selected: !folder.selected } : folder)));
  }

  function addSourceFolder(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSourceFolders((folders) => {
      const existing = folders.find((folder) => folder.root === trimmed || folder.name === trimmed);
      if (existing) {
        return folders.map((folder) => (folder.id === existing.id ? { ...folder, selected: true } : folder));
      }
      return [
        ...folders,
        { id: `source-${Date.now()}`, name: trimmed, root: trimmed, hint: t("kb.source.customHint"), selected: true }
      ];
    });
  }

  function pickSyncFolderFromDisk() {
    syncFolderPickerRef.current?.click();
  }

  function handleSyncFolderPicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const folderName = file?.webkitRelativePath.split("/")[0]?.trim();
    if (folderName) addSourceFolder(folderName);
    event.target.value = "";
  }

  function toggleFileSelection(id: string) {
    if (fileById(id)?.status === "unsupported") return;
    setJoinMenuOpen(false);
    setSelectedFileIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
  }

  function toggleFolderSelection(fileIds: string[]) {
    const selectableIds = fileIds.filter((id) => fileById(id)?.status !== "unsupported");
    if (!selectableIds.length) return;
    setJoinMenuOpen(false);
    setSelectedFileIds((ids) => {
      const allSelected = selectableIds.every((id) => ids.includes(id));
      if (allSelected) return ids.filter((id) => !selectableIds.includes(id));
      const merged = new Set(ids);
      for (const id of selectableIds) merged.add(id);
      return [...merged];
    });
  }

  function addFileIdsToBase(fileIds: string[], baseId: string) {
    const supportedSelection = fileIds.filter((id) => fileById(id)?.status !== "unsupported");
    setBases((current) => current.map((base) => (
      base.id === baseId
        ? {
            ...base,
            fileIds: [...base.fileIds, ...supportedSelection.filter((id) => !base.fileIds.includes(id))],
            updated: t("kb.updatedJustNow")
          }
        : base
    )));
  }

  function addSelectionToBase(baseId: string) {
    addFileIdsToBase(selectedFileIds, baseId);
    setSelectedFileIds([]);
    setJoinMenuOpen(false);
  }

  function submitNameModal() {
    const name = nameModal?.value.trim();
    if (!nameModal || !name) return;
    if (nameModal.kind === "rename") {
      const baseId = nameModal.baseId ?? activeBase?.id;
      if (!baseId) return;
      setBases((current) => current.map((base) => (base.id === baseId ? { ...base, name } : base)));
    } else {
      const id = `kb-${Date.now()}`;
      const fromSelection = nameModal.kind === "create-from-selection";
      setBases((current) => [
        {
          id,
          name,
          updated: t("kb.updatedJustNow"),
          fileIds: fromSelection ? [...selectedFileIds] : [],
          folders: []
        },
        ...current
      ]);
      if (fromSelection) {
        setSelectedFileIds([]);
        setJoinMenuOpen(false);
      }
      setShowAllBases(true);
    }
    setNameModal(null);
  }

  function startInlineFolderCreation() {
    if (!activeBase) return;
    if (inlineFolderDraft != null) {
      inlineFolderInputRef.current?.focus();
      inlineFolderInputRef.current?.select();
      return;
    }
    setDetailBrowsePath("");
    setDetailSearch("");
    setDetailPage(1);
    setInlineFolderDraft(t("kb.folder.defaultName"));
  }

  function commitInlineFolder() {
    const name = inlineFolderDraft?.trim();
    if (!activeBase || !name) {
      setInlineFolderDraft(null);
      return;
    }
    const folder: KbKnowledgeFolder = {
      id: `kb-folder-${Date.now()}`,
      name,
      fileIds: []
    };
    setBases((current) => current.map((base) => (
      base.id === activeBase.id
        ? {
            ...base,
            folders: [...base.folders, folder],
            updated: t("kb.updatedJustNow")
          }
        : base
    )));
    setInlineFolderDraft(null);
  }

  function startFolderRename(folderId: string, name: string) {
    setInlineFolderDraft(null);
    setRenamingFolder({ id: folderId, value: name });
    setFileContextMenu(null);
  }

  function commitFolderRename() {
    const name = renamingFolder?.value.trim();
    if (!activeBase || !renamingFolder || !name) {
      setRenamingFolder(null);
      return;
    }
    setBases((current) => current.map((base) => (
      base.id === activeBase.id
        ? {
            ...base,
            folders: base.folders.map((folder) => (
              folder.id === renamingFolder.id ? { ...folder, name } : folder
            )),
            updated: t("kb.updatedJustNow")
          }
        : base
    )));
    setRenamingFolder(null);
  }

  function moveFilesToFolder(fileIds: string[], folderId: string | null) {
    if (!activeBase || !fileIds.length) return;
    setBases((current) => current.map((base) => (
      base.id === activeBase.id
        ? {
            ...moveFilesToKnowledgeFolder(base, fileIds, folderId),
            updated: t("kb.updatedJustNow")
          }
        : base
    )));
  }

  function deleteSelectedBase() {
    if (!deleteBaseId) return;
    setBases((current) => current.filter((base) => base.id !== deleteBaseId));
    if (activeBaseId === deleteBaseId) setActiveBaseId(null);
    setDeleteBaseId(null);
  }

  function confirmRemoveFromActiveBase() {
    if (!activeBase || !removeFileIds?.length) return;
    const remove = new Set(removeFileIds);
    setBases((current) => current.map((base) => (
      base.id === activeBase.id
        ? {
            ...base,
            fileIds: base.fileIds.filter((id) => !remove.has(id)),
            folders: base.folders.map((folder) => ({
              ...folder,
              fileIds: folder.fileIds.filter((id) => !remove.has(id))
            }))
          }
        : base
    )));
    setSelectedFileIds((ids) => ids.filter((id) => !remove.has(id)));
    setRemoveFileIds(null);
  }

  function addMockImportedFile(baseId?: string) {
    const root = selectedSourceRoots[0] ?? sourceFolders[0]?.root ?? kbDefaultImportRoot(desktopPlatform);
    const imported = kbImportedFileMock(root, Date.now());
    setLibraryFiles((files) => [...files, imported]);
    if (baseId) {
      setBases((current) => current.map((base) => (
        base.id === baseId
          ? { ...base, fileIds: [...base.fileIds, imported.id], updated: t("kb.updatedJustNow") }
          : base
      )));
      setDetailBrowsePath("");
      setDetailSearch("");
      setDetailPage(1);
    } else {
      setBrowsePath("");
      setLibraryPage(1);
    }
  }

  useEffect(() => {
    if (nameModal) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [nameModal]);

  useEffect(() => {
    if (!joinMenuOpen && !filterMenuOpen && !baseMenuId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-kb-popover-root]")) return;
      setJoinMenuOpen(false);
      setFilterMenuOpen(false);
      setBaseMenuId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [baseMenuId, filterMenuOpen, joinMenuOpen]);

  function deleteLibraryFiles(ids: string[]) {
    if (!ids.length) return;
    const remove = new Set(ids);
    setLibraryFiles((files) => files.filter((file) => !remove.has(file.id)));
    setBases((current) => current.map((base) => ({
      ...base,
      fileIds: base.fileIds.filter((id) => !remove.has(id)),
      folders: base.folders.map((folder) => ({
        ...folder,
        fileIds: folder.fileIds.filter((id) => !remove.has(id))
      }))
    })));
    setSelectedFileIds((current) => current.filter((id) => !remove.has(id)));
    setDeleteFileIds(null);
  }

  function deleteKnowledgeFolder(deleteContainedFiles: boolean) {
    if (!activeBase || !deleteFolder) return;
    const deletedFileIds = new Set(deleteContainedFiles ? deleteFolder.fileIds : []);
    if (deleteContainedFiles) {
      setLibraryFiles((files) => files.filter((file) => !deletedFileIds.has(file.id)));
      setSelectedFileIds((ids) => ids.filter((id) => !deletedFileIds.has(id)));
    }
    setBases((current) => current.map((base) => ({
      ...base,
      fileIds: deleteContainedFiles
        ? base.fileIds.filter((id) => !deletedFileIds.has(id))
        : base.fileIds,
      folders: base.folders
        .filter((folder) => !(base.id === activeBase.id && folder.id === deleteFolder.id))
        .map((folder) => deleteContainedFiles
          ? { ...folder, fileIds: folder.fileIds.filter((id) => !deletedFileIds.has(id)) }
          : folder),
      updated: base.id === activeBase.id ? t("kb.updatedJustNow") : base.updated
    })));
    setDetailBrowsePath("");
    setDeleteFolder(null);
  }

  function renderJoinMenu(): ReactNode {
    return (
      <div className="kb-popover kb-join-menu">
        <button
          type="button"
          className="kb-join-menu__item"
          onClick={() => {
            setNameModal({ kind: "create-from-selection", value: "" });
            setJoinMenuOpen(false);
          }}
        >
          <span>{t("kb.selection.createNew")}</span>
          <small>{t("kb.selection.createNewHint")}</small>
        </button>
        <div className="kb-join-menu__divider" />
        {bases.map((base) => (
          <button
            type="button"
            key={base.id}
            className="kb-join-menu__item"
            onClick={() => {
              addSelectionToBase(base.id);
              setJoinMenuOpen(false);
            }}
          >
            <span>{base.name}</span>
          </button>
        ))}
      </div>
    );
  }

  function renderRowOperate(target: KbFileActionTarget): ReactNode {
    return target.fileIds.length || target.virtualFolderId ? (
      <button
        type="button"
        className="kb-file-table__operate kb-file-table__operate--icon"
        aria-label={t("kb.base.actions")}
        title={t("kb.base.actions")}
        onClick={(event) => openFileContextMenu(event, target)}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
    ) : <span className="kb-file-table__dash">—</span>;
  }

  function renderFileBrowser(options: {
    files: KbLibraryFile[];
    entries: KbBrowseEntry[];
    path: string;
    crumbs: string[];
    onPathChange: (path: string) => void;
    emptyLabel: string;
    /** When set, operate column removes from the active knowledge base. */
    onRemoveFiles?: (fileIds: string[]) => void;
    /** Flat search results skip folder navigation. */
    searchQuery?: string;
    inlineFolderDraft?: string | null;
    onInlineFolderChange?: (value: string) => void;
    onInlineFolderCommit?: () => void;
    onInlineFolderCancel?: () => void;
    onMoveFilesToFolder?: (fileIds: string[], folderId: string | null) => void;
    page: number;
    onPageChange: (page: number) => void;
  }): ReactNode {
    if (!options.files.length && !options.entries.length && options.inlineFolderDraft == null) {
      return <div className="kb-empty-hint kb-empty-hint--boxed">{options.emptyLabel}</div>;
    }

    const query = options.searchQuery?.trim().toLowerCase() ?? "";
    const searching = query.length > 0;
    const searchFiles = searching
      ? options.files.filter((file) => file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query))
      : [];
    const totalItems = searching ? searchFiles.length : options.entries.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / FILES_PAGE_SIZE));
    const currentPage = Math.min(Math.max(options.page, 1), totalPages);
    const pageStart = (currentPage - 1) * FILES_PAGE_SIZE;
    const pagedSearchFiles = searchFiles.slice(pageStart, pageStart + FILES_PAGE_SIZE);
    const pagedEntries = options.entries.slice(pageStart, pageStart + FILES_PAGE_SIZE);

    const renderFileRow = (file: KbLibraryFile) => {
      const selected = selectedFileIds.includes(file.id);
      const unsupported = file.status === "unsupported";
      const actionTarget: KbFileActionTarget = {
        reference: composerReferenceForFile(file),
        fileIds: [file.id],
        path: file.path,
        kind: "file",
        context: options.onRemoveFiles ? "detail" : "library"
      };
      return (
        <div
          key={file.id}
          className={`kb-file-table__row kb-file-table__row--static${selected ? " kb-file-table__row--selected" : ""}${unsupported ? " kb-file-table__row--unsupported" : ""}`}
          onContextMenu={(event) => openFileContextMenu(event, actionTarget)}
        >
          <button
            type="button"
            className={`kb-checkbox${selected ? " kb-checkbox--checked" : ""}`}
            aria-label={file.name}
            disabled={unsupported}
            onClick={() => toggleFileSelection(file.id)}
          >
            {selected ? <Check size={11} /> : null}
          </button>
          <span
            className="kb-file-table__name"
            title={file.path}
            draggable={!unsupported}
            onDragStart={(event) => beginFileDrag(
              event,
              file,
              options.onMoveFilesToFolder ? (selected ? selectedFileIds : [file.id]) : []
            )}
            onDragEnd={() => {
              draggedKbFileIdsRef.current = [];
              setDropFolderId(null);
            }}
          >
            <FileTypeIcon name={file.name} surface="row" />
            <span>{file.name}</span>
            {unsupported ? (
              <span className="kb-file-table__unsupported">
                <AlertCircle size={12} aria-hidden="true" />
                {t("kb.status.unsupported")}
              </span>
            ) : null}
          </span>
          <span className="kb-file-table__size">{file.size}</span>
          <span className="kb-file-table__updated">{file.updated}</span>
          {renderRowOperate(actionTarget)}
        </div>
      );
    };

    return (
      <div className="kb-file-browser">
        {!searching && options.path ? (
          <nav className="kb-file-breadcrumb" aria-label={t("kb.files.breadcrumbRoot")}>
            <button
              type="button"
              className={`kb-file-breadcrumb__item${dropFolderId === ROOT_DROP_TARGET ? " kb-file-breadcrumb__item--drop-target" : ""}`}
              onClick={() => options.onPathChange("")}
              onDragOver={options.onMoveFilesToFolder ? (event) => {
                if (!draggedKbFileIdsRef.current.length) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setDropFolderId(ROOT_DROP_TARGET);
              } : undefined}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId(null);
              }}
              onDrop={options.onMoveFilesToFolder ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                options.onMoveFilesToFolder?.(draggedKbFileIdsRef.current, null);
                draggedKbFileIdsRef.current = [];
                setDropFolderId(null);
                setSelectedFileIds([]);
              } : undefined}
            >
              {t("kb.files.breadcrumbRoot")}
            </button>
            {options.crumbs.map((crumb, index) => {
              const path = options.crumbs.slice(0, index + 1).join("/");
              const last = index === options.crumbs.length - 1;
              return (
                <span key={path} className="kb-file-breadcrumb__segment">
                  <ChevronRight size={12} aria-hidden="true" />
                  {last ? (
                    <span className="kb-file-breadcrumb__current">{crumb}</span>
                  ) : (
                    <button type="button" className="kb-file-breadcrumb__item" onClick={() => options.onPathChange(path)}>
                      {crumb}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        ) : null}
        <div className="kb-file-table kb-file-table--browse">
          <div className="kb-file-table__head">
            <span />
            <span>{t("kb.files.col.name")}</span>
            <span>{t("kb.files.col.size")}</span>
            <span>{t("kb.files.col.updated")}</span>
            <span>{t("kb.files.col.operate")}</span>
          </div>
          {!searching && options.inlineFolderDraft != null ? (
            <div className="kb-file-table__row kb-file-table__row--static kb-file-table__row--inline-folder">
              <span />
              <label className="kb-inline-folder-name">
                <FolderTypeIcon surface="row" />
                <input
                  ref={inlineFolderInputRef}
                  value={options.inlineFolderDraft}
                  aria-label={t("kb.folder.nameLabel")}
                  onChange={(event) => options.onInlineFolderChange?.(event.target.value)}
                  onBlur={(event) => {
                    if (event.currentTarget.dataset.cancelled !== "true") options.onInlineFolderCommit?.();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      options.onInlineFolderCommit?.();
                    } else if (event.key === "Escape") {
                      event.currentTarget.dataset.cancelled = "true";
                      options.onInlineFolderCancel?.();
                    }
                  }}
                />
              </label>
              <span className="kb-file-table__size">{t("kb.itemCount", { count: 0 })}</span>
              <span className="kb-file-table__dash">—</span>
              <span className="kb-file-table__dash">—</span>
            </div>
          ) : null}
          {searching ? (
            searchFiles.length ? pagedSearchFiles.map(renderFileRow) : (
              <div className="kb-empty-hint kb-empty-hint--table">{t("kb.detail.emptySearch")}</div>
            )
          ) : options.entries.length ? pagedEntries.map((entry) => {
            if (entry.kind === "folder") {
              const selectableIds = entry.fileIds.filter((id) => fileById(id)?.status !== "unsupported");
              const selected = selectableIds.length > 0 && selectableIds.every((id) => selectedFileIds.includes(id));
              const actionTarget: KbFileActionTarget = {
                reference: { kind: "path", id: entry.path, label: entry.name },
                fileIds: entry.fileIds,
                path: entry.path,
                kind: "folder",
                context: options.onRemoveFiles ? "detail" : "library",
                virtualFolderId: entry.moveTargetId,
                virtualFolderName: entry.moveTargetId ? entry.name : undefined
              };
              return (
                <div
                  key={`folder:${entry.path}`}
                  className={`kb-file-table__row kb-file-table__row--static${selected ? " kb-file-table__row--selected" : ""}${dropFolderId === entry.moveTargetId ? " kb-file-table__row--drop-target" : ""}`}
                  onDragOver={entry.moveTargetId && options.onMoveFilesToFolder ? (event) => {
                    if (!draggedKbFileIdsRef.current.length) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setDropFolderId(entry.moveTargetId ?? null);
                  } : undefined}
                  onDragLeave={entry.moveTargetId ? (event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId(null);
                  } : undefined}
                  onDrop={entry.moveTargetId && options.onMoveFilesToFolder ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    options.onMoveFilesToFolder?.(draggedKbFileIdsRef.current, entry.moveTargetId!);
                    draggedKbFileIdsRef.current = [];
                    setDropFolderId(null);
                    setSelectedFileIds([]);
                  } : undefined}
                  onContextMenu={(event) => openFileContextMenu(event, actionTarget)}
                >
                  <button
                    type="button"
                    className={`kb-checkbox${selected ? " kb-checkbox--checked" : ""}`}
                    aria-label={entry.name}
                    disabled={!selectableIds.length}
                    onClick={() => toggleFolderSelection(entry.fileIds)}
                  >
                    {selected ? <Check size={11} /> : null}
                  </button>
                  {entry.moveTargetId && renamingFolder?.id === entry.moveTargetId ? (
                    <label className="kb-inline-folder-name">
                      <FolderTypeIcon surface="row" />
                      <input
                        ref={folderNameInputRef}
                        value={renamingFolder.value}
                        aria-label={t("kb.folder.nameLabel")}
                        onChange={(event) => setRenamingFolder((folder) => (
                          folder ? { ...folder, value: event.target.value } : folder
                        ))}
                        onBlur={(event) => {
                          if (event.currentTarget.dataset.cancelled !== "true") commitFolderRename();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitFolderRename();
                          } else if (event.key === "Escape") {
                            event.currentTarget.dataset.cancelled = "true";
                            setRenamingFolder(null);
                          }
                        }}
                      />
                    </label>
                  ) : (
                    <button
                      type="button"
                      className="kb-file-table__name kb-file-table__name--folder"
                      onClick={() => options.onPathChange(entry.path)}
                    >
                      <FolderTypeIcon surface="row" />
                      <span>{entry.name}</span>
                    </button>
                  )}
                  <span className="kb-file-table__size">{t("kb.itemCount", { count: entry.itemCount })}</span>
                  <span className="kb-file-table__dash">—</span>
                  {renderRowOperate(actionTarget)}
                </div>
              );
            }
            return renderFileRow(entry.file);
          }) : (
            <div className="kb-empty-hint kb-empty-hint--table">{t("kb.files.emptyFolder")}</div>
          )}
        </div>
        {totalItems > 0 ? (
          <nav className="kb-file-pagination" aria-label={t("kb.pagination.label")}>
            <button
              type="button"
              aria-label={t("kb.pagination.previous")}
              disabled={currentPage <= 1}
              onClick={() => options.onPageChange(currentPage - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span>{currentPage} / {totalPages}</span>
            <button
              type="button"
              aria-label={t("kb.pagination.next")}
              disabled={currentPage >= totalPages}
              onClick={() => options.onPageChange(currentPage + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </nav>
        ) : null}
      </div>
    );
  }

  function renderOnboarding(): ReactNode {
    const selectedCount = sourceFolders.filter((folder) => folder.selected).length;
    const onboardingFiles = visibleFiles
      .filter((file) => file.status !== "unsupported")
      .slice(0, 5);
    const syncing = onboardingStep === 1;
    return (
      <div className="kb-onboarding-wrap">
        <section className="kb-onboarding">
          <ol className="kb-onboarding__steps" aria-label={t("kb.onboarding.flowLabel")}>
            <li className={`kb-onboarding__step ${syncing ? "kb-onboarding__step--active" : "kb-onboarding__step--completed"}`}>
              <span>1</span>
              <strong>{t("kb.onboarding.stepSync")}</strong>
            </li>
            <li className="kb-onboarding__step-line" aria-hidden="true" />
            <li className={`kb-onboarding__step${syncing ? "" : " kb-onboarding__step--active"}`}>
              <span>2</span>
              <strong>{t("kb.onboarding.stepCreate")}</strong>
            </li>
          </ol>
          <header className="kb-onboarding__header">
            <h2>{t(syncing ? "kb.onboarding.title" : "kb.onboarding.createTitle")}</h2>
            <p>{t(syncing ? "kb.onboarding.desc" : "kb.onboarding.createDesc")}</p>
          </header>
          {syncing ? (
            <>
              <div className="kb-onboarding__section-label">{t("kb.onboarding.chooseFolders")}</div>
              <div className="kb-source-list">
                {sourceFolders.map((folder) => (
                  <button
                    type="button"
                    key={folder.id}
                    className={`kb-source-row${folder.selected ? " kb-source-row--selected" : ""}`}
                    onClick={() => toggleSourceFolder(folder.id)}
                  >
                    <span className={`kb-checkbox${folder.selected ? " kb-checkbox--checked" : ""}`}>{folder.selected ? <Check size={11} /> : null}</span>
                    <FolderTypeIcon surface="row" />
                    <span className="kb-source-row__name">{folder.name}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="kb-add-source" onClick={pickSyncFolderFromDisk}>
                <Plus size={12} /> {t("kb.onboarding.addFolder")}
              </button>
              <footer className="kb-onboarding__footer">
                <div className="kb-onboarding__actions">
                  <Button variant="ghost" size="sm" onClick={() => continueOnboarding(true)}>{t("kb.onboarding.skip")}</Button>
                  <Button variant="primary" size="sm" disabled={selectedCount === 0} onClick={() => continueOnboarding(false)}>
                    {t("kb.onboarding.start")}
                  </Button>
                </div>
              </footer>
            </>
          ) : (
            <>
              <label className="kb-onboarding__name-field">
                <span>{t("kb.onboarding.nameLabel")}</span>
                <input
                  autoFocus
                  value={onboardingBaseName}
                  placeholder={t("kb.onboarding.namePlaceholder")}
                  onChange={(event) => setOnboardingBaseName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") createFirstKnowledgeBase();
                  }}
                />
              </label>
              <div className="kb-onboarding__section-label">{t("kb.onboarding.filesLabel")}</div>
              {onboardingFiles.length ? (
                <div className="kb-onboarding-file-list">
                  {onboardingFiles.map((file) => {
                    const selected = onboardingFileIds.includes(file.id);
                    return (
                      <button
                        type="button"
                        key={file.id}
                        className={`kb-onboarding-file-row${selected ? " kb-onboarding-file-row--selected" : ""}`}
                        onClick={() => toggleOnboardingFile(file.id)}
                      >
                        <span className={`kb-checkbox${selected ? " kb-checkbox--checked" : ""}`}>
                          {selected ? <Check size={11} /> : null}
                        </span>
                        <FileTypeIcon name={file.name} surface="row" />
                        <span>{file.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="kb-onboarding__empty-files">{t("kb.onboarding.noFiles")}</div>
              )}
              <p className="kb-onboarding__files-hint">{t("kb.onboarding.filesHint")}</p>
              <footer className="kb-onboarding__footer">
                <Button variant="ghost" size="sm" onClick={() => setOnboardingStep(1)}>{t("kb.onboarding.back")}</Button>
                <div className="kb-onboarding__actions">
                  <Button variant="ghost" size="sm" onClick={skipFirstKnowledgeBase}>{t("kb.onboarding.skipCreate")}</Button>
                  <Button variant="primary" size="sm" disabled={!onboardingBaseName.trim()} onClick={createFirstKnowledgeBase}>
                    {t("kb.onboarding.createAction")}
                  </Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    );
  }

  function renderDashboard(): ReactNode {
    const shownBases = showAllBases ? bases : bases.slice(0, RECENT_BASE_LIMIT);
    return (
      <div className="kb-dashboard">
        <section className="kb-section">
          <div className="kb-section-head">
            <h3>{t("kb.recent.title")}</h3>
            <div className="kb-section-head__actions">
              {bases.length > RECENT_BASE_LIMIT ? (
                <Button variant="secondary" size="sm" onClick={() => setShowAllBases((value) => !value)}>
                  {showAllBases ? t("kb.recent.collapse") : t("kb.recent.viewAll", { count: bases.length })}
                </Button>
              ) : null}
              <Button variant="primary" size="sm" onClick={() => setNameModal({ kind: "create", value: "" })}>
                <Plus size={13} /> {t("kb.create")}
              </Button>
            </div>
          </div>
          {bases.length ? (
            <div className="kb-card-grid">
              {shownBases.map((base) => (
                <div key={base.id} className="kb-base-card">
                  <button
                    type="button"
                    className="kb-base-card__main"
                    onClick={() => {
                      setActiveBaseId(base.id);
                      setSelectedFileIds([]);
                      setDetailSearch("");
                    }}
                  >
                    <span className="kb-base-card__icon" aria-hidden="true">
                      <LibraryBig size={19} />
                    </span>
                    <span className="kb-base-card__copy">
                      <strong>{base.name}</strong>
                      <span className="kb-base-card__meta">{base.updated}</span>
                    </span>
                  </button>
                  <div className="kb-base-card__menu-anchor" data-kb-popover-root>
                    <button
                      type="button"
                      className="kb-base-card__menu-button"
                      aria-label={t("kb.base.actions")}
                      onClick={() => setBaseMenuId((current) => (current === base.id ? null : base.id))}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {baseMenuId === base.id ? (
                      <div className="kb-popover kb-base-card__menu">
                        <button
                          type="button"
                          className="kb-base-card__menu-item"
                          onClick={() => {
                            setNameModal({ kind: "rename", value: base.name, baseId: base.id });
                            setBaseMenuId(null);
                          }}
                        >
                          <Pencil size={14} /> {t("common.rename")}
                        </button>
                        <button
                          type="button"
                          className="kb-base-card__menu-item kb-base-card__menu-item--danger"
                          onClick={() => {
                            setDeleteBaseId(base.id);
                            setBaseMenuId(null);
                          }}
                        >
                          <Trash2 size={14} /> {t("common.delete")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="kb-empty-hint">{t("kb.recent.empty")}</div>
          )}
        </section>

        <section className="kb-section">
          <div className="kb-section-head">
            <h3>{t("kb.files.title")}</h3>
            <div className="kb-section-head__actions">
              <Button variant="secondary" size="sm" onClick={() => setSyncModalOpen(true)}>
                <FolderSync size={13} /> {t("kb.sync.button")}
              </Button>
            </div>
          </div>

          <div className="kb-files-toolbar">
            <div className="kb-files-toolbar__actions">
              <Button variant="primary" size="sm" onClick={() => addMockImportedFile()}>
                <Upload size={13} /> {t("kb.toolbar.upload")}
              </Button>
              {selectedFileIds.length ? (
                <>
                  <Button variant="danger" size="sm" onClick={() => setDeleteFileIds([...selectedFileIds])}>
                    <Trash2 size={13} /> {t("kb.toolbar.delete")}
                  </Button>
                  <div className="kb-popover-anchor" data-kb-popover-root>
                    <Button variant="secondary" size="sm" onClick={() => setJoinMenuOpen((value) => !value)}>
                      {t("kb.selection.join")} <ChevronDown size={12} />
                    </Button>
                    {joinMenuOpen ? renderJoinMenu() : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedFileIds([]);
                      setJoinMenuOpen(false);
                    }}
                  >
                    {t("kb.selection.clear")}
                  </Button>
                </>
              ) : null}
            </div>
            <div className="kb-files-toolbar__filters">
              <label className="kb-search-box kb-search-box--toolbar">
                <Search size={13} />
                <input
                  value={librarySearch}
                  placeholder={t("kb.toolbar.searchPlaceholder")}
                  onChange={(event) => setLibrarySearch(event.target.value)}
                />
              </label>
              <div className="kb-popover-anchor" data-kb-popover-root>
                <Button
                  variant="secondary"
                  size="sm"
                  className="kb-files-toolbar__icon-btn"
                  aria-label={t("kb.toolbar.filter")}
                  onClick={() => setFilterMenuOpen((value) => !value)}
                >
                  <Filter size={14} />
                  {libraryFilter !== "all" ? (
                    <span className="kb-files-toolbar__filter-dot" aria-hidden="true" />
                  ) : null}
                </Button>
                {filterMenuOpen ? (
                  <div className="kb-popover kb-filter-menu">
                    {([
                      ["all", t("kb.toolbar.filterAll")],
                      ["processed", t("kb.status.processed")],
                      ["processing", t("kb.status.processing")],
                      ["uploading", t("kb.status.uploading")],
                      ["unsupported", t("kb.status.unsupported")]
                    ] as const).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={`kb-filter-menu__item${libraryFilter === value ? " kb-filter-menu__item--active" : ""}`}
                        onClick={() => {
                          setLibraryFilter(value);
                          setFilterMenuOpen(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {selectedFileIds.length ? (
            <div className="kb-files-meta">{t("kb.selection.count", { count: selectedFileIds.length })}</div>
          ) : null}

          {renderFileBrowser({
            files: visibleFiles,
            entries: browseEntries,
            path: browsePath,
            crumbs: browseCrumbs,
            onPathChange: setBrowsePath,
            emptyLabel: t("kb.files.empty"),
            searchQuery: librarySearch,
            page: libraryPage,
            onPageChange: setLibraryPage
          })}
        </section>
      </div>
    );
  }

  function renderDetail(base: KbKnowledgeBase): ReactNode {
    return (
      <div className="kb-detail">
        <header className="kb-detail-header">
          <button
            type="button"
            className="kb-back-link"
            aria-label={t("kb.detail.back")}
            title={t("kb.detail.back")}
            onClick={() => {
              setActiveBaseId(null);
              setSelectedFileIds([]);
              setDetailBrowsePath("");
            }}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="kb-detail-header__icon" aria-hidden="true">
            <LibraryBig size={17} />
          </span>
          <h1>{base.name}</h1>
        </header>
        <div className="kb-files-toolbar">
          <div className="kb-files-toolbar__actions">
            <Button variant="primary" size="sm" onClick={() => addMockImportedFile(base.id)}>
              <Upload size={14} /> {t("kb.toolbar.upload")}
            </Button>
            <Button variant="secondary" size="sm" onClick={startInlineFolderCreation}>
              <FolderPlus size={14} /> {t("kb.folder.create")}
            </Button>
            {selectedFileIds.length ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => setRemoveFileIds([...selectedFileIds])}>
                  {t("kb.detail.removeShort")}
                </Button>
                <Button variant="danger" size="sm" onClick={() => setDeleteFileIds([...selectedFileIds])}>
                  <Trash2 size={13} /> {t("kb.toolbar.delete")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedFileIds([])}>
                  {t("kb.selection.clear")}
                </Button>
              </>
            ) : null}
          </div>
          <div className="kb-files-toolbar__filters">
            <label className="kb-search-box kb-search-box--toolbar">
              <Search size={13} />
              <input
                value={detailSearch}
                placeholder={t("kb.detail.searchPlaceholder")}
                onChange={(event) => setDetailSearch(event.target.value)}
              />
            </label>
          </div>
        </div>
        {renderFileBrowser({
          files: activeBaseDocs,
          entries: detailBrowseEntries,
          path: detailBrowsePath,
          crumbs: detailBrowseCrumbs,
          onPathChange: setDetailBrowsePath,
          emptyLabel: t("kb.detail.empty"),
          searchQuery: detailSearch,
          inlineFolderDraft,
          onInlineFolderChange: setInlineFolderDraft,
          onInlineFolderCommit: commitInlineFolder,
          onInlineFolderCancel: () => setInlineFolderDraft(null),
          onMoveFilesToFolder: moveFilesToFolder,
          page: detailPage,
          onPageChange: setDetailPage,
          onRemoveFiles: (fileIds) => setRemoveFileIds([...new Set(fileIds)])
        })}
      </div>
    );
  }

  return (
    <AppFrame title={t("kb.title")}>
      <div className={`app-frame-page-content kb-page h-full overflow-y-auto py-6${!onboarded ? " kb-page--onboarding" : ""}`}>
        {!activeBase ? (
          <div className="app-page-hero">
            <Memmy pose="read" size={56} />
            <div>
              <h1>{t("kb.title")}</h1>
              <p>{t("kb.subtitle")}</p>
            </div>
          </div>
        ) : null}
        {!onboarded ? renderOnboarding() : activeBase ? renderDetail(activeBase) : renderDashboard()}
      </div>
      <input
        ref={syncFolderPickerRef}
        type="file"
        hidden
        className="hidden"
        multiple
        // Chromium folder picker; mock sync uses the selected directory name only.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={handleSyncFolderPicked}
      />

      <Modal
        open={nameModal != null}
        title={
          nameModal?.kind === "rename"
            ? t("kb.modal.renameTitle")
            : t("kb.modal.createTitle")
        }
        closeLabel={t("common.close")}
        onClose={() => setNameModal(null)}
        className="kb-name-modal-dialog"
        initialFocusRef={nameInputRef}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setNameModal(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" size="sm" disabled={!nameModal?.value.trim()} onClick={submitNameModal}>{t("common.confirm")}</Button>
          </>
        )}
      >
        <label className="kb-modal-field">
          <span>{t("kb.modal.nameLabel")}</span>
          <input
            ref={nameInputRef}
            value={nameModal?.value ?? ""}
            placeholder={t("kb.modal.namePlaceholder")}
            onChange={(event) => setNameModal((state) => (state ? { ...state, value: event.target.value } : state))}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitNameModal();
            }}
          />
        </label>
      </Modal>

      <Modal
        open={syncModalOpen}
        title={t("kb.sync.title")}
        subtitle={t("kb.sync.desc")}
        closeLabel={t("common.close")}
        onClose={() => setSyncModalOpen(false)}
        className="kb-sync-modal-dialog"
        bodyClassName="kb-sync-modal-body"
      >
        {(() => {
          const synced = sourceFolders.filter((folder) => folder.selected);
          return (
            <div className="kb-sync-modal">
              <section className="kb-sync-modal__section">
                <header className="kb-sync-modal__section-head">
                  <strong>{t("kb.sync.syncedSection")}</strong>
                  <span>{t("kb.sync.syncedSectionHint", { count: synced.length })}</span>
                </header>
                {synced.length ? (
                  <div className="kb-sync-modal__list">
                    {synced.map((folder) => (
                      <div key={folder.id} className="kb-sync-modal__row">
                        <span className="kb-sync-modal__icon kb-sync-modal__icon--active"><FolderSync size={15} /></span>
                        <span className="kb-sync-modal__text">
                          <strong>{folder.name}</strong>
                          <small>{folder.root}</small>
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => toggleSourceFolder(folder.id)}>
                          {t("kb.sync.pause")}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="kb-sync-modal__empty">{t("kb.sync.syncedEmpty")}</div>
                )}
              </section>

              <Button variant="secondary" size="sm" className="kb-sync-modal__add-btn" onClick={pickSyncFolderFromDisk}>
                <Plus size={14} /> {t("kb.sync.add")}
              </Button>
            </div>
          );
        })()}
      </Modal>

      <Modal
        open={deleteFolder != null}
        title={t("kb.folder.deleteTitle", { name: deleteFolder?.name ?? "" })}
        closeLabel={t("common.close")}
        closeContent={<X size={16} aria-hidden="true" />}
        onClose={() => setDeleteFolder(null)}
        className="kb-folder-delete-dialog"
        footerClassName="kb-folder-delete-dialog__footer"
        footer={deleteFolder?.fileIds.length ? (
          <>
            <Button
              className="kb-folder-delete-dialog__action kb-folder-delete-dialog__action--keep"
              variant="primary"
              size="sm"
              onClick={() => deleteKnowledgeFolder(false)}
            >
              {t("kb.folder.deleteKeepFiles")}
            </Button>
            <Button
              className="kb-folder-delete-dialog__action kb-folder-delete-dialog__action--danger"
              variant="danger"
              size="sm"
              onClick={() => deleteKnowledgeFolder(true)}
            >
              {t("kb.folder.deleteWithFiles")}
            </Button>
          </>
        ) : (
          <Button
            className="kb-folder-delete-dialog__action kb-folder-delete-dialog__action--danger"
            variant="danger"
            size="sm"
            onClick={() => deleteKnowledgeFolder(false)}
          >
            {t("kb.folder.delete")}
          </Button>
        )}
      >
        <p className="kb-folder-delete-dialog__message">
          {deleteFolder?.fileIds.length
            ? t("kb.folder.deleteDesc", { count: deleteFolder.fileIds.length })
            : t("kb.folder.deleteEmptyDesc")}
        </p>
      </Modal>

      <ConfirmDialog
        open={removeFileIds != null}
        title={t("kb.removeConfirm.title")}
        message={t("kb.removeConfirm.desc", {
          count: removeFileIds?.length ?? 0,
          name: activeBase?.name ?? ""
        })}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("kb.removeConfirm.confirm")}
        confirmVariant="danger"
        onCancel={() => setRemoveFileIds(null)}
        onConfirm={confirmRemoveFromActiveBase}
      />

      <ConfirmDialog
        open={deleteFileIds != null}
        title={t("kb.deleteFilesConfirm.title")}
        message={t("kb.deleteFilesConfirm.desc", { count: deleteFileIds?.length ?? 0 })}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("kb.deleteFilesConfirm.confirm")}
        confirmVariant="danger"
        onCancel={() => setDeleteFileIds(null)}
        onConfirm={() => deleteLibraryFiles(deleteFileIds ?? [])}
      />

      <ConfirmDialog
        open={deleteBaseId != null}
        title={t("kb.deleteConfirm.title")}
        message={t("kb.deleteConfirm.desc", { name: bases.find((base) => base.id === deleteBaseId)?.name ?? "" })}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmVariant="danger"
        onCancel={() => setDeleteBaseId(null)}
        onConfirm={deleteSelectedBase}
      />

      {fileContextMenu ? (
        <div
          className={`composer-file-context-menu composer-file-context-menu--submenu-${fileContextMenu.submenuSide}`}
          role="menu"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {fileContextMenu.virtualFolderId ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => startFolderRename(
                  fileContextMenu.virtualFolderId!,
                  fileContextMenu.virtualFolderName ?? ""
                )}
              >
                <Pencil size={13} aria-hidden="true" />
                {t("common.rename")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="composer-file-context-menu__danger"
                onClick={() => {
                  setDeleteFolder({
                    id: fileContextMenu.virtualFolderId!,
                    name: fileContextMenu.virtualFolderName ?? "",
                    fileIds: [...fileContextMenu.fileIds]
                  });
                  setFileContextMenu(null);
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                {t("kb.folder.delete")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  addReferenceToChat(fileContextMenu.reference);
                  setFileContextMenu(null);
                }}
              >
                {t("composer.addToChat")}
              </button>
              {fileContextMenu.context === "library" && fileContextMenu.fileIds.length ? (
                <div className="composer-file-context-menu__submenu-anchor">
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={contextJoinMenuOpen}
                    className="composer-file-context-menu__submenu-trigger"
                    onClick={() => setContextJoinMenuOpen((open) => !open)}
                  >
                    <span>{t("kb.selection.join")}</span>
                    <ChevronRight size={13} aria-hidden="true" />
                  </button>
                  {contextJoinMenuOpen ? (
                    <div className="composer-file-context-menu__submenu" role="group" aria-label={t("kb.selection.join")}>
                      {bases.map((base) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={base.id}
                          onClick={() => {
                            addFileIdsToBase(fileContextMenu.fileIds, base.id);
                            setFileContextMenu(null);
                          }}
                        >
                          {base.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => showActionTargetInFolder(fileContextMenu)}
              >
                {t("kb.files.showInFolder")}
              </button>
              {fileContextMenu.context === "detail" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRemoveFileIds([...fileContextMenu.fileIds]);
                    setFileContextMenu(null);
                  }}
                >
                  {t("kb.detail.remove")}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="composer-file-context-menu__danger"
                onClick={() => {
                  setDeleteFileIds([...fileContextMenu.fileIds]);
                  setFileContextMenu(null);
                }}
              >
                {t("kb.toolbar.delete")}
              </button>
            </>
          )}
        </div>
      ) : null}
    </AppFrame>
  );
}
