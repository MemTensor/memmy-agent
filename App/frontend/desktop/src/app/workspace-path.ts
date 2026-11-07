/**
 * 工作区路径的显示写法：侧栏与项目设置共用，两处显示同一个项目时不能出现两种写法。
 *
 * 只做展示层的改写，不用于比较路径是否相同（比较用 `sameWorkspacePath`，在 `app-frame.tsx`）。
 */
export function formatWorkspacePath(rootPath: string): string {
  return rootPath
    .replace(/\\/g, "/")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
}
