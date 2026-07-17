/** Jsonl lines tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlParseError, readJsonlObjects } from "../jsonl-lines.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("readJsonlObjects", () => {
  it("streams JSON objects and skips empty lines", async () => {
    const filePath = writeJsonl(['{"a":1}', "", '{"b":2}']);

    await expect(collect(readJsonlObjects(filePath))).resolves.toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws JsonlParseError with file path and line number for invalid JSON", async () => {
    const filePath = writeJsonl(['{"a":1}', "not-json"]);

    await expect(collect(readJsonlObjects(filePath))).rejects.toMatchObject({
      filePath,
      lineNumber: 2
    });
    await expect(collect(readJsonlObjects(filePath))).rejects.toBeInstanceOf(JsonlParseError);
  });

  it("honors an already aborted signal", async () => {
    const filePath = writeJsonl(['{"a":1}']);
    const controller = new AbortController();
    controller.abort();

    await expect(collect(readJsonlObjects(filePath, controller.signal))).rejects.toMatchObject({
      name: "AbortError"
    });
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

function writeJsonl(lines: readonly string[]): string {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-jsonl-"));
  const filePath = join(tempDir, "sample.jsonl");
  writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}
