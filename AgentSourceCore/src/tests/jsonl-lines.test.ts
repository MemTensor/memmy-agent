import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonlObjects } from "../jsonl-lines.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function transcript(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "memmy-jsonl-"));
  directories.push(directory);
  const filePath = join(directory, "session.jsonl");
  await writeFile(filePath, content);
  return filePath;
}

describe("JSONL reader cancellation", () => {
  it.each(["\n", ""])("stops buffered records after cancellation with final newline %j", async ending => {
    const filePath = await transcript(`{"id":1}\n{"id":2}${ending}`);
    const controller = new AbortController();
    const iterator = readJsonlObjects(filePath, controller.signal)[Symbol.asyncIterator]();
    try {
      expect(await iterator.next()).toEqual({ value: { id: 1 }, done: false });
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await iterator.return?.();
    }
  });

  it("rejects an already-canceled read of an empty file", async () => {
    const filePath = await transcript("");
    const controller = new AbortController();
    controller.abort();
    const iterator = readJsonlObjects(filePath, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
