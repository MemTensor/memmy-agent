import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStoreDigest } from "../store-digest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(layout: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memmy-store-"));
  roots.push(root);
  for (const [path, content] of Object.entries(layout)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

/** 把某个文件的时间戳往后推，模拟「追加了一轮」。 */
async function touch(path: string, seconds = 5): Promise<void> {
  const when = new Date(Date.now() + seconds * 1000);
  await utimes(path, when, when);
}

describe("store digest", () => {
  it("stays the same while the store is untouched", async () => {
    const digest = createStoreDigest();
    const root = await store({ "project-a/session-1.jsonl": "{}", "project-b/session-2.jsonl": "{}" });

    const first = await digest(root);

    expect(first).toMatch(/^dir:2:/u);
    expect(await digest(root)).toBe(first);
  });

  it("changes when a session is appended to, even though the directory's own mtime does not move", async () => {
    const digest = createStoreDigest();
    const root = await store({ "project-a/older.jsonl": "{}", "project-a/newer.jsonl": "{}" });
    const before = await digest(root);

    // 往更早的那个会话里追加内容：父目录 mtime 不变，只有文件本身变。
    await touch(join(root, "project-a/older.jsonl"));

    expect(await digest(root)).not.toBe(before);
  });

  it("changes when a session is added or removed", async () => {
    const digest = createStoreDigest();
    const root = await store({ "project-a/session-1.jsonl": "{}" });
    const before = await digest(root);

    await writeFile(join(root, "project-a/session-2.jsonl"), "{}");
    const added = await digest(root);
    expect(added).not.toBe(before);

    await rm(join(root, "project-a/session-2.jsonl"));
    expect(await digest(root)).toBe(before);
    expect(added).not.toBe(before);
  });

  it("digests a single-file store by mtime and size", async () => {
    const digest = createStoreDigest();
    const root = await store({ "opencode.db": "one" });
    const file = join(root, "opencode.db");

    const before = await digest(file);
    expect(before).toMatch(/^file:\d+:3$/u);
    await writeFile(file, "one and more");
    expect(await digest(file)).not.toBe(before);
  });

  it("reports nothing to read when the store is not there", async () => {
    const digest = createStoreDigest();

    expect(await digest("/no/such/agent/store")).toBe("absent");
  });

  it("ignores sqlite's shared index, which every read rebuilds", async () => {
    const digest = createStoreDigest();
    const root = await store({ "state.vscdb": "db", "state.vscdb-wal": "wal", "state.vscdb-shm": "shm" });
    const before = await digest(root);

    // 读一次带 WAL 的库会把 -shm 重建一遍，而数据（-wal 与库本身）没有任何变化。
    await touch(join(root, "state.vscdb-shm"));

    expect(await digest(root)).toBe(before);
    await touch(join(root, "state.vscdb-wal"));
    expect(await digest(root)).not.toBe(before);
  });

  it("gives up on a store too large to digest cheaply", async () => {
    const digest = createStoreDigest({ maxEntries: 5 });
    const root = await store({
      "a/1.jsonl": "{}",
      "a/2.jsonl": "{}",
      "b/3.jsonl": "{}",
      "b/4.jsonl": "{}",
      "b/5.jsonl": "{}"
    });

    expect(await digest(root)).toBeNull();
  });

  it("gives up when session files sit deeper than it looks", async () => {
    const digest = createStoreDigest({ maxDepth: 1 });
    const root = await store({ "a/b/deep.jsonl": "{}" });

    expect(await digest(root)).toBeNull();
  });
});
