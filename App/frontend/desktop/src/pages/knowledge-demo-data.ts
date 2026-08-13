/**
 * Demo dataset for the knowledge base workspace.
 *
 * The knowledge page is currently a design-complete mock driven by this file:
 * it walks from the first-run folder authorization all the way to populated
 * knowledge bases so the whole flow can be reviewed without a backend.
 */

export type KbFileStatus = "uploading" | "processing" | "processed" | "unsupported";

export interface KbSourceFolder {
  id: string;
  name: string;
  root: string;
  hint: string;
  selected: boolean;
}

export interface KbLibraryFile {
  id: string;
  /** Path relative to the synced source root, e.g. `文稿/论文资料/MemGPT.pdf`. */
  path: string;
  name: string;
  size: string;
  updated: string;
  status: KbFileStatus;
  source?: "agent-generated" | "agent-downloaded";
}

export interface KbKnowledgeBase {
  id: string;
  name: string;
  updated: string;
  fileIds: string[];
  folders: KbKnowledgeFolder[];
}

export interface KbKnowledgeFolder {
  id: string;
  name: string;
  fileIds: string[];
}

/** Moves knowledge-base members between virtual folders without changing source files. */
export function moveFilesToKnowledgeFolder(
  base: KbKnowledgeBase,
  fileIds: string[],
  folderId: string | null
): KbKnowledgeBase {
  if (folderId && !base.folders.some((folder) => folder.id === folderId)) return base;
  const moving = new Set(fileIds.filter((id) => base.fileIds.includes(id)));
  if (!moving.size) return base;
  return {
    ...base,
    folders: base.folders.map((folder) => ({
      ...folder,
      fileIds: [
        ...folder.fileIds.filter((id) => !moving.has(id)),
        ...(folder.id === folderId ? [...moving] : [])
      ]
    }))
  };
}

export const KB_ONBOARDED_STORAGE_KEY = "memmy.knowledgeDemoOnboarded";

/** Fallback source root used when no synced folder is selected. */
export const KB_DEFAULT_IMPORT_ROOT = "文稿";

/** Returns the localized demo root used by the current desktop platform. */
export function kbDefaultImportRoot(platform?: string): string {
  return platform === "win32" ? "文档" : KB_DEFAULT_IMPORT_ROOT;
}

/** Builds the mock file entry produced by the "add files" action. */
export function kbImportedFileMock(root: string, seed: number): KbLibraryFile {
  const name = `新导入文献-${seed % 100}.pdf`;
  return {
    id: `import-${seed}`,
    path: `${root}/${name}`,
    name,
    size: "2.4 MB",
    updated: "刚刚",
    status: "uploading"
  };
}

/** Suggested local folders shown in the sync modal before they are synced. */
export const KB_RECOMMENDED_FOLDERS: Array<Omit<KbSourceFolder, "selected">> = [
  { id: "documents", name: "文稿 (Documents)", root: "文稿", hint: "工作文件和项目" },
  { id: "downloads", name: "下载 (Downloads)", root: "下载", hint: "下载的文件" },
  { id: "desktop", name: "桌面 (Desktop)", root: "桌面", hint: "桌面文件" },
  { id: "papers", name: "论文", root: "论文", hint: "论文 PDF 与笔记" },
  { id: "notes", name: "备忘录", root: "备忘录", hint: "本地备忘与草稿" }
];

export function buildDemoSourceFolders(platform?: string): KbSourceFolder[] {
  return KB_RECOMMENDED_FOLDERS.slice(0, 3).map((folder) => {
    if (folder.id !== "documents" || platform !== "win32") {
      return { ...folder, selected: true };
    }
    return {
      ...folder,
      name: "文档 (Documents)",
      root: "文档",
      selected: true
    };
  });
}

export function buildDemoLibraryFiles(platform?: string): KbLibraryFile[] {
  const documents = kbDefaultImportRoot(platform);
  return [
    { id: "d1", path: `${documents}/论文资料/references/MemGPT.pdf`, name: "MemGPT.pdf", size: "4.8 MB", updated: "2025.03.16 18:00", status: "processed" },
    { id: "d2", path: `${documents}/论文资料/references/MemoryBank.pdf`, name: "MemoryBank.pdf", size: "3.2 MB", updated: "2025.03.16 17:20", status: "processed" },
    { id: "d3", path: "下载/LongMemEval.pdf", name: "LongMemEval.pdf", size: "2.7 MB", updated: "2025.03.15 21:08", status: "processing" },
    { id: "d4", path: `${documents}/论文资料/长期记忆阅读笔记.md`, name: "长期记忆阅读笔记.md", size: "28 KB", updated: "2025.03.14 11:30", status: "processed" },
    { id: "d5", path: `${documents}/医学影像/U-Net.pdf`, name: "U-Net.pdf", size: "1.9 MB", updated: "2025.03.12 09:15", status: "processed" },
    { id: "d6", path: `${documents}/医学影像/影像分割资料汇总.docx`, name: "影像分割资料汇总.docx", size: "740 KB", updated: "2025.03.11 16:42", status: "processed" },
    { id: "d7", path: "桌面/Agent评测/AgentBench.pdf", name: "AgentBench.pdf", size: "5.1 MB", updated: "2025.03.10 14:05", status: "processed" },
    { id: "d8", path: "桌面/Agent评测/评测指标草稿.md", name: "评测指标草稿.md", size: "16 KB", updated: "2025.03.09 20:18", status: "processed" },
    { id: "d9", path: "下载/待整理/研究方法说明.pdf", name: "研究方法说明.pdf", size: "860 KB", updated: "刚刚", status: "uploading" },
    { id: "d10", path: "下载/待整理/会议笔记.md", name: "会议笔记.md", size: "12 KB", updated: "今天 10:22", status: "processing" },
    { id: "d11", path: `${documents}/pyproject.toml`, name: "pyproject.toml", size: "3 KB", updated: "昨天 23:58", status: "unsupported" }
  ];
}

export function buildDemoKnowledgeBases(): KbKnowledgeBase[] {
  return [
    {
      id: "kb1",
      name: "大模型长期记忆",
      updated: "刚刚更新",
      fileIds: ["d1", "d2", "d3", "d4"],
      folders: [{ id: "folder-core-papers", name: "核心论文", fileIds: ["d1", "d2"] }]
    },
    { id: "kb2", name: "医学影像综述", updated: "昨天", fileIds: ["d5", "d6"], folders: [] },
    { id: "kb3", name: "Agent 评测", updated: "3 天前", fileIds: ["d7", "d8"], folders: [] },
    { id: "kb4", name: "研究方法", updated: "上周", fileIds: ["d4", "d8"], folders: [] },
    { id: "kb5", name: "具身智能", updated: "2 周前", fileIds: ["d7"], folders: [] }
  ];
}

/** Existing demo sessions keep sample content; first-run onboarding starts empty. */
export function buildInitialKnowledgeBases(onboarded: boolean): KbKnowledgeBase[] {
  return onboarded ? buildDemoKnowledgeBases() : [];
}

export function readKbOnboarded(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(KB_ONBOARDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeKbOnboarded(storage: Storage | undefined): void {
  try {
    storage?.setItem(KB_ONBOARDED_STORAGE_KEY, "1");
  } catch {
    // Demo flag only; losing it just replays onboarding.
  }
}
