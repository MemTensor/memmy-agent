import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryRestClient,
  API_ROUTES,
  createMemoryHttpServer
} from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import {
  accountRuntimeConfig,
  addAgentSourceImport,
  createCapturingEmbedder,
  createFailingLlm,
  createMemoryServiceFixture,
  runWorkerRounds,
  setRawTurnActivityAt
} from "../fixtures/memory-service-fixture.js";

const roots: string[] = [];
const {
  cleanup: cleanupMemoryServiceFixture,
  createTestMemoryService,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withServerClosed(
  server: ReturnType<typeof createMemoryHttpServer>,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("MemoryService / REST contract", () => {

  it("serves the REST health endpoint", async () => {
    const { db, service } = createTestService();
    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
    const body = await response.json() as {
      ok: boolean;
      storage: {
        backend: string;
        backendId?: string;
        fullText?: string;
        vector?: string;
      };
    };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.storage.backend).toBe("sqlite");
    expect(body.storage.backendId).toBe("sqlite-local");
    expect(body.storage.fullText).toBe("fts5");
    expect(body.storage.vector).toBe("native");
    const client = new MemoryRestClient({
      endpoint: `http://127.0.0.1:${address.port}`
    });
    const health = await client.health();
    expect(health.storage.backendId).toBe("sqlite-local");
    expect(health.capabilities.routes).toEqual([...API_ROUTES]);
    expect(health.capabilities.tools).toEqual([
      "session.open",
      "session.close",
      "turn.start",
      "turn.complete",
      "memory.search",
      "memory.add",
      "memory.get",
      "memory.delete",
      "panel.overview",
      "panel.analysis",
      "panel.items"
    ]);

    });
    db.close();
  });

  it("serves the manual memory-processing retry endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-http-processing-retry-"));
    roots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      llm: createFailingLlm(),
      embedder: createCapturingEmbedder([])
    });
    const namespace = { source: "hermes", profileId: "default", userId: "http-retry-user" };
    const added = addAgentSourceImport(service, namespace, "retry through HTTP", "http-retry");
    await runWorkerRounds(service, 3, 1);
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]?.state).toBe("failed");

    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/memory/${encodeURIComponent(added.id)}/processing/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace })
      }
    );
    const body = await response.json() as {
      accepted: boolean;
      processing: { state: string; stage: string | null; manualRetryCount: number };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      processing: {
        state: "summary_pending",
        stage: "summary",
        manualRetryCount: 1
      }
    });

    });
    db.close();
  });

  it("preserves lifecycle routing fields across the REST boundary", async () => {
    const { db, service } = createTestService();
    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = "http://127.0.0.1:" + address.port + "/api/v1";

    const openedResponse = await fetch(baseUrl + "/sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "cursor-memory-http-fields",
        source: "cursor",
        workspacePath: "/tmp/hook-workspace"
      })
    });
    const opened = await openedResponse.json() as { sessionId: string };
    expect(openedResponse.status).toBe(200);

    const startResponse = await fetch(baseUrl + "/turns/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "memmy-cursor-hook",
        requestId: "cursor-start:http-fields",
        source: "cursor",
        sessionId: opened.sessionId,
        turnId: "cursor-http-turn",
        query: "Continue the hook lifecycle repair",
        contextHints: {
          agentIdentity: "cursor-agent",
          hostProvider: "cursor"
        },
        contextBudget: 37
      })
    });
    const started = await startResponse.json() as {
      episodeId: string;
      searchEventId: string;
      turnId: string;
    };
    expect(startResponse.status).toBe(200);
    expect(started.turnId).toBe("cursor-http-turn");

    const completeResponse = await fetch(baseUrl + "/turns/cursor-http-turn/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "memmy-cursor-hook",
        requestId: "cursor-complete:http-fields",
        source: "cursor",
        sessionId: opened.sessionId,
        episodeId: started.episodeId,
        query: "Continue the hook lifecycle repair",
        answer: "The lifecycle now reuses its started turn and episode.",
        tags: ["hook-lifecycle"],
        artifacts: [{
          kind: "file",
          uri: "file:///tmp/hook-report.md",
          name: "hook-report.md"
        }],
        sourceMemoryIds: ["memory-from-turn-start"],
        status: "succeeded"
      })
    });
    const completed = await completeResponse.json() as { episodeId: string; rawTurnId: string };
    expect(completeResponse.status).toBe(200);
    expect(completed.episodeId).toBe(started.episodeId);

    const sessionRow = db.db.prepare(
      "SELECT source, profile_id, workspace_path FROM sessions WHERE id = ?"
    ).get(opened.sessionId) as {
      source: string;
      profile_id: string;
      workspace_path: string;
    };
    expect(sessionRow).toMatchObject({
      source: "cursor",
      profile_id: "default",
      workspace_path: "/tmp/hook-workspace"
    });

    const recallRow = db.db.prepare(
      "SELECT request_json FROM recall_events WHERE id = ?"
    ).get(started.searchEventId) as { request_json: string };
    expect(JSON.parse(recallRow.request_json)).toMatchObject({
      contextBudget: 37,
      contextHints: {
        agentIdentity: "cursor-agent",
        hostProvider: "cursor"
      }
    });

    const rawTurn = db.db.prepare(
      "SELECT episode_id, source_memory_ids_json FROM raw_turns WHERE id = ?"
    ).get(completed.rawTurnId) as { episode_id: string; source_memory_ids_json: string };
    expect(rawTurn.episode_id).toBe(started.episodeId);
    expect(JSON.parse(rawTurn.source_memory_ids_json)).toEqual(["memory-from-turn-start"]);
    const artifactCount = db.db.prepare(
      "SELECT COUNT(*) AS count FROM artifacts WHERE raw_turn_id = ?"
    ).get(completed.rawTurnId) as { count: number };
    expect(artifactCount.count).toBe(1);

    });
    db.close();
  });

  it("auto-drains REST turn.complete embedding jobs", async () => {
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const sessionResponse = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        namespace: {
          source: "openclaw",
          profileId: "default",
          userId: "auto-worker-user"
        },
        sessionId: "openclaw-memory-agent:auto-worker"
      })
    });
    const session = await sessionResponse.json() as { sessionId: string };
    const completeResponse = await fetch(`${baseUrl}/turns/turn-auto-worker/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        query: "remember auto worker embeddings",
        answer: "embedding jobs should drain after REST turn complete"
      })
    });
    const complete = await completeResponse.json() as { l1MemoryId: string };
    expect(completeResponse.status).toBe(200);

    await waitFor(() => {
      const row = db.db.prepare(
        `SELECT embedding_dim
         FROM memory_vector_entries
         WHERE memory_id = ? AND vector_field = 'vec_summary'`
      ).get(complete.l1MemoryId) as { embedding_dim: number } | undefined;
      return row?.embedding_dim === 3;
    });
    expect(embeddingTexts.length).toBeGreaterThan(0);

    });
    db.close();
  });

  it("auto-closes idle episodes after a REST turn.complete", async () => {
    const { db, service } = createTestService();
    const idleSession = service.openSession({
      namespace: {
        source: "openclaw",
        profileId: "default",
        userId: "auto-idle-account-user",
        sessionKey: "auto-idle-session"
      }
    });
    const idleTurn = service.completeTurn("turn-auto-idle-old", {
      sessionId: idleSession.sessionId,
      query: "Remember the old task",
      answer: "The old task is recorded."
    });
    await service.runWorkerOnce(20);
    setRawTurnActivityAt(
      db,
      idleTurn.rawTurnId,
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    );

    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    const sessionResponse = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        namespace: {
          source: "openclaw",
          profileId: "default",
          userId: "auto-idle-local-user",
          sessionKey: "auto-idle-trigger-session"
        }
      })
    });
    const triggerSession = await sessionResponse.json() as { sessionId: string };
    const completeResponse = await fetch(`${baseUrl}/turns/turn-auto-idle-trigger/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: triggerSession.sessionId,
        query: "Start the new task",
        answer: "The new task has started."
      })
    });
    expect(completeResponse.status).toBe(200);

    await waitFor(() => {
      const episode = db.db.prepare(
        `SELECT status
         FROM episodes
         WHERE id = ?`
      ).get(idleTurn.episodeId) as { status: string } | undefined;
      return episode?.status === "closed";
    });
    const reflection = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE episode_id = ?
         AND job_type = 'reflection'`
    ).get(idleTurn.episodeId) as { count: number };
    expect(reflection.count).toBe(1);

    });
    db.close();
  });

  it("auto-closes idle episodes after a REST memory.add", async () => {
    const { db, service } = createTestService({ mode: "local" });
    const idleSession = service.openSession({
      namespace: {
        source: "memmy",
        profileId: "default",
        userId: "memory-add-account-user",
        sessionKey: "memory-add-idle-session"
      }
    });
    const idleTurn = service.completeTurn("turn-memory-add-idle-old", {
      sessionId: idleSession.sessionId,
      query: "Remember the old memory add task",
      answer: "The old memory add task is recorded."
    });
    await service.runWorkerOnce(20);
    setRawTurnActivityAt(
      db,
      idleTurn.rawTurnId,
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    );

    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    const addResponse = await fetch(`${baseUrl}/memory/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        namespace: {
          source: "codex",
          profileId: "default",
          userId: "memory-add-local-user"
        },
        content: "A new direct memory arrived.",
        createdAt: "2025-01-01T00:00:00.000Z"
      })
    });
    const added = await addResponse.json() as { id: string };
    expect(addResponse.status).toBe(200);

    await waitFor(() => {
      const episode = db.db.prepare(
        `SELECT status
         FROM episodes
         WHERE id = ?`
      ).get(idleTurn.episodeId) as { status: string } | undefined;
      return episode?.status === "closed";
    });
    const closedEpisode = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE id = ?`
    ).get(idleTurn.episodeId) as { meta_json: string };
    expect(JSON.parse(closedEpisode.meta_json)).toMatchObject({
      closeReason: "idle_timeout",
      triggerSource: "memory.add",
      triggerMemoryId: added.id
    });
    const reflection = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE episode_id = ?
         AND job_type = 'reflection'`
    ).get(idleTurn.episodeId) as { count: number };
    expect(reflection.count).toBe(1);

    });
    db.close();
  });

  it("auto-drains queued jobs when the REST server starts", async () => {
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "openclaw",
      profileId: "default",
      userId: "auto-worker-start-user"
    };
    const session = service.openSession({
      namespace,
      sessionId: "openclaw-memory-agent:auto-worker-start"
    });
    const complete = service.completeTurn("turn-auto-worker-start", {
      sessionId: session.sessionId,
      query: "remember queued startup embeddings",
      answer: "queued jobs should drain when the server starts"
    });
    const queuedRow = db.db.prepare(
      `SELECT embedding_dim
       FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = 'vec_summary'`
    ).get(complete.l1MemoryId) as { embedding_dim: number } | undefined;
    expect(queuedRow).toBeUndefined();

    const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 0 });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    await waitFor(() => {
      const row = db.db.prepare(
        `SELECT embedding_dim
         FROM memory_vector_entries
         WHERE memory_id = ? AND vector_field = 'vec_summary'`
      ).get(complete.l1MemoryId) as { embedding_dim: number } | undefined;
      return row?.embedding_dim === 3;
    });
    expect(embeddingTexts.length).toBeGreaterThan(0);

    });
    db.close();
  });

  it("wakes the worker when a pending embedding retry becomes due", async () => {
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const repos = new Repositories(db.db);
    const memory = service.addMemory({
      namespace: { source: "codex", profileId: "default", userId: "retry-timer-user" },
      layer: "L2",
      title: "retry timer policy",
      content: "retry this embedding when its backoff expires"
    });
    const retry = repos.runtime.enqueueEmbeddingRetry({
      targetKind: "policy",
      targetId: memory.id,
      vectorField: "vec",
      sourceText: "Summary: retry this embedding when its backoff expires",
      now: Date.now() + 100
    });

    const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 0 });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    await waitFor(() => repos.runtime.getEmbeddingRetry(retry.id)?.status === "succeeded", 2_000);
    expect(repos.runtime.getEmbeddingRetry(retry.id)?.status).toBe("succeeded");
    expect(db.db.prepare(
      `SELECT embedding_dim
       FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = 'vec'`
    ).get(memory.id)).toEqual({ embedding_dim: 3 });
    expect(embeddingTexts).toContain("Summary: retry this embedding when its backoff expires");

    });
    db.close();
  });

  it("reconciles interrupted, missing, and terminally failed processing jobs on startup", async () => {
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const repos = new Repositories(db.db);
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "startup-reconcile-user"
    };

    const interruptedMemory = addAgentSourceImport(
      service,
      namespace,
      "resume an interrupted evolution embedding job",
      "startup-interrupted"
    );
    await service.runWorkerOnce(1);
    const [interruptedJob] = repos.runtime.leaseQueuedJobs(1, 600);
    expect(interruptedJob?.jobType).toBe("embedding");

    const failedMemory = addAgentSourceImport(
      service,
      namespace,
      "retry a terminal embedding failure on startup",
      "startup-failed"
    );
    await service.runWorkerOnce(1);
    const failedMemoryJob = repos.runtime.getPendingJob(failedMemory.id, "embedding");
    expect(failedMemoryJob).toBeDefined();
    repos.runtime.completeJob(failedMemoryJob!.id);
    db.db.prepare(
      `UPDATE evolution_jobs
       SET status = 'dead_letter',
           attempts = max_attempts,
           last_error = 'previous embedding worker failed',
           updated_at = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), failedMemoryJob!.id);
    repos.processing.update(failedMemory.id, {
      state: "failed",
      stage: "embedding",
      activeJobId: null,
      attemptCount: failedMemoryJob!.maxAttempts,
      retryAction: "retry",
      errorCode: "embedding_failed",
      errorMessage: "previous embedding worker failed",
      failedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const orphanMemory = addAgentSourceImport(
      service,
      namespace,
      "repair an indexing memory whose embedding task disappeared",
      "startup-orphan"
    );
    await service.runWorkerOnce(1);
    const orphanMemoryJob = repos.runtime.getPendingJob(orphanMemory.id, "embedding");
    expect(orphanMemoryJob).toBeDefined();
    repos.runtime.completeJob(orphanMemoryJob!.id);

    const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 0 });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const repairedMemoryIds = [interruptedMemory.id, failedMemory.id, orphanMemory.id];
    await waitFor(() => {
      const row = db.db.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_vector_entries
         WHERE memory_id IN (?, ?, ?)
           AND vector_field = 'vec_summary'`
      ).get(...repairedMemoryIds) as { count: number };
      return row.count === repairedMemoryIds.length;
    }, 2_000);

    expect(repos.runtime.getJob(interruptedJob!.id)?.status).toBe("succeeded");
    expect(repos.processing.get(interruptedMemory.id)?.state).toBe("ready");
    expect(repos.processing.get(failedMemory.id)?.state).toBe("ready");
    expect(repos.processing.get(orphanMemory.id)?.state).toBe("ready");
    expect(repos.memories.hasVector(failedMemory.id, "vec_summary")).toBe(true);
    const failedMemoryJobs = db.db.prepare(
      `SELECT status
       FROM evolution_jobs
       WHERE target_memory_id = ? AND job_type = 'embedding'
       ORDER BY created_at ASC, id ASC`
    ).all(failedMemory.id) as Array<{ status: string }>;
    expect(failedMemoryJobs.map((job) => job.status)).toEqual(["dead_letter", "succeeded"]);

    });
    db.close();
  });

  it("serves the admin reload-config endpoint with admin scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-http-reload-"));
    roots.push(root);
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: DEFAULT_MEMMY_CONFIG,
      configLoader: () => ({ config: accountRuntimeConfig() })
    });
    const server = createMemoryHttpServer({
      service,
      auth: {
        scopedApiKeys: {
          "admin-token": {
            namespace: {
              source: "codex",
              profileId: "admin-profile"
            },
            scopes: ["admin:write"]
          },
          "reader-token": {
            namespace: {
              source: "codex",
              profileId: "reader-profile"
            },
            scopes: ["memory:read"]
          }
        }
      }
    });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const endpoint = `http://127.0.0.1:${address.port}`;
    const readerResponse = await fetch(`${endpoint}/api/v1/admin/reload-config`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: "profile_switched" })
    });
    const client = new MemoryRestClient({
      endpoint,
      token: "admin-token"
    });

    const result = await client.reloadConfig({ reason: "profile_switched" });

    expect(readerResponse.status).toBe(403);
    expect(result).toMatchObject({
      activeProfile: "account",
      changed: true,
      requiresRestart: false
    });

    });
    db.close();
  });

  it("accepts a supervised shutdown request only with admin scope", async () => {
    const { db, service } = createTestService();
    let shutdownRequests = 0;
    const server = createMemoryHttpServer({
      service,
      onShutdownRequested: () => {
        shutdownRequests += 1;
      },
      auth: {
        scopedApiKeys: {
          "admin-token": {
            namespace: { source: "codex", profileId: "admin-profile" },
            scopes: ["admin:write"]
          },
          "reader-token": {
            namespace: { source: "codex", profileId: "reader-profile" },
            scopes: ["memory:read"]
          }
        }
      }
    });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/admin/shutdown`;

    const denied = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer reader-token", "content-type": "application/json" },
      body: "{}"
    });
    expect(denied.status).toBe(403);
    expect(shutdownRequests).toBe(0);

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: "{}"
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true });
    await waitFor(() => shutdownRequests === 1);

    });
    db.close();
  });

  it("applies REST auth principal scope and validates DTOs", async () => {
    const { db, service } = createTestService();
    const server = createMemoryHttpServer({
      service,
      auth: {
        cloudAccessTokens: {
          "cloud-token": {
            source: "codex",
            profileId: "cloud-profile",
            userId: "cloud-user",
            projectId: "cloud-project",
            workspaceId: "cloud-workspace"
          }
        }
      }
    });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const unauthorized = await fetch(`${baseUrl}/memory/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ query: "test" })
    });
    expect(unauthorized.status).toBe(401);

    const invalidSearch = await fetch(`${baseUrl}/memory/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer cloud-token",
        "content-type": "application/json",
        "x-request-id": "req-invalid-search"
      },
      body: JSON.stringify({})
    });
    const invalidSearchBody = await invalidSearch.json() as {
      error: { code: string; requestId?: string };
    };
    expect(invalidSearch.status).toBe(400);
    expect(invalidSearchBody.error.code).toBe("invalid_argument");
    expect(invalidSearchBody.error.requestId).toBe("req-invalid-search");

    const crossNamespace = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer cloud-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        namespace: {
          source: "codex",
          profileId: "other",
          userId: "other-user"
        }
      })
    });
    expect(crossNamespace.status).toBe(200);

    const sessionResponse = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer cloud-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId: "cloud-host-session"
      })
    });
    const session = await sessionResponse.json() as {
      sessionId: string;
      status: string;
      resumed: boolean;
    };
    expect(sessionResponse.status).toBe(200);
    expect(session.status).toBe("open");
    expect(session.resumed).toBe(false);

    });
    db.close();
  });

  it("passes REST search tags and limit through to recall", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "locomo-eval",
      profileId: "preloaded-direct",
      userId: "local-user"
    };
    service.addMemory({
      namespace,
      layer: "L1",
      title: "conv-26 beach memory one",
      tags: ["locomo", "conv-26"],
      content: "Melanie and Caroline discussed a shared beach trip detail for LoCoMo filtering."
    });
    service.addMemory({
      namespace,
      layer: "L1",
      title: "conv-26 beach memory two",
      tags: ["locomo", "conv-26"],
      content: "Melanie and Caroline discussed another shared beach trip detail for LoCoMo filtering."
    });
    service.addMemory({
      namespace,
      layer: "L1",
      title: "conv-30 beach memory",
      tags: ["locomo", "conv-30"],
      content: "Jon and Gina discussed a shared beach trip detail for LoCoMo filtering."
    });
    await runWorkerRounds(service, 2, 20);
    const server = createMemoryHttpServer({ service });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const response = await fetch(`${baseUrl}/memory/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        namespace,
        query: "shared beach trip detail",
        layers: ["L1"],
        tags: ["conv-26"],
        limit: 1,
        contextBudget: 512,
        verbose: true
      })
    });
    const body = await response.json() as {
      debug: {
        hits: Array<{ id: string; tags: string[] }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.debug.hits).toHaveLength(1);
    expect(body.debug.hits[0]?.tags).toContain("conv-26");
    expect(body.debug.hits[0]?.tags).not.toContain("conv-30");

    });
    db.close();
  });

  it("enforces scoped API permissions, idempotency, and shared resource access", async () => {
    const { db, service } = createTestService();
    const server = createMemoryHttpServer({
      service,
      auth: {
        scopedApiKeys: {
          "writer-a": {
            namespace: {
              source: "codex",
              profileId: "profile-a",
              userId: "user-a",
              workspaceId: "workspace-a"
            },
            scopes: ["memory:read", "memory:write", "panel:read"]
          },
          "reader-a": {
            namespace: {
              source: "codex",
              profileId: "profile-a",
              userId: "user-a",
              workspaceId: "workspace-a"
            },
            scopes: ["memory:read", "panel:read"]
          },
          "reader-b": {
            namespace: {
              source: "codex",
              profileId: "profile-b",
              userId: "user-b",
              workspaceId: "workspace-b"
            },
            scopes: ["memory:read", "panel:read"]
          }
        }
      }
    });
    await withServerClosed(server, async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const readOnlyCreate = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader-b",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        adapterId: "rest-test",
        requestId: "session-readonly"
      })
    });
    expect(readOnlyCreate.status).toBe(403);

    const createBody = {
      adapterId: "rest-test",
      requestId: "session-create",
      sessionId: "host-a"
    };
    const createdResponse = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer writer-a",
        "content-type": "application/json"
      },
      body: JSON.stringify(createBody)
    });
    const created = await createdResponse.json() as {
      sessionId: string;
      status: string;
      duplicate?: boolean;
    };
    expect(createdResponse.status).toBe(200);
    expect(created.status).toBe("open");
    expect(created.duplicate).toBeUndefined();

    const duplicateSessionResponse = await fetch(`${baseUrl}/sessions/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer writer-a",
        "content-type": "application/json"
      },
      body: JSON.stringify(createBody)
    });
    const duplicateSession = await duplicateSessionResponse.json() as {
      sessionId: string;
      duplicate?: boolean;
    };
    expect(duplicateSessionResponse.status).toBe(200);
    expect(duplicateSession.sessionId).toBe(created.sessionId);
    expect(duplicateSession.duplicate).toBeUndefined();

    const completeResponse = await fetch(`${baseUrl}/turns/turn-scope/complete`, {
      method: "POST",
      headers: {
        authorization: "Bearer writer-a",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        adapterId: "rest-test",
        requestId: "turn-scope-complete",
        sessionId: created.sessionId,
        query: "write a scoped trace",
        answer: "stored scoped trace"
      })
    });
    const complete = await completeResponse.json() as {
      episodeId: string;
      l1MemoryId: string;
      rawTurnId: string;
      changeSeq: number;
    };
    expect(completeResponse.status).toBe(200);
    expect(complete.changeSeq).toBeGreaterThan(0);

    const writerItemsResponse = await fetch(baseUrl + "/panel/items?layer=L1", {
      headers: {
        authorization: "Bearer writer-a"
      }
    });
    const writerItems = await writerItemsResponse.json() as {
      items: Array<{ id: string }>;
    };
    expect(writerItemsResponse.status).toBe(200);
    expect(writerItems.items.map((item) => item.id)).toContain(complete.l1MemoryId);

    const crossUserGet = await fetch(baseUrl + "/memory/" + complete.l1MemoryId, {
      headers: {
        authorization: "Bearer reader-b"
      }
    });
    const crossUserBody = await crossUserGet.json() as { id: string };
    expect(crossUserGet.status).toBe(200);
    expect(crossUserBody.id).toBe(complete.l1MemoryId);
    });
    db.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
