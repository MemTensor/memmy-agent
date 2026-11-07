/**
 * Runs the local session scan on a worker thread.
 *
 * <p>Reading an agent's history is a few seconds of synchronous work - JSON.parse, regular expressions, splitting
 * a stream into rows - and it ran on the thread that also serves messages, page loads and the collaboration sync,
 * so everything else waited inside it. The reading is the same either way; only the thread changes.</p>
 *
 * <p>Every way out of here ends at the same place: a source the worker did not answer for is read on the calling
 * thread, exactly as before. A worker that cannot start (no file, a packaged layout that cannot load it), one that
 * dies mid-pass, or one holding a different store for a source all leave the result unchanged and only give back the
 * responsiveness this was for.</p>
 */
import { Worker } from "node:worker_threads";
import type { LocalSession, LocalSessionScanOffload, LocalSessionScanRequest } from "../adapters/outbound/agent-source/session-reference/local-session-reader.js";

/** The worker as this module uses it, so a test can stand in for it. */
export interface SessionScanWorker {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once when the worker fails or exits before answering everything asked of it. */
  onFailure(listener: (reason: string) => void): void;
  terminate(): void;
}

export interface CreateSessionScanOffloadOptions {
  /** The worker entry; defaults to the file compiled next to this one. */
  workerUrl?: URL;
  createWorker?: (url: URL) => SessionScanWorker;
  /** Told once per worker that could not be used, so a packaged build that cannot load it says so in the log. */
  onFailure?: (reason: string) => void;
}

/** A `scanned` answer: the sessions of one request, or why this thread should read that source itself. */
interface ScanAnswer {
  type: "scanned";
  id: number;
  accepted: boolean;
  sessions?: unknown;
  reason?: string;
}

/** Creates the offload the local session reader takes; one worker is reused across scans. */
export function createSessionScanOffload(options: CreateSessionScanOffloadOptions = {}): LocalSessionScanOffload {
  const workerUrl = options.workerUrl ?? new URL("./collab-session-scan-worker.js", import.meta.url);
  const openWorker = options.createWorker ?? defaultWorker;
  const report = options.onFailure ?? ((reason: string): void => {
    console.warn(`Local session scan stays on the calling thread: ${reason}`);
  });
  /** The worker in use, and the requests still waiting on it. */
  let running: { worker: SessionScanWorker; pending: Map<number, (sessions: LocalSession[] | null) => void> } | null = null;
  let nextId = 1;

  /** Drops the worker in use: whoever was waiting on it reads on this thread instead. */
  function stop(reason: string, notify = true): void {
    const current = running;
    if (!current) {
      if (notify) report(reason);
      return;
    }
    running = null;
    current.worker.terminate();
    for (const settle of current.pending.values()) {
      settle(null);
    }
    current.pending.clear();
    if (notify) report(reason);
  }

  /** The worker in use, or a fresh one; null when it cannot be started at all. */
  function start(): { worker: SessionScanWorker; pending: Map<number, (sessions: LocalSession[] | null) => void> } | null {
    if (running) {
      return running;
    }
    let worker: SessionScanWorker;
    try {
      worker = openWorker(workerUrl);
    } catch (error) {
      report(`the worker did not start (${describe(error)})`);
      return null;
    }
    const pending = new Map<number, (sessions: LocalSession[] | null) => void>();
    const current = { worker, pending };
    running = current;
    worker.onMessage((message) => {
      if (running !== current || !isScanAnswer(message)) {
        return;
      }
      const settle = pending.get(message.id);
      if (!settle) {
        return;
      }
      pending.delete(message.id);
      const accepted = message.accepted && Array.isArray(message.sessions);
      settle(accepted ? message.sessions as LocalSession[] : null);
    });
    worker.onFailure((reason) => stop(`the worker stopped (${reason})`, running === current));
    return current;
  }

  /** One source: its sessions, or null when this thread has to read it. */
  function ask(request: LocalSessionScanRequest): Promise<LocalSession[] | null> {
    const current = start();
    if (!current) {
      return Promise.resolve(null);
    }
    const id = nextId;
    nextId += 1;
    return new Promise((settle) => {
      current.pending.set(id, settle);
      try {
        current.worker.postMessage({
          type: "scan",
          id,
          sourceId: request.sourceId,
          dataPath: request.dataPath,
          limit: request.limit
        } satisfies { type: "scan"; id: number } & LocalSessionScanRequest);
      } catch (error) {
        current.pending.delete(id);
        settle(null);
        stop(`the request did not reach the worker (${describe(error)})`, running === current);
      }
    });
  }

  return async function offload(requests) {
    if (!requests.length) {
      return new Map();
    }
    const answers = await Promise.all(requests.map(async (request) => ({ request, sessions: await ask(request) })));
    const read = new Map<string, LocalSession[]>();
    for (const { request, sessions } of answers) {
      // 没答的源留在本线程读：空列表是「读了，一个会话也没有」，与没读成不是一回事。
      if (sessions) {
        read.set(request.sourceId, sessions);
      }
    }
    return read;
  };
}

function defaultWorker(url: URL): SessionScanWorker {
  const worker = new Worker(url);
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.on("message", listener),
    onFailure: (listener) => {
      worker.on("error", (error) => listener(describe(error)));
      worker.on("exit", (code) => listener(`exit code ${code}`));
    },
    terminate: () => {
      void worker.terminate();
    }
  };
}

function isScanAnswer(message: unknown): message is ScanAnswer {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const answer = message as Partial<ScanAnswer>;
  return answer.type === "scanned" && typeof answer.id === "number" && typeof answer.accepted === "boolean";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
