import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const touched = new Set<string>();

export class ReadState {
  mtime: number;
  offset: number;
  limit: number | null;
  private contentHashValue: string | null;
  private canDedupValue: boolean;

  constructor({
    mtime,
    offset,
    limit,
    contentHash,
    canDedup,
  }: {
    mtime: number;
    offset: number;
    limit: number | null;
    contentHash?: string | null;
    canDedup?: boolean;
  }) {
    this.mtime = mtime;
    this.offset = offset;
    this.limit = limit;
    this.contentHashValue = contentHash ?? null;
    this.canDedupValue = canDedup ?? true;
  }

  get contentHash(): string | null {
    return this.contentHashValue;
  }

  set contentHash(value: string | null) {
    this.contentHashValue = value;
  }

  get canDedup(): boolean {
    return this.canDedupValue;
  }

  set canDedup(value: boolean) {
    this.canDedupValue = value;
  }
}

export function hashFile(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.resolve(filePath))).digest("hex");
  } catch {
    return null;
  }
}

function resolved(filePath: string | fs.PathLike): string {
  return path.resolve(String(filePath));
}

function mtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export class FileStates {
  private state = new Map<string, ReadState>();

  recordRead(filePath: string | fs.PathLike, offset = 1, limit: number | null = null): void {
    const p = resolved(filePath);
    const currentMtime = mtime(p);
    if (currentMtime == null) return;
    this.state.set(p, new ReadState({
      mtime: currentMtime,
      offset,
      limit,
      contentHash: hashFile(p),
      canDedup: true,
    }));
  }

  recordWrite(filePath: string | fs.PathLike): void {
    const p = resolved(filePath);
    touched.add(p);
    const currentMtime = mtime(p);
    if (currentMtime == null) {
      this.state.delete(p);
      return;
    }
    this.state.set(p, new ReadState({
      mtime: currentMtime,
      offset: 1,
      limit: null,
      contentHash: hashFile(p),
      canDedup: false,
    }));
  }

  checkRead(filePath: string | fs.PathLike): string | null {
    const p = resolved(filePath);
    const entry = this.state.get(p);
    if (!entry) return "Warning: file has not been read yet. Read it first to verify content before editing.";
    const currentMtime = mtime(p);
    if (currentMtime == null) return null;
    const currentHash = entry.contentHash ? hashFile(p) : null;
    if (currentMtime !== entry.mtime) {
      if (entry.contentHash && currentHash === entry.contentHash) {
        entry.mtime = currentMtime;
        return null;
      }
      return "Warning: file has been modified since last read. Re-read to verify content before editing.";
    }
    if (entry.contentHash && currentHash !== entry.contentHash) {
      return "Warning: file has been modified since last read. Re-read to verify content before editing.";
    }
    return null;
  }

  isUnchanged(filePath: string | fs.PathLike, offset = 1, limit: number | null = null): boolean {
    const p = resolved(filePath);
    const entry = this.state.get(p);
    if (!entry || !entry.canDedup || entry.offset !== offset || entry.limit !== limit) return false;
    const currentMtime = mtime(p);
    if (currentMtime == null) return false;
    if (currentMtime !== entry.mtime) {
      const currentHash = hashFile(p);
      if (currentHash !== entry.contentHash) {
        entry.canDedup = false;
        return false;
      }
      entry.canDedup = false;
      return true;
    }
    if (entry.contentHash && hashFile(p) !== entry.contentHash) return false;
    return true;
  }

  get(filePath: string | fs.PathLike): ReadState | null {
    return this.state.get(resolved(filePath)) ?? null;
  }

  clear(): void {
    this.state.clear();
  }
}

export class FileStateStore {
  private statesByKey = new Map<string, FileStates>();

  forSession(sessionKey?: string | null): FileStates {
    const key = sessionKey || "__default__";
    let states = this.statesByKey.get(key);
    if (!states) {
      states = new FileStates();
      this.statesByKey.set(key, states);
    }
    return states;
  }

  clear(): void {
    this.statesByKey.clear();
  }
}

const storage = new AsyncLocalStorage<FileStates>();
const defaultStates = new FileStates();

export type FileStatesToken = { previous: FileStates | undefined };

export function currentFileStates(fallback: FileStates = defaultStates): FileStates {
  return storage.getStore() ?? fallback;
}

export function bindFileStates(fileStates: FileStates): FileStatesToken {
  const token = { previous: storage.getStore() };
  storage.enterWith(fileStates);
  return token;
}

export function resetFileStates(token: FileStatesToken): void {
  if (token.previous) storage.enterWith(token.previous);
  else storage.disable();
}

export function recordRead(filePath: string | fs.PathLike, offset = 1, limit: number | null = null): void {
  defaultStates.recordRead(filePath, offset, limit);
}

export function recordWrite(filePath: string | fs.PathLike): void {
  defaultStates.recordWrite(filePath);
}

export function checkRead(filePath: string | fs.PathLike): string | null {
  return defaultStates.checkRead(filePath);
}

export function isUnchanged(filePath: string | fs.PathLike, offset = 1, limit: number | null = null): boolean {
  return defaultStates.isUnchanged(filePath, offset, limit);
}

export function clear(): void {
  defaultStates.clear();
  touched.clear();
}

export function markFileTouched(filePath: string): void {
  touched.add(resolved(filePath));
}

export function touchedFiles(): string[] {
  return [...touched];
}

export function clearTouchedFiles(): void {
  touched.clear();
}
