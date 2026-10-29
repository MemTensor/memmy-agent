import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith(`~${sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homeDirectory, value.slice(2));
  }
  return value;
}

/** Resolves only a direct Markdown child of Computer History's summary store. */
export function resolveComputerHistoryMarkdownPath(
  rawPath: unknown,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (typeof rawPath !== "string" || !rawPath.trim() || /[\0\r\n]/u.test(rawPath)) {
    throw new Error("invalid Computer History Markdown path");
  }
  const memmyHome = resolve(expandHome(env.MEMMY_HOME?.trim() || "~/.memmy", homeDirectory));
  const historyDirectory = resolve(memmyHome, "computer-history", "histories");
  const target = resolve(rawPath.trim());
  const child = relative(historyDirectory, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)
    || dirname(target) !== historyDirectory || extname(target).toLowerCase() !== ".md") {
    throw new Error("path is outside the Computer History Markdown directory");
  }
  return target;
}
