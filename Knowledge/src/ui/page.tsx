import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type KnowledgeBase,
  type KnowledgeFiles,
  type KnowledgeFolder,
  type KnowledgeMember,
  type KnowledgeSettings,
  FILES_PAGE_SIZE,
  MAX_BASE_NAME_LENGTH,
} from "../types.js";

import { visiblePages } from "./pagination.js";
import {
  DOCUMENT_EXTENSIONS,
  fileRelativePath,
  filesFromDrop,
  folderSegments,
  isAbortError,
  isJunkUpload,
  resolveFolderId,
  summarizeUploads,
  uploadDocuments,
} from "./upload.js";

export interface KnowledgePageProps {
  connection: { baseUrl: string; localToken: string };
  language?: string;
  onSignIn?: () => void;
}

/* ---------- 图标（线性，currentColor） ---------- */
function I({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
const IC = {
  plus: "M12 5v14M5 12h14",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM21 21l-4.8-4.8",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  upload:
    "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  folder:
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  note: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
  mic: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4",
  trash:
    "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  sort: "M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 5v14",
  close: "M18 6 6 18M6 6l12 12",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM12 7v6M9 10h6",
  back: "M15 18l-6-6 6-6",
  fwd: "M9 18l6-6-6-6",
  edit: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
  move: "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20",
  open: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
} as const;

/** 统一默认封面：浅青底 + 深青线性书本。 */
function Cover({ large }: { large?: boolean }) {
  return (
    <span className={large ? "mk-cover mk-cover-lg" : "mk-cover"} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path
          d="M5 3.5h9a2 2 0 0 1 2 2V18a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 18V3.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M5 15.5h11" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    </span>
  );
}

function fileExtension(name: string) {
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return (ext || "file").toUpperCase().slice(0, 4);
}

function NameField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <span className="mk-name-field">
      <input
        value={value}
        onChange={(event) =>
          onChange(event.target.value.slice(0, MAX_BASE_NAME_LENGTH))
        }
        maxLength={MAX_BASE_NAME_LENGTH}
        required
        autoFocus
        placeholder={placeholder}
      />
      <span className="mk-name-count" aria-hidden="true">
        {value.length}/{MAX_BASE_NAME_LENGTH}
      </span>
    </span>
  );
}

function fileStatus(status: string, zh: boolean) {
  if (/available|可用|success|completed|done/i.test(status))
    return { cls: "mk-dot-ok", label: zh ? "可用" : "Available" };
  if (/处理中|上传中|pending|running|processing|uploading/i.test(status))
    return { cls: "mk-dot-busy", label: zh ? "处理中" : "Processing" };
  if (/fail|error|失败|无效/i.test(status))
    return { cls: "mk-dot-fail", label: zh ? "失败" : "Failed" };
  return { cls: "", label: status };
}

