import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteWebuiThread, webuiThreadFilePath } from "../../../src/entrypoints/frontend-bridge/thread-disk.js";
import { appendTranscriptObject, webuiTranscriptPath } from "../../../src/entrypoints/frontend-bridge/transcript.js";

const roots: string[] = [];
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function useDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-thread-disk-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

afterEach(() => {
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("webui thread disk cleanup", () => {
  it("removes the legacy JSON snapshot and transcript JSONL", () => {
    useDataDir();
    const key = "websocket:k1";
    const jsonPath = webuiThreadFilePath(key);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, '{"x":1}', "utf8");
    appendTranscriptObject(key, { event: "user", chat_id: "k1", text: "hi" });

    expect(fs.existsSync(webuiTranscriptPath(key))).toBe(true);
    expect(deleteWebuiThread(key)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(webuiTranscriptPath(key))).toBe(false);
    expect(deleteWebuiThread(key)).toBe(false);
  });
});
