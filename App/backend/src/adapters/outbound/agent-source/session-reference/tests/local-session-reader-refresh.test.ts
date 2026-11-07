import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type { ConversationMessage, SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { createLocalSessionReader } from "../local-session-reader.js";
import { createStoreDigest, type StoreDigest } from "../store-digest.js";

/**
 * 每分钟的后台同步曾经每次都把每个 Agent 的最近会话读一遍，本机量级是 6～10 秒。这里盯住的是：
 * 存储没变时不再读盘，变了以后仍然能在同一个 TTL 周期里发现。
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sessionStore(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memmy-sessions-"));
  roots.push(root);
  for (const name of files) {
    await writeFile(join(root, name), "{}");
  }
  return root;
}

/** 一个以目录里 *.jsonl 为会话的假 Agent，并记下它被扫了几次。 */
function storeAdapter(sourceId: string, displayName: string, root: string): SourceAdapter & { scans: number } {
  const adapter = {
    descriptor: { sourceId, displayName, builtin: true, dataPath: root },
    scans: 0,
    detect: async () => true,
    async *scan(): AsyncIterable<ConversationMessage> {
      adapter.scans += 1;
      // 与真实适配器一样按最近优先返回：文件名里的序号越小越新。
      const names = (await readdir(root)).filter((name) => name.endsWith(".jsonl")).sort();
      for (const [index, name] of names.entries()) {
        yield message(sourceId, parse(name).name, new Date(Date.UTC(2026, 9, 21, 8, 0, 60 - index)).toISOString());
      }
    }
  };
  return adapter;
}

function countingDigest(inner: StoreDigest): StoreDigest & { calls: number } {
  const wrapped = (async (dataPath: string) => {
    wrapped.calls += 1;
    return inner(dataPath);
  }) as StoreDigest & { calls: number };
  wrapped.calls = 0;
  return wrapped;
}

function readerWith(adapters: SourceAdapter[], digest: StoreDigest, clock: { now: number }) {
  return createLocalSessionReader({
    registry: createSourceRegistry(adapters),
    snapshotTtlMs: 15_000,
    now: () => clock.now,
    storeDigest: digest
  });
}

describe("local session reader: 存储没变就不重扫", () => {
  it("keeps hitting the snapshot inside the TTL without even checking the stores", async () => {
    const root = await sessionStore(["a.jsonl"]);
    const adapter = storeAdapter("codex", "Codex", root);
    const digest = countingDigest(createStoreDigest());
    const clock = { now: 0 };
    const reader = readerWith([adapter], digest, clock);

    await reader.available({});
    clock.now += 10_000;
    await reader.available({});

    expect(adapter.scans).toBe(1);
    expect(digest.calls).toBe(1);
  });

  it("answers from the snapshot without reading the stores again when nothing changed", async () => {
    const root = await sessionStore(["a.jsonl"]);
    const adapter = storeAdapter("codex", "Codex", root);
    const clock = { now: 0 };
    const reader = readerWith([adapter], createStoreDigest(), clock);

    const cold = await reader.available({});
    clock.now += 60_000;
    const second = await reader.available({});
    clock.now += 60_000;
    const third = await reader.available({});

    expect(adapter.scans).toBe(1);
    for (const listing of [cold, second, third]) {
      expect(listing.sessions.map((session) => session.conversationId)).toEqual(["a"]);
      expect(listing.refreshing).toBe(false);
    }
  });

  it("rescans as soon as a session file appears, and lists it", async () => {
    const root = await sessionStore(["a.jsonl"]);
    const adapter = storeAdapter("codex", "Codex", root);
    const clock = { now: 0 };
    const reader = readerWith([adapter], createStoreDigest(), clock);
    await reader.available({});

    await writeFile(join(root, "b.jsonl"), "{}");
    clock.now += 60_000;
    const stale = await reader.available({});
    // 旧列表马上答，扫描在后台跑：与 TTL 过期时的既有行为一致。
    expect(stale.refreshing).toBe(true);
    expect(stale.sessions.map((session) => session.conversationId)).toEqual(["a"]);

    const fresh = await reader.available({ fresh: true });
    expect(fresh.refreshing).toBe(false);
    expect(fresh.sessions.map((session) => session.conversationId).sort()).toEqual(["a", "b"]);
    expect(adapter.scans).toBe(2);
  });

  it("only rescans the stores that changed", async () => {
    const codexRoot = await sessionStore(["a.jsonl"]);
    const workbuddyRoot = await sessionStore(["w.jsonl"]);
    const codex = storeAdapter("codex", "Codex", codexRoot);
    const workbuddy = storeAdapter("workbuddy", "WorkBuddy", workbuddyRoot);
    const clock = { now: 0 };
    const reader = readerWith([codex, workbuddy], createStoreDigest(), clock);
    await reader.available({});

    await writeFile(join(workbuddyRoot, "w2.jsonl"), "{}");
    clock.now += 60_000;
    await reader.available({ fresh: true });

    expect(codex.scans).toBe(1);
    expect(workbuddy.scans).toBe(2);
  });

  it("rescans a store it cannot tell apart every time, instead of guessing", async () => {
    const root = await sessionStore(["a.jsonl"]);
    const adapter = storeAdapter("hermes", "Hermes", root);
    const clock = { now: 0 };
    const reader = readerWith([adapter], async () => null, clock);

    await reader.available({});
    clock.now += 60_000;
    const stale = await reader.available({});
    expect(stale.refreshing).toBe(true);
    // 要求 fresh 时会等上那次已经开始的扫描，不另外再扫一遍。
    await reader.available({ fresh: true });
    expect(adapter.scans).toBe(2);

    clock.now += 60_000;
    await reader.available({ fresh: true });
    expect(adapter.scans).toBe(3);
  });

  it("still picks up a session whose file was appended to", async () => {
    const root = await sessionStore(["a.jsonl"]);
    const adapter = storeAdapter("codex", "Codex", root);
    const clock = { now: 0 };
    const reader = readerWith([adapter], createStoreDigest(), clock);
    await reader.available({});

    const later = new Date(Date.now() + 5_000);
    await import("node:fs/promises").then(({ utimes }) => utimes(join(root, "a.jsonl"), later, later));
    clock.now += 60_000;
    await reader.available({ fresh: true });

    expect(adapter.scans).toBe(2);
  });

  it("forgets a store that dropped out of the scan range", async () => {
    const root = await sessionStore(["a.jsonl"]);
    const adapter = storeAdapter("codex", "Codex", root);
    const clock = { now: 0 };
    let visible: SourceAdapter[] = [adapter];
    const reader = createLocalSessionReader({
      registry: createSourceRegistry([adapter]),
      adapters: async () => visible,
      snapshotTtlMs: 15_000,
      now: () => clock.now,
      storeDigest: createStoreDigest()
    });

    await reader.available({});
    // 用户在设置里关掉这个 Agent：它不该再出现在列表里。
    visible = [];
    clock.now += 60_000;
    expect((await reader.available({ fresh: true })).sessions).toEqual([]);

    // 重新打开时从头读一遍，而不是拿上次的缓存。
    visible = [adapter];
    clock.now += 60_000;
    expect((await reader.available({ fresh: true })).sessions.map((session) => session.conversationId)).toEqual(["a"]);
    expect(adapter.scans).toBe(2);
  });
});

function message(sourceId: string, conversationId: string, createdAt: string): ConversationMessage {
  return {
    sourceId,
    conversationId,
    role: "user",
    content: `问 ${conversationId}`,
    createdAt,
    workspacePath: "/repo",
    gitRoot: "/repo",
    rawMeta: {}
  };
}