function Switch({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`mk-switch${on ? " mk-switch-on" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}

export function KnowledgePage({
  connection,
  language = "zh",
  onSignIn,
}: KnowledgePageProps) {
  const zh = language.startsWith("zh");
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [settings, setSettings] = useState<KnowledgeSettings | null>(null);
  const [name, setName] = useState("");
  const [activeId, setActiveId] = useState("");
  const [kbQuery, setKbQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [sortByName, setSortByName] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<KnowledgeMember | null>(null);
  const [fileDeleteTarget, setFileDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<KnowledgeFiles | null>(null);
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [folderId, setFolderId] = useState(""); // "" 表示知识库根目录
  const [folderBack, setFolderBack] = useState<string[]>([]);
  const [folderFwd, setFolderFwd] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState<KnowledgeFolder | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; kind: "folder" | "file"; id: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ kind: "folder" | "file"; id: string; name: string } | null>(null);
  const [moveDest, setMoveDest] = useState("");
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<KnowledgeFolder | null>(null);
  const [folderDeleteMode, setFolderDeleteMode] = useState<"out" | "all">("out");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState<
    | {
        baseId: string;
        kind: "progress";
        current: number;
        total: number;
        name: string;
      }
    | {
        baseId: string;
        kind: "done";
        succeeded: number;
        failed: number;
        format: number;
        size: number;
        other: number;
        stopped: boolean;
      }
    | null
  >(null);
  const [refresh, setRefresh] = useState(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const uploadingRef = useRef(false);
  const folderIdRef = useRef(folderId);
  folderIdRef.current = folderId;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [shareUserId, setShareUserId] = useState("");
  const [members, setMembers] = useState<KnowledgeMember[]>([]);
  const api = useMemo(
    () =>
      async <T,>(
        path: string,
        method = "GET",
        body?: unknown,
        signal?: AbortSignal,
      ): Promise<T> => {
        const response = await fetch(
          new URL(`/api/knowledge${path}`, connection.baseUrl),
          {
            method,
            signal,
            headers: {
              "x-memmy-local-token": connection.localToken,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : `HTTP ${response.status}`,
          );
        return data as T;
      },
    [connection.baseUrl, connection.localToken],
  );
  const acceptSettings = useCallback(
    (value: KnowledgeSettings, fallback: "first" | "none" = "first") => {
      setSettings(value);
      setActiveId((current) =>
        value.bases.some((base) => base.id === current)
          ? current
          : fallback === "first"
            ? (value.bases[0]?.id ?? "")
            : "",
      );
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    void api<KnowledgeSettings>(
      "/settings",
      "GET",
      undefined,
      controller.signal,
    )
      .then(acceptSettings)
      .catch((error) => {
        if (!controller.signal.aborted) { console.error("knowledge settings request failed", error); setError(zh ? "知识库暂时无法加载，请稍后重试。" : "Knowledge bases are temporarily unavailable. Please try again later."); }
      });
    return () => controller.abort();
  }, [api, acceptSettings]);
  useEffect(() => {
    uploadAbort.current?.abort();
    uploadingRef.current = false;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = undefined;
    setUploadNotice(null);
    setMenuOpen(false);
    setAddMenuOpen(false);
    setDragOver(false);
    setFileQuery("");
    setSortByName(false);
    setFolders([]);
    setFolderId("");
    setFolderBack([]);
    setFolderFwd([]);
    setCreatingFolder(false);
    setRenamingFolder(null);
    setRowMenu(null);
    setMoveTarget(null);
    setFolderDeleteTarget(null);
    setChecked(new Set());
    setBatchDeleteOpen(false);
  }, [activeId]);
  useEffect(() => {
    setMembers([]);
    if (!activeId || settings?.bases.find((base) => base.id === activeId)?.shared) return;
    void api<{ members: KnowledgeMember[] }>(`/bases/${encodeURIComponent(activeId)}/members`).then((value) => setMembers(value.members ?? [])).catch(() => setMembers([]));
  }, [activeId, settings, api]);
  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    void api<{ folders: KnowledgeFolder[] }>(
      `/bases/${encodeURIComponent(activeId)}/folders`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setFolders(value.folders ?? []);
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error)) setFolders([]);
      });
    return () => controller.abort();
  }, [activeId, api, refresh]);
  useEffect(() => {
    setListing(null);
  }, [activeId, page, folderId]);
  useEffect(() => {
    if (!activeId) return;
    const filesUnavailable = zh
      ? "知识库文件暂时无法加载，请稍后重试。"
      : "Knowledge files are temporarily unavailable. Please try again later.";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const load = async (attempt = 0) => {
      if (uploadingRef.current) return;
      try {
        const value = await api<KnowledgeFiles>(
          `/bases/${encodeURIComponent(activeId)}/files?page=${page}${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setListing(value);
        setError((current) => (current === filesUnavailable ? "" : current));
        // Refresh processing files and freshly uploaded files without resetting the management form.
        if (
          !uploadingRef.current &&
          (value.files.some((file) =>
            /处理中|上传中|pending|running|processing|uploading/i.test(
              file.status,
            ),
          ) ||
            (refresh > 0 && polls++ < 6))
        )
          timer = setTimeout(() => void load(), 5000);
      } catch (error) {
        if (
          controller.signal.aborted ||
          isAbortError(error) ||
          uploadingRef.current
        )
          return;
        if (attempt < 2) {
          timer = setTimeout(() => void load(attempt + 1), 1200);
          return;
        }
        console.error("knowledge files request failed", error);
        setError(filesUnavailable);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeId, page, folderId, api, refresh, zh]);
  useEffect(() => {
    if (!menuOpen && !addMenuOpen && !rowMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuOpen && !menuRef.current?.contains(target)) setMenuOpen(false);
      if (addMenuOpen && !addMenuRef.current?.contains(target))
        setAddMenuOpen(false);
      if (rowMenu && !(event.target as Element).closest?.(".mk-rowmenu"))
        setRowMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setAddMenuOpen(false);
        setRowMenu(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen, addMenuOpen, rowMenu]);
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      console.error("knowledge request failed", error);
      // 服务端返回的是可读文案（如“不支持的文档格式…”），优先展示；网络类错误回退到通用提示
      const serverMessage =
        error instanceof Error &&
        error.message &&
        !/failed to fetch|network ?error|load failed|abort/i.test(error.message)
          ? error.message
          : "";
      setError(serverMessage || (zh ? "知识库服务暂时不可用，请稍后重试。" : "Knowledge service is temporarily unavailable. Please try again later."));
    } finally {
      setBusy(false);
    }
  }
  async function save(patch: unknown) {
    acceptSettings(await api<KnowledgeSettings>("/settings", "PUT", patch));
  }
  function confirmDeleteActive() {
    if (!active || !settings) return;
    const id = active.id;
    const snapshot = settings;
    const remaining = settings.bases.filter((base) => base.id !== id);
    setDeleteOpen(false);
    setPage(1);
    acceptSettings(
      {
        ...settings,
        bases: remaining,
        enabled: remaining.some((base) => base.selected)
          ? settings.enabled
          : false,
      },
      "none",
    );
    void api<KnowledgeSettings>(`/bases/${encodeURIComponent(id)}`, "DELETE")
      .then((value) => acceptSettings(value, "none"))
      .catch((error) => {
        acceptSettings(snapshot);
        console.error("knowledge request failed", error);
        const serverMessage =
          error instanceof Error &&
          error.message &&
          !/failed to fetch|network ?error|load failed|abort/i.test(
            error.message,
          )
            ? error.message
            : "";
        setError(
          serverMessage ||
            (zh
              ? "知识库服务暂时不可用，请稍后重试。"
              : "Knowledge service is temporarily unavailable. Please try again later."),
        );
      });
  }
  function flushListRefresh() {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = undefined;
    setRefresh((value) => value + 1);
  }
  function rememberUploadedFile(name: string, destFolderId: string) {
    if (destFolderId !== folderIdRef.current) return;
    setListing((current) => {
      if (!current || current.files.some((file) => file.name === name))
        return current;
      return {
        ...current,
        files: [
          ...current.files,
          {
            id: `local-${destFolderId}-${name}`,
            name,
            status: "processing",
            message: "",
          },
        ],
        total: current.total + 1,
      };
    });
  }
  function startUpload(files: File[], baseId: string, targetFolderId = "") {
    const incoming = files.filter(
      (file) => !isJunkUpload(fileRelativePath(file)),
    );
    if (!incoming.length) return;
    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    const cache = new Map<string, string>();
    for (const folder of folders)
      cache.set(`${folder.parentId}\0${folder.name}`, folder.id);
    void (async () => {
      uploadingRef.current = true;
      setError("");
      setUploadNotice({
        baseId,
        kind: "progress",
        current: 1,
        total: incoming.length,
        name: incoming[0]?.name ?? "",
      });
      let succeeded = 0;
      try {
        const batch = await uploadDocuments(
          incoming,
          async (file, content, signal) => {
            const dest = await resolveFolderId(
              folderSegments(fileRelativePath(file)),
              targetFolderId,
              (parentId, name) => cache.get(`${parentId}\0${name}`),
              async (parentId, name) => {
                try {
                  const created = await api<{ id: string }>(
                    `/bases/${encodeURIComponent(baseId)}/folders`,
                    "POST",
                    {
                      name,
                      ...(parentId ? { parentId } : {}),
                    },
                    signal,
                  );
                  cache.set(`${parentId}\0${name}`, created.id);
                  setFolders((current) =>
                    current.some((folder) => folder.id === created.id)
                      ? current
                      : [
                          ...current,
                          { id: created.id, parentId, name },
                        ],
                  );
                  return created.id;
                } catch (error) {
                  if (signal?.aborted) throw error;
                  const latest = await api<{ folders: KnowledgeFolder[] }>(
                    `/bases/${encodeURIComponent(baseId)}/folders`,
                    "GET",
                    undefined,
                    signal,
                  );
                  const found = (latest.folders ?? []).find(
                    (folder) =>
                      folder.parentId === parentId && folder.name === name,
                  );
                  if (!found) throw error;
                  cache.set(`${parentId}\0${name}`, found.id);
                  setFolders(latest.folders ?? []);
                  return found.id;
                }
              },
            );
            await api(
              `/bases/${encodeURIComponent(baseId)}/files`,
              "POST",
              {
                name: file.name,
                content,
                ...(dest ? { folderId: dest } : {}),
              },
              signal,
            );
            rememberUploadedFile(file.name, dest);
          },
          (completed, total, name) =>
            setUploadNotice({
              baseId,
              kind: "progress",
              current: completed + 1,
              total,
              name,
            }),
          zh,
          controller.signal,
        );
        const summary = summarizeUploads(batch.results, batch.stopped);
        succeeded = summary.succeeded;
        setUploadNotice({ baseId, kind: "done", ...summary });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("knowledge upload failed", error);
        setUploadNotice(null);
        setError(
          zh
            ? "知识库服务暂时不可用，请稍后重试。"
            : "Knowledge service is temporarily unavailable. Please try again later.",
        );
      } finally {
        uploadingRef.current = false;
        if (succeeded) {
          setPage(1);
          if (page === 1) flushListRefresh();
        }
      }
    })();
  }
  function toggleBaseSelected(base: KnowledgeBase, on: boolean) {
    const ids = on
      ? [...selected, base.id]
      : selected.filter((id) => id !== base.id);
    void run(async () =>
      save({
        selectedIds: ids,
        ...(on && !settings?.enabled ? { enabled: true } : {}),
        ...(!ids.length ? { enabled: false } : {}),
      }),
    );
  }
  const active = settings?.bases.find((base) => base.id === activeId);
  const activeMembers = members.filter((member) => member.status === "ACTIVE");
  const ownedBases = settings?.bases.filter((base) => !base.shared) ?? [];
  const maxBases = settings?.maxBases ?? 10;
  const sharedBases = settings?.bases.filter((base) => base.shared) ?? [];
  const keyword = kbQuery.trim().toLowerCase();
  const matchKeyword = (base: KnowledgeBase) =>
    !keyword || base.name.toLowerCase().includes(keyword);
  const visibleOwned = ownedBases.filter(matchKeyword);
  const visibleShared = sharedBases.filter(matchKeyword);
  const selected =
    settings?.bases.filter((base) => base.selected).map((base) => base.id) ??
    [];
  const fileKeyword = fileQuery.trim().toLowerCase();
  const visibleFiles = (listing?.files ?? [])
    .filter((file) => !fileKeyword || file.name.toLowerCase().includes(fileKeyword))
    .slice()
    .sort((a, b) => (sortByName ? a.name.localeCompare(b.name, zh ? "zh" : "en") : 0));
  const quotaReached = ownedBases.length >= maxBases;

  /* ---------- 目录导航与操作 ---------- */
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const childFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.parentId === folderId)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, zh ? "zh" : "en")),
    [folders, folderId, zh],
  );
  const crumbPath = useMemo(() => {
    const path: KnowledgeFolder[] = [];
    let cursor = folderId;
    while (cursor) {
      const folder = folderById.get(cursor);
      if (!folder) break;
      path.unshift(folder);
      cursor = folder.parentId;
    }
    return path;
  }, [folderById, folderId]);
  /** 目录的可读路径（含根），用于标注上传落点，如「文件 / folder / 新建文件夹」。 */
  function folderPathLabel(id: string) {
    const names: string[] = [];
    let cursor = id;
    while (cursor) {
      const folder = folderById.get(cursor);
      if (!folder) break;
      names.unshift(folder.name);
      cursor = folder.parentId;
    }
    return [t("文件", "Files"), ...names].join(" / ");
  }
  /** 移动弹窗可选目录（排除被移动目录自身及其后代）。 */
  const moveOptions = useMemo(() => {
    if (!moveTarget || moveTarget.kind !== "folder") {
      return folders
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, zh ? "zh" : "en"))
        .map((folder) => ({ folder, depth: 0 }));
    }
    const banned = new Set<string>([moveTarget.id]);
    let grown = true;
    while (grown) {
      grown = false;
      for (const folder of folders)
        if (!banned.has(folder.id) && banned.has(folder.parentId) && banned.add(folder.id))
          grown = true;
    }
    const depthOf = (folder: KnowledgeFolder): number => {
      let depth = 0;
      let cursor = folder.parentId;
      while (cursor) {
        depth += 1;
        cursor = folderById.get(cursor)?.parentId ?? "";
      }
      return depth;
    };
    return folders
      .filter((folder) => !banned.has(folder.id))
      .sort((a, b) => a.name.localeCompare(b.name, zh ? "zh" : "en"))
      .map((folder) => ({ folder, depth: depthOf(folder) }));
  }, [moveTarget, folders, folderById, zh]);
  const visibleChildFolders = childFolders.filter(
    (folder) => !fileKeyword || folder.name.toLowerCase().includes(fileKeyword),
  );
  const subFolderCount = (id: string) =>
    folders.filter((folder) => folder.parentId === id).length;
  /* ---------- 批量选择与删除 ---------- */
  const visibleRowKeys = [
    ...visibleChildFolders.map((folder) => `folder:${folder.id}`),
    ...visibleFiles.map((file) => `file:${file.id}`),
  ];
  const allRowsChecked =
    visibleRowKeys.length > 0 && visibleRowKeys.every((key) => checked.has(key));
  const checkedFolderCount = [...checked].filter((key) =>
    key.startsWith("folder:"),
  ).length;
  const checkedFileCount = checked.size - checkedFolderCount;
  useEffect(() => {
    setChecked(new Set());
  }, [folderId, page, fileQuery]);
  function toggleChecked(key: string, on: boolean) {
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }
  function toggleCheckAll() {
    setChecked(allRowsChecked ? new Set() : new Set(visibleRowKeys));
  }
  function commitBatchDelete() {
    if (!active) return;
    const baseId = active.id;
    const folderIds = [...checked]
      .filter((key) => key.startsWith("folder:"))
      .map((key) => key.slice("folder:".length));
    const fileIds = [...checked]
      .filter((key) => key.startsWith("file:"))
      .map((key) => key.slice("file:".length));
    void run(async () => {
      await Promise.all([
        ...folderIds.map((id) =>
          api(`/folders/${encodeURIComponent(id)}`, "DELETE", { mode: "all" }),
        ),
        ...fileIds.map((id) =>
          api(
            `/bases/${encodeURIComponent(baseId)}/files/${encodeURIComponent(id)}`,
            "DELETE",
            { page },
          ),
        ),
      ]);
      setBatchDeleteOpen(false);
      setChecked(new Set());
      setRefresh((value) => value + 1);
    });
  }
  function enterFolder(id: string, pushHistory = true) {
    if (pushHistory) {
      setFolderBack((stack) => [...stack, folderId]);
      setFolderFwd([]);
    }
    setFolderId(id);
    setPage(1);
    setFileQuery("");
    setCreatingFolder(false);
    setRenamingFolder(null);
    setRowMenu(null);
  }
  function goFolderBack() {
    if (!folderBack.length) return;
    const previous = folderBack[folderBack.length - 1] ?? "";
    setFolderBack((stack) => stack.slice(0, -1));
    setFolderFwd((stack) => [...stack, folderId]);
    setFolderId(previous);
    setPage(1);
    setFileQuery("");
    setRowMenu(null);
  }
  function goFolderForward() {
    if (!folderFwd.length) return;
    const next = folderFwd[folderFwd.length - 1] ?? "";
    setFolderFwd((stack) => stack.slice(0, -1));
    setFolderBack((stack) => [...stack, folderId]);
    setFolderId(next);
    setPage(1);
    setFileQuery("");
    setRowMenu(null);
  }
  function commitCreateFolder() {
    const name = newFolderName.trim();
    if (!name || !active) return;
    void run(async () => {
      await api(`/bases/${encodeURIComponent(active.id)}/folders`, "POST", {
        name,
        ...(folderId ? { parentId: folderId } : {}),
      });
      setCreatingFolder(false);
      setNewFolderName("");
      setRefresh((value) => value + 1);
    });
  }
  function commitRenameFolder() {
    const name = renameFolderName.trim();
    if (!name || !renamingFolder) return;
    const target = renamingFolder;
    void run(async () => {
      await api(`/folders/${encodeURIComponent(target.id)}`, "PATCH", { name });
      setRenamingFolder(null);
      setRenameFolderName("");
      setRefresh((value) => value + 1);
    });
  }
  function openMove(kind: "folder" | "file", id: string, name: string) {
    setMoveDest(folderId);
    setMoveTarget({ kind, id, name });
  }
  function commitMove() {
    if (!moveTarget || !active) return;
    const target = moveTarget;
    void run(async () => {
      if (target.kind === "file")
        await api(
          `/bases/${encodeURIComponent(active.id)}/files/${encodeURIComponent(target.id)}`,
          "PATCH",
          { folderId: moveDest },
        );
      else
        await api(`/folders/${encodeURIComponent(target.id)}`, "PATCH", {
          parentId: moveDest,
        });
      setMoveTarget(null);
      setRefresh((value) => value + 1);
    });
  }
  function commitDeleteFolder() {
    if (!folderDeleteTarget) return;
    const target = folderDeleteTarget;
    void run(async () => {
      await api(`/folders/${encodeURIComponent(target.id)}`, "DELETE", {
        mode: folderDeleteMode,
      });
      if (crumbPath.some((folder) => folder.id === target.id)) setFolderId("");
      setFolderDeleteTarget(null);
      setRefresh((value) => value + 1);
    });
  }

  function kbItem(base: KnowledgeBase) {
    return (
      <div
        className={`mk-kb${base.id === activeId ? " mk-kb-active" : ""}`}
        key={base.id}
        role="button"
        tabIndex={0}
        onClick={() => {
          setActiveId(base.id);
          setPage(1);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setActiveId(base.id);
            setPage(1);
          }
        }}
      >
        <Cover />
        <div className="mk-kb-meta">
          <div className="mk-kb-name">{base.name}</div>
          {base.shared ? (
            <div className="mk-kb-sub">{t(`来自 ${base.ownerName || "其他用户"}`, `From ${base.ownerName || "another user"}`)}</div>
          ) : base.sharedByMe ? (
            <div className="mk-kb-sub">{t("已共享", "Shared")}</div>
          ) : null}
        </div>
        {base.selected && <span className="mk-recall-dot" title={t("已参与召回", "Used for recall")} />}
      </div>
    );
  }

  return (
    <section className="memmy-knowledge">
      <style>{styles}</style>

      {/* ============ 二级侧边栏 ============ */}
      <aside className="mk-side">
        <div className="mk-side-head">
          <h2>{t("知识库", "Knowledge")}</h2>
        </div>
        <button
          type="button"
          className="mk-new-btn"
          disabled={!settings || quotaReached}
          title={
            quotaReached
              ? t(`已达可创建上限（${ownedBases.length}/${maxBases}）`, `Limit reached (${ownedBases.length}/${maxBases})`)
              : t("新建知识库", "New knowledge base")
          }
          onClick={() => setCreateOpen(true)}
        >
          <I d={IC.plus} size={14} />
          {t("新建知识库", "New knowledge base")}
        </button>
        {settings && settings.bases.length > 3 && (
          <div className="mk-side-search">
            <I d={IC.search} size={13} />
            <input
              value={kbQuery}
              onChange={(event) => setKbQuery(event.target.value)}
              placeholder={t("搜索知识库", "Search bases")}
              aria-label={t("搜索知识库", "Search knowledge bases")}
            />
          </div>
        )}
        <div className="mk-side-scroll">
          {!settings ? (
            <p className="mk-side-loading" aria-live="polite">{t("加载中…", "Loading…")}</p>
          ) : (
            <>
              <div className="mk-group">
                <div className="mk-group-title">
                  {t("个人知识库", "Personal")}
                  <span className="mk-group-count">{ownedBases.length}</span>
                </div>
                {visibleOwned.map(kbItem)}
                {!visibleOwned.length && (
                  <p className="mk-group-empty">{ownedBases.length ? t("没有匹配的知识库", "No matching bases") : t("还没有知识库", "No knowledge bases yet")}</p>
                )}
              </div>
              {visibleShared.length > 0 && (
                <div className="mk-group">
                  <div className="mk-group-title">
                    {t("共享知识库", "Shared with me")}
                    <span className="mk-group-count">{sharedBases.length}</span>
                  </div>
                  {visibleShared.map(kbItem)}
                </div>
              )}
            </>
          )}
        </div>
        {settings && (
          <footer className="mk-side-foot">
            <span className="mk-quota">
              {t(`可创建的知识库：${ownedBases.length}/${maxBases}`, `Knowledge bases: ${ownedBases.length}/${maxBases}`)}
            </span>
          </footer>
        )}
      </aside>

      {/* ============ 主内容区 ============ */}
      <main className="mk-main">
        <fieldset aria-busy={busy}>
          {error && (
            <div className="mk-error" role="alert">
              {error}
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setRefresh((value) => value + 1);
                  void run(async () =>
                    acceptSettings(await api<KnowledgeSettings>("/settings")),
                  );
                }}
              >
                {t("重试", "Retry")}
              </button>
            </div>
          )}
          {!settings ? (
            <p aria-live="polite" className="mk-loading">
              {t("正在读取知识库配置…", "Loading knowledge settings…")}
            </p>
          ) : !settings.serviceAvailable ? (
            <p className="mk-notice" role="status">
              {t(
                settings.authenticated
                  ? "知识库服务暂未就绪，请稍后重试。"
                  : "登录 Memmy 后即可使用知识库，无需配置其他服务。",
                settings.authenticated
                  ? "Knowledge service is not ready. Please try again later."
                  : "Sign in to Memmy to use knowledge. No additional service setup is needed.",
              )}
              {!settings.authenticated && onSignIn && (
                <button type="button" onClick={onSignIn}>
                  {t("登录 Memmy", "Sign in to Memmy")}
                </button>
              )}
            </p>
          ) : !active ? (
            settings.bases.length === 0 ? (
              <div className="mk-empty-state">
                <div className="mk-illust">
                  <I d={IC.book} size={44} />
                </div>
                <h3>{t("创建你的第一个知识库", "Create your first knowledge base")}</h3>
                <p>{t("上传资料后，Memmy 会在对话中检索并引用这些内容", "Upload documents and Memmy will search and cite them in chats")}</p>
                <button type="button" className="mk-primary" onClick={() => setCreateOpen(true)}>
                  <I d={IC.plus} size={13} />
                  {t("新建知识库", "New knowledge base")}
                </button>
              </div>
            ) : (
              <div className="mk-empty-state mk-blank" />
            )
          ) : (
            <>
              {/* ---------- 知识库头部 ---------- */}
              <header className="mk-kbheader">
                <Cover large />
                <div className="mk-titleblock">
                  <h1>{active.name}</h1>
                  <div className="mk-meta">
                    {active.shared ? (
                      <>
                        <span>{t("共享知识库", "Shared knowledge base")}</span>
                        <span className="mk-meta-dot" />
                        <span>{t(`来自 ${active.ownerName || "其他用户"} · 仅可查看和参与召回`, `From ${active.ownerName || "another user"} · View and recall only`)}</span>
                      </>
                    ) : (
                      <>
                        <span>{t("个人知识库", "Personal knowledge base")}</span>
                        {activeMembers.length > 0 && (
                          <>
                            <span className="mk-meta-dot" />
                            <span>{t(`已共享给 ${activeMembers.length} 位用户`, `Shared with ${activeMembers.length}`)}</span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="mk-hactions">
                  <span className="mk-recall-inline" title={t("开启后，该知识库会参与 Agent 对话召回", "When on, this base participates in Agent recall")}>
                    {t("参与召回", "Recall")}
                    <Switch
                      on={active.selected}
                      disabled={!settings.serviceAvailable}
                      label={`${t("参与召回", "Use for recall")}: ${active.name}`}
                      onChange={(on) => toggleBaseSelected(active, on)}
                    />
                  </span>
                  {!active.shared && (
                    <div className="mk-menu-wrap" ref={menuRef}>
                      <button
                        type="button"
                        className="mk-icon-btn mk-icon-lg"
                        onClick={() => setMenuOpen((open) => !open)}
                        aria-label={t("更多操作", "More actions")}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                      >
                        <I d={IC.dots} size={17} />
                      </button>
                      {menuOpen && (
                        <div className="mk-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpen(false);
                              setRenameName(active.name);
                              setRenameOpen(true);
                            }}
                          >
                            {t("重命名知识库", "Rename")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpen(false);
                              setShareOpen(true);
                            }}
                          >
                            {t("共享管理", "Sharing")}
                            {activeMembers.length > 0 && <span className="mk-menu-count">{activeMembers.length}</span>}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="mk-menu-danger"
                            onClick={() => {
                              setMenuOpen(false);
                              setDeleteOpen(true);
                            }}
                          >
                            {t("删除知识库", "Delete")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {!active.shared && (
                    <div className="mk-menu-wrap" ref={addMenuRef}>
                      <button
                        type="button"
                        className="mk-primary"
                        onClick={() => setAddMenuOpen((open) => !open)}
                        aria-haspopup="menu"
                        aria-expanded={addMenuOpen}
                      >
                        <I d={IC.upload} size={13} />
                        {t("上传", "Upload")}
                      </button>
                      {addMenuOpen && (
                        <div className="mk-menu mk-addmenu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className="mk-am-item"
                            onClick={() => {
                              setAddMenuOpen(false);
                              uploadInput.current?.click();
                            }}
                          >
                            <span className="mk-am-icon"><I d={IC.file} /></span>
                            <span className="mk-am-name">{t("本地文件", "Local files")}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="mk-am-item"
                            onClick={() => {
                              setAddMenuOpen(false);
                              folderInput.current?.click();
                            }}
                          >
                            <span className="mk-am-icon"><I d={IC.folder} /></span>
                            <span className="mk-am-name">{t("本地文件夹", "Folder")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {!active.shared && (
                    <button
                      type="button"
                      className="mk-primary"
                      onClick={() => {
                        setCreatingFolder(true);
                        setNewFolderName(t("新建文件夹", "New folder"));
                      }}
                    >
                      <I d={IC.plus} size={13} />
                      {t("新建", "New")}
                    </button>
                  )}
                </div>
              </header>
              <input
                ref={uploadInput}
                type="file"
                hidden
                multiple
                accept={DOCUMENT_EXTENSIONS}
                aria-label={t("选择上传文件", "Select documents to upload")}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  startUpload(files, active.id, folderId);
                }}
              />
              <input
                ref={folderInput}
                type="file"
                hidden
                multiple
                aria-label={t("选择上传文件夹", "Select a folder to upload")}
                {...{ webkitdirectory: "" }}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  startUpload(files, active.id, folderId);
                }}
              />

              {/* ---------- 面包屑导航（目录内） ---------- */}
              {folderId && (
                <nav className="mk-nav" aria-label={t("目录路径", "Folder path")}>
                  <button
                    type="button"
                    className="mk-nav-arrow"
                    disabled={!folderBack.length}
                    onClick={goFolderBack}
                    title={t("后退", "Back")}
                    aria-label={t("后退", "Back")}
                  >
                    <span aria-hidden="true">←</span>
                  </button>
                  <button
                    type="button"
                    className="mk-nav-arrow"
                    disabled={!folderFwd.length}
                    onClick={goFolderForward}
                    title={t("前进", "Forward")}
                    aria-label={t("前进", "Forward")}
                  >
                    <span aria-hidden="true">→</span>
                  </button>
                  <div className="mk-crumb">
                    <a
                      role="button"
                      tabIndex={0}
                      onClick={() => enterFolder("")}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          enterFolder("");
                        }
                      }}
                    >
                      {t("文件", "Files")}
                    </a>
                    {crumbPath.map((folder) => (
                      <span key={folder.id} className="mk-crumb-item">
                        <span className="mk-crumb-sep">/</span>
                        {folder.id === folderId ? (
                          <span className="mk-crumb-cur">{folder.name}</span>
                        ) : (
                          <a
                            role="button"
                            tabIndex={0}
                            onClick={() => enterFolder(folder.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                enterFolder(folder.id);
                              }
                            }}
                          >
                            {folder.name}
                          </a>
                        )}
                      </span>
                    ))}
                  </div>
                </nav>
              )}

              {/* ---------- 工具条 ---------- */}
              <div className="mk-toolbar">
                <div className="mk-count">{t("文件", "Files")}</div>
                <div className="mk-spacer" />
                <div className="mk-fsearch">
                  <I d={IC.search} size={13} />
                  <input
                    value={fileQuery}
                    onChange={(event) => setFileQuery(event.target.value)}
                    placeholder={folderId ? t("搜索当前文件夹", "Search this folder") : t("搜索文件", "Search files")}
                    aria-label={t("搜索文件", "Search files")}
                  />
                </div>
                <button
                  type="button"
                  className={`mk-tool-btn${sortByName ? " mk-tool-on" : ""}`}
                  onClick={() => setSortByName((value) => !value)}
                  title={t("切换排序方式", "Toggle sort order")}
                >
                  <I d={IC.sort} size={13} />
                  {sortByName ? t("按名称", "By name") : t("默认排序", "Default")}
                </button>
              </div>
              {checked.size > 0 && !active.shared && (
                <div className="mk-batchbar" role="toolbar" aria-label={t("批量操作", "Batch actions")}>
                  <span className="mk-batch-count">
                    {t(`已选 ${checked.size} 项`, `${checked.size} selected`)}
                  </span>
                  <button type="button" className="mk-tool-btn" onClick={toggleCheckAll}>
                    {allRowsChecked ? t("取消全选", "Deselect all") : t("全选", "Select all")}
                  </button>
                  <div className="mk-spacer" />
                  <button type="button" className="mk-tool-btn" onClick={() => setChecked(new Set())}>
                    {t("取消选择", "Clear selection")}
                  </button>
                  <button type="button" className="mk-danger" onClick={() => setBatchDeleteOpen(true)}>
                    <I d={IC.trash} size={13} />
                    {t("删除", "Delete")}
                  </button>
                </div>
              )}
              {uploadNotice?.baseId === active.id && (
                <div
                  className="mk-upload-banner"
                  role="status"
                >
                  {uploadNotice.kind === "progress" ? (
                    <div className="mk-upload-progress">
                      <span>
                        {t(
                          `正在上传 ${uploadNotice.current}/${uploadNotice.total}：${uploadNotice.name}`,
                          `Uploading ${uploadNotice.current}/${uploadNotice.total}: ${uploadNotice.name}`,
                        )}
                      </span>
                      <button
                        type="button"
                        className="mk-tool-btn"
                        onClick={() => uploadAbort.current?.abort()}
                      >
                        {t("停止上传", "Stop")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="mk-icon-btn mk-upload-close"
                        aria-label={t("关闭", "Close")}
                        onClick={() => setUploadNotice(null)}
                      >
                        <I d={IC.close} size={14} />
                      </button>
                      <p>
                        {t(
                          `上传完成：成功 ${uploadNotice.succeeded} 个，失败 ${uploadNotice.failed} 个`,
                          `Upload complete: ${uploadNotice.succeeded} succeeded, ${uploadNotice.failed} failed`,
                        )}
                      </p>
                      {uploadNotice.stopped && (
                        <p>
                          {t("已停止，其余文件未上传。", "Stopped. Remaining files were not uploaded.")}
                        </p>
                      )}
                      {uploadNotice.format > 0 && (
                        <p>
                          {t(
                            `${uploadNotice.format} 个文件格式不支持，已跳过。支持 PDF、Word、TXT、Markdown、JSON、XML`,
                            `${uploadNotice.format} unsupported file(s) skipped. Supported: PDF, Word, TXT, Markdown, JSON, XML`,
                          )}
                        </p>
                      )}
                      {uploadNotice.size > 0 && (
                        <p>
                          {t(
                            `${uploadNotice.size} 个文件超过 20 MB`,
                            `${uploadNotice.size} file(s) exceed 20 MB`,
                          )}
                        </p>
                      )}
                      {uploadNotice.other > 0 && (
                        <p>
                          {t(
                            `${uploadNotice.other} 个文件未能上传`,
                            `${uploadNotice.other} file(s) failed to upload`,
                          )}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ---------- 文件区 ---------- */}
              <div
                className={`mk-body${dragOver ? " mk-body-drag" : ""}`}
                onDragOver={(event) => {
                  if (active.shared) return;
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  if (active.shared) return;
                  event.preventDefault();
                  setDragOver(false);
                  void filesFromDrop(event).then((files) =>
                    startUpload(files, active.id, folderId),
                  );
                }}
              >
                {!listing ? (
                  <p className="mk-loading">{t("正在读取文件…", "Loading files…")}</p>
                ) : visibleFiles.length === 0 && !visibleChildFolders.length && !creatingFolder ? (
                  folderId ? (
                    <div className="mk-empty-state">
                      <div className="mk-illust">
                        <I d={IC.folder} size={44} />
                      </div>
                      <h3>{t("这个文件夹是空的", "This folder is empty")}</h3>
                      <p>{t("上传文件到当前目录，或把其他文件移动到这里", "Upload files into this folder, or move existing files here")}</p>
                      {!active.shared && (
                        <p className="mk-empty-limit">{t(`也可以直接拖拽文件到这里，同样上传到「${folderPathLabel(folderId)}」`, `You can also drag files here; they upload to "${folderPathLabel(folderId)}"`)}</p>
                      )}
                    </div>
                  ) : (
                  <div className="mk-empty-state">
                    <div className="mk-illust">
                      <I d={IC.book} size={44} />
                    </div>
                    <h3>{t("知识库还是空的", "This knowledge base is empty")}</h3>
                    <p>{t("添加文件后，Agent 即可在对话中检索并引用这些资料", "Add documents and Agent can search and cite them in chats")}</p>
                    <div className="mk-fmts">
                      <span>PDF</span><span>Word</span><span>Markdown</span><span>TXT</span><span>JSON</span><span>XML</span>
                    </div>
                    {!active.shared && (
                      <p className="mk-empty-limit">{t("可拖拽文件到此处上传，每个文件最多 20 MB", "Drag files here to upload, up to 20 MB each")}</p>
                    )}
                  </div>
                  )
                ) : (
                  <ul className="mk-flist">
                    {creatingFolder && (
                      <li className="mk-frow mk-row-create">
                        <span className="mk-fic mk-fic-folder" aria-hidden="true"><I d={IC.folder} size={17} /></span>
                        <input
                          className="mk-create-input"
                          value={newFolderName}
                          maxLength={200}
                          autoFocus
                          onChange={(event) => setNewFolderName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitCreateFolder();
                            if (event.key === "Escape") setCreatingFolder(false);
                          }}
                          aria-label={t("文件夹名称", "Folder name")}
                        />
                        <button type="button" className="mk-primary" onClick={commitCreateFolder} disabled={!newFolderName.trim()}>
                          {t("创建", "Create")}
                        </button>
                        <button type="button" onClick={() => setCreatingFolder(false)}>
                          {t("取消", "Cancel")}
                        </button>
                      </li>
                    )}
                    {visibleChildFolders.map((folder) =>
                      renamingFolder?.id === folder.id ? (
                        <li key={folder.id} className="mk-frow">
                          <span className="mk-fic mk-fic-folder" aria-hidden="true"><I d={IC.folder} size={17} /></span>
                          <input
                            className="mk-create-input"
                            value={renameFolderName}
                            maxLength={200}
                            autoFocus
                            onChange={(event) => setRenameFolderName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitRenameFolder();
                              if (event.key === "Escape") setRenamingFolder(null);
                            }}
                            aria-label={t("文件夹名称", "Folder name")}
                          />
                          <button type="button" className="mk-primary" onClick={commitRenameFolder} disabled={!renameFolderName.trim()}>
                            {t("保存", "Save")}
                          </button>
                        </li>
                      ) : (
                        <li
                          key={folder.id}
                          className="mk-frow mk-frow-folder"
                          onClick={() => enterFolder(folder.id)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setRowMenu({ x: event.clientX, y: event.clientY, kind: "folder", id: folder.id });
                          }}
                        >
                          {!active.shared && (
                            <input
                              type="checkbox"
                              className="mk-check"
                              checked={checked.has(`folder:${folder.id}`)}
                              aria-label={t(`选择文件夹 ${folder.name}`, `Select folder ${folder.name}`)}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => toggleChecked(`folder:${folder.id}`, event.target.checked)}
                            />
                          )}
                          <span className="mk-fic mk-fic-folder" aria-hidden="true"><I d={IC.folder} size={17} /></span>
                          <div className="mk-fmeta">
                            <div className="mk-fname">{folder.name}</div>
                            {subFolderCount(folder.id) > 0 && (
                              <div className="mk-fsub">
                                {t(`${subFolderCount(folder.id)} 个子文件夹`, `${subFolderCount(folder.id)} subfolders`)}
                              </div>
                            )}
                          </div>
                          {!active.shared && (
                            <button
                              type="button"
                              className="mk-icon-btn mk-fdel"
                              aria-label={t(`删除文件夹 ${folder.name}`, `Delete folder ${folder.name}`)}
                              onClick={(event) => {
                                event.stopPropagation();
                                setFolderDeleteMode("out");
                                setFolderDeleteTarget(folder);
                              }}
                            >
                              <I d={IC.trash} size={14} />
                            </button>
                          )}
                        </li>
                      ),
                    )}
                    {visibleFiles.map((file) => {
                      const status = fileStatus(file.status, zh);
                      return (
                        <li
                          key={file.id}
                          className="mk-frow"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setRowMenu({ x: event.clientX, y: event.clientY, kind: "file", id: file.id });
                          }}
                        >
                          {!active.shared && (
                            <input
                              type="checkbox"
                              className="mk-check"
                              checked={checked.has(`file:${file.id}`)}
                              aria-label={t(`选择 ${file.name}`, `Select ${file.name}`)}
                              onChange={(event) => toggleChecked(`file:${file.id}`, event.target.checked)}
                            />
                          )}
                          <span className="mk-fic" aria-hidden="true">{fileExtension(file.name)}</span>
                          <div className="mk-fmeta">
                            <div className="mk-fname">{file.name}</div>
                            {file.message && <div className="mk-fsub">{file.message}</div>}
                          </div>
                          <span className={`mk-fstatus ${status.cls}`}>
                            <span className="mk-sdot" />
                            {status.label}
                          </span>
                          {!active.shared && (
                            <button
                              type="button"
                              className="mk-icon-btn mk-fdel"
                              aria-label={t(`删除 ${file.name}`, `Delete ${file.name}`)}
                              onClick={() => setFileDeleteTarget({ id: file.id, name: file.name })}
                            >
                              <I d={IC.trash} size={14} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                    {!visibleChildFolders.length && !visibleFiles.length && !creatingFolder && (
                      <p className="mk-loading">{t("没有匹配的文件。", "No matching files.")}</p>
                    )}
                  </ul>
                )}
                {listing && listing.total > FILES_PAGE_SIZE && (
                  <div className="mk-pagination">
                    <span>
                      {t(`共 ${listing.total} 个文件`, `${listing.total} files`)}
                    </span>
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      {t("上一页", "Previous")}
                    </button>
                    {visiblePages(
                      page,
                      Math.ceil(listing.total / FILES_PAGE_SIZE),
                    ).map((item, index) =>
                      item === "gap" ? (
                        <span key={`gap-${index}`} className="mk-page-gap">
                          …
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          className={item === page ? "mk-page-on" : undefined}
                          onClick={() => setPage(item)}
                        >
                          {item}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      disabled={page * FILES_PAGE_SIZE >= listing.total}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      {t("下一页", "Next")}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </fieldset>
      </main>

      {/* ============ 创建知识库（仅名称） ============ */}
      {settings && createOpen && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-create-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setCreateOpen(false)}><I d={IC.close} size={14} /></button><h2 id="mk-create-title">{t("创建个人知识库", "New knowledge base")}</h2><form onSubmit={(event) => { event.preventDefault(); const value = name.trim(); if (!value) return; void run(async () => { const before = new Set((settings?.bases ?? []).map((base) => base.id)); const next = await api<KnowledgeSettings>("/bases", "POST", { name: value }); acceptSettings(next); const created = next.bases.find((base) => !before.has(base.id)); if (created) setActiveId(created.id); setName(""); setCreateOpen(false); }); }}><label>{t("名称", "Name")}<NameField value={name} onChange={setName} placeholder={t("请输入知识库名称", "Knowledge base name")} /></label><div className="mk-modal-actions"><button type="button" onClick={() => setCreateOpen(false)}>{t("取消", "Cancel")}</button><button className="mk-primary" type="submit" disabled={!settings.serviceAvailable}>{t("确认创建", "Create")}</button></div></form></div></div>}
      {settings && renameOpen && active && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-rename-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setRenameOpen(false)}><I d={IC.close} size={14} /></button><h2 id="mk-rename-title">{t("重命名知识库", "Rename knowledge base")}</h2><p>{t("新名称会同步给所有已共享的用户，对方刷新后即可看到。", "The new name syncs to everyone this base is shared with once they refresh.")}</p><form onSubmit={(event) => { event.preventDefault(); const value = renameName.trim(); if (!value || value === active.name) { setRenameOpen(false); return; } void run(async () => { acceptSettings(await api<KnowledgeSettings>(`/bases/${encodeURIComponent(active.id)}`, "PATCH", { name: value })); setRenameName(""); setRenameOpen(false); }); }}><label>{t("名称", "Name")}<NameField value={renameName} onChange={setRenameName} /></label><div className="mk-modal-actions"><button type="button" onClick={() => setRenameOpen(false)}>{t("取消", "Cancel")}</button><button className="mk-primary" type="submit" disabled={!renameName.trim() || renameName.trim() === active.name}>{t("保存", "Save")}</button></div></form></div></div>}
      {settings && shareOpen && active && !active.shared && <div className="mk-modal-backdrop"><div className="mk-action-modal mk-share-modal" role="dialog" aria-modal="true" aria-labelledby="mk-share-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setShareOpen(false)}><I d={IC.close} size={14} /></button><h2 id="mk-share-title">{t("共享管理", "Sharing")}</h2><p className="mk-share-hint">{t("输入对方的 Memmy 用户 ID 即可共享此知识库；对方可在「账户」页面复制自己的 ID。被共享的用户可以查看文档并参与召回。", "Share by entering the other person's Memmy user ID. They can copy it from the Account page. Shared users can view documents and use recall.")}</p><form className="mk-share-form" onSubmit={(event) => { event.preventDefault(); const userId = shareUserId.trim(); if (!userId) return; void run(async () => { await api(`/bases/${encodeURIComponent(active.id)}/members`, "POST", { userId }); setShareUserId(""); const value = await api<{ members: KnowledgeMember[] }>(`/bases/${encodeURIComponent(active.id)}/members`); setMembers(value.members ?? []); acceptSettings(await api<KnowledgeSettings>("/settings")); }); }}><input value={shareUserId} onChange={(event) => setShareUserId(event.target.value)} placeholder={t("输入用户 ID", "Enter user ID")} aria-label={t("Memmy 用户 ID", "Memmy user ID")} required /><button className="mk-primary" type="submit" disabled={!shareUserId.trim()}>{t("添加", "Add")}</button></form>{activeMembers.length ? (<ul className="mk-members">{activeMembers.map((member) => (<li key={member.userId}><span className="mk-member-avatar" aria-hidden="true">{(member.name || "?").trim().charAt(0).toUpperCase()}</span><div className="mk-member-meta"><strong>{member.name}</strong><small>ID {member.userId}</small></div><button className="mk-member-revoke" type="button" onClick={() => setRevokeTarget(member)}>{t("移除", "Remove")}</button></li>))}</ul>) : (<p className="mk-share-empty">{t("暂未共享给其他用户。", "Not shared with anyone yet.")}</p>)}</div></div>}
      {revokeTarget && active && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-revoke-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setRevokeTarget(null)}><I d={IC.close} size={14} /></button><h2 id="mk-revoke-title">{t("取消分享", "Unshare knowledge base")}</h2><p>{t(`确定取消与“${revokeTarget.name}（${revokeTarget.userId}）”的共享吗？对方刷新后将无法继续访问此知识库。`, `Unshare this knowledge base from “${revokeTarget.name} (${revokeTarget.userId})”? They will lose access after refreshing.`)}</p><div className="mk-modal-actions"><button type="button" onClick={() => setRevokeTarget(null)}>{t("取消", "Cancel")}</button><button className="mk-danger" type="button" onClick={() => { const target = revokeTarget; void run(async () => { await api(`/bases/${encodeURIComponent(active.id)}/members/${encodeURIComponent(target.userId)}`, "DELETE"); setMembers((current) => current.filter((item) => item.userId !== target.userId)); setRevokeTarget(null); acceptSettings(await api<KnowledgeSettings>("/settings")); }); }}>{t("确认取消分享", "Unshare")}</button></div></div></div>}
      {deleteOpen && active && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-delete-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setDeleteOpen(false)}><I d={IC.close} size={14} /></button><h2 id="mk-delete-title">{t("删除知识库", "Delete knowledge base")}</h2><p>{t("彻底删除此知识库及全部文件？删除后无法恢复。", "Permanently delete this knowledge base and all its files? This cannot be undone.")}</p><div className="mk-modal-actions"><button type="button" onClick={() => setDeleteOpen(false)}>{t("取消", "Cancel")}</button><button className="mk-danger" type="button" onClick={confirmDeleteActive}>{t("确认删除", "Delete")}</button></div></div></div>}
      {fileDeleteTarget && active && <div className="mk-modal-backdrop"><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-file-delete-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setFileDeleteTarget(null)}><I d={IC.close} size={14} /></button><h2 id="mk-file-delete-title">{t("删除文件", "Delete file")}</h2><p>{t(`从云端删除“${fileDeleteTarget.name}”？此操作也会影响该知识库的其他使用方。`, `Delete “${fileDeleteTarget.name}” from the cloud? This also affects other users of this knowledge base.`)}</p><div className="mk-modal-actions"><button type="button" onClick={() => setFileDeleteTarget(null)}>{t("取消", "Cancel")}</button><button className="mk-danger" type="button" onClick={() => { const target = fileDeleteTarget; void run(async () => { await api(`/bases/${encodeURIComponent(active.id)}/files/${encodeURIComponent(target.id)}`, "DELETE", { page }); setFileDeleteTarget(null); setRefresh((value) => value + 1); }); }}>{t("确认删除", "Delete")}</button></div></div></div>}
      {/* ---------- 行右键菜单 ---------- */}
      {rowMenu && (() => {
        const folder = rowMenu.kind === "folder" ? folderById.get(rowMenu.id) : undefined;
        const file = rowMenu.kind === "file" ? (listing?.files ?? []).find((item) => item.id === rowMenu.id) : undefined;
        const name = folder?.name ?? file?.name ?? "";
        return (
          <div
            className="mk-rowmenu"
            role="menu"
            style={{
              left: Math.min(rowMenu.x, window.innerWidth - 200),
              top: Math.min(rowMenu.y, window.innerHeight - 220),
            }}
          >
            {rowMenu.kind === "folder" && (
              <button type="button" role="menuitem" onClick={() => { const id = rowMenu.id; setRowMenu(null); enterFolder(id); }}>
                <I d={IC.open} size={14} />
                {t("打开", "Open")}
              </button>
            )}
            {!active?.shared && (
              <button type="button" role="menuitem" onClick={() => { const target = { kind: rowMenu.kind, id: rowMenu.id, name }; setRowMenu(null); openMove(target.kind, target.id, target.name); }}>
                <I d={IC.move} size={14} />
                {t("移动到…", "Move to…")}
              </button>
            )}
            {rowMenu.kind === "folder" && !active?.shared && folder && (
              <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setRenameFolderName(folder.name); setRenamingFolder(folder); }}>
                <I d={IC.edit} size={14} />
                {t("重命名", "Rename")}
              </button>
            )}
            {rowMenu.kind === "file" && file && (
              <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setFileDeleteTarget({ id: file.id, name: file.name }); }}>
                <I d={IC.trash} size={14} />
                {t("删除", "Delete")}
              </button>
            )}
            {rowMenu.kind === "folder" && !active?.shared && folder && (
              <>
                <div className="mk-ctx-sep" />
                <button type="button" role="menuitem" className="mk-menu-danger" onClick={() => { setRowMenu(null); setFolderDeleteMode("out"); setFolderDeleteTarget(folder); }}>
                  <I d={IC.trash} size={14} />
                  {t("删除", "Delete")}
                </button>
              </>
            )}
          </div>
        );
      })()}
      {/* ---------- 移动到目录 ---------- */}
      {moveTarget && (<div className="mk-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMoveTarget(null); }}><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-move-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setMoveTarget(null)}><I d={IC.close} size={14} /></button><h2 id="mk-move-title">{t("移动到…", "Move to…")}</h2><p>{t(`将“${moveTarget.name}”移动到：`, `Move “${moveTarget.name}” to:`)}</p><div className="mk-tree"><div className={`mk-tree-item${moveDest === "" ? " mk-tree-on" : ""}`} role="button" tabIndex={0} onClick={() => setMoveDest("")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setMoveDest(""); } }}><I d={IC.folder} size={14} />{t("文件（根目录）", "Files (root)")}</div>{moveOptions.map(({ folder, depth }) =><div key={folder.id} className={`mk-tree-item${moveDest === folder.id ? " mk-tree-on" : ""}`} style={{ paddingLeft: 10 + depth * 22 }} role="button" tabIndex={0} onClick={() => setMoveDest(folder.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setMoveDest(folder.id); } }}><I d={IC.folder} size={14} />{folder.name}</div>)}</div><div className="mk-modal-note"><I d={IC.book} size={13} /><span>{t("目录结构保存在 Memmy 本地，移动不会重新上传文件。", "Folders are stored in Memmy. Moving does not re-upload files.")}</span></div><div className="mk-modal-actions"><button type="button" onClick={() => setMoveTarget(null)}>{t("取消", "Cancel")}</button><button className="mk-primary" type="button" onClick={commitMove}>{t("移动", "Move")}</button></div></div></div>)}
      {/* ---------- 拖拽上传落点提示 ---------- */}
      {dragOver && !active?.shared && (
        <div className="mk-drop-mask" aria-hidden="true">
          <div className="mk-drop-card">
            <h3>{t("松开鼠标上传", "Drop to upload")}</h3>
            <p>{t("上传到：", "Upload to: ")}{folderPathLabel(folderId)}</p>
          </div>
        </div>
      )}
      {/* ---------- 批量删除 ---------- */}
      {batchDeleteOpen && active && (
        <div className="mk-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBatchDeleteOpen(false); }}>
          <div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-batch-delete-title">
            <button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setBatchDeleteOpen(false)}><I d={IC.close} size={14} /></button>
            <h2 id="mk-batch-delete-title">{t("批量删除", "Delete selected")}</h2>
            <p>
              {checkedFolderCount > 0 && checkedFileCount > 0
                ? t(
                    `将删除选中的 ${checkedFolderCount} 个文件夹和 ${checkedFileCount} 个文件；文件夹中的内容会一并删除，且无法恢复。`,
                    `Delete the selected ${checkedFolderCount} folder(s) and ${checkedFileCount} file(s)? Folder contents are deleted too. This cannot be undone.`,
                  )
                : checkedFolderCount > 0
                  ? t(
                      `将删除选中的 ${checkedFolderCount} 个文件夹，其中的内容会一并删除，且无法恢复。`,
                      `Delete the selected ${checkedFolderCount} folder(s)? Their contents are deleted too. This cannot be undone.`,
                    )
                  : t(
                      `将删除选中的 ${checkedFileCount} 个文件，删除后无法恢复。`,
                      `Delete the selected ${checkedFileCount} file(s)? This cannot be undone.`,
                    )}
            </p>
            <div className="mk-modal-actions">
              <button type="button" onClick={() => setBatchDeleteOpen(false)}>{t("取消", "Cancel")}</button>
              <button className="mk-danger" type="button" onClick={commitBatchDelete}>{t("确认删除", "Delete")}</button>
            </div>
          </div>
        </div>
      )}
      {/* ---------- 删除文件夹 ---------- */}
      {folderDeleteTarget && (<div className="mk-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFolderDeleteTarget(null); }}><div className="mk-action-modal" role="dialog" aria-modal="true" aria-labelledby="mk-folder-delete-title"><button className="mk-modal-close" aria-label={t("关闭", "Close")} onClick={() => setFolderDeleteTarget(null)}><I d={IC.close} size={14} /></button><h2 id="mk-folder-delete-title">{t("删除文件夹", "Delete folder")}</h2><p>{t(`删除文件夹“${folderDeleteTarget.name}”后，其中的内容如何处理？`, `What should happen to the contents of “${folderDeleteTarget.name}”?`)}</p><label className="mk-radio"><input type="radio" name="mk-folder-delete-mode" checked={folderDeleteMode === "out"} onChange={() => setFolderDeleteMode("out")} />{t("仅删除文件夹，文件移回上级目录", "Delete the folder only; files move to the parent folder")}</label><label className="mk-radio"><input type="radio" name="mk-folder-delete-mode" checked={folderDeleteMode === "all"} onChange={() => setFolderDeleteMode("all")} />{t("连同文件一起删除", "Also delete the files")}</label><div className="mk-modal-actions"><button type="button" onClick={() => setFolderDeleteTarget(null)}>{t("取消", "Cancel")}</button><button className="mk-danger" type="button" onClick={commitDeleteFolder}>{t("确认删除", "Delete")}</button></div></div></div>)}
    </section>
  );
}
const styles = `
/* ===== 简约主题：中性灰白 + 单一青绿主色 ===== */
.memmy-knowledge{--mk-accent:#2fb393;--mk-accent-hover:#25a082;--mk-accent-tint:#e6f4f0;--mk-accent-deep:#3d8570;--mk-side:#f7f9f8;--mk-line:#e9efed;--mk-line-strong:#dfe7e4;--mk-ink:#1b2a27;--mk-sub:#5f716d;--mk-ter:#9aa8a4;--mk-warn:#dfa04a;--mk-err:#e1707e;display:flex;height:100%;min-height:0;position:relative;color:var(--mk-ink);font-size:14px;width:100%;box-sizing:border-box;background:#fff}
.memmy-knowledge fieldset{border:0;padding:0;margin:0;min-width:0;display:contents}
.memmy-knowledge p{margin:6px 0;line-height:1.65}
.memmy-knowledge button{-webkit-appearance:none;appearance:none;border:1px solid var(--mk-line-strong);border-radius:8px;padding:7px 12px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;font-size:13px;font-family:inherit;transform:none;transition:background .15s ease,border-color .15s ease,color .15s ease}
.memmy-knowledge button:hover{background:#f4f7f6}
.memmy-knowledge button:active{transform:none;filter:none}
.memmy-knowledge button:disabled,.memmy-knowledge fieldset:disabled{opacity:.55;cursor:default}
.memmy-knowledge input{border:1px solid var(--mk-line-strong);border-radius:8px;padding:8px 12px;background:#fff;color:inherit;min-width:0;box-sizing:border-box;font-size:13px;font-family:inherit}
.memmy-knowledge input:focus-visible{outline:none;border-color:var(--mk-accent);box-shadow:0 0 0 3px rgba(47,179,147,.14)}
.memmy-knowledge :focus-visible{outline:2px solid var(--mk-accent);outline-offset:2px}
.memmy-knowledge .mk-primary{display:inline-flex;align-items:center;gap:6px;background:var(--mk-accent);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-weight:700}
.memmy-knowledge .mk-primary:hover:not(:disabled),.memmy-knowledge .mk-primary:active:not(:disabled){background:var(--mk-accent-hover);transform:none}
.memmy-knowledge .mk-primary:disabled{opacity:1;background:var(--mk-accent);color:#fff}
.memmy-knowledge .mk-danger{background:#c05a55;color:#fff;border:0;border-radius:8px;padding:8px 16px}
.memmy-knowledge .mk-danger:hover{background:#a94c47}
.memmy-knowledge .mk-loading{padding:40px 0;text-align:center;color:var(--mk-ter);font-size:13px}
.mk-error{padding:12px 16px;margin:16px 32px 0;border:1px solid #ecc3c1;border-radius:10px;color:#b74b46;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fdf6f5;font-size:13px}
.mk-notice{padding:11px 14px;background:var(--mk-accent-tint);border-radius:10px;font-size:13px;color:var(--mk-accent-deep);margin:16px 32px 0}

/* ---------- 开关 ---------- */
.memmy-knowledge .mk-switch{position:relative;width:32px;height:19px;border-radius:20px;background:#d5dfdc;border:0;padding:0;transition:background .15s ease;flex-shrink:0}
.memmy-knowledge .mk-switch:hover{background:#c8d4d0}
.memmy-knowledge .mk-switch span{position:absolute;top:2.5px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s ease}
.memmy-knowledge .mk-switch-on{background:var(--mk-accent)}
.memmy-knowledge .mk-switch-on:hover{background:var(--mk-accent-hover)}
.memmy-knowledge .mk-switch-on span{transform:translateX(12px)}

/* ---------- 图标按钮 / 封面 ---------- */
.memmy-knowledge .mk-icon-btn{width:26px;height:26px;min-width:26px;min-height:26px;box-sizing:border-box;border:0;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;color:var(--mk-ter);padding:0;flex:0 0 auto;background:transparent}
.memmy-knowledge .mk-icon-btn:hover{background:rgba(27,42,39,.05);color:var(--mk-ink)}
.memmy-knowledge .mk-icon-lg{width:30px;height:30px;min-width:30px;min-height:30px}
.mk-cover{border-radius:8px;background:var(--mk-accent-tint);color:var(--mk-accent-deep);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:26px;height:26px}
.mk-cover svg{width:15px;height:15px}
.mk-cover-lg{width:56px;height:56px;border-radius:14px}
.mk-cover-lg svg{width:28px;height:28px}

/* ---------- 二级侧边栏 ---------- */
.mk-side{width:244px;flex-shrink:0;background:var(--mk-side);border-right:1px solid var(--mk-line);display:flex;flex-direction:column;min-height:0;padding-top:var(--codex-toolbar-height,46px)}
.mk-side-head{display:flex;align-items:center;justify-content:space-between;padding:6px 14px 8px}
.mk-side-head h2{font-size:15px;font-weight:800;margin:0}
.memmy-knowledge .mk-new-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:calc(100% - 24px);margin:2px 12px 10px;padding:8px 12px;border:1px solid var(--mk-line-strong);border-radius:8px;background:#fff;font-size:13px;font-weight:700;color:var(--mk-sub)}
.memmy-knowledge .mk-new-btn:hover:not(:disabled){border-color:var(--mk-accent);color:var(--mk-accent-deep);background:var(--mk-accent-tint)}
.mk-side-search{display:flex;align-items:center;gap:6px;margin:2px 12px 8px;padding:5px 9px;background:#fff;border:1px solid var(--mk-line);border-radius:8px;color:var(--mk-ter)}
.mk-side-search input{border:0;padding:2px 0;font-size:12px;background:transparent}
.mk-side-search input:focus-visible{outline:none;box-shadow:none;border:0}
.mk-side-scroll{flex:1;overflow-y:auto;padding:0 8px 12px;min-height:0}
.mk-side-loading{padding:20px 10px;font-size:12px;color:var(--mk-ter)}
.mk-group{margin-top:6px}
.mk-group-title{padding:6px 10px;font-size:11.5px;font-weight:700;color:var(--mk-ter)}
.mk-group-count{margin-left:6px;font-size:10.5px;font-weight:700;color:var(--mk-ter);background:rgba(27,42,39,.06);padding:1px 6px;border-radius:999px}
.mk-group-empty{padding:8px 10px;font-size:12px;color:var(--mk-ter)}
.mk-kb{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;cursor:pointer;transition:background .15s ease}
.mk-kb:hover{background:rgba(27,42,39,.04)}
.mk-kb-active{background:var(--mk-accent-tint)}
.mk-kb-active .mk-kb-name{color:var(--mk-accent-deep)}
.mk-kb-meta{flex:1;min-width:0}
.mk-kb-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-kb-sub{font-size:11px;color:var(--mk-ter);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-recall-dot{width:5px;height:5px;border-radius:50%;background:var(--mk-accent);flex-shrink:0}
.mk-side-foot{padding:10px 16px}
.mk-quota{font-size:11.5px;color:var(--mk-ter)}

/* ---------- 主内容区 ---------- */
.mk-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow-y:auto;padding-top:var(--codex-toolbar-height,46px)}
.mk-kbheader{display:flex;align-items:flex-start;gap:16px;padding:10px 32px 0;flex-wrap:wrap}
.mk-titleblock{flex:1;min-width:0}
.mk-titleblock h1{font-size:20px;font-weight:800;margin:0;letter-spacing:.01em}
.mk-meta{display:flex;align-items:center;gap:10px;margin-top:6px;font-size:12px;color:var(--mk-ter);font-weight:600;flex-wrap:wrap;row-gap:3px}
.mk-meta-dot{width:3px;height:3px;border-radius:50%;background:var(--mk-line-strong)}
.mk-hactions{display:flex;align-items:center;gap:12px;padding-top:6px}
.mk-recall-inline{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;color:var(--mk-sub)}
.mk-menu-wrap{position:relative}
.mk-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:30;background:#fff;border:1px solid var(--mk-line);border-radius:12px;box-shadow:0 16px 48px rgba(27,42,39,.14);padding:6px;min-width:170px}
.memmy-knowledge .mk-menu button{display:flex;align-items:center;width:100%;border:0;border-radius:8px;padding:8px 10px;text-align:left;font-size:13px;background:transparent}
.memmy-knowledge .mk-menu button:hover{background:#f4f7f6}
.mk-menu-count{margin-left:auto;font-size:11px;color:var(--mk-ter)}
.memmy-knowledge .mk-menu .mk-menu-danger{color:#c05a55}
.memmy-knowledge .mk-menu .mk-menu-danger:hover{background:#faf0ef}
.mk-addmenu{width:216px}
.memmy-knowledge .mk-am-item{gap:11px}
.mk-am-item .mk-am-icon{width:28px;height:28px;border-radius:7px;background:#f2f5f4;color:var(--mk-sub);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.mk-am-name{display:block;font-size:13px;font-weight:700}
.mk-am-sub{display:block;font-size:10.5px;color:var(--mk-ter);margin-top:1px}
.mk-am-soon{margin-left:auto;font-size:10px;font-weight:700;color:var(--mk-ter);background:rgba(27,42,39,.06);padding:2px 7px;border-radius:999px}
.mk-am-disabled{opacity:.55;cursor:default;display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:8px}
.mk-am-divider{height:1px;background:var(--mk-line);margin:5px 10px}

/* ---------- 工具条 ---------- */
.mk-toolbar{display:flex;align-items:center;gap:10px;padding:22px 32px 14px}
.mk-count{font-size:13px;font-weight:800}
.mk-count em{font-style:normal;color:var(--mk-ter);font-weight:700;margin-left:2px}
.mk-spacer{flex:1}
.mk-fsearch{display:flex;align-items:center;gap:7px;background:#f6f8f8;border:1px solid transparent;border-radius:8px;padding:5px 11px;width:180px;color:var(--mk-ter)}
.mk-fsearch:focus-within{background:#fff;border-color:var(--mk-accent)}
.mk-fsearch input{border:0;background:transparent;padding:1px 0;font-size:12.5px;width:100%}
.mk-fsearch input:focus-visible{outline:none;box-shadow:none;border:0}
.memmy-knowledge .mk-tool-btn{display:inline-flex;align-items:center;gap:5px;border:0;padding:6px 9px;font-size:12px;font-weight:700;color:var(--mk-sub);background:transparent}
.memmy-knowledge .mk-tool-btn:hover{color:var(--mk-ink);background:rgba(27,42,39,.05)}
.memmy-knowledge .mk-tool-on{color:var(--mk-accent-deep);background:var(--mk-accent-tint)}
.mk-upload-banner{position:relative;margin:0 32px 12px;padding:10px 36px 10px 14px;border-radius:10px;background:#f7faf9;color:var(--mk-accent-deep);font-size:12.5px;line-height:1.65}
.mk-upload-banner p{margin:0}
.mk-upload-banner p+p{margin-top:4px}
.mk-upload-progress{display:flex;align-items:center;gap:10px;padding-right:0}
.mk-upload-progress span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.memmy-knowledge .mk-upload-close{position:absolute;right:8px;top:8px}

/* ---------- 文件区 ---------- */
.mk-body{flex:1;padding:0 32px 28px;min-height:0}
.mk-body-drag .mk-flist,.mk-body-drag .mk-empty-state{outline:1.5px dashed var(--mk-accent);outline-offset:8px;border-radius:12px}
.mk-drop-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(230,244,240,.72);pointer-events:none}
.mk-drop-card{background:#fff;border:1.5px dashed var(--mk-accent);border-radius:16px;padding:26px 40px;text-align:center;box-shadow:0 16px 48px rgba(27,42,39,.14)}
.mk-drop-card h3{margin:0 0 6px;font-size:15px;font-weight:800;color:var(--mk-accent-deep)}
.mk-drop-card p{margin:0;font-size:12.5px;color:var(--mk-sub)}
.mk-flist{list-style:none;padding:0;margin:0}
.mk-check{width:15px;height:15px;accent-color:var(--mk-accent);flex-shrink:0;cursor:pointer;margin:0}
.mk-batchbar{display:flex;align-items:center;gap:10px;padding:0 32px 10px;font-size:12.5px}
.mk-batch-count{font-weight:700;color:var(--mk-sub)}
.mk-batchbar .mk-danger{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12.5px}
.mk-frow{display:flex;align-items:center;gap:13px;border:1px solid var(--mk-line);border-radius:10px;padding:12px 16px;margin-bottom:8px;transition:border-color .15s ease,box-shadow .15s ease}
.mk-frow:hover{border-color:var(--mk-line-strong);box-shadow:0 6px 20px rgba(27,42,39,.06)}
.mk-fic{width:36px;height:36px;border-radius:9px;background:#f2f5f4;color:#7d8d88;display:inline-flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:800;letter-spacing:.02em;flex-shrink:0}
.mk-fmeta{flex:1;min-width:0}
.mk-fname{font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-fsub{font-size:11.5px;color:var(--mk-ter);font-weight:600;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-fstatus{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:var(--mk-sub);flex-shrink:0}
.mk-sdot{width:6px;height:6px;border-radius:50%;background:var(--mk-line-strong)}
.mk-dot-ok .mk-sdot{background:var(--mk-accent)}
.mk-dot-busy .mk-sdot{background:var(--mk-warn);animation:mk-pulse 1.2s infinite}
.mk-dot-fail{color:var(--mk-err)}
.mk-dot-fail .mk-sdot{background:var(--mk-err)}
@keyframes mk-pulse{50%{opacity:.35}}
.memmy-knowledge .mk-fdel{opacity:0;transition:opacity .15s ease}
.mk-frow:hover .mk-fdel{opacity:1}
.memmy-knowledge .mk-fdel:hover{background:#faf0ef;color:#c05a55}
.mk-pagination{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:14px;font-size:12px;color:var(--mk-ter);flex-wrap:wrap}
.mk-pagination>span:first-child{margin-right:auto}
.memmy-knowledge .mk-pagination button{min-width:28px;padding:5px 8px;border:0;background:transparent}
.memmy-knowledge .mk-pagination button:hover:not(:disabled){background:#f4f7f6}
.memmy-knowledge .mk-pagination .mk-page-on{background:var(--mk-accent-tint);color:var(--mk-accent-deep);font-weight:700}
.mk-page-gap{padding:0 4px}

/* ---------- 空状态 ---------- */
.mk-empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 32px;text-align:center}
.mk-blank{padding:0}
.mk-illust{width:112px;height:112px;border-radius:26px;background:var(--mk-accent-tint);color:var(--mk-accent-deep);display:flex;align-items:center;justify-content:center;margin-bottom:22px;position:relative}
.mk-illust::after{content:"";position:absolute;inset:-11px;border-radius:34px;border:1.5px dashed rgba(47,179,147,.35)}
.mk-empty-state h3{font-size:16px;font-weight:800;margin:0 0 8px}
.mk-empty-state p{font-size:13px;color:var(--mk-ter);margin:0 0 20px}
.mk-empty-cta{margin-bottom:4px}
.mk-fmts{display:flex;gap:8px;margin-top:18px}
.mk-fmts span{font-size:11px;font-weight:700;color:var(--mk-sub);background:#f4f7f6;padding:4px 11px;border-radius:999px}
.mk-empty-limit{font-size:11.5px;color:var(--mk-ter);margin-top:14px!important}

/* ---------- 共享弹窗 ---------- */
.mk-share-modal{width:440px}
.mk-share-hint{font-size:12px;color:var(--mk-ter);line-height:1.7;margin:0 0 14px!important}
.mk-share-form{display:flex;gap:10px}
.mk-share-form input{flex:1}
.mk-share-form .mk-primary{flex-shrink:0;padding:8px 18px}
.mk-members{list-style:none;padding:0;margin:14px 0 0;max-height:260px;overflow-y:auto}
.mk-members li{display:flex;align-items:center;gap:12px;padding:10px 4px;border-radius:8px}
.mk-members li:hover{background:#f7faf9}
.mk-members li+li{border-top:1px solid var(--mk-line)}
.mk-member-avatar{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#37b795,#1f8f74);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.mk-member-meta{min-width:0;flex:1}
.mk-member-meta strong,.mk-member-meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mk-member-meta strong{font-size:13px;font-weight:600}
.mk-member-meta small{font-size:11px;color:var(--mk-ter);margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.memmy-knowledge .mk-member-revoke{border:0;background:transparent;font-size:12px;color:var(--mk-ter);padding:5px 8px;border-radius:7px}
.memmy-knowledge .mk-member-revoke:hover{color:#c05a55;background:#faf0ef}
.mk-share-empty{font-size:12px;color:var(--mk-ter);margin:14px 0 0!important}
@media(max-width:560px){.mk-share-form{flex-wrap:wrap}.mk-share-form .mk-primary{width:100%}}

/* ---------- 弹窗 ---------- */
.mk-modal-backdrop{position:fixed;inset:0;background:rgba(27,42,39,.26);backdrop-filter:blur(2px);z-index:10002;display:grid;place-items:center}
.mk-action-modal{position:relative;width:400px;max-width:calc(100vw - 48px);background:#fff;border-radius:16px;padding:24px 26px 20px;box-shadow:0 16px 48px rgba(27,42,39,.18)}
.mk-action-modal h2{font-size:15.5px;font-weight:800;margin:0 0 16px}
.mk-action-modal>p{font-size:12.5px;color:var(--mk-sub);margin:0 0 18px;line-height:1.65}
.mk-action-modal form{display:grid;gap:12px}
.mk-action-modal label{display:grid;gap:7px;font-size:12.5px;font-weight:700}
.mk-name-field{position:relative;display:block}
.mk-name-field input{width:100%;padding-right:52px}
.mk-name-count{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:600;color:var(--mk-ter);pointer-events:none}
.memmy-knowledge .mk-modal-close{position:absolute;right:14px;top:14px;border:0;padding:4px;color:var(--mk-ter);background:transparent;border-radius:7px;display:inline-flex}
.memmy-knowledge .mk-modal-close:hover{background:#f4f7f6;color:var(--mk-ink)}
.mk-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
/* ---------- 目录导航 ---------- */
.mk-nav{display:flex;align-items:center;gap:8px;padding:18px 32px 0}
.mk-nav-arrow{border:0;background:transparent;padding:2px 7px;font-size:17px;font-weight:600;line-height:1;color:var(--mk-ink);border-radius:6px}
.mk-nav-arrow:hover:not(:disabled){background:rgba(27,42,39,.06)}
.mk-nav-arrow:disabled{color:var(--mk-ter);cursor:default}
.mk-crumb{display:flex;align-items:center;gap:2px;font-size:13px;font-weight:700;min-width:0;flex-wrap:wrap}
.mk-crumb a{color:var(--mk-accent-deep);cursor:pointer;border-radius:6px;padding:3px 6px}
.mk-crumb a:hover{background:var(--mk-accent-tint)}
.mk-crumb-item{display:inline-flex;align-items:center;gap:2px;min-width:0}
.mk-crumb-sep{color:var(--mk-ter);font-weight:400}
.mk-crumb-cur{color:var(--mk-ink);padding:3px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------- 目录行 / 行内编辑 ---------- */
.mk-frow-folder{cursor:pointer}
.mk-fic-folder{background:var(--mk-accent-tint);color:var(--mk-accent-deep)}
.mk-row-create{border-style:dashed;border-color:var(--mk-accent);background:var(--mk-accent-tint)}
.mk-create-input{flex:1;min-width:0;padding:7px 11px;font-size:13px}

/* ---------- 行右键菜单 ---------- */
.mk-rowmenu{position:fixed;z-index:200;background:#fff;border:1px solid var(--mk-line);border-radius:12px;box-shadow:0 16px 48px rgba(27,42,39,.16);padding:6px;min-width:180px}
.mk-rowmenu button{display:flex;align-items:center;gap:9px;width:100%;border:0;border-radius:8px;padding:8px 10px;text-align:left;font-size:13px;background:transparent}
.mk-rowmenu button:hover{background:#f4f7f6}
.mk-rowmenu button svg{color:var(--mk-ter);flex-shrink:0}
.mk-rowmenu .mk-menu-danger{color:#c05a55}
.mk-rowmenu .mk-menu-danger svg{color:#c05a55}
.mk-ctx-sep{height:1px;background:var(--mk-line);margin:5px 8px}

/* ---------- 移动到弹窗 ---------- */
.mk-tree{max-height:260px;overflow-y:auto;border:1px solid var(--mk-line);border-radius:10px;padding:6px;margin:4px 0 12px}
.mk-tree-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;color:var(--mk-sub)}
.mk-tree-item:hover{background:#f4f7f6}
.mk-tree-item.mk-tree-on{background:var(--mk-accent-tint);color:var(--mk-accent-deep)}
.mk-tree-item svg{flex-shrink:0}
.mk-modal-note{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--mk-ter);background:#f7faf9;border-radius:10px;padding:10px 12px;line-height:1.6;margin-top:4px}
.mk-modal-note svg{flex-shrink:0;margin-top:2px}
.mk-radio{display:flex!important;align-items:flex-start;gap:8px;font-size:13px;font-weight:600;padding:6px 0;cursor:pointer;line-height:1.5}
.mk-radio input{margin-top:2px;accent-color:var(--mk-accent)}
@media(max-width:850px){.mk-side{width:210px}.mk-kbheader,.mk-toolbar,.mk-body,.mk-nav{padding-left:20px;padding-right:20px}}
`;
