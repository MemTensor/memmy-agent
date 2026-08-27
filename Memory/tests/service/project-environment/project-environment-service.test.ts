import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { Repositories } from "../../../src/storage/repositories.js";

describe("project environment repository", () => {
  const fixture = createMemoryServiceFixture();

  beforeEach(() => undefined);
  afterEach(() => fixture.cleanup());

  it("deduplicates a Session trigger and makes the newest scan current", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const first = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      dedupeKey: "profile:session-1"
    });
    const duplicate = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      dedupeKey: "profile:session-1"
    });
    const second = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "token_compaction",
      dedupeKey: "profile:compaction-2"
    });

    expect(first.enqueued).toBe(true);
    expect(duplicate.enqueued).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(second.enqueued).toBe(true);
    expect(repos.projectEnvironments.getState("user-1", "project-1")?.currentScanId)
      .toBe(second.job.payload.scanId);
    expect(repos.projectEnvironments.beginScan(
      "user-1",
      "project-1",
      String(first.job.payload.scanId)
    )).toBe(false);
  });

  it("applies only the current scan and rejects a concurrent field change", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const request = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      dedupeKey: "profile:session-1"
    });
    const scanId = String(request.job.payload.scanId);
    expect(repos.projectEnvironments.beginScan("user-1", "project-1", scanId)).toBe(true);
    expect(repos.projectEnvironments.markSummarizing("user-1", "project-1", scanId)).toBe(true);

    repos.l3WorldModels.upsertField({
      userId: "user-1",
      projectId: "project-1",
      targetField: "project_environment_profile",
      value: "Concurrent profile"
    });
    expect(() => repos.projectEnvironments.applyProfile({
      userId: "user-1",
      projectId: "project-1",
      scanId,
      projectKind: "code",
      fingerprint: "fingerprint-1",
      expectedCurrentProfile: null,
      operation: "create",
      profile: "Generated profile"
    })).toThrow("concurrent_update");

    expect(repos.projectEnvironments.applyProfile({
      userId: "user-1",
      projectId: "project-1",
      scanId: "stale-scan",
      projectKind: "code",
      fingerprint: "fingerprint-1",
      expectedCurrentProfile: "Concurrent profile",
      operation: "noop",
      profile: ""
    })).toEqual({ stale: true });
  });

  it("requires a complete replacement when project kind changes with a published profile", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const first = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      dedupeKey: "profile:first"
    });
    const firstScan = String(first.job.payload.scanId);
    repos.projectEnvironments.beginScan("user-1", "project-1", firstScan);
    repos.projectEnvironments.applyProfile({
      userId: "user-1",
      projectId: "project-1",
      scanId: firstScan,
      projectKind: "folder",
      fingerprint: "folder-fingerprint",
      expectedCurrentProfile: null,
      operation: "create",
      profile: "Folder profile"
    });
    const second = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "token_compaction",
      dedupeKey: "profile:second"
    });
    const secondScan = String(second.job.payload.scanId);
    repos.projectEnvironments.beginScan("user-1", "project-1", secondScan);
    expect(() => repos.projectEnvironments.applyProfile({
      userId: "user-1",
      projectId: "project-1",
      scanId: secondScan,
      projectKind: "code",
      fingerprint: "code-fingerprint",
      expectedCurrentProfile: "Folder profile",
      operation: "noop",
      profile: ""
    })).toThrow("type_change_requires_update");
  });

  it("does not cache an empty first-scan noop as an applied profile", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const request = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      dedupeKey: "profile:empty-noop"
    });
    const scanId = String(request.job.payload.scanId);
    repos.projectEnvironments.beginScan("user-1", "project-1", scanId);
    repos.projectEnvironments.markSummarizing("user-1", "project-1", scanId);

    expect(repos.projectEnvironments.applyProfile({
      userId: "user-1",
      projectId: "project-1",
      scanId,
      projectKind: "folder",
      fingerprint: "empty-fingerprint",
      expectedCurrentProfile: null,
      operation: "noop",
      profile: ""
    })).toEqual({ stale: false });

    expect(repos.projectEnvironments.getState("user-1", "project-1")).toMatchObject({
      status: "clean",
      currentScanId: scanId,
      appliedScanId: undefined,
      fingerprint: undefined
    });
    expect(repos.l3WorldModels.getScope("user-1", "project-1")?.memoryId).toBeUndefined();
    expect(repos.l3WorldModels.getMemory("user-1", "project-1")).toBeUndefined();
  });

  it("rescans a matching legacy fingerprint when no profile Memory exists", async () => {
    const complete = vi.fn<LlmClient["complete"]>().mockResolvedValue(
      '{"op":"create","profile":"Generated profile"}'
    );
    const llm = testLlm(complete);
    const { db, root, service } = fixture.createTestService({ skillLlm: llm });
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, "package.json"), '{"name":"profile-retry"}');
    const workspaceUri = pathToFileURL(realpathSync(projectRoot)).href;
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "legacy-profile-user"
    };
    const first = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri,
      workspaceHostId: "a".repeat(64),
      namespace: { ...namespace, sessionKey: "legacy-profile-session-1" }
    });
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type = 'project_environment_profile'`
    ).get()).toEqual({ count: 1 });
    const firstRun = await service.runWorkerOnce(10);
    const firstJob = db.db.prepare(
      `SELECT status, last_error FROM evolution_jobs WHERE job_type = 'project_environment_profile'`
    ).get();
    expect({ firstRun, firstJob }).toMatchObject({
      firstRun: { leased: 1, succeeded: 1, failed: 0 },
      firstJob: { status: "succeeded", last_error: null }
    });

    const repos = new Repositories(db.db);
    const firstMemory = repos.l3WorldModels.getMemory(namespace.userId, first.projectId)!;
    expect(complete).toHaveBeenCalledTimes(1);
    db.db.prepare(`UPDATE l3_world_model_scopes SET memory_id = NULL WHERE memory_id = ?`)
      .run(firstMemory.id);
    db.db.prepare(`DELETE FROM memories WHERE id = ?`).run(firstMemory.id);

    service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri,
      workspaceHostId: "a".repeat(64),
      namespace: { ...namespace, sessionKey: "legacy-profile-session-2" }
    });
    await service.runWorkerOnce(10);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(repos.l3WorldModels.getMemory(namespace.userId, first.projectId)).toMatchObject({
      memoryValue: expect.stringContaining("Generated profile")
    });
  });

  it("keeps the applied scan provenance when an unchanged fingerprint skips the model", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const first = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      trigger: "session_start",
      dedupeKey: "profile:first"
    });
    const firstScanId = String(first.job.payload.scanId);
    repos.projectEnvironments.beginScan("user-1", "project-1", firstScanId);
    repos.projectEnvironments.applyProfile({
      userId: "user-1",
      projectId: "project-1",
      scanId: firstScanId,
      projectKind: "code",
      fingerprint: "same-fingerprint",
      expectedCurrentProfile: null,
      operation: "create",
      profile: "Stable profile"
    });
    const before = repos.l3WorldModels.getMemory("user-1", "project-1")!;

    const second = repos.projectEnvironments.requestScan({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-2",
      trigger: "session_start",
      dedupeKey: "profile:second"
    });
    const secondScanId = String(second.job.payload.scanId);
    repos.projectEnvironments.beginScan("user-1", "project-1", secondScanId);
    expect(repos.projectEnvironments.markCleanWithoutModel({
      userId: "user-1",
      projectId: "project-1",
      scanId: secondScanId,
      projectKind: "code"
    })).toBe(true);

    expect(repos.projectEnvironments.getState("user-1", "project-1")).toMatchObject({
      status: "clean",
      currentScanId: secondScanId,
      appliedScanId: firstScanId,
      fingerprint: "same-fingerprint"
    });
    expect(repos.l3WorldModels.getMemory("user-1", "project-1")).toMatchObject({
      version: before.version,
      info: expect.objectContaining({ project_environment_applied_scan_id: firstScanId })
    });
  });
});

function testLlm(complete: LlmClient["complete"]): LlmClient {
  return {
    config: {
      provider: "host",
      endpoint: "http://localhost/unused",
      model: "project-environment-test",
      apiKey: "",
      temperature: 0,
      maxTokens: 4096,
      timeoutMs: 30_000,
      maxRetries: 0,
      malformedRetries: 0,
      enableThinking: false
    },
    isConfigured: () => true,
    complete,
    completeJson: vi.fn(),
    status: () => ({
      provider: "host",
      model: "project-environment-test",
      configured: true,
      remote: false
    })
  };
}
