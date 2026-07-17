/** Adapter tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexSourceAdapter } from "../index.js";
import { readCodexRollout } from "../rollout-reader.js";
import { discoverCodexSessions } from "../session-discovery.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("codex source adapter", () => {
  it("reads user, assistant, and tool response items", async () => {
    const fixture = createFixture();

    const messages = await collect(readCodexRollout(fixture.rolloutPath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:2",
        conversationId: "019e72be-500b-7f02-9400-112c5a194e5c",
        role: "user",
        content: "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"
      }),
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:3",
        role: "tool",
        content: expect.stringContaining("Tool: shell")
      }),
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:4",
        role: "tool",
        content: expect.stringContaining("Output:")
      }),
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:5",
        role: "assistant",
        content: "Done"
      })
    ]);
  });

  it("discovers rollout files and streams redacted messages", async () => {
    const fixture = createFixture();
    const adapter = createCodexSourceAdapter({ sessionsRoot: fixture.sessionsRoot });

    await expect(discoverCodexSessions({ root: fixture.sessionsRoot })).resolves.toEqual([
      expect.objectContaining({ sessionFilePath: fixture.rolloutPath, workspacePath: fixture.workspacePath })
    ]);

    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "codex",
        content: "Use OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({ sourceId: "codex", role: "tool" }),
      expect.objectContaining({ sourceId: "codex", role: "tool" }),
      expect.objectContaining({ sourceId: "codex", role: "assistant" })
    ]);
  });

  it("redacts large image tool outputs without failing the scan", async () => {
    const fixture = createLargeImageFixture();
    const adapter = createCodexSourceAdapter({ sessionsRoot: fixture.sessionsRoot });

    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "codex",
        role: "tool",
        content: expect.stringContaining("data:image/png;base64,[REDACTED:base64_secret]")
      })
    ]);
    expect(messages[0]?.content.length).toBeLessThan(500);
  });

  it("skips corrupt rollout files and continues scanning Codex history", async () => {
    const fixture = createCorruptRolloutFixture();
    const adapter = createCodexSourceAdapter({ sessionsRoot: fixture.sessionsRoot });

    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "codex",
        conversationId: "019e72be-500b-7f02-9400-112c5a194e5d",
        role: "assistant",
        content: "Recovered"
      })
    ]);
  });

  it("discovers rollout files through nested directories without recursive traversal", async () => {
    const fixture = createFixture();
    const nestedDirectory = join(fixture.sessionsRoot, "archive", "deep", "2026", "05", "30");
    const nestedRolloutPath = join(nestedDirectory, "rollout-2026-05-30T15-58-55-119e72be-500b-7f02-9400-112c5a194e5c.jsonl");
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(
      nestedRolloutPath,
      JSON.stringify({ timestamp: "2026-05-30T10:00:00.000Z", type: "session_meta", payload: { cwd: fixture.workspacePath } }),
      "utf8"
    );

    await expect(discoverCodexSessions({ root: fixture.sessionsRoot, order: "recent_first", maxSessions: 1 })).resolves.toEqual([
      expect.objectContaining({ sessionFilePath: nestedRolloutPath })
    ]);
  });

  it("treats a missing sessions directory as an empty history", async () => {
    const sessionsRoot = join(tmpdir(), `memmy-missing-codex-${crypto.randomUUID()}`);

    await expect(discoverCodexSessions({ root: sessionsRoot })).resolves.toEqual([]);
    await expect(collect(createCodexSourceAdapter({ sessionsRoot }).scan({}))).resolves.toEqual([]);
  });

  it("throws AbortError when scan is aborted before reading", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(collect(createCodexSourceAdapter({ sessionsRoot: fixture.sessionsRoot }).scan({ signal: controller.signal }))).rejects.toMatchObject({
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

function createFixture(): { sessionsRoot: string; workspacePath: string; rolloutPath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-codex-source-"));
  const sessionsRoot = join(tempDir, "sessions");
  const workspacePath = join(tempDir, "project");
  const rolloutDirectory = join(sessionsRoot, "2026", "05", "29");
  const rolloutPath = join(rolloutDirectory, "rollout-2026-05-29T15-58-55-019e72be-500b-7f02-9400-112c5a194e5c.jsonl");

  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(rolloutDirectory, { recursive: true });
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ timestamp: "2026-05-29T10:00:00.000Z", type: "session_meta", payload: { cwd: workspacePath } }),
      JSON.stringify({ timestamp: "2026-05-29T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }] } }),
      JSON.stringify({ timestamp: "2026-05-29T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call-shell-1", arguments: "{\"cmd\":\"pwd\"}" } }),
      JSON.stringify({ timestamp: "2026-05-29T10:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-shell-1", output: "/tmp/project" } }),
      JSON.stringify({ timestamp: "2026-05-29T10:00:04.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } })
    ].join("\n"),
    "utf8"
  );

  return { sessionsRoot, workspacePath, rolloutPath };
}

function createLargeImageFixture(): { sessionsRoot: string; rolloutPath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-codex-source-"));
  const sessionsRoot = join(tempDir, "sessions");
  const rolloutDirectory = join(sessionsRoot, "2026", "05", "29");
  const rolloutPath = join(rolloutDirectory, "rollout-2026-05-29T15-58-55-019e72be-500b-7f02-9400-112c5a194e5c.jsonl");

  mkdirSync(rolloutDirectory, { recursive: true });
  writeFileSync(
    rolloutPath,
    JSON.stringify({
      timestamp: "2026-05-29T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-view-image",
        output: `data:image/png;base64,${"A".repeat(2_000_000)}`
      }
    }),
    "utf8"
  );

  return { sessionsRoot, rolloutPath };
}

function createCorruptRolloutFixture(): { sessionsRoot: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-codex-source-"));
  const sessionsRoot = join(tempDir, "sessions");
  const rolloutDirectory = join(sessionsRoot, "2026", "05", "29");
  const corruptRolloutPath = join(rolloutDirectory, "rollout-2026-05-29T15-58-55-019e72be-500b-7f02-9400-112c5a194e5c.jsonl");
  const validRolloutPath = join(rolloutDirectory, "rollout-2026-05-29T15-59-55-019e72be-500b-7f02-9400-112c5a194e5d.jsonl");

  mkdirSync(rolloutDirectory, { recursive: true });
  writeFileSync(corruptRolloutPath, "{\"timestamp\":\"2026-05-29T10:00:00.000Z\"\n", "utf8");
  writeFileSync(
    validRolloutPath,
    JSON.stringify({
      timestamp: "2026-05-29T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Recovered" }]
      }
    }),
    "utf8"
  );

  return { sessionsRoot };
}
