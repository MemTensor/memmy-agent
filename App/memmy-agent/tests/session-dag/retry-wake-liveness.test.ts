import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SessionDagConfig } from "../../src/config/schema.js";
import { Session, SessionManager } from "../../src/core/session/manager.js";
import { SessionDagQueueManager } from "../../src/session-dag/queue.js";
import { SessionDagStore } from "../../src/session-dag/store.js";

it("keeps a persisted retry scheduled when the session is woken before its deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dag-early-wake-"));
  const previousDirectory = process.env.MEMMY_AGENT_SESSION_DAG_DIR;
  process.env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(root, "dag");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T00:00:00.000Z"));
  const sessionKey = "cli:early-retry-wake";
  const sessions = new SessionManager(path.join(root, "sessions"));
  const session = new Session({ key: sessionKey });
  session.addMessage("user", "Repair the queue");
  session.addMessage("assistant", "The queue is repaired.");
  sessions.save(session);
  let calls = 0;
  const provider = {
    chatWithRetry: vi.fn(async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          ops: calls === 1
            ? [{ op: "unsupported" }]
            : [{ op: "add_node", temp_id: "n0", kind: "task", status: "active", title: "Repair the queue", summary: "Retry completed", importance: 90 }],
        }),
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    }),
  };
  const queue = new SessionDagQueueManager({
    config: new SessionDagConfig({ debugLog: false, maxUpdateAttempts: 2, retryBackoffMs: [1000], maxConcurrentSessionQueues: 1 }),
    sessions,
    provider: () => provider,
    model: () => "test-model",
  });
  const store = new SessionDagStore({ sessionKey });
  try {
    queue.enqueueSavedTurn(sessionKey, { turn_id: "turn-retry", message_start: 0, message_end: 2, user_text: "Repair the queue", assistant_text: "The queue is repaired." });
    await vi.advanceTimersByTimeAsync(0);
    const retry = store.getTurn("turn-retry");
    expect(retry).toMatchObject({ dag_status: "retry", attempt_count: 1 });
    expect(retry?.next_retry_at).toBe("2026-11-03T00:00:01.000Z");

    await vi.advanceTimersByTimeAsync(100);
    queue.wakeSession(sessionKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(store.getTurn("turn-retry")?.next_retry_at).toBe(retry?.next_retry_at);

    await vi.advanceTimersByTimeAsync(899);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(store.getTurn("turn-retry")).toMatchObject({ dag_status: "done", build_mode: "llm_patch" });
    expect(store.readGraphForHistoryDag().nodes.map(node => node.title)).toEqual(["Repair the queue"]);
  } finally {
    await queue.closeSession(sessionKey);
    store.close();
    vi.useRealTimers();
    if (previousDirectory === undefined) delete process.env.MEMMY_AGENT_SESSION_DAG_DIR;
    else process.env.MEMMY_AGENT_SESSION_DAG_DIR = previousDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
