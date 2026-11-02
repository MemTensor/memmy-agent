import type { ComposerContextReference } from "../state/agent-composer-state.js";

export const MEMMY_COMPOSER_REFERENCE_MIME = "application/x-memmy-composer-reference+json";

export function mergeComposerContextReferences(
  current: ComposerContextReference[],
  incoming: ComposerContextReference[]
): ComposerContextReference[] {
  const next = [...current];
  for (const reference of incoming) {
    if (!next.some((item) => item.kind === reference.kind && item.id === reference.id)) {
      next.push(reference);
    }
  }
  return next;
}

export function composerFolderReferenceFromFiles(
  files: File[],
  resolvePath?: (file: File) => string
): ComposerContextReference | null {
  const first = files[0];
  if (!first) return null;
  const relativePath = (first.webkitRelativePath || "").replace(/\\/g, "/");
  const rootName = relativePath.split("/")[0] || first.name;
  const fullPath = (resolvePath?.(first) || first.name).replace(/\\/g, "/");
  const rootPath = relativePath && fullPath.endsWith(relativePath)
    ? `${fullPath.slice(0, -relativePath.length)}${rootName}`
    : relativePath ? rootName : fullPath;
  return {
    kind: "path",
    id: rootPath,
    label: `${rootName}/`
  };
}

export type ComposerDropItem = Pick<DataTransferItem, "kind" | "getAsFile"> & {
  webkitGetAsEntry?: () => Pick<FileSystemEntry, "isDirectory"> | null;
};

export interface ComposerDropSource {
  items?: ArrayLike<ComposerDropItem> | Iterable<ComposerDropItem>;
  files?: ArrayLike<File> | Iterable<File>;
}

export interface ComposerDropEntry {
  kind: "file" | "folder";
  file: File;
}

/** Read the drag store synchronously, before the drop event finishes. */
export function composerDropEntriesFromDataTransfer(source: ComposerDropSource | null | undefined): ComposerDropEntry[] {
  const entries: ComposerDropEntry[] = [];
  const transferredFiles = Array.from(source?.files ?? []);
  const seen = new Set<File>();
  let fileIndex = 0;
  for (const item of Array.from(source?.items ?? [])) {
    if (item.kind !== "file") continue;
    const directory = item.webkitGetAsEntry?.()?.isDirectory === true;
    const file = item.getAsFile() ?? transferredFiles[fileIndex];
    fileIndex += 1;
    if (!file) {
      if (directory) throw new Error("home.media.error.sendReadFailed");
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    entries.push({ kind: directory ? "folder" : "file", file });
  }
  // FileList is also used by older drag sources that do not expose items.
  for (const file of transferredFiles.slice(fileIndex)) {
    if (!seen.has(file)) {
      seen.add(file);
      entries.push({ kind: "file", file });
    }
  }
  return entries;
}

export function partitionComposerDropFiles(source: ComposerDropSource | null | undefined): {
  files: File[];
  folders: File[];
} {
  const entries = composerDropEntriesFromDataTransfer(source);
  return {
    files: entries.filter((entry) => entry.kind === "file").map((entry) => entry.file),
    folders: entries.filter((entry) => entry.kind === "folder").map((entry) => entry.file)
  };
}

export function appendComposerContextReferences(content: string, references: ComposerContextReference[]): string {
  if (!references.length) return content;
  return [content.trimEnd(), ...references.map((reference) => JSON.stringify(reference.id))]
    .filter(Boolean).join("\n\n");
}

export function writeComposerReferenceDrag(
  dataTransfer: DataTransfer,
  reference: ComposerContextReference
): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(MEMMY_COMPOSER_REFERENCE_MIME, JSON.stringify(reference));
  dataTransfer.setData("text/plain", reference.label);
}

export function readComposerReferenceDrag(dataTransfer: DataTransfer): ComposerContextReference | null {
  if (typeof dataTransfer.getData !== "function") return null;
  const payload = dataTransfer.getData(MEMMY_COMPOSER_REFERENCE_MIME);
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as Partial<ComposerContextReference>;
    if (
      value.kind === "path"
      && typeof value.id === "string"
      && value.id.length > 0
      && typeof value.label === "string"
      && value.label.length > 0
    ) {
      return { kind: value.kind, id: value.id, label: value.label };
    }
  } catch {
    return null;
  }
  return null;
}

export function dataTransferHasComposerReference(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(MEMMY_COMPOSER_REFERENCE_MIME);
}
