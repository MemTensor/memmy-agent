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
  const relativePath = first.webkitRelativePath.replace(/\\/g, "/");
  const rootName = relativePath.split("/")[0] || first.name;
  const fullPath = (resolvePath?.(first) || first.name).replace(/\\/g, "/");
  const rootPath = relativePath && fullPath.endsWith(relativePath)
    ? `${fullPath.slice(0, -relativePath.length)}${rootName}`
    : rootName;
  return {
    kind: "path",
    id: rootPath,
    label: `${rootName}/`
  };
}

export function parsePathReferencesFromComposerContent(content: string): {
  content: string;
  references: ComposerContextReference[];
} {
  const match = /(?:\r?\n){0,2}<memmy-context>\r?\n([\s\S]*?)\r?\n<\/memmy-context>\s*$/.exec(content);
  if (!match) return { content, references: [] };
  const references = (match[1] ?? "").split(/\r?\n/).flatMap((line) => {
    const prefix = /^- (file|folder): /.exec(line);
    const idStart = line.lastIndexOf(" (");
    if (!prefix || idStart <= prefix[0].length || !line.endsWith(")")) return [];
    const label = line.slice(prefix[0].length, idStart);
    const id = line.slice(idStart + 2, -1);
    return label && id ? [{ kind: "path" as const, id, label }] : [];
  });
  if (!references.length) return { content, references: [] };
  return {
    content: content.slice(0, match.index).trimEnd(),
    references
  };
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
