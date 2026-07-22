import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / lifecycle / governance", () => {
  it("exports redacted bundles, imports them, and records governance audit changes", async () => {
    const first = createTestService();
    const session = first.service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "gov-user",
        projectId: "project-alpha"
      },
      workspaceId: "workspace-alpha"
    });
    const complete = first.service.completeTurn("turn-governance", {
      sessionId: session.sessionId,
      query: "secret raw user text should not be exported by default",
      answer: "secret raw assistant text should stay in raw turn only"
    });
    await first.service.runWorkerOnce(20);

    const redactedBundle = first.service.exportBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "gov-user",
        projectId: "project-alpha"
      }
    });
    const exportedRawTurns = redactedBundle.tables.raw_turns as Array<{
      id: string;
      user_text: string | null;
      assistant_text: string | null;
      tool_calls_json: string;
    }>;
    const exportedRawTurn = exportedRawTurns.find((row) => row.id === complete.rawTurnId);
    expect(exportedRawTurn?.user_text).toBeNull();
    expect(exportedRawTurn?.assistant_text).toBeNull();
    expect(exportedRawTurn?.tool_calls_json).toBe("[]");
    const exportedMemory = (redactedBundle.tables.memories as Array<Record<string, unknown>>)
      .find((row) => row.id === complete.l1MemoryId);
    expect(exportedMemory).toBeTruthy();
    const exportedVector = (redactedBundle.tables.memory_vectors as Array<Record<string, unknown>>)
      .find((row) => row.memory_id === complete.l1MemoryId && row.vector_field === "vec_summary");
    expect(exportedVector).toBeTruthy();
    exportedVector!.embedding_model = "foreign-embedding-model";
    for (const row of redactedBundle.tables.sessions as Array<Record<string, unknown>>) {
      delete row.last_seen_at;
    }
    for (const row of redactedBundle.tables.episodes as Array<Record<string, unknown>>) {
      delete row.turn_count;
    }

    const rawBundle = first.service.exportBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "gov-user",
        projectId: "project-alpha"
      },
      includeRawText: true
    });
    const rawExportedTurn = (rawBundle.tables.raw_turns as Array<{
      id: string;
      user_text: string | null;
    }>).find((row) => row.id === complete.rawTurnId);
    expect(rawExportedTurn?.user_text).toContain("secret raw user text");

    const second = createTestService();
    const imported = second.service.importBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "import-user"
      },
      bundle: redactedBundle
    });
    expect(imported.ok).toBe(true);
    expect(imported.inserted.memories).toBeGreaterThanOrEqual(1);
    expect(imported.migrationMap.memories?.[complete.l1MemoryId]).toBe(complete.l1MemoryId);
    expect(imported.conflicts).toHaveLength(0);
    expect(imported.reembedMemoryIds).toContain(complete.l1MemoryId);
    const importedMemory = second.service.getMemory(complete.l1MemoryId);
    expect(importedMemory.id).toBe(complete.l1MemoryId);

    const duplicateImport = second.service.importBundle({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "import-user"
      },
      bundle: redactedBundle
    });
    expect(duplicateImport.skipped.memories).toBeGreaterThanOrEqual(1);
    expect(duplicateImport.migrationMap.memories?.[complete.l1MemoryId]).toBe(complete.l1MemoryId);
    expect(duplicateImport.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "memories",
        primaryKey: "id",
        sourceId: complete.l1MemoryId,
        targetId: complete.l1MemoryId,
        action: "skipped"
      })
    ]));

    const redact = first.service.redactRawTurn(complete.rawTurnId, {
      reason: "test raw redaction"
    });
    expect(redact.changeSeq).toBeGreaterThan(0);
    const rawTurnAfterRedact = first.db.db.prepare(
      `SELECT user_text, assistant_text, redacted_at
       FROM raw_turns
       WHERE id = ?`
    ).get(complete.rawTurnId) as {
      user_text: string | null;
      assistant_text: string | null;
      redacted_at: string | null;
    };
    expect(rawTurnAfterRedact.user_text).toBeNull();
    expect(rawTurnAfterRedact.assistant_text).toBeNull();
    expect(rawTurnAfterRedact.redacted_at).toBeTruthy();

    const archive = first.service.archiveMemory(complete.l1MemoryId, {
      reason: "test archive"
    });
    expect(archive.status).toBe("archived");
    const deleteResult = first.service.deleteMemory(complete.l1MemoryId, {
      reason: "test delete"
    });
    expect(deleteResult.status).toBe("deleted");
    const deletedRow = first.db.db.prepare(
      `SELECT status, deleted_at, properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as {
      status: string;
      deleted_at: string | null;
      properties_json: string;
    };
    expect(deletedRow.status).toBe("deleted");
    expect(deletedRow.deleted_at).toBeTruthy();
    expect((JSON.parse(deletedRow.properties_json) as { status?: string }).status).toBe("deleted");

    const changes = first.service.panelChanges({ userId: "gov-user" });
    expect(changes.changes.some((change) => change.kind === "raw_turn" && change.op === "updated")).toBe(true);
    expect(changes.changes.some((change) => change.kind === "trace" && change.op === "archived")).toBe(true);
    expect(changes.changes.some((change) => change.kind === "trace" && change.op === "deleted")).toBe(true);
    const audit = first.service.auditLogs({ userId: "gov-user" });
    expect(audit.items.map((item) => item.action)).toEqual(expect.arrayContaining([
      "export",
      "raw_redact",
      "archive",
      "delete"
    ]));

    first.db.close();
    second.db.close();
  });
});
