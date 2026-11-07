import { describe, expect, it } from "vitest";
import { createSourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type { ConversationMessage, SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import {
  createLocalSessionReader,
  type LocalSession,
  type LocalSessionScanOffload,
  type LocalSessionScanRequest
} from "../local-session-reader.js";

describe("local session reader with the scan offloaded", () => {
  it("asks one request per source and lists what came back, in adapter order", async () => {
    const asked: LocalSessionScanRequest[][] = [];
    const scans: string[] = [];
    const reader = readerWith(adapters(scans), async (requests) => {
      asked.push([...requests]);
      // 按来源分开返回：调用方必须按适配器顺序拼回来。
      return new Map<string, readonly LocalSession[]>([
        ["codex", [session("codex", "c-2")]],
        ["claude_code", [session("claude_code", "s-1"), session("claude_code", "s-0")]]
      ]);
    });

    const listing = await reader.available({});

    expect(asked).toEqual([[
      { sourceId: "codex", dataPath: "/fake/codex", limit: 30 },
      { sourceId: "claude_code", dataPath: "/fake/claude_code", limit: 30 }
    ]]);
    // 交出去的源不再在本线程读：这正是省下来的时间。
    expect(scans).toEqual([]);
    expect(listing.sessions.map((entry) => entry.conversationId)).toEqual(["c-2", "s-1", "s-0"]);
  });

  it("reads a source itself when the offload did not answer for it", async () => {
    const scans: string[] = [];
    const reader = readerWith(adapters(scans), async () => new Map([["claude_code", [session("claude_code", "s-1")]]]));

    const listing = await reader.available({});

    expect(scans).toEqual(["codex"]);
    expect(listing.sessions.map((entry) => entry.conversationId)).toEqual(["c-1", "s-1"]);
  });

  it("keeps listing every source when the offload itself fails", async () => {
    const scans: string[] = [];
    const reader = readerWith(adapters(scans), async () => {
      throw new Error("worker went away");
    });

    const listing = await reader.available({});

    expect(scans).toEqual(["codex", "claude_code"]);
    expect(listing.sessions.map((entry) => entry.conversationId)).toEqual(["c-1", "s-1"]);
  });

  it("lists exactly what the same readers list without the offload", async () => {
    const onThread = readerWith(adapters([]), undefined);
    // 同一份存储，本线程自己读出来的会话：代读原样交回这一份，列表必须一模一样。
    const read = await Promise.all([
      onThread.read({ sourceId: "codex", conversationId: "c-1" }),
      onThread.read({ sourceId: "claude_code", conversationId: "s-1" })
    ]);
    const replace = async (_requests: readonly LocalSessionScanRequest[]) =>
      new Map(read.map((entry) => [entry.sourceId, [entry]]));
    const offloaded = readerWith(adapters([]), replace);

    expect((await offloaded.available({ limit: 500 })).sessions)
      .toEqual((await onThread.available({ limit: 500 })).sessions);
  });

  it("asks again only for the stores that changed", async () => {
    const asked: string[][] = [];
    let digestOf = (sourceId: string): string | null => `v1-${sourceId}`;
    const scans: string[] = [];
    const reader = createLocalSessionReader({
      registry: createSourceRegistry(adapters(scans)),
      snapshotTtlMs: 0,
      storeDigest: async (path) => digestOf(path.split("/").at(-1) ?? ""),
      offloadScan: async (requests) => {
        asked.push(requests.map((request) => request.sourceId));
        return new Map(requests.map((request) => [request.sourceId, [session(request.sourceId, "c-1")]]));
      }
    });

    await reader.available({});
    digestOf = (sourceId) => (sourceId === "codex" ? "v2-codex" : "v1-claude_code");
    await reader.available({ fresh: true });

    expect(asked).toEqual([["codex", "claude_code"], ["codex"]]);
  });

  it("answers from the last scan while the offloaded scan runs, and waits only when asked for fresh", async () => {
    /** 第一遍直接回，之后那一遍卡住，用来观察「先答旧列表」这一段。 */
    let hold = false;
    let release = (): void => undefined;
    let clock = 0;
    const reader = createLocalSessionReader({
      registry: createSourceRegistry(adapters([])),
      snapshotTtlMs: 15_000,
      now: () => clock,
      // 说不清有没有变：过期之后照旧先答旧列表、后台再扫。
      storeDigest: async () => null,
      offloadScan: async (requests) => {
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        const conversationId = hold ? "new" : "c-1";
        return new Map(requests.map((request) => [request.sourceId, [session(request.sourceId, conversationId)]]));
      }
    });

    expect((await reader.available({})).sessions.map((entry) => entry.conversationId)).toEqual(["c-1", "c-1"]);

    hold = true;
    clock = 20_000;
    const stale = await reader.available({});
    expect(stale).toMatchObject({ refreshing: true });
    expect(stale.sessions.map((entry) => entry.conversationId)).toEqual(["c-1", "c-1"]);

    const fresh = reader.available({ fresh: true });
    release();
    expect((await fresh).sessions.map((entry) => entry.conversationId)).toEqual(["new", "new"]);
    expect((await reader.available({})).sessions.map((entry) => entry.conversationId)).toEqual(["new", "new"]);
  });

  it("does not ask for anything when no agent may be read", async () => {
    let asked = 0;
    const reader = createLocalSessionReader({
      registry: createSourceRegistry(adapters([])),
      adapters: async () => [],
      storeDigest: async () => null,
      offloadScan: async () => {
        asked += 1;
        return new Map();
      }
    });

    expect((await reader.available({})).sessions).toEqual([]);
    expect(asked).toBe(0);
  });
});

/** A reader over these adapters, scanning every store as changed so each call really reads. */
function readerWith(list: SourceAdapter[], offloadScan?: LocalSessionScanOffload) {
  return createLocalSessionReader({
    registry: createSourceRegistry(list),
    snapshotTtlMs: 0,
    storeDigest: async () => null,
    ...(offloadScan ? { offloadScan } : {})
  });
}

/** Two adapters that record the scans they take part in. */
function adapters(scans: string[]): SourceAdapter[] {
  return [
    counting("codex", "c-1", "第一个问题", scans),
    counting("claude_code", "s-1", "另一个问题", scans)
  ];
}

function counting(sourceId: string, conversationId: string, content: string, scans: string[]): SourceAdapter {
  return {
    descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: `/fake/${sourceId}` },
    detect: async () => true,
    scan: async function* () {
      scans.push(sourceId);
      yield message(sourceId, conversationId, content);
    }
  };
}

function message(sourceId: string, conversationId: string, content: string): ConversationMessage {
  return {
    messageId: `${conversationId}:1`,
    sourceId,
    conversationId,
    role: "user",
    content,
    createdAt: "2026-10-21T08:00:00.000Z",
    workspacePath: "/repo",
    gitRoot: null,
    rawMeta: {}
  };
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
    turns: [{ question: "问题", reply: "", steps: [], startedAt: "2026-10-21T08:00:00.000Z" }]
  };
}