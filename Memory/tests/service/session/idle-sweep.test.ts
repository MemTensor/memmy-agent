import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryServiceFixture,
  setRawTurnActivityAt
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / session / idle sweep", () => {
  it("closes idle episodes across local user aliases after a started turn completes", async () => {
    const { db, service } = createTestService();
    const idleSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "account-user-idle-episode-close",
        sessionKey: "idle-session"
      }
    });
    const idleTurn = service.completeTurn("turn-idle-episode-old", {
      sessionId: idleSession.sessionId,
      query: "Prepare the old deployment checklist",
      answer: "The old deployment checklist is ready."
    });
    await service.runWorkerOnce(20);

    const idleAt = new Date(Date.now() - 2 * 60 * 60 * 1000 - 5_000).toISOString();
    setRawTurnActivityAt(db, idleTurn.rawTurnId, idleAt);

    const triggerSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "local-user-idle-episode-close",
        sessionKey: "trigger-session"
      }
    });
    await service.startTurn({
      turnId: "turn-idle-episode-trigger",
      sessionId: triggerSession.sessionId,
      query: "Start a separate release task"
    });
    const triggerTurn = service.completeTurn("turn-idle-episode-trigger", {
      sessionId: triggerSession.sessionId,
      query: "Start a separate release task",
      answer: "The separate release task has started."
    });

    expect(triggerTurn.jobs.map((job) => job.jobType)).toContain("episode_idle_close");
    const run = await service.runWorkerOnce(20);
    expect(run.jobs.map((job) => job.jobType)).toContain("episode_idle_close");

    const episodes = db.db.prepare(
      `SELECT id, status, meta_json
       FROM episodes
       WHERE id IN (?, ?)`
    ).all(idleTurn.episodeId, triggerTurn.episodeId) as Array<{
      id: string;
      status: string;
      meta_json: string;
    }>;
    const closedIdleEpisode = episodes.find((episode) => episode.id === idleTurn.episodeId);
    const currentEpisode = episodes.find((episode) => episode.id === triggerTurn.episodeId);
    expect(closedIdleEpisode?.status).toBe("closed");
    expect(JSON.parse(closedIdleEpisode!.meta_json)).toMatchObject({
      closeReason: "idle_timeout",
      closedBy: "worker.episode_idle_close",
      triggerEpisodeId: triggerTurn.episodeId
    });
    expect(currentEpisode?.status).toBe("open");

    const reflection = db.db.prepare(
      `SELECT status, payload_json
       FROM evolution_jobs
       WHERE episode_id = ?
         AND job_type = 'reflection'`
    ).get(idleTurn.episodeId) as { status: string; payload_json: string } | undefined;
    expect(reflection?.status).toBe("queued");
    expect(JSON.parse(reflection!.payload_json)).toMatchObject({
      trigger: "idle_timeout",
      targetKind: "episode"
    });

    const change = db.db.prepare(
      `SELECT change_type, source
       FROM memory_change_log
       WHERE entity_id = ?
         AND change_type = 'episode_closed'
       ORDER BY seq DESC
       LIMIT 1`
    ).get(idleTurn.episodeId) as { change_type: string; source: string } | undefined;
    expect(change).toEqual({
      change_type: "episode_closed",
      source: "worker.episode_idle_close"
    });
    db.close();
  });

  it("keeps local episodes open until they have been idle for over two hours", async () => {
    const { db, service } = createTestService();
    const recentSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "account-user-recent-episode",
        sessionKey: "recent-session"
      }
    });
    const recentTurn = service.completeTurn("turn-recent-episode", {
      sessionId: recentSession.sessionId,
      query: "Prepare a recent checklist",
      answer: "The recent checklist is ready."
    });
    await service.runWorkerOnce(20);

    const recentAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    setRawTurnActivityAt(db, recentTurn.rawTurnId, recentAt);

    const triggerSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "local-user-recent-episode",
        sessionKey: "recent-trigger-session"
      }
    });
    service.completeTurn("turn-recent-episode-trigger", {
      sessionId: triggerSession.sessionId,
      query: "Start another recent task",
      answer: "Another recent task has started."
    });
    await service.runWorkerOnce(20);

    const recentEpisode = db.db.prepare(
      `SELECT status
       FROM episodes
       WHERE id = ?`
    ).get(recentTurn.episodeId) as { status: string };
    expect(recentEpisode.status).toBe("open");
    db.close();
  });

  it("closes cloud-mode episodes across user ids in the same database", async () => {
    const { db, service } = createTestService({ mode: "cloud" });
    const idleSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "cloud-user-a",
        sessionKey: "cloud-idle-session"
      }
    });
    const idleTurn = service.completeTurn("turn-cloud-idle-old", {
      sessionId: idleSession.sessionId,
      query: "Prepare the cloud deployment checklist",
      answer: "The cloud deployment checklist is ready."
    });
    await service.runWorkerOnce(20);
    setRawTurnActivityAt(
      db,
      idleTurn.rawTurnId,
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    );

    const otherUserSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "cloud-user-b",
        sessionKey: "cloud-other-user-session"
      }
    });
    service.completeTurn("turn-cloud-other-user", {
      sessionId: otherUserSession.sessionId,
      query: "Start work for another cloud user",
      answer: "The other cloud user task has started."
    });
    await service.runWorkerOnce(20);

    const closedEpisode = db.db.prepare(
      `SELECT status
       FROM episodes
       WHERE id = ?`
    ).get(idleTurn.episodeId) as { status: string };
    expect(closedEpisode.status).toBe("closed");
    db.close();
  });

  it("uses turn completion time as the latest episode activity", async () => {
    const { db, service } = createTestService();
    const longSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "account-user-long-turn",
        sessionKey: "long-turn-session"
      }
    });
    const started = await service.startTurn({
      turnId: "turn-long-running",
      sessionId: longSession.sessionId,
      query: "Run a long deployment verification"
    });
    const rawTurn = db.db.prepare(
      `SELECT id
       FROM raw_turns
       WHERE session_id = ?
         AND turn_id = ?`
    ).get(longSession.sessionId, "turn-long-running") as { id: string };
    db.db.prepare(
      `UPDATE raw_turns
       SET created_at = ?
       WHERE id = ?`
    ).run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), rawTurn.id);
    service.completeTurn("turn-long-running", {
      sessionId: longSession.sessionId,
      query: "Run a long deployment verification",
      answer: "The long deployment verification completed."
    });
    db.db.prepare(
      `UPDATE episodes
       SET updated_at = ?
       WHERE id = ?`
    ).run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), started.episodeId);

    const triggerSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "local-user-long-turn-trigger",
        sessionKey: "long-turn-trigger-session"
      }
    });
    service.completeTurn("turn-long-running-trigger", {
      sessionId: triggerSession.sessionId,
      query: "Start a new local task",
      answer: "The new local task has started."
    });
    await service.runWorkerOnce(20);

    const episode = db.db.prepare(
      `SELECT status
       FROM episodes
       WHERE id = ?`
    ).get(started.episodeId) as { status: string };
    expect(episode.status).toBe("open");
    db.close();
  });

  it("keeps an old turn open when it has a recent tool observation", async () => {
    const { db, service } = createTestService();
    const activeSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "account-user-active-tool",
        sessionKey: "active-tool-session"
      }
    });
    const started = await service.startTurn({
      turnId: "turn-active-tool",
      sessionId: activeSession.sessionId,
      query: "Run a long tool-driven deployment"
    });
    const rawTurn = db.db.prepare(
      `SELECT id
       FROM raw_turns
       WHERE session_id = ?
         AND turn_id = ?`
    ).get(activeSession.sessionId, "turn-active-tool") as { id: string };
    const oldAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    setRawTurnActivityAt(db, rawTurn.id, oldAt);
    await service.observeTool({
      sessionId: activeSession.sessionId,
      episodeId: started.episodeId,
      turnId: "turn-active-tool",
      toolCallId: "call-active-tool",
      toolName: "deployment_status",
      result: "The deployment is still running."
    });
    db.db.prepare(
      `UPDATE episodes
       SET updated_at = ?
       WHERE id = ?`
    ).run(oldAt, started.episodeId);

    const triggerSession = service.openSession({
      namespace: {
        source: "openclaw",
        profileId: "default",
        userId: "local-user-active-tool-trigger",
        sessionKey: "active-tool-trigger-session"
      }
    });
    service.completeTurn("turn-active-tool-trigger", {
      sessionId: triggerSession.sessionId,
      query: "Record another memory",
      answer: "Another memory was recorded."
    });
    await service.runWorkerOnce(20);

    const episode = db.db.prepare(
      `SELECT status
       FROM episodes
       WHERE id = ?`
    ).get(started.episodeId) as { status: string };
    expect(episode.status).toBe("open");
    db.close();
  });

  it("does not enqueue another idle sweep when direct completion is retried", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-direct-complete-retry"
      }
    });
    const first = service.completeTurn("turn-direct-complete-retry", {
      sessionId: session.sessionId,
      query: "Record the direct completion",
      answer: "The direct completion was recorded."
    });
    await service.runWorkerOnce(20);

    const retry = service.completeTurn("turn-direct-complete-retry", {
      sessionId: session.sessionId,
      query: "Record the direct completion",
      answer: "The direct completion was recorded."
    });
    expect(retry.jobs.map((job) => job.jobType)).not.toContain("episode_idle_close");
    const idleCloseJobs = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'episode_idle_close'
         AND episode_id = ?`
    ).get(first.episodeId) as { count: number };
    expect(idleCloseJobs.count).toBe(1);
    db.close();
  });

  it("keeps separate idle sweeps for separate memory.add writes", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "memory-add-sweep-user"
    };
    const first = service.addMemory({
      namespace,
      content: "First interactive memory write."
    });
    const second = service.addMemory({
      namespace,
      content: "Second interactive memory write."
    });

    const jobs = db.db.prepare(
      `SELECT dedupe_key, payload_json
       FROM evolution_jobs
       WHERE job_type = 'episode_idle_close'
       ORDER BY id ASC`
    ).all() as Array<{ dedupe_key: string; payload_json: string }>;
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.dedupe_key))).toEqual(new Set([
      `episode_idle_close:memory.add:${first.id}`,
      `episode_idle_close:memory.add:${second.id}`
    ]));
    expect(new Set(jobs.map((job) => JSON.parse(job.payload_json).triggerMemoryId))).toEqual(
      new Set([first.id, second.id])
    );
    db.close();
  });
});
