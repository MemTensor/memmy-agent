import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface RotatingWriter {
  write(chunk: string): void;
  close(): void;
}

export interface RotatingWriterOptions {
  filePath: string;
  maxSize: number;
  maxFiles: number;
}

function indexedPath(filePath: string, index: number): string {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return join(dir, `${stem}.${index}${ext}`);
}

/**
 * Rotates log files by renaming, freeing up `filePath` for fresh writes.
 * Order: delete the oldest one, shift the rest back one slot, then move the
 * current file to `.1`.
 *
 * @param filePath Base log path.
 * @param maxFiles Maximum number of files to keep, including the current one.
 */
export function rollLogFiles(filePath: string, maxFiles: number): void {
  try {
    const oldest = indexedPath(filePath, maxFiles - 1);
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let i = maxFiles - 2; i >= 1; i -= 1) {
      const from = indexedPath(filePath, i);
      if (existsSync(from)) {
        renameSync(from, indexedPath(filePath, i + 1));
      }
    }
    if (existsSync(filePath)) {
      renameSync(filePath, indexedPath(filePath, 1));
    }
  } catch {
    // Rotation failures must never take down the caller; swallow and degrade.
  }
}

/**
 * Creates a synchronous rotating writer. Daemon logging is low-frequency, so
 * synchronous appends are acceptable and are the simplest, most reliable option.
 *
 * @param options Path and rotation parameters.
 * @returns The writer instance.
 */
export function createRotatingWriter(options: RotatingWriterOptions): RotatingWriter {
  const { filePath, maxSize, maxFiles } = options;
  let currentSize = existsSync(filePath) ? safeSize(filePath) : 0;
  let directoryReady = false;

  function ensureDirectory(): void {
    if (directoryReady) {
      return;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    directoryReady = true;
  }

  return {
    write(chunk: string): void {
      try {
        ensureDirectory();
        appendFileSync(filePath, chunk);
        currentSize += Buffer.byteLength(chunk);
        if (currentSize >= maxSize) {
          rollLogFiles(filePath, maxFiles);
          currentSize = 0;
        }
      } catch {
        // Write failures must never take down the daemon capture callback; swallow and degrade.
      }
    },
    close(): void {
      // Synchronous writes need no flush; kept for interface symmetry.
    }
  };
}

/**
 * Reads a file's size, returning 0 on failure.
 *
 * @param filePath Target path.
 * @returns Size in bytes.
 */
function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
