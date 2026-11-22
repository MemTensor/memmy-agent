/**
 * 「这个 Agent 的存储有没有变」的廉价摘要。
 *
 * 后台同步每分钟跑一次，而一次扫描要把每个存储里最近的会话文件读一遍（本机十个 Agent 合计约 10 秒）。
 * 绝大多数时候本机什么都没变，所以先花几毫秒确认「没变」，再决定要不要读盘。
 *
 * 摘要只做一件事：浅层走一遍目录，把每个文件的 mtime 和大小累加。新增、删除、追加写入都会让累加值变化，
 * 所以「摘要相同」可以当成「没有变化」。目录自身的 mtime 不参与：往既有会话文件里追加内容不会改父目录
 * 的 mtime，那正是最常见的写入方式。
 *
 * 唯一的例外是 sqlite 的 `-shm`：读一次带 WAL 的库就会把它重建一遍，算进去会让「扫完就变」自激，
 * 于是每分钟都重新扫。它不装数据（数据在 `-wal` 与库里，两者都参与摘要）。
 *
 * 说明不了的时候一律返回 null，调用方照常扫描，宁可多扫一遍也不漏：
 * - 路径读不了但不是「不存在」（权限、损坏）。
 * - 目录项超过上限（本机 hermes 13 万、openclaw 5.5 万个文件，深达九层）。这类存储逐个 stat 要一两秒，
 *   但它们自己的扫描只要几十毫秒，直接扫更划算。
 *
 * 路径根本不存在时给的是一个确定的值（这个 Agent 没装，就是没有会话），不必每分钟再试一次。
 *
 * 已知的盲区：内容变了但 mtime 与大小都没变（例如有人手动把 mtime 改回去，或存储写在网络盘上）。这类情况
 * 摘要看不出来，只能靠调用方自己的过期时间兜底。
 */
import { lstat, readdir } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";

/** 一次摘要最多看这么多个目录项，超了就放弃：本机四个大存储合计 3400 项，留出几倍的余量。 */
const DEFAULT_MAX_ENTRIES = 10_000;
/** 会话文件最深的层级：codex 是 sessions/2026/10/28/*.jsonl，四层。 */
const DEFAULT_MAX_DEPTH = 5;
/** 同一个目录里一次并发 stat 的文件数：不走满 libuv 线程池，免得和真正的请求抢。 */
const STAT_BATCH = 8;
/** 这份存储不存在：确定没有会话，与「说不清」区分开。 */
const ABSENT_STORE = "absent";

/** 读一个存储现在长什么样；null 表示这份存储说不清有没有变。 */
export type StoreDigest = (dataPath: string) => Promise<string | null>;

export interface StoreDigestDeps {
  maxEntries?: number;
  maxDepth?: number;
}

/** 默认的摘要实现：浅层遍历 + 文件 mtime/大小的累加。 */
export function createStoreDigest(deps: StoreDigestDeps = {}): StoreDigest {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  return async (dataPath) => {
    let root: Stats;
    try {
      root = await lstat(dataPath);
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT" ? ABSENT_STORE : null;
    }
    // 单个文件的存储（opencode 一个 sqlite 库）：mtime 与大小就够。
    if (!root.isDirectory()) {
      return `file:${Math.floor(root.mtimeMs)}:${root.size}`;
    }
    const tally: Tally = { entries: 0, files: 0, mtimeMs: 0, bytes: 0 };
    if (!(await walk(dataPath, 0, tally, maxEntries, maxDepth))) {
      return null;
    }
    return `dir:${tally.files}:${tally.mtimeMs}:${tally.bytes}`;
  };
}

interface Tally {
  entries: number;
  files: number;
  /** 所有文件 mtime 之和；上限个文件也远小于 2^53，整数加法是精确的。 */
  mtimeMs: number;
  bytes: number;
}

/** sqlite 的共享内存索引文件：只服务 WAL 读写，任何一次读取都会重建它，本身不装数据。 */
function isSqliteSharedIndex(name: string): boolean {
  return name.endsWith("-shm");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** 返回 false 表示这一层或更深处看不清，摘要作废。 */
async function walk(dir: string, depth: number, tally: Tally, maxEntries: number, maxDepth: number): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of entries) {
    tally.entries += 1;
    if (tally.entries > maxEntries) return false;
    if (entry.isDirectory()) {
      directories.push(entry.name);
    } else if (entry.isFile() && !isSqliteSharedIndex(entry.name)) {
      files.push(entry.name);
    }
    // 符号链接与特殊文件不算：它们不承载会话，跟下去还会跑出这份存储之外。
  }
  if (directories.length && depth + 1 > maxDepth) {
    return false;
  }
  for (let index = 0; index < files.length; index += STAT_BATCH) {
    const stats = await Promise.all(
      files.slice(index, index + STAT_BATCH).map((name) => lstat(join(dir, name)).catch(() => null))
    );
    for (const stat of stats) {
      if (!stat) return false;
      tally.files += 1;
      tally.mtimeMs += Math.floor(stat.mtimeMs);
      tally.bytes += stat.size;
    }
  }
  for (const name of directories) {
    if (!(await walk(join(dir, name), depth + 1, tally, maxEntries, maxDepth))) return false;
  }
  return true;
}
