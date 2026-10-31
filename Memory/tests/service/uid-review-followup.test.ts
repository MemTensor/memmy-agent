import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryDb } from '../../src/storage/db.js';
import { Repositories, l3WorldModelMemoryKey, l3WorldModelScopeKey } from '../../src/storage/repositories.js';
import { deriveWorkspaceHostId, sha256Hex } from '../../src/contracts/index.js';
import { ProjectEnvironmentService } from '../../src/service/project-environment/project-environment-service.js';
import { ProjectEnvironmentProfilePipeline } from '../../src/service/project-environment/profile-pipeline.js';
import { createMemoryServiceFixture, createFailingLlm } from '../fixtures/memory-service-fixture.js';
import type { MemoryService } from '../../src/service/memory-service.js';
import type { LlmClient } from '../../src/model/types.js';
import type { ProjectEnvironmentDerivedEvidence } from '../../src/service/project-environment/types.js';
import { DEVICE_MEMORY_OWNER } from '../../src/service/namespace/memory-owner.js';
import { pendingPolicyIndex } from '../../src/storage/queue-scheduling-schema.js';
import { SCHEMA_VERSION } from '../../src/storage/schema.js';
const f = createMemoryServiceFixture();
afterEach(f.cleanup);
const device = DEVICE_MEMORY_OWNER;
const ns = (userId: string, key = 'new-comments') => ({ source: 'codex', profileId: 'default', userId, sessionKey: key });
function open(service: MemoryService, userId: string, uri: string, key: string) {
    const opened = service.openSession({ namespace: ns(userId, key), workspaceUri: uri, workspaceHostId: deriveWorkspaceHostId('review-machine'), l3WorldModelProtocolVersion: 2, l3WorldModelTransition: 'resume_only' });
    if (!opened.projectId) throw new Error('expected workspace project');
    return { ...opened, projectId: opened.projectId };
}
const read = (service: MemoryService, opened: ReturnType<typeof open>, userId: string = device) => service.l3WorldModelContext(opened.sessionId, { requestId: crypto.randomUUID(), adapterId: 'test', namespace: { source: "codex", profileId: "default", userId, projectId: opened.projectId } });
const llm = () => ({ ...createFailingLlm(), complete: vi.fn<LlmClient['complete']>().mockResolvedValue('{"op":"create","profile":"TypeScript project"}') });
it.each(['domain_knowledge', 'project_environment_profile'] as const)('deleting an old contract preserves independent %s after restart', async (field) => {
    const { service, db, root } = f.createTestService();
    const repos = new Repositories(db.db);
    const uri = 'file:///tmp/pr796-delete-boundary';
    const oldProject = `ws_${sha256Hex(`account-a\0local\0${deriveWorkspaceHostId('review-machine')}\0${uri}`)}`;
    const oldSession = open(service, 'account-a', uri, 'old');
    db.db.prepare('UPDATE sessions SET user_id=?,project_id=? WHERE id=?').run('account-a', oldProject, oldSession.sessionId);
    const old = repos.l3WorldModels.upsertField({ userId: 'account-a', projectId: oldProject, targetField: 'project_contract', value: 'Run tests.' })!;
    db.db.prepare('UPDATE memories SET user_id=?,memory_key=? WHERE id=?').run('account-a', l3WorldModelMemoryKey('account-a', oldProject), old.id);
    db.db.prepare('UPDATE l3_world_model_scopes SET user_id=?,scope_key=? WHERE memory_id=?').run('account-a', l3WorldModelScopeKey('account-a', oldProject), old.id);
    db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
    const current = open(service, device, uri, 'current');
    let fresh;
    if (field === 'domain_knowledge')
        fresh = repos.l3WorldModels.upsertField({ userId: device, projectId: current.projectId, targetField: field, value: 'Independent knowledge' });
    else {
        const req = repos.projectEnvironments.requestScan({ userId: device, projectId: current.projectId, sessionId: current.sessionId, trigger: 'session_start', dedupeKey: 'profile-fresh' });
        repos.projectEnvironments.applyProfile({ userId: device, projectId: current.projectId, scanId: String(req.job.payload.scanId), projectKind: 'code', fingerprint: 'fresh', expectedCurrentProfile: null, operation: 'create', profile: 'Independent profile' });
        fresh = repos.l3WorldModels.getMemory(device, current.projectId);
    }
    const property = field === 'domain_knowledge' ? 'domainKnowledge' : 'projectEnvironmentProfile';
    const value = field === 'domain_knowledge' ? 'Independent knowledge' : 'Independent profile';
    const before = read(service, current);
    expect(before[property]).toBe(value);
    const freshBefore = repos.memories.get(fresh!.id);
    const markersBefore = db.db.prepare("SELECT * FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%' ORDER BY key").all();
    service.deleteMemory(old.id, { namespace: { source: "codex", profileId: "default", userId: "account-a", projectId: oldProject } });
    const after = read(service, current);
    expect(after[property]).toBe(value);
    expect(repos.memories.get(fresh!.id)).toEqual(freshBefore);
    expect(db.db.prepare('SELECT status FROM memories WHERE id=?').get(old.id)).toEqual({ status: 'deleted' });
    const markersAfter = db.db.prepare("SELECT * FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%' ORDER BY key").all();
    expect(markersAfter).toEqual(expect.arrayContaining(markersBefore));
    await service.stop();
    db.close();
    const reopenedDb = new MemoryDb({ path: join(root, 'memory.sqlite') });
    const reopened = f.createTestMemoryService({ db: reopenedDb });
    const restarted = read(reopened, current);
    expect(restarted[property]).toBe(value);
});
function oldJobFixture() {
    const model = llm();
    const x = f.createTestService({ skillLlm: model });
    const repos = new Repositories(x.db.db);
    const folder = join(x.root, 'project');
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), '{"name":"legacy-project","type":"module"}');
    const uri = pathToFileURL(realpathSync(folder)).href;
    const opened = open(x.service, 'account-a', uri, 'old-scan');
    const projectId = `ws_${sha256Hex(`account-a\0local\0${deriveWorkspaceHostId('review-machine')}\0${uri}`)}`;
    x.db.db.prepare('UPDATE sessions SET user_id=?,project_id=? WHERE id=?').run('account-a', projectId, opened.sessionId);
    repos.l3WorldModels.bindWorkspaceUri('account-a', projectId, uri);
    const req = repos.projectEnvironments.requestScan({ userId: 'account-a', projectId, sessionId: opened.sessionId, trigger: 'session_start', dedupeKey: 'old-persistent-scan' });
    x.db.db.prepare('UPDATE l3_world_model_scopes SET user_id=?,scope_key=? WHERE project_id=?').run('account-a', l3WorldModelScopeKey('account-a', projectId), projectId);
    return { ...x, repos, model, opened: { ...opened, projectId }, job: req.job, uri };
}
it.each(['session_start', 'token_compaction'] as const)('a resumed legacy session can publish a new device %s scan across restart', async trigger => {
    const x = oldJobFixture();
    // Preserve an actual old-owner L3 row as well as the old session and scope.
    const historical = x.repos.l3WorldModels.upsertField({
        userId: device, projectId: x.opened.projectId,
        targetField: 'project_contract', value: 'Keep the historical contract'
    })!;
    x.db.db.prepare('UPDATE memories SET user_id=?,memory_key=? WHERE id=?')
        .run('account-a', l3WorldModelMemoryKey('account-a', x.opened.projectId), historical.id);
    x.db.db.prepare('DELETE FROM l3_world_model_scopes WHERE user_id=? AND project_id=? AND memory_id IS NULL')
        .run('account-a', x.opened.projectId);
    x.db.db.prepare('UPDATE l3_world_model_scopes SET user_id=?,scope_key=?,workspace_uri=? WHERE memory_id=?')
        .run('account-a', l3WorldModelScopeKey('account-a', x.opened.projectId), x.uri, historical.id);
    x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
    const memoryBefore = x.repos.memories.get(historical.id);
    const scopeBefore = x.repos.l3WorldModels.getOwnedScope('account-a', x.opened.projectId);
    const sessionBefore = x.repos.runtime.getSession(x.opened.sessionId)!;

    const resumed = x.service.openSession({
        sessionId: x.opened.sessionId,
        namespace: ns('account-b', 'old-scan'),
        workspaceUri: x.uri, workspaceHostId: deriveWorkspaceHostId('review-machine'),
        l3WorldModelProtocolVersion: 2, l3WorldModelTransition: 'resume_only'
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.sessionId).toBe(sessionBefore.id);
    if (trigger === 'token_compaction') {
        const completed = await x.service.completeTurn('legacy-session-compaction', {
            sessionId: resumed.sessionId, query: 'Continue the existing project',
            answer: 'Continuing with its historical contract', status: 'succeeded'
        });
        if (!completed.l1MemoryId) throw new Error('expected registered L1 memory');
        x.service.l3WorldModelBoundary(resumed.sessionId, {
            requestId: 'legacy-compaction', adapterId: 'test',
            namespace: { ...ns('account-b', 'old-scan'), projectId: x.opened.projectId },
            trigger: 'token_compaction', throughL1MemoryId: completed.l1MemoryId
        });
    }
    const job = x.repos.runtime.listJobs('queued', 100).find(candidate =>
        candidate.jobType === 'project_environment_profile' && candidate.userId === device &&
        candidate.sessionId === resumed.sessionId && candidate.payload.projectId === x.opened.projectId &&
        candidate.payload.trigger === trigger);
    expect(job).toBeDefined();
    expect(job!.payload.userId).toBe(device);
    await new ProjectEnvironmentService({ repos: x.repos, llm: x.model }).processProfileJob(job!);
    const published = x.repos.l3WorldModels.getMemory(device, x.opened.projectId)!;
    expect(published.userId).toBe(device);
    expect(published.info.project_environment_applied_scan_id).toBe(job!.payload.scanId);
    expect(x.repos.projectEnvironments.getState(device, x.opened.projectId)).toMatchObject({
        status: 'clean', appliedScanId: job!.payload.scanId
    });
    expect(read(x.service, x.opened, 'account-b')).toMatchObject({
        projectEnvironmentProfile: 'TypeScript project', projectContract: 'Keep the historical contract'
    });
    expect(x.repos.memories.get(historical.id)).toEqual(memoryBefore);
    expect(x.repos.l3WorldModels.getOwnedScope('account-a', x.opened.projectId)).toEqual(scopeBefore);
    expect(x.repos.runtime.getSession(resumed.sessionId)).toMatchObject({
        userId: sessionBefore.userId, projectId: sessionBefore.projectId, meta: sessionBefore.meta
    });
    await x.service.stop();
    x.db.close();
    const reopenedDb = new MemoryDb({ path: join(x.root, 'memory.sqlite') });
    const reopened = f.createTestMemoryService({ db: reopenedDb, skillLlm: x.model });
    const repos = new Repositories(reopenedDb.db);
    expect(read(reopened, x.opened, 'account-c')).toMatchObject({
        projectEnvironmentProfile: 'TypeScript project', projectContract: 'Keep the historical contract'
    });
    expect(repos.memories.get(historical.id)).toEqual(memoryBefore);
    expect(repos.l3WorldModels.getOwnedScope('account-a', x.opened.projectId)).toEqual(scopeBefore);
    expect(repos.runtime.getSession(resumed.sessionId)?.userId).toBe('account-a');
});
it('restores a v9 queued scan and publishes readable device provenance without rewriting its old scope', async () => {
    const x = oldJobFixture();
    const saved = x.db.db.prepare('SELECT * FROM l3_world_model_scopes WHERE user_id=? AND project_id=?').get('account-a', x.opened.projectId);
    await x.service.stop();
    restoreV9Queue(x.db);
    x.db.close();
    const db = new MemoryDb({ path: join(x.root, 'memory.sqlite') });
    const service = f.createTestMemoryService({ db, skillLlm: x.model });
    const repos = new Repositories(db.db);
    expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
    const restored = repos.runtime.getJobByDedupeKey('old-persistent-scan')!;
    expect(restored).toMatchObject(x.job);
    const runner = new ProjectEnvironmentService({ repos, llm: x.model });
    let error: string | null = null;
    try {
        await runner.processProfileJob(restored);
    }
    catch (e) {
        error = String((e as Error).message);
    }
    expect(error).toBe(null);
    const state = repos.projectEnvironments.getState('account-a', x.opened.projectId)!;
    expect(state.status).toBe('clean');
    expect(db.db.prepare('SELECT * FROM l3_world_model_scopes WHERE user_id=? AND project_id=?').get('account-a', x.opened.projectId)).toEqual(saved);
    const context = read(service, x.opened, 'account-a');
    expect(context.projectEnvironmentProfile).toBe('TypeScript project');
    expect(repos.runtime.getJob(x.job.id)).toMatchObject(x.job);
    await service.stop();
    db.close();
    const againDb = new MemoryDb({ path: join(x.root, 'memory.sqlite') });
    const again = f.createTestMemoryService({ db: againDb, skillLlm: x.model });
    expect(read(again, x.opened, 'account-a').projectEnvironmentProfile).toBe('TypeScript project');
});
it.each(['override', 'clear'] as const)('deleting an overridden record preserves an existing %s marker exactly', mode => {
    const x = oldJobFixture();
    const old = x.repos.l3WorldModels.upsertField({ userId: 'account-a', projectId: x.opened.projectId, targetField: 'project_contract', value: 'Old contract' })!;
    x.db.db.prepare('UPDATE memories SET user_id=?,memory_key=? WHERE id=?').run('account-a', l3WorldModelMemoryKey('account-a', x.opened.projectId), old.id);
    x.db.db.prepare('DELETE FROM l3_world_model_scopes WHERE user_id=? AND project_id=? AND memory_id IS NULL').run('account-a', x.opened.projectId);
    x.db.db.prepare('UPDATE l3_world_model_scopes SET user_id=?,scope_key=? WHERE memory_id=?').run('account-a', l3WorldModelScopeKey('account-a', x.opened.projectId), old.id);
    x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
    x.repos.l3WorldModels.upsertField({ userId: device, projectId: x.opened.projectId, targetField: 'project_contract', value: mode === 'override' ? 'New contract' : null });
    const markers = x.db.db.prepare("SELECT * FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%' ORDER BY key").all();
    x.service.deleteMemory(old.id);
    expect(read(x.service, x.opened, 'account-a').projectContract).toBe(mode === 'override' ? 'New contract' : null);
    expect(x.db.db.prepare("SELECT * FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%' ORDER BY key").all()).toEqual(markers);
});
it('deleting one of multiple historical contributors retains the remaining effective value', () => {
    const x = oldJobFixture();
    const make = (owner: string, value: string) => {
        const row = x.repos.l3WorldModels.upsertField({ userId: device, projectId: x.opened.projectId, targetField: 'project_contract', value })!;
        x.db.db.prepare('UPDATE memories SET user_id=?,memory_key=? WHERE id=?').run(owner, l3WorldModelMemoryKey(owner, x.opened.projectId), row.id);
        // No existing Memory on the original old scope in this fixture.
        x.db.db.prepare('DELETE FROM l3_world_model_scopes WHERE user_id=? AND project_id=? AND memory_id IS NULL').run(owner, x.opened.projectId);
        x.db.db.prepare('UPDATE l3_world_model_scopes SET user_id=?,scope_key=? WHERE memory_id=?').run(owner, l3WorldModelScopeKey(owner, x.opened.projectId), row.id);
        x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
        return x.repos.memories.get(row.id)!;
    };
    const a = make('account-a', 'First contract');
    const b = make('account-b', 'Second contract');
    expect(read(x.service, x.opened, 'account-a').projectContract).toContain('First contract');
    expect(read(x.service, x.opened, 'account-a').projectContract).toContain('Second contract');
    x.service.deleteMemory(a.id);
    expect(read(x.service, x.opened, 'account-a').projectContract).toBe('Second contract');
    expect(x.repos.memories.get(b.id)).toEqual(b);
    x.service.deleteMemory(b.id);
    expect(read(x.service, x.opened, 'account-a').projectContract).toBeNull();
});
it.each(['job-owner', 'session-project', 'workspace', 'scope-key', 'job-payload'] as const)('rejects a persisted old scan with mismatched %s evidence', async (mismatch) => {
    const x = oldJobFixture();
    if (mismatch === 'job-owner')
        x.job.userId = 'different-owner';
    if (mismatch === 'session-project')
        x.db.db.prepare("UPDATE sessions SET project_id='different-project' WHERE id=?").run(x.opened.sessionId);
    if (mismatch === 'workspace')
        x.db.db.prepare("UPDATE l3_world_model_scopes SET workspace_uri='file:///tmp/forged' WHERE user_id='account-a' AND project_id=?").run(x.opened.projectId);
    if (mismatch === 'scope-key')
        x.db.db.prepare("UPDATE l3_world_model_scopes SET scope_key='forged' WHERE user_id='account-a' AND project_id=?").run(x.opened.projectId);
    if (mismatch === 'job-payload')
        x.job.payload.trigger = 'token_compaction';
    await expect(new ProjectEnvironmentService({ repos: x.repos, llm: x.model }).processProfileJob(x.job)).rejects.toThrow();
    expect(x.model.complete).not.toHaveBeenCalled();
    expect(x.repos.l3WorldModels.getMemory(device, x.opened.projectId)).toBeUndefined();
});
it.each(['before-start', 'during-model'] as const)('a newer device scan supersedes a legacy scan across verified project aliases: %s', async (when) => {
    const x = oldJobFixture();
    const runner = new ProjectEnvironmentService({ repos: x.repos, llm: x.model });
    let release: ((value: string) => void) | undefined;
    if (when === 'during-model')
        x.model.complete.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = when === 'during-model' ? runner.processProfileJob(x.job) : undefined;
    if (pending)
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const current = open(x.service, device, x.uri, 'new-device-scan');
    const newer = x.repos.projectEnvironments.requestScan({ userId: device, projectId: current.projectId, sessionId: current.sessionId, trigger: 'token_compaction', dedupeKey: 'new-device-scan' }).job;
    expect(x.repos.l3WorldModels.sharedProjectIds(current.projectId)).toContain(x.opened.projectId);
    x.model.complete.mockResolvedValue('{"op":"create","profile":"Newer device profile"}');
    await runner.processProfileJob(newer);
    if (pending) {
        release!('{"op":"create","profile":"Obsolete old profile"}');
        await pending;
    }
    else
        await runner.processProfileJob(x.job);
    expect(read(x.service, current).projectEnvironmentProfile).toBe('Newer device profile');
    expect(read(x.service, x.opened, 'account-a').projectEnvironmentProfile).toBe('Newer device profile');
    expect(x.repos.l3WorldModels.getMemory(device, x.opened.projectId)).toBeUndefined();
});
it('a legacy noop retains its historical applied scan and source row', async () => {
    const x = oldJobFixture();
    const old = x.repos.l3WorldModels.upsertField({ userId: device, projectId: x.opened.projectId, targetField: 'project_environment_profile', value: 'Historical profile', projectEnvironmentAppliedScanId: 'previous-scan' })!;
    x.db.db.prepare('UPDATE memories SET user_id=?,memory_key=? WHERE id=?').run('account-a', l3WorldModelMemoryKey('account-a', x.opened.projectId), old.id);
    x.db.db.prepare('DELETE FROM l3_world_model_scopes WHERE user_id=? AND project_id=? AND memory_id IS NULL').run('account-a', x.opened.projectId);
    x.db.db.prepare('UPDATE l3_world_model_scopes SET user_id=?,scope_key=? WHERE memory_id=?').run('account-a', l3WorldModelScopeKey('account-a', x.opened.projectId), old.id);
    x.db.db.prepare('UPDATE l3_world_model_scopes SET workspace_uri=? WHERE memory_id=?').run(x.uri, old.id);
    x.db.db.prepare("UPDATE l3_world_model_project_environment_state SET applied_scan_id='previous-scan' WHERE user_id='account-a' AND project_id=?").run(x.opened.projectId);
    x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
    const before = x.repos.memories.get(old.id);
    x.model.complete.mockResolvedValue('{"op":"noop","profile":""}');
    await new ProjectEnvironmentService({ repos: x.repos, llm: x.model }).processProfileJob(x.job);
    expect(read(x.service, x.opened, 'account-a').projectEnvironmentProfile).toBe('Historical profile');
    expect(x.repos.memories.get(old.id)).toEqual(before);
    expect(x.repos.projectEnvironments.getState('account-a', x.opened.projectId)?.appliedScanId).toBe('previous-scan');
    expect(x.repos.l3WorldModels.getMemory(device, x.opened.projectId)).toBeUndefined();
});
/** Same legacy queue reconstruction used by worker-lease-schema.test.ts. */
function restoreV9Queue(db: MemoryDb): void {
    for (const table of ['evolution_jobs', 'embedding_retry_queue'])
        for (const suffix of ['deadline_insert', 'deadline_update'])
            db.db.exec(`DROP TRIGGER ${table}_${suffix}`);
    for (const index of ['worker_main_deadline', 'worker_main_lease_deadline', 'worker_retry_lease_deadline'])
        db.db.exec(`DROP INDEX ${index}`);
    db.db.exec('DROP TABLE worker_deadline_revision');
    for (const table of ['evolution_jobs', 'embedding_retry_queue']) {
        for (const suffix of ['enqueue_sequence', 'policy_dirty'])
            db.db.exec(`DROP TRIGGER ${table}_${suffix}`);
        db.db.exec(`DROP INDEX ${pendingPolicyIndex(table)}`);
        db.db.exec(`DROP INDEX ${pendingPolicyIndex(table, true)}`);
        for (const suffix of ['enqueue_seq', 'lane_due', 'lane_fifo', 'policy_dirty'])
            db.db.exec(`DROP INDEX ${table}_${suffix}`);
    }
    for (const suffix of ['dirty', 'insert', 'delete'])
        db.db.exec(`DROP TRIGGER memories_worker_policy_${suffix}`);
    for (const table of ['evolution_jobs', 'embedding_retry_queue'])
        for (const column of ['queue_lane', 'resource_class', 'enqueue_seq', 'first_queued_at', 'base_priority', 'policy_version', 'policy_promotion'])
            db.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    db.db.exec('DROP TABLE worker_enqueue_counter; DROP INDEX idx_evolution_jobs_available');
    for (const column of ['lease_owner', 'lease_token', 'available_at', 'blocked_reason', 'failure_count', 'lease_count', 'lease_recovery_count'])
        db.db.exec(`ALTER TABLE evolution_jobs DROP COLUMN ${column}`);
    db.db.exec('ALTER TABLE embedding_retry_queue DROP COLUMN blocked_reason; ALTER TABLE embedding_retry_queue DROP COLUMN lease_token');
    db.db.exec("DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES('009_token_usage_outbox',9,'2026-01-01','legacy')");
}
it('comment2b: profile-only completion marks old state clean but writes a device record with matching applied provenance', async () => {
    const x = oldJobFixture();
    const derived: ProjectEnvironmentDerivedEvidence = { projectKind: 'code', fingerprint: 'derived', compactFileTree: 'package.json', omittedCount: 0, deterministicFacts: { languageCounts: { TypeScript: 1 }, manifestLanguages: [], runtimeDeclarations: [], runtimeProbes: [], toolchains: [], buildEntries: [], testEntries: [], checkEntries: [] } };
    await new ProjectEnvironmentProfilePipeline({ repos: x.repos, llm: x.model }).process(x.job, derived);
    const state = x.repos.projectEnvironments.getState('account-a', x.opened.projectId)!;
    expect(state.status).toBe('clean');
    const row = x.repos.l3WorldModels.getMemory('account-a', x.opened.projectId)!;
    expect(row.memoryValue).toContain('TypeScript project');
    expect(row.userId).toBe(device);
    const matching = x.repos.projectEnvironments.getState(row.userId, x.opened.projectId);
    expect(matching?.appliedScanId).toBe(row.info.project_environment_applied_scan_id);
    const context = read(x.service, x.opened, 'account-a');
    expect(context.projectEnvironmentProfile).toBe('TypeScript project');
    await x.service.stop();
    x.db.close();
    const db = new MemoryDb({ path: join(x.root, 'memory.sqlite') });
    const service = f.createTestMemoryService({ db, skillLlm: x.model });
    const restarted = read(service, x.opened, 'account-a');
    expect(restarted.projectEnvironmentProfile).toBe('TypeScript project');
});
it('comment2 control: device-owner scan completes and stale same-owner scan is rejected', async () => {
    const model = llm();
    const { service, db, root } = f.createTestService({ skillLlm: model });
    const repos = new Repositories(db.db);
    const folder = join(root, 'current');
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), '{"name":"current-project"}');
    const opened = open(service, device, pathToFileURL(realpathSync(folder)).href, 'current-scan');
    const old = repos.projectEnvironments.requestScan({ userId: device, projectId: opened.projectId, sessionId: opened.sessionId, trigger: 'session_start', dedupeKey: 'control-old' }).job;
    const current = repos.projectEnvironments.requestScan({ userId: device, projectId: opened.projectId, sessionId: opened.sessionId, trigger: 'token_compaction', dedupeKey: 'control-current' }).job;
    const runner = new ProjectEnvironmentService({ repos, llm: model });
    await runner.processProfileJob(current);
    expect(read(service, opened).projectEnvironmentProfile).toBe('TypeScript project');
    const before = repos.l3WorldModels.getMemory(device, opened.projectId);
    await runner.processProfileJob(old);
    expect(repos.l3WorldModels.getMemory(device, opened.projectId)).toEqual(before);
    expect(model.complete).toHaveBeenCalledTimes(1);
});
