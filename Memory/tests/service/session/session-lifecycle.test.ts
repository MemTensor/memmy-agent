import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / session / lifecycle", () => {
  it("opens a session, completes a turn, recalls memory, and respects idempotency", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      adapterId: "test-adapter",
      requestId: "session-open-1",
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-1"
      },
      workspaceId: "workspace-1",
      meta: {
        conversationId: "conversation-1"
      }
    });
    const duplicateSession = service.openSession({
      adapterId: "test-adapter",
      requestId: "session-open-1",
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-1"
      },
      workspaceId: "workspace-1",
      meta: {
        conversationId: "conversation-1"
      }
    });
    expect(session.resumed).toBe(false);
    expect(duplicateSession.sessionId).toBe(session.sessionId);
    expect(duplicateSession.duplicate).toBe(true);
    expect(session.changeSeq).toBeGreaterThan(0);

    const hostSession = service.openSession({
      adapterId: "test-adapter",
      requestId: "session-host-open-1",
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-1",
        sessionKey: "host-session-1"
      }
    });
    const resumedHostSession = service.openSession({
      adapterId: "test-adapter",
      requestId: "session-host-open-2",
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-1",
        sessionKey: "host-session-1"
      }
    });
    expect(hostSession.resumed).toBe(false);
    expect(resumedHostSession.sessionId).toBe(hostSession.sessionId);
    expect(resumedHostSession.resumed).toBe(true);
    expect(resumedHostSession.duplicate).toBeUndefined();

    const complete = service.completeTurn("turn-1", {
      adapterId: "test-adapter",
      requestId: "request-1",
      sessionId: session.sessionId,
      query: "把记忆插件迁移为 SQLite 本地记忆底座服务",
      answer: "已创建 REST 和 CLI 的服务框架。",
      tags: ["migration"]
    });

    const duplicate = service.completeTurn("turn-1", {
      adapterId: "test-adapter",
      requestId: "request-1",
      sessionId: session.sessionId,
      query: "把记忆插件迁移为 SQLite 本地记忆底座服务",
      answer: "已创建 REST 和 CLI 的服务框架。",
      tags: ["migration"]
    });

    expect(duplicate.l1MemoryId).toBe(complete.l1MemoryId);
    expect(duplicate.duplicate).toBe(true);
    expect(complete.l1MemoryIds).toEqual([complete.l1MemoryId]);
    expect(complete.jobs.map((job) => job.jobType)).toEqual(["embedding", "episode_idle_close"]);
    const idleCloseJobs = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'episode_idle_close'
         AND episode_id = ?`
    ).get(complete.episodeId) as { count: number };
    expect(idleCloseJobs.count).toBe(1);
    expect(complete.changeSeq).toBeGreaterThan(0);
    expect(complete.syncCursor).toMatch(/^cur_/);
    const completeLatestChange = db.db.prepare(
      `SELECT seq, kind, op, source
       FROM memory_change_log
       WHERE namespace_id = (
         SELECT namespace_id
         FROM memory_change_log
         WHERE entity_id = ?
         ORDER BY seq ASC
         LIMIT 1
       )
       ORDER BY seq DESC
       LIMIT 1`
    ).get(complete.rawTurnId) as { seq: number; kind: string; op: string; source: string };
    expect(complete.changeSeq).toBe(completeLatestChange.seq);
    expect(completeLatestChange).toMatchObject({
      kind: "job",
      op: "queued",
      source: "worker.evolution_jobs"
    });
    const sessionState = db.db.prepare(
      `SELECT opened_at, last_seen_at
       FROM sessions
       WHERE id = ?`
    ).get(session.sessionId) as { opened_at: string; last_seen_at: string };
    expect(Date.parse(sessionState.last_seen_at)).toBeGreaterThanOrEqual(Date.parse(sessionState.opened_at));
    const episodeState = db.db.prepare(
      `SELECT turn_count
       FROM episodes
       WHERE id = ?`
    ).get(complete.episodeId) as { turn_count: number };
    expect(episodeState.turn_count).toBe(1);
    const initialChangeKinds = db.db.prepare(
      `SELECT kind, op, entity_id
       FROM memory_change_log
       WHERE entity_id IN (?, ?, ?, ?)
       ORDER BY seq ASC`
    ).all(session.sessionId, complete.episodeId, complete.rawTurnId, complete.l1MemoryId) as Array<{
      kind: string;
      op: string;
      entity_id: string;
    }>;
    expect(initialChangeKinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", op: "created", entity_id: session.sessionId }),
      expect.objectContaining({ kind: "episode", op: "created", entity_id: complete.episodeId }),
      expect.objectContaining({ kind: "raw_turn", op: "created", entity_id: complete.rawTurnId }),
      expect.objectContaining({ kind: "trace", op: "created", entity_id: complete.l1MemoryId })
    ]));

    const detail = service.getMemory(complete.l1MemoryId);
    expect((detail.metadata.info as { tags?: string[] }).tags).toContain("migration");
    const properties = detail.metadata.properties as {
      internal_info: {
        summary?: string;
        reflection?: string | null;
        alpha?: number;
        value?: number;
        priority?: number;
        raw_turn_id?: string;
        raw_span?: Record<string, unknown>;
        error_signatures?: string[];
        trace: Record<string, unknown>;
      };
    };
    expect(properties.internal_info.summary).toContain("SQLite");
    expect(properties.internal_info.raw_turn_id).toBe(complete.rawTurnId);
    expect(properties.internal_info.raw_span).toMatchObject({
      user_text: true,
      agent_text: true
    });
    expect(properties.internal_info.value).toBe(0);
    expect(properties.internal_info.priority).toBe(0.5);
    expect(properties.internal_info.error_signatures).toEqual(expect.any(Array));
    const traceMeta = properties.internal_info.trace;
    expect(traceMeta.raw_turn_id).toBe(complete.rawTurnId);
    expect(traceMeta.userText).toBe("把记忆插件迁移为 SQLite 本地记忆底座服务");
    expect(traceMeta.agentText).toBe("已创建 REST 和 CLI 的服务框架。");
    expect(traceMeta.user_text).toBeUndefined();
    expect(traceMeta.agent_text).toBeUndefined();

    const feedback = await service.feedback({
      adapterId: "test-adapter",
      requestId: "feedback-1",
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1
    });
    const duplicateFeedback = await service.feedback({
      adapterId: "test-adapter",
      requestId: "feedback-1",
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1
    });
    expect(duplicateFeedback.feedbackId).toBe(feedback.feedbackId);
    expect(duplicateFeedback.duplicate).toBe(true);
    const workerRun = await service.runWorkerOnce(10);
    expect(workerRun.jobs.map((job) => job.jobType)).toContain("embedding");

    const recall = await service.search({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-1"
      },
      query: "SQLite 记忆底座服务",
      includeInjectedContext: true
    });

    expect(recall.hits.length).toBeGreaterThan(0);
    expect(recall.candidateMemoryIds).toEqual(expect.arrayContaining(recall.sourceMemoryIds));
    expect(recall.sourceMemoryIds).toEqual(recall.hits.map((hit) => hit.id));
    expect(recall.injectedContext.markdown).not.toContain("# Memory context");
    expect(recall.injectedContext.markdown).not.toContain("Summary:");
    expect(recall.injectedContext.markdown).toContain("Historical user statement:\n   把记忆插件迁移为 SQLite 本地记忆底座服务");
    expect(recall.injectedContext.markdown).toContain("Historical assistant response:\n   已创建 REST 和 CLI 的服务框架。");
    expect(recall.injectedContext.markdown).not.toContain("Reflection:");
    expect(recall.injectedContext.markdown).not.toContain("## Follow-up memory tools");
    expect(recall.injectedContext.markdown).not.toContain("memmy_memory_get");
    expect(recall.injectedContext.markdown).not.toContain("memmy_memory_search");

    const turnStartRecall = await service.search({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-1"
      },
      sessionId: session.sessionId,
      retrievalMode: "turn_start",
      query: "SQLite 记忆底座服务",
      includeInjectedContext: true
    });
    expect(turnStartRecall.sourceMemoryIds).not.toContain(complete.l1MemoryId);
    expect(turnStartRecall.injectedContext.markdown).not.toContain("把记忆插件迁移为 SQLite 本地记忆底座服务");

    const recallRow = db.db.prepare(
      `SELECT namespace_id, query_hash, candidate_memory_ids_json, injected_memory_ids_json, outcome
       FROM recall_events
       WHERE id = ?`
    ).get(recall.searchEventId) as {
      namespace_id: string | null;
      query_hash: string | null;
      candidate_memory_ids_json: string;
      injected_memory_ids_json: string;
      outcome: string;
    } | undefined;
    expect(recallRow?.namespace_id).toContain("user-1");
    expect(recallRow?.query_hash).toBeTruthy();
    expect(JSON.parse(recallRow!.candidate_memory_ids_json)).toEqual(recall.candidateMemoryIds);
    expect(JSON.parse(recallRow!.injected_memory_ids_json)).toEqual(recall.sourceMemoryIds);
    expect(recallRow?.outcome).toBe("pending");

    const recallFeedback = await service.feedback({
      adapterId: "test-adapter",
      requestId: "feedback-recall-1",
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      recallEventId: recall.searchEventId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "the recalled memory helped"
    });
    expect(recallFeedback.recallEventId).toBe(recall.searchEventId);
    expect(recallFeedback.recallOutcome).toBe("positive");
    const recallAfterFeedback = db.db.prepare(
      `SELECT outcome
       FROM recall_events
       WHERE id = ?`
    ).get(recall.searchEventId) as { outcome: string } | undefined;
    expect(recallAfterFeedback?.outcome).toBe("positive");
    const recalledMemory = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(recall.sourceMemoryIds[0]) as { properties_json: string } | undefined;
    const recallStats = JSON.parse(recalledMemory!.properties_json) as {
      internal_info?: { recall?: { positive?: number; effectiveness?: number } };
    };
    expect(recallStats.internal_info?.recall?.positive).toBe(1);
    expect(recallStats.internal_info?.recall?.effectiveness).toBe(1);
    const recallChanges = db.db.prepare(
      `SELECT kind, op, entity_id, namespace_id
       FROM memory_change_log
       WHERE change_type = 'recall_outcome'
         AND entity_id = ?`
    ).get(recall.searchEventId) as {
      kind: string;
      op: string;
      entity_id: string;
      namespace_id: string | null;
    };
    expect(recallChanges).toMatchObject({
      kind: "recall",
      op: "updated",
      entity_id: recall.searchEventId
    });
    expect(recallChanges.namespace_id).toBe(recallRow?.namespace_id);
    const recallMemoryChange = db.db.prepare(
      `SELECT kind, op
       FROM memory_change_log
       WHERE change_type = 'recall_outcome_update'
         AND entity_id = ?`
    ).get(recall.sourceMemoryIds[0]) as { kind: string; op: string };
    expect(recallMemoryChange).toEqual({ kind: "trace", op: "updated" });
    db.close();
  });

  it("refreshes explicit source when reopening an existing session", () => {
    const { db, service } = createTestService();
    const sessionId = "openclaw-memory-default";
    const stale = service.openSession({
      sessionId,
      namespace: {
        source: "memmy",
        profileId: "default",
        userId: "user-session-source-refresh"
      }
    });
    const refreshed = service.openSession({
      sessionId,
      namespace: {
        source: "openclaw",
        profileId: "main",
        userId: "user-session-source-refresh"
      },
      workspacePath: "/tmp/openclaw-workspace"
    });
    expect(stale.source).toBe("memmy");
    expect(refreshed.resumed).toBe(true);
    expect(refreshed.source).toBe("openclaw");

    const sessionRow = db.db
      .prepare(`SELECT source, profile_id, workspace_path FROM sessions WHERE id = ?`)
      .get(sessionId) as { source: string; profile_id: string; workspace_path: string };
    expect(sessionRow).toMatchObject({
      source: "openclaw",
      profile_id: "main",
      workspace_path: "/tmp/openclaw-workspace"
    });

    const complete = service.completeTurn("turn-openclaw-source-refresh", {
      sessionId,
      query: "remember source refresh",
      answer: "source refresh captured"
    });
    const memoryRow = db.db
      .prepare(`SELECT agent_id FROM memories WHERE id = ?`)
      .get(complete.l1MemoryId) as { agent_id: string };
    expect(memoryRow.agent_id).toBe("openclaw");
    db.close();
  });

  it("records turn artifacts in the artifact table and change log", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-turn-artifacts"
    };
    const session = service.openSession({ namespace });
    const complete = service.completeTurn("turn-artifact", {
      sessionId: session.sessionId,
      query: "create an artifact for export",
      answer: "created the artifact reference",
      artifacts: [{
        kind: "file",
        uri: "file:///tmp/memmy-report.txt",
        name: "memmy-report.txt"
      }]
    });

    const artifacts = db.db.prepare(
      `SELECT id, session_id, episode_id, raw_turn_id, user_id, kind, uri, payload_json
       FROM artifacts
       WHERE raw_turn_id = ?`
    ).all(complete.rawTurnId) as Array<{
      id: string;
      session_id: string;
      episode_id: string;
      raw_turn_id: string;
      user_id: string;
      kind: string;
      uri: string;
      payload_json: string;
    }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      session_id: session.sessionId,
      episode_id: complete.episodeId,
      raw_turn_id: complete.rawTurnId,
      user_id: namespace.userId,
      kind: "file",
      uri: "file:///tmp/memmy-report.txt"
    });
    expect(JSON.parse(artifacts[0]!.payload_json)).toMatchObject({
      name: "memmy-report.txt"
    });

    const artifactChange = db.db.prepare(
      `SELECT kind, op, source, entity_id
       FROM memory_change_log
       WHERE entity_id = ?`
    ).get(artifacts[0]!.id) as { kind: string; op: string; source: string; entity_id: string };
    expect(artifactChange).toMatchObject({
      kind: "artifact",
      op: "created",
      source: "turn.complete.artifact",
      entity_id: artifacts[0]!.id
    });
    const panelChanges = service.panelChanges({ namespace });
    expect(panelChanges.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "artifact",
        id: artifacts[0]!.id,
        source: "turn_complete"
      })
    ]));
    const bundle = service.exportBundle({ namespace });
    expect((bundle.tables.artifacts as Array<Record<string, unknown>>)
      .some((row) => row.id === artifacts[0]!.id)).toBe(true);
    db.close();
  });
});
