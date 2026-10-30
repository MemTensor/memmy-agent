import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import type { LlmClient } from "../../../src/model/types.js";
import { ProjectEnvironmentService } from "../../../src/service/project-environment/project-environment-service.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(reply = '{"op":"create","profile":"Node 项目，测试用 vitest"}') {
  const db = new MemoryDb({ path: ":memory:" });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "l3-unit-profile-")));
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, "repo");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo", engines: { node: ">=20" }, scripts: { test: "vitest run" } }));
  writeFileSync(join(project, "index.ts"), "export const a = 1;\n");
  const repos = new Repositories(db.db);
  const complete = vi.fn<LlmClient["complete"]>().mockResolvedValue(reply);
  const service = new ProjectEnvironmentService({ repos, llm: testLlm(complete) });
  const unit = repos.l3Field.ensureProjectUnit({
    userId: "u1",
    machineId: "m".repeat(64),
    project: { identity: "dir:repo", checkoutRoot: project, source: "folder", displayName: "repo" }
  });
  const pendingJob = (): EvolutionJobRecord => {
    const row = db.db.prepare(
      `SELECT id, user_id, payload_json, created_at FROM evolution_jobs
       WHERE job_type = 'project_environment_profile' AND status = 'queued' ORDER BY created_at DESC LIMIT 1`
    ).get() as { id: string; user_id: string; payload_json: string; created_at: string };
    return {
      id: row.id,
      jobType: "project_environment_profile",
      userId: row.user_id,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at
    } as EvolutionJobRecord;
  };
  return { db, repos, service, complete, unit, project, pendingJob };
}

describe("L3 field cognition project profile", () => {
  it("queues at most one pending profile job per unit, and scans a unit at most once in ten minutes", () => {
    const { service, unit, project, db } = setup();
    const request = () => service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project });
    expect(request()).toBe(true);
    expect(request()).toBe(false);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded', updated_at = ? WHERE job_type = 'project_environment_profile'`)
      .run(new Date(Date.now() - 9 * 60_000).toISOString());
    expect(request()).toBe(false);
    db.db.prepare(`UPDATE evolution_jobs SET updated_at = ? WHERE job_type = 'project_environment_profile'`)
      .run(new Date(Date.now() - 11 * 60_000).toISOString());
    expect(request()).toBe(true);
  });

  it("writes the summary into the unit, refreshes its snapshot, and leaves machine runtime versions out", async () => {
    const { service, repos, complete, unit, project, pendingJob } = setup();
    service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project });
    await service.processProfileJob(pendingJob());
    const updated = repos.l3Field.getUnit(unit.unitKey)!;
    expect(updated.profileText).toBe("Node 项目，测试用 vitest");
    expect(updated.profileFingerprint).toBeTruthy();
    expect(repos.memories.get(updated.snapshotMemoryId!)!.memoryValue).toContain("Node 项目，测试用 vitest");
    const sent = JSON.stringify(complete.mock.calls);
    expect(sent).toContain("runtime_probes\\\":[]");
    expect(sent).toContain(">=20");
    expect(repos.l3WorldModels.getScope("u1", "dir:repo")).toBeUndefined();
  });

  it("skips the model when the scan is unchanged", async () => {
    const { service, complete, unit, project, pendingJob, db } = setup();
    service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project });
    await service.processProfileJob(pendingJob());
    // Past the ten-minute gap, so the next session open scans again.
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded', updated_at = ? WHERE job_type = 'project_environment_profile'`)
      .run(new Date(Date.now() - 11 * 60_000).toISOString());
    expect(service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project })).toBe(true);
    await service.processProfileJob(pendingJob());
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not ask the model again for an unchanged project that had nothing worth a profile (an empty folder)", async () => {
    const { service, complete, unit, project, pendingJob, db } = setup('{"op":"noop","profile":""}');
    rmSync(join(project, "package.json"));
    rmSync(join(project, "index.ts"));
    service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project });
    await service.processProfileJob(pendingJob());
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded', updated_at = ? WHERE job_type = 'project_environment_profile'`)
      .run(new Date(Date.now() - 11 * 60_000).toISOString());
    service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project });
    await service.processProfileJob(pendingJob());
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("drops a job queued before the unit was deleted, but serves jobs queued after it", async () => {
    const { service, repos, complete, unit, project, pendingJob, db } = setup();
    service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project, at: "2026-10-01T00:00:00.000Z" });
    repos.l3Field.markUnitDeleted(unit.unitKey, "2026-10-02T00:00:00.000Z");
    await service.processProfileJob(pendingJob());
    expect(complete).not.toHaveBeenCalled();
    expect(repos.l3Field.getUnit(unit.unitKey)!.profileText).toBeUndefined();

    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE job_type = 'project_environment_profile'`).run();
    service.requestL3UnitProfile({ userId: "u1", unitKey: unit.unitKey, checkoutRoot: project, at: "2026-10-03T00:00:00.000Z" });
    await service.processProfileJob(pendingJob());
    expect(repos.l3Field.getUnit(unit.unitKey)!.profileText).toBe("Node 项目，测试用 vitest");
  });
});

function testLlm(complete: LlmClient["complete"]): LlmClient {
  return {
    config: {
      provider: "host",
      endpoint: "http://localhost/unused",
      model: "l3-unit-profile-test",
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
    status: () => ({ provider: "host", model: "l3-unit-profile-test", configured: true, remote: false })
  };
}
