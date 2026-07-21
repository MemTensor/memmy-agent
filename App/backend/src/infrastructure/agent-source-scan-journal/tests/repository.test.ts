import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore, type AppStateStore } from "../../app-state-store/index.js";
import { createAgentSourceScanJournal } from "../repository.js";

let tempDir: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("agent source scan journal repository", () => {
  it("stores add-phase resume data as SQLite rows", () => {
    const journal = createJournal();

    journal.writeResume({
      jobId: "job-1",
      sourceId: "all",
      mode: "initial_subset",
      resume: {
        phase: "add",
        collected: [
          {
            sourceId: "cursor",
            scanMode: "initial_subset",
            scanStartedAt: "2026-07-07T01:00:00.000Z",
            watermarkedSince: undefined,
            conversationIds: ["conversation-1"],
            messages: [
              {
                messageId: "message-1",
                sourceId: "cursor",
                conversationId: "conversation-1",
                role: "user",
                content: "hello",
                createdAt: "2026-07-07T01:00:01.000Z",
                workspacePath: "/tmp/workspace",
                gitRoot: "/tmp/workspace",
                rawMeta: Object.freeze({ toolName: "shell" })
              }
            ],
            errors: []
          }
        ]
      }
    });

    expect(readCount("account_agent_source_scan_messages")).toBe(1);
    expect(journal.readResume("job-1")).toEqual({
      phase: "add",
      collected: [
        {
          sourceId: "cursor",
          scanMode: "initial_subset",
          scanStartedAt: "2026-07-07T01:00:00.000Z",
          watermarkedSince: undefined,
          conversationIds: ["conversation-1"],
          messages: [
            {
              messageId: "message-1",
              sourceId: "cursor",
              conversationId: "conversation-1",
              role: "user",
              content: "hello",
              createdAt: "2026-07-07T01:00:01.000Z",
              workspacePath: "/tmp/workspace",
              gitRoot: "/tmp/workspace",
              rawMeta: Object.freeze({ toolName: "shell" })
            }
          ],
          errors: []
        }
      ]
    });
  });

  it("stores summarize-phase resume data without staged messages", () => {
    const journal = createJournal();

    journal.writeResume({
      jobId: "job-2",
      sourceId: "all",
      resume: {
        phase: "summarize",
        results: [
          {
            sourceId: "cursor",
            discoveredConversations: 1,
            emittedMessages: 2,
            skipped: 0,
            errors: [{ conversationId: "scan", reason: "read failed" }]
          }
        ]
      }
    });

    expect(readCount("account_agent_source_scan_messages")).toBe(0);
    expect(journal.readResume("job-2")).toEqual({
      phase: "summarize",
      results: [
        {
          sourceId: "cursor",
          discoveredConversations: 1,
          emittedMessages: 2,
          skipped: 0,
          memoryIds: [],
          errors: [{ conversationId: "scan", reason: "read failed" }]
        }
      ]
    });
    expect(journal.findLatestJob()).toEqual({
      jobId: "job-2",
      sourceId: "all",
      mode: undefined,
      phase: "summarize",
      messageCount: 0,
      sourceCount: 0,
      resultCount: 1
    });
  });

  it("deletes all rows for a completed or canceled scan job", () => {
    const journal = createJournal();

    journal.writeResume({
      jobId: "job-3",
      sourceId: "all",
      resume: {
        phase: "add",
        collected: [
          {
            sourceId: "cursor",
            conversationIds: ["conversation-1"],
            messages: [
              {
                messageId: "message-1",
                sourceId: "cursor",
                conversationId: "conversation-1",
                role: "assistant",
                content: "answer",
                createdAt: "2026-07-07T01:00:01.000Z",
                workspacePath: null,
                gitRoot: null,
                rawMeta: Object.freeze({})
              }
            ],
            errors: []
          }
        ]
      }
    });

    journal.deleteJob("job-3");

    expect(journal.readResume("job-3")).toBeNull();
    expect(readCount("account_agent_source_scan_messages")).toBe(0);
    expect(readCount("account_agent_source_scan_source_state")).toBe(0);
  });
});

function createJournal() {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-scan-journal-"));
  store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });
  return createAgentSourceScanJournal(store.db);
}

function readCount(tableName: string): number {
  const row = store?.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number } | undefined;
  return row?.count ?? 0;
}
