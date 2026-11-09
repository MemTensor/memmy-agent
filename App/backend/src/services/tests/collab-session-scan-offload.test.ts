import { describe, expect, it } from "vitest";
import type { LocalSession } from "../../adapters/outbound/agent-source/session-reference/local-session-reader.js";
import { createSessionScanOffload, type SessionScanWorker } from "../collab-session-scan-offload.js";

describe("session scan offload", () => {
  it("reads every requested source on the worker and groups the sessions by source", async () => {
    const worker = fakeWorker();
    const offload = createSessionScanOffload({ createWorker: () => worker.worker, onFailure: fail });

    const reading = offload([
      { sourceId: "claude_code", dataPath: "/store/claude", limit: 30 },
      { sourceId: "codex", dataPath: "/store/codex", limit: 30 }
    ]);
    worker.answerAll();
    const read = await reading;

    expect(worker.requests).toEqual([
      { type: "scan", id: 1, sourceId: "claude_code", dataPath: "/store/claude", limit: 30 },
      { type: "scan", id: 2, sourceId: "codex", dataPath: "/store/codex", limit: 30 }
    ]);
    expect([...read.keys()].sort()).toEqual(["claude_code", "codex"]);
    expect(read.get("codex")).toEqual([session("codex", "c-1")]);
  });

  it("leaves a source the worker declines to the caller", async () => {
    const worker = fakeWorker();
    const offload = createSessionScanOffload({ createWorker: () => worker.worker, onFailure: fail });

    const reading = offload([
      { sourceId: "cursor", dataPath: "/store/cursor", limit: 30 },
      { sourceId: "codex", dataPath: "/store/codex", limit: 30 }
    ]);
    // 同一个来源读的却是另一份存储：worker 不答，调用方自己读。
    worker.answer(worker.requests[0]!.id, { accepted: false, reason: "Store mismatch: cursor" });
    worker.answer(worker.requests[1]!.id, { accepted: true, sessions: [session("codex", "c-1")] });
    const read = await reading;

    expect([...read.keys()]).toEqual(["codex"]);
  });

  it("treats an answer without sessions as a source the worker did not read", async () => {
    const worker = fakeWorker();
    const offload = createSessionScanOffload({ createWorker: () => worker.worker, onFailure: fail });

    const reading = offload([{ sourceId: "codex", dataPath: "/store/codex", limit: 30 }]);
    // 回了、但不是一组会话：当成没读出来，留给调用方自己读。
    worker.answer(worker.requests[0]!.id, { accepted: true, sessions: "not an array" as unknown as LocalSession[] });

    expect([...(await reading).keys()]).toEqual([]);
  });

  it("answers nothing when the worker cannot start, and says so once", async () => {
    const reported: string[] = [];
    const offload = createSessionScanOffload({
      createWorker: () => {
        throw new Error("no such file");
      },
      onFailure: (reason) => reported.push(reason)
    });

    expect([...await offload([{ sourceId: "codex", dataPath: "/store/codex", limit: 30 }]).then((read) => read.keys())])
      .toEqual([]);
    // 每次来信都记一句，但不会因为没读成而抛出：结果一样，只是慢。
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("no such file");
  });

  it("hands the pending sources back when the worker dies, and starts a new one for the next scan", async () => {
    const reported: string[] = [];
    const workers: FakeWorker[] = [];
    const offload = createSessionScanOffload({
      createWorker: () => {
        const next = fakeWorker();
        workers.push(next);
        return next.worker;
      },
      onFailure: (reason) => reported.push(reason)
    });

    const dying = offload([{ sourceId: "codex", dataPath: "/store/codex", limit: 30 }]);
    workers[0]!.fail("worker exited");
    expect([...(await dying).keys()]).toEqual([]);
    expect(workers[0]!.terminated).toBe(true);
    expect(reported.some((reason) => reason.includes("worker exited"))).toBe(true);

    // 下一次扫描另起一个，读完就好。
    const next = offload([{ sourceId: "codex", dataPath: "/store/codex", limit: 30 }]);
    expect(workers).toHaveLength(2);
    workers[1]!.answer(workers[1]!.requests.at(-1)!.id, { accepted: true, sessions: [session("codex", "c-2")] });
    expect([...(await next).get("codex") ?? []].map((entry) => entry.conversationId)).toEqual(["c-2"]);
  });

  it("reuses one worker across scans instead of starting another", async () => {
    const created: FakeWorker[] = [];
    const offload = createSessionScanOffload({
      createWorker: () => {
        const next = fakeWorker();
        created.push(next);
        return next.worker;
      },
      onFailure: fail
    });

    for (const id of ["c-1", "c-2"]) {
      const reading = offload([{ sourceId: "codex", dataPath: "/store/codex", limit: 30 }]);
      created.at(-1)!.answer(created.at(-1)!.requests.at(-1)!.id, { accepted: true, sessions: [session("codex", id)] });
      expect([...(await reading).get("codex") ?? []].map((entry) => entry.conversationId)).toEqual([id]);
    }
    expect(created).toHaveLength(1);
  });

  it("does not start a worker when there is nothing to read", async () => {
    let started = 0;
    const offload = createSessionScanOffload({
      createWorker: () => {
        started += 1;
        return fakeWorker().worker;
      },
      onFailure: fail
    });

    expect([...await offload([]).then((read) => read.keys())]).toEqual([]);
    expect(started).toBe(0);
  });
});

function fail(reason: string): never {
  throw new Error(`Unexpected worker failure: ${reason}`);
}

interface FakeWorker {
  worker: SessionScanWorker;
  requests: Array<{ type: string; id: number; sourceId: string; dataPath: string; limit: number }>;
  answer(id: number, answer: { accepted: boolean; sessions?: LocalSession[]; reason?: string }): void;
  answerAll(): void;
  fail(reason: string): void;
  terminated: boolean;
}

/** A stand-in for the worker thread: the test decides what it answers. */
function fakeWorker(): FakeWorker {
  const requests: FakeWorker["requests"] = [];
  const messages: Array<(message: unknown) => void> = [];
  const failures: Array<(reason: string) => void> = [];
  const state: FakeWorker = {
    requests,
    terminated: false,
    worker: {
      postMessage: (message) => {
        requests.push(message as FakeWorker["requests"][number]);
      },
      onMessage: (listener) => messages.push(listener),
      onFailure: (listener) => failures.push(listener),
      terminate: () => {
        state.terminated = true;
      }
    },
    answer: (id, answer) => {
      for (const listener of messages) {
        listener({ type: "scanned", id, ...answer });
      }
    },
    answerAll: () => {
      for (const request of requests) {
        state.answer(request.id, { accepted: true, sessions: [session(request.sourceId, "c-1")] });
      }
    },
    fail: (reason) => {
      for (const listener of failures) {
        listener(reason);
      }
    }
  };
  return state;
}

function session(sourceId: string, conversationId: string): LocalSession {
  return {
    sourceId,
    agentName: sourceId,
    conversationId,
    title: "标题",
    lastQuestion: "问题",
    workspacePath: "/repo",
    group: { id: "/repo", label: "repo", path: "/repo" },
    updatedAt: "2026-10-21T08:00:00.000Z",
    turns: []
  };
}