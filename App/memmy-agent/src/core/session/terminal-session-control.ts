import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as lockfile from "proper-lockfile";

const TURN_LOCK_UPDATE_MS = 10_000;
const TURN_LOCK_STALE_MS = 120_000;
const RUN_HEARTBEAT_MS = 5_000;
const RUN_STALE_MS = 120_000;

export type TerminalRunState = {
  canonicalSessionKey: string;
  turnId: string;
  startedAt: number;
  heartbeatAt: number;
  cancelRequested: boolean;
};

function sessionHash(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("hex");
}

function abortError(signal: AbortSignal): Error {
  const error = new Error(String(signal.reason ?? "terminal turn lock wait cancelled"));
  error.name = "AbortError";
  return error;
}

function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function ensureTarget(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a"));
}

function readJson(file: string): TerminalRunState | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !value
      || typeof value !== "object"
      || typeof value.canonicalSessionKey !== "string"
      || typeof value.turnId !== "string"
      || !Number.isFinite(value.startedAt)
      || !Number.isFinite(value.heartbeatAt)
      || typeof value.cancelRequested !== "boolean"
    ) {
      return null;
    }
    return value as TerminalRunState;
  } catch {
    return null;
  }
}

function isStale(state: TerminalRunState, now = Date.now()): boolean {
  return now - state.heartbeatAt > RUN_STALE_MS;
}

function writeJsonAtomic(file: string, value: TerminalRunState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "w");
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      let dirFd: number | null = null;
      try {
        dirFd = fs.openSync(path.dirname(file), "r");
        fs.fsyncSync(dirFd);
      } catch {
        // The state file has already been flushed; some filesystems reject directory fsync.
      } finally {
        if (dirFd !== null) fs.closeSync(dirFd);
      }
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

async function acquire(
  target: string,
  {
    signal = null,
    stale,
    update,
  }: {
    signal?: AbortSignal | null;
    stale: number;
    update: number;
  },
): Promise<() => Promise<void>> {
  ensureTarget(target);
  while (true) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await lockfile.lock(target, {
        realpath: false,
        stale,
        update,
        retries: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ELOCKED") throw error;
      await waitForRetry(1_000, signal);
    }
  }
}

export class TerminalSessionTurnLock {
  readonly root: string;

  constructor(sessionsDir: string) {
    this.root = path.join(path.resolve(sessionsDir), ".terminal-control");
  }

  targetPath(sessionKey: string): string {
    return path.join(this.root, `turn-${sessionHash(sessionKey)}.target`);
  }

  async runExclusive<T>(
    sessionKey: string,
    operation: () => Promise<T>,
    signal: AbortSignal | null = null,
  ): Promise<T> {
    if (!sessionKey.startsWith("cli:")) return operation();
    const release = await acquire(this.targetPath(sessionKey), {
      signal,
      stale: TURN_LOCK_STALE_MS,
      update: TURN_LOCK_UPDATE_MS,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

export class TerminalRunControl {
  readonly root: string;

  constructor(sessionsDir: string) {
    this.root = path.join(path.resolve(sessionsDir), ".terminal-control");
  }

  runPath(sessionKey: string): string {
    return path.join(this.root, `run-${sessionHash(sessionKey)}.json`);
  }

  private targetPath(sessionKey: string): string {
    return path.join(this.root, `run-${sessionHash(sessionKey)}.target`);
  }

  private async update(
    sessionKey: string,
    operation: (current: TerminalRunState | null) => TerminalRunState | null,
  ): Promise<TerminalRunState | null> {
    const release = await acquire(this.targetPath(sessionKey), {
      stale: 10_000,
      update: 2_000,
    });
    try {
      const file = this.runPath(sessionKey);
      const next = operation(readJson(file));
      if (next) writeJsonAtomic(file, next);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
      return next;
    } finally {
      await release();
    }
  }

  async create(sessionKey: string, turnId: string): Promise<TerminalRunState> {
    const now = Date.now();
    return (await this.update(sessionKey, () => ({
      canonicalSessionKey: sessionKey,
      turnId,
      startedAt: now,
      heartbeatAt: now,
      cancelRequested: false,
    })))!;
  }

  async heartbeat(sessionKey: string, turnId: string): Promise<TerminalRunState | null> {
    return this.update(sessionKey, (current) => {
      if (!current || current.turnId !== turnId) return current;
      return { ...current, heartbeatAt: Date.now() };
    });
  }

  async requestCancel(sessionKey: string): Promise<boolean> {
    let found = false;
    await this.update(sessionKey, (current) => {
      if (!current || isStale(current)) return null;
      found = true;
      return { ...current, cancelRequested: true };
    });
    return found;
  }

  async cleanupStale(sessionKey: string): Promise<boolean> {
    if (!fs.existsSync(this.runPath(sessionKey))) return false;
    let removed = false;
    await this.update(sessionKey, (current) => {
      if (current && !isStale(current)) return current;
      removed = true;
      return null;
    });
    return removed;
  }

  async remove(sessionKey: string, turnId?: string | null): Promise<void> {
    await this.update(sessionKey, (current) => {
      if (turnId && current?.turnId !== turnId) return current;
      return null;
    });
  }

  read(sessionKey: string): TerminalRunState | null {
    const state = readJson(this.runPath(sessionKey));
    if (state && !isStale(state)) return state;
    if (state) void this.cleanupStale(sessionKey).catch(() => undefined);
    return null;
  }

  startOwner(
    sessionKey: string,
    turnId: string,
    controller: AbortController,
  ): () => Promise<void> {
    const poll = async () => {
      const current = await this.heartbeat(sessionKey, turnId);
      if (current?.cancelRequested && !controller.signal.aborted) controller.abort();
    };
    const heartbeat = setInterval(() => void poll().catch(() => undefined), RUN_HEARTBEAT_MS);
    const cancellationPoll = setInterval(() => {
      const current = readJson(this.runPath(sessionKey));
      if (current?.turnId === turnId && current.cancelRequested && !controller.signal.aborted) {
        controller.abort();
      }
    }, 250);
    return async () => {
      clearInterval(heartbeat);
      clearInterval(cancellationPoll);
      await this.remove(sessionKey, turnId);
    };
  }
}
