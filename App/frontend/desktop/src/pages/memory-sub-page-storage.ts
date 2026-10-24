export type MemorySubPageId =
  | "overview"
  | "computer-history"
  | "memories"
  | "user-memories"
  | "tasks"
  | "policies"
  | "world-model"
  | "skills"
  | "analytics"
  | "logs"
  | "sources";

export const MEMORY_SUB_PAGE_STORAGE_KEY = "memmy.memorySubPage";

export function writeMemorySubPage(storage: Storage | undefined, page: MemorySubPageId): void {
  storage?.setItem(MEMORY_SUB_PAGE_STORAGE_KEY, page);
}
