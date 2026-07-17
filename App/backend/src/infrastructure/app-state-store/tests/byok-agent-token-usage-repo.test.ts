import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ByokTokenUsageEvent } from "@memmy/local-api-contracts";
import { createAppStateStore } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("ByokTokenUsageRepository", () => {
  it("records events and persists metadata and raw usage JSON", () => {
    const store = createStore();

    store.repositories.byokTokenUsage.recordEvent(eventFixture({
      id: "event-1",
      rawUsage: { prompt_tokens: 10, completion_tokens: 20, cached_tokens: 3 },
    }));

    const row = store.db
      .prepare("SELECT kind, source, operation_id, input_tokens, metadata_json, usage_json FROM byok_token_usage_events WHERE id = ?")
      .get("event-1") as {
        kind: string;
        source: string;
        operation_id: string;
        input_tokens: number;
        metadata_json: string;
        usage_json: string;
      } | undefined;
    store.close();

    expect(row).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      operation_id: "turn-1",
      input_tokens: 10,
    });
    expect(JSON.parse(row?.metadata_json ?? "{}")).toMatchObject({
      sessionKey: "cli:direct",
      modelId: "gpt-4.1-mini",
    });
    expect(JSON.parse(row?.usage_json ?? "{}")).toMatchObject({
      prompt_tokens: 10,
      cached_tokens: 3,
    });
  });

  it("upserts the same kind, source and operation without duplicating summary totals", () => {
    const store = createStore();

    store.repositories.byokTokenUsage.recordEvent(eventFixture({
      id: "event-1",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    }));
    store.repositories.byokTokenUsage.recordEvent(eventFixture({
      id: "event-2",
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      createdAt: "2026-06-11T11:00:00.000Z",
    }));

    const count = store.db
      .prepare("SELECT COUNT(*) AS count FROM byok_token_usage_events")
      .get() as { count: number };
    const summary = store.repositories.byokTokenUsage.getSummary();
    store.close();

    expect(count.count).toBe(1);
    expect(summary).toMatchObject({
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      updatedAt: "2026-06-11T11:00:00.000Z",
    });
  });

  it("summarizes totals by fixed usage kind", () => {
    const store = createStore();

    store.repositories.byokTokenUsage.recordEvent(eventFixture({
      id: "event-1",
      kind: "agent_chat",
      operationId: "turn-1",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 2,
    }));
    store.repositories.byokTokenUsage.recordEvent(eventFixture({
      id: "event-2",
      kind: "memory_summary",
      source: "memory",
      operationId: "episode.summarize:event-2",
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cachedInputTokens: 1,
      cacheCreationInputTokens: 1,
      createdAt: "2026-06-11T11:00:00.000Z",
    }));
    store.repositories.byokTokenUsage.recordEvent(eventFixture({
      id: "event-3",
      kind: "embedding",
      source: "memory",
      operationId: "embedding.document:event-3",
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      createdAt: "2026-06-11T12:00:00.000Z",
    }));

    const summary = store.repositories.byokTokenUsage.getSummary();
    store.close();

    expect(summary).toMatchObject({
      inputTokens: 18,
      outputTokens: 22,
      totalTokens: 40,
      cachedInputTokens: 6,
      cacheCreationInputTokens: 3,
      updatedAt: "2026-06-11T12:00:00.000Z",
    });
    expect(summary.byKind).toEqual([
      {
        kind: "agent_chat",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 2,
        eventCount: 1,
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
      {
        kind: "memory_summary",
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 1,
        eventCount: 1,
        updatedAt: "2026-06-11T11:00:00.000Z",
      },
      {
        kind: "embedding",
        inputTokens: 7,
        outputTokens: 0,
        totalTokens: 7,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        eventCount: 1,
        updatedAt: "2026-06-11T12:00:00.000Z",
      },
    ]);
  });
});

function createStore() {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-app-state-"));
  return createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });
}

function eventFixture(overrides: Partial<ByokTokenUsageEvent> = {}): ByokTokenUsageEvent {
  const base: ByokTokenUsageEvent = {
    id: "event-1",
    kind: "agent_chat",
    source: "agent",
    operationId: "turn-1",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    metadata: {
      sessionKey: "cli:direct",
      provider: "openai",
      modelId: "gpt-4.1-mini",
    },
    rawUsage: { prompt_tokens: 10, completion_tokens: 20 },
    createdAt: "2026-06-11T10:00:00.000Z",
  };
  return { ...base, ...overrides };
}
