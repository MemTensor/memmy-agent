import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionDagConfig } from "../../src/config/schema.js";
import { Session, SessionManager } from "../../src/core/session/manager.js";
import { SessionDagQueueManager } from "../../src/session-dag/queue.js";
import { SessionDagStore } from "../../src/session-dag/store.js";

const roots: string[] = [];
const originalDagDir = process.env.MEMMY_AGENT_SESSION_DAG_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalDagDir === undefined) delete process.env.MEMMY_AGENT_SESSION_DAG_DIR;
  else process.env.MEMMY_AGENT_SESSION_DAG_DIR = originalDagDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("rechecks a retry timer that fires before the persisted retry deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-30T00:00:00.000Z"));
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    // The timer expires early while the durable wall-clock deadline is unchanged.
    return schedule(callback, delay === 1000 ? 999 : delay, ...args);
  }) as typeof setTimeout);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dag-retry-deadline-"));
  roots.push(root);
  process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
  const sessionKey = "cli:early-retry-timer";
  const turnId = "early-retry";
  const sessions = new SessionManager(path.join(root, "sessions"));
  const session = new Session({ key: sessionKey });
  session.addMessage("user", "Build a task DAG");
  session.addMessage("assistant", "The task is ready");
  sessions.save(session);
  const provider: any = {
    chatWithRetry: vi.fn(async () => ({
      content: JSON.stringify({ ops: provider.chatWithRetry.mock.calls.length === 1
        ? [{ op: "unsupported" }]
        : [{ op: "add_node", temp_id: "n0", kind: "task", status: "active",
          title: "Retry deadline", summary: "The queued turn completes after its retry deadline", importance: 80 }] }),
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })),
  };
  const queue = new SessionDagQueueManager({
    config: new SessionDagConfig({ debugLog: false, maxUpdateAttempts: 2, retryBackoffMs: [1000], maxConcurrentSessionQueues: 1 }),
    sessions, provider: () => provider, model: () => "test-model",
  });
  queue.enqueueSavedTurn(sessionKey, { turn_id: turnId, message_start: 0, message_end: session.messages.length });
  const store = new SessionDagStore({ sessionKey });
  try {
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(store.getTurn(turnId)?.dag_status).not.toBe("done");
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(store.getTurn(turnId)).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });
  } finally {
    await queue.closeSession(sessionKey);
    store.close();
  }
});
