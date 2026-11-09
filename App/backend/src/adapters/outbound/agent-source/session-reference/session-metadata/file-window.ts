/**
 * Reads the two ends of a session file without reading the whole of it.
 *
 * <p>A session file grows to tens of megabytes and its middle is tool output nobody lists. The listed fields only
 * need the first question a person asked and the last one, so a listing can look at the head and the tail. The
 * windows grow when a small one holds nothing usable, but they stop at {@link MAX_WINDOW_BYTES}: a file that keeps
 * its first question megabytes in must be read whole by the caller, not by an ever-growing window.</p>
 */
import { open } from "node:fs/promises";

/** Where the read starts: the first rows, or the last ones. */
export type WindowSide = "head" | "tail";

/** One contiguous slice of a file, aligned to line boundaries so every line in it is a whole record. */
export interface FileWindow {
  /** The slice's records, one per line, blank lines dropped. */
  lines: readonly string[];
  /** Byte offset the slice starts at. */
  start: number;
  /** Byte offset the slice ends at; equal to the file size when the slice reached the end. */
  end: number;
  /** File size at read time. */
  size: number;
}

/** Reads one window of a file, aligned to line boundaries; a file shorter than the window is returned whole. */
export async function readFileWindow(filePath: string, side: WindowSide, bytes: number, stopAt = 0): Promise<FileWindow | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size <= 0) {
      return { lines: [], start: 0, end: 0, size };
    }
    const length = Math.min(size, Math.max(1, Math.trunc(bytes)));
    // `stopAt` is where the other window ended: the tail reads the remainder rather than those bytes twice.
    const start = side === "head" ? 0 : Math.max(Math.min(stopAt, size), size - length);
    const readLength = side === "head" ? length : size - start;
    const end = start + readLength;
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    // A cut that lands mid-line leaves a fragment. The head keeps its first line (it starts at 0); the tail keeps
    // its last line only when it ends at EOF. The other end is a fragment of a record and is dropped.
    if (start > 0 && !(await endsLine(handle, start))) {
      lines.shift();
    }
    if (end < size && !text.endsWith("\n")) {
      lines.pop();
    }
    return { lines: lines.filter((line) => line.trim().length > 0), start, end, size };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** True when the byte before `offset` ends a line, so `offset` starts a whole record. */
