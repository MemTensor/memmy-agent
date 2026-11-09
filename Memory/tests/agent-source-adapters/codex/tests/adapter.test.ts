/** Adapter tests. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexSourceAdapter } from "../../../../src/agent-source/adapters/codex/index.js";
import { readCodexRollout } from "../../../../src/agent-source/adapters/codex/rollout-reader.js";
import { discoverCodexSessions } from "../../../../src/agent-source/adapters/codex/session-discovery.js";

// Generated synthetic data for redaction coverage, never a live credential.
const SYNTHETIC_API_KEY = `sk-${"fixture".repeat(8)}`;

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("codex source adapter", () => {
  const threadId = "01a1b5c6-fa7d-7d73-ad9d-a1d1c6280d18";
  const contentHash = "0".repeat(64);

  it.each(["records", "imports"])("recognizes timestamped rollouts from the %s ledger", async field => {
    const fixture = createFixture();
    const record = { source_path: "cursor/agent-transcripts/example.txt", imported_thread_id: threadId,
      [field === "records" ? "content_sha256" : "content_hash"]: contentHash };
    writeFileSync(join(tempDir!, "external_agent_session_imports.json"), JSON.stringify({ [field]: [record], detected_connector_records: [] }));
    const source = readFileSync(fixture.rolloutPath, "utf8").split("\n");
    source[0] = JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: fixture.workspacePath } });
    const timestampedPath = join(fixture.sessionsRoot, `rollout-2026-11-07T19-31-18-${threadId}.jsonl`);
    renameSync(fixture.rolloutPath, timestampedPath);
    writeFileSync(timestampedPath, source.join("\n"));

    await expect(discoverCodexSessions({ root: fixture.sessionsRoot })).resolves.toEqual([
      expect.objectContaining({ sessionFilePath: timestampedPath, externalImport: {
        sourcePath: record.source_path, importedThreadId: threadId, contentHash
      } })
    ]);
  });

  it("uses session_meta.id over a conflicting filename and accepts metadata without cwd", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.rolloutPath, JSON.stringify({ type: "session_meta", payload: { id: threadId } }));
    writeFileSync(join(tempDir!, "external_agent_session_imports.json"), JSON.stringify({ records: [{
      source_path: "cursor/example.txt", imported_thread_id: threadId, content_sha256: contentHash
    }] }));
    await expect(discoverCodexSessions({ root: fixture.sessionsRoot })).resolves.toEqual([
      expect.objectContaining({ workspacePath: null, externalImport: {
        sourcePath: "cursor/example.txt", importedThreadId: threadId, contentHash
      } })
    ]);
  });

  it.each([false, true])("uses the UUID filename suffix when session metadata has no id (plain=%s)", async plain => {
    const fixture = createFixture();
    // This fixture has cwd in session_meta but no id, as in older rollouts.
    const filenameThreadId = "019e72be-500b-7f02-9400-112c5a194e5c";
    if (plain) renameSync(fixture.rolloutPath, join(fixture.sessionsRoot, `rollout-${filenameThreadId}.jsonl`));
    writeFileSync(join(tempDir!, "external_agent_session_imports.json"), JSON.stringify({ records: [{
      source_path: "cursor/example.txt", imported_thread_id: filenameThreadId, content_sha256: contentHash
    }] }));
    const sessions = await discoverCodexSessions({ root: fixture.sessionsRoot });
    expect(sessions[0]?.externalImport).toEqual({ sourcePath: "cursor/example.txt", importedThreadId: filenameThreadId, contentHash });
    expect(sessions[0]?.workspacePath).toBe(fixture.workspacePath);
  });

  it("prefers native records/content_sha256 and ignores invalid and connector-only entries", async () => {
    const fixture = createFixture();
    const filenameThreadId = "019e72be-500b-7f02-9400-112c5a194e5c";
    const record = { source_path: "cursor/native.txt", imported_thread_id: filenameThreadId,
      content_sha256: contentHash, content_hash: "legacy-hash" };
    const ledgerPath = join(tempDir!, "external_agent_session_imports.json");
    writeFileSync(ledgerPath, JSON.stringify({ records: [null, {}, { ...record, source_path: "" },
      { ...record, imported_thread_id: "" }, record], imports: [{ ...record, source_path: "cursor/legacy.txt" }] }));
    expect((await discoverCodexSessions({ root: fixture.sessionsRoot }))[0]?.externalImport).toEqual({
      sourcePath: record.source_path, importedThreadId: filenameThreadId, contentHash
    });
    writeFileSync(ledgerPath, JSON.stringify({ records: [], detected_connector_records: [record] }));
    expect((await discoverCodexSessions({ root: fixture.sessionsRoot }))[0]?.externalImport).toBeUndefined();
  });

  it.each(["{", "null", '{"records":{}}'])("still discovers sessions with an unreadable ledger: %s", async ledger => {
    const fixture = createFixture();
    writeFileSync(join(tempDir!, "external_agent_session_imports.json"), ledger);
    const sessions = await discoverCodexSessions({ root: fixture.sessionsRoot });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.workspacePath).toBe(fixture.workspacePath);
    expect(sessions[0]?.externalImport).toBeUndefined();
  });

  it("reads user, assistant, and tool response items", async () => {
    const fixture = createFixture();

    const messages = await collect(readCodexRollout(fixture.rolloutPath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:000000000002",
        conversationId: "019e72be-500b-7f02-9400-112c5a194e5c",
        role: "user",
        content: `Use OPENAI_API_KEY=${SYNTHETIC_API_KEY}`
      }),
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:000000000003",
        role: "tool",
        content: expect.stringContaining("Tool: shell")
      }),
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:000000000004",
        role: "tool",
        content: expect.stringContaining("Output:")
      }),
      expect.objectContaining({
        messageId: "019e72be-500b-7f02-9400-112c5a194e5c:000000000005",
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
    expect(messages.some((message) => message.content.includes(SYNTHETIC_API_KEY))).toBe(false);
  });

  it("ignores backup copies of rollout files", async () => {
    const fixture = createFixture();
    const backupPath = `${fixture.rolloutPath}.bak-strip-input-image.jsonl`;
    writeFileSync(
      backupPath,
      JSON.stringify({
        timestamp: "2026-05-29T11:00:00.000Z",
        type: "session_meta",
        payload: { cwd: join(fixture.workspacePath, "backup-copy") }
      }),
      "utf8"
    );

    await expect(discoverCodexSessions({ root: fixture.sessionsRoot })).resolves.toEqual([
      expect.objectContaining({ sessionFilePath: fixture.rolloutPath })
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
      JSON.stringify({ timestamp: "2026-05-29T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Use OPENAI_API_KEY=${SYNTHETIC_API_KEY}` }] } }),
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
