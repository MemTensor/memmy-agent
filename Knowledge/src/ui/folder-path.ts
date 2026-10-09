import type { KnowledgeFolder } from "../types.js";

/** Walk from `startId` toward the knowledge-base root. Stops on a missing parent or a cycle. */
export function folderChain(
  folderById: Map<string, KnowledgeFolder>,
  startId: string,
): KnowledgeFolder[] {
  const chain: KnowledgeFolder[] = [];
  const seen = new Set<string>();
  let cursor = startId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const folder = folderById.get(cursor);
    if (!folder) break;
    chain.push(folder);
    cursor = folder.parentId;
  }
  return chain;
}

export function folderLocationPath(
  folderById: Map<string, KnowledgeFolder>,
  targetId: string,
): string {
  if (!targetId) return "";
  const names = folderChain(folderById, targetId)
    .map((folder) => folder.name)
    .reverse();
  return names.length ? `${names.join(" / ")} /` : "";
}

export function folderBreadcrumb(
  folderById: Map<string, KnowledgeFolder>,
  folderId: string,
): KnowledgeFolder[] {
  return folderChain(folderById, folderId).reverse();
}

export function folderDepth(
  folderById: Map<string, KnowledgeFolder>,
  folderId: string,
): number {
  return folderChain(folderById, folderId).length;
}

/** Folder ids in `rootIds` plus every descendant. Stops on cycles. O(n). */
export function descendantFolderIds(
  folders: readonly KnowledgeFolder[],
  rootIds: readonly string[],
): string[] {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    const parent = folder.parentId || "";
    const siblings = children.get(parent);
    if (siblings) siblings.push(folder.id);
    else children.set(parent, [folder.id]);
  }
  const seen = new Set<string>();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const nested = children.get(id);
    if (nested) for (let i = nested.length - 1; i >= 0; i -= 1) stack.push(nested[i]!);
  }
  return [...seen];
}