async function endsLine(handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<boolean> {
  const previous = Buffer.alloc(1);
  const { bytesRead } = await handle.read(previous, 0, 1, offset - 1);
  return bytesRead === 1 && previous[0] === 0x0a;
}

/** One chunk of a file read backwards, aligned so every line in it is a whole record. */
export interface TailChunk {
  lines: readonly string[];
  /** Byte offset a further, earlier chunk ends at; equal to `start` when this chunk covered the whole file. */
  nextEnd: number;
  start: number;
}

/**
 * Reads the chunk of a file that ends at `endOffset`, walking backwards through a file.
 *
 * <p>Reading in chunks keeps a session file's tail cheap to widen: a narrower chunk is tried first, and when it
 * holds nothing the next one continues just before it instead of reading the same bytes again.</p>
 *
 * @param endOffset Byte offset to stop at, which is the start of a whole record from the previous chunk.
 * @param chunkBytes How much to read; a chunk that holds one huge record returns a fragment the caller drops.
 * @param floor Byte offset the chunk may not start before.
 */
export async function readTailChunk(filePath: string, endOffset: number, chunkBytes: number, floor = 0): Promise<TailChunk | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const start = Math.max(floor, endOffset - Math.max(1, Math.trunc(chunkBytes)));
    if (start >= endOffset) {
      return { lines: [], nextEnd: start, start };
    }
    const buffer = Buffer.alloc(endOffset - start);
    const { bytesRead } = await handle.read(buffer, 0, endOffset - start, start);
    const slice = buffer.subarray(0, bytesRead);
    const text = slice.toString("utf8");
    const lines = text.split("\n");
    // 起点不在文件开头时，第一行可能是半条记录：下一条更早的窗口从它开头继续读。偏移量按字节数算：
    // 文本里一个汉字是一个字符、三个字节，用字符下标会越读越偏。
    let nextEnd = start;
    // 起点落在记录中间时，第一行是半条记录，要扔掉；正好落在行首时它是完整的一条，不能扔。
    if (start > 0 && !(await endsLine(handle, start))) {
      const firstBreak = slice.indexOf(0x0a);
      if (firstBreak < 0) {
        // 整个窗口落在一条巨长的记录里，没有可用的行边界；这条记录只能留给整份读取。
        return { lines: [], nextEnd: start, start };
      }
      lines.shift();
      nextEnd = start + firstBreak + 1;
    }
    const records = lines.filter((line) => line.trim().length > 0);
    // 一条记录比窗口还长时，窗口里除了它的开头与结尾什么都没有：不前进就会停在这条记录上。
    return { lines: records, nextEnd: records.length > 0 ? nextEnd : start, start };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Finds the last line of a file that contains `marker` and means something to `read`.
 *
 * <p>An agent that names a conversation writes that name once; the name a person sees is the newest such row, which
 * can sit megabytes before the end. The marker can also appear inside another row's data, so each candidate is
 * handed to the caller, which decides whether it is a name at all. Searching the raw bytes keeps that cheap.</p>
 *
 * @returns What `read` made of the newest matching line, or null when none was found in {@link MAX_WINDOW_BYTES}.
 */
export async function readLastLineWhere<T>(
  filePath: string,
  marker: string,
  read: (line: string) => T | null
): Promise<T | null> {
  const needle = Buffer.from(marker, "utf8");
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size <= 0) {
      return null;
    }
    let end = size;
    let budget = 0;
    while (end > 0 && budget <= MAX_WINDOW_BYTES) {
      const start = Math.max(0, end - TAIL_SEARCH_STEP);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      budget += bytesRead;
      const slice = buffer.subarray(0, bytesRead);
      let index = slice.lastIndexOf(needle);
      while (index >= 0) {
        const lineStart = slice.lastIndexOf(0x0a, Math.max(0, index - 1)) + 1;
        const lineEnd = slice.indexOf(0x0a, index);
        const value = read(slice.subarray(lineStart, lineEnd < 0 ? slice.length : lineEnd).toString("utf8"));
        if (value !== null) {
          return value;
        }
        index = index === 0 ? -1 : slice.lastIndexOf(needle, index - 1);
      }
      if (start === 0) {
        return null;
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** How much of a file one backward search for a marker reads at a time. */
const TAIL_SEARCH_STEP = 512 * 1024;

/**
 * The offset just after the last newline at or before `offset`, so a window can start or end on a record boundary.
 *
 * @returns 0 when no newline exists before `offset`.
 */
export async function lineBoundaryBefore(filePath: string, offset: number): Promise<number> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return 0;
  }
  try {
    let end = offset;
    while (end > 0) {
      const start = Math.max(0, end - LINE_SEARCH_STEP);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const index = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (index >= 0) {
        return start + index + 1;
      }
      end = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** How much of a file one backward search for a newline reads at a time. */
const LINE_SEARCH_STEP = 64 * 1024;

/** Byte size of a file, or 0 when it cannot be read. */
export async function fileSize(filePath: string): Promise<number> {
  try {
    const handle = await open(filePath, "r");
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return 0;
  }
}

/** The window sizes a listing tries, smallest first, before giving up on the file. */
export const WINDOW_GROWTH = [
  8 * 1024, 16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024,
  1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024, 16 * 1024 * 1024
] as const;

/** The widest a listing reads from one end of a file; beyond this the whole file has to be read. */
export const MAX_WINDOW_BYTES = WINDOW_GROWTH[WINDOW_GROWTH.length - 1]!;
