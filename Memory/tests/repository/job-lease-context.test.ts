import { afterEach, describe, expect, it } from "vitest";
import {
  assertCurrentJobLease,
  JobLeaseLostError,
  withJobLeaseGuard
} from "../../src/storage/job-lease-context.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { EmbeddingJobProcessor } from "../../src/service/embedding/embedding-job-processor.js";
import {
  addAgentSourceImport,
  createBatchReflectionLlm,
  createCapturingEmbedder,
  createMemoryServiceFixture
} from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

describe("worker lease write context", () => {
  it("keeps ordinary writes and readonly queries available, but rejects stale prepared writes", () => {
    const { db } = fixture.createTestService();
    db.db.exec("CREATE TABLE fence_test (id INTEGER PRIMARY KEY, value TEXT)");
    const insert = db.db.prepare("INSERT INTO fence_test (value) VALUES (?)");
    insert.run("foreground");
    let held = true;
    withJobLeaseGuard({ id: "job-A" }, () => held, () => {
      insert.run("valid-worker");
      held = false;
      expect(() => insert.run("obsolete-worker")).toThrow(JobLeaseLostError);
      expect(() => db.db.exec("DELETE FROM fence_test")).toThrow(JobLeaseLostError);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM fence_test").get()).toEqual({ count: 2 });
    });
    insert.run("foreground-after-context");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM fence_test").get()).toEqual({ count: 3 });
  });

  it.each(["get", "all", "iterate"] as const)("guards a RETURNING mutation executed using %s", (method) => {
    const { db } = fixture.createTestService();
    db.db.exec("CREATE TABLE fence_returning (id INTEGER PRIMARY KEY, value TEXT)");
    const statement = db.db.prepare("INSERT INTO fence_returning (value) VALUES (?) RETURNING id");
    let held = true;
    withJobLeaseGuard({ id: "returning-job" }, () => held, () => {
      held = false;
      expect(() => statement[method]("stale")).toThrow(JobLeaseLostError);
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM fence_returning").get()).toEqual({ count: 0 });
  });

  it("rechecks a lazy mutating iterator before its first step", () => {
    const { db } = fixture.createTestService();
    db.db.exec("CREATE TABLE fence_iterator (id INTEGER PRIMARY KEY, value TEXT)");
    let held = true;
    withJobLeaseGuard({ id: "iterator-job" }, () => held, () => {
      const iterator = db.db.prepare("INSERT INTO fence_iterator (value) VALUES ('stale') RETURNING id").iterate();
      held = false;
      expect(() => iterator.next()).toThrow(JobLeaseLostError);
      iterator.return?.();
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM fence_iterator").get()).toEqual({ count: 0 });
  });

  it("isolates overlapping async claims and rolls back a stale multi-statement transaction", async () => {
    const { db } = fixture.createTestService();
    db.db.exec("CREATE TABLE fence_concurrent (value TEXT)");
    let release!: () => void;
    const wait = new Promise<void>((done) => { release = done; });
    let heldA = true;
    const a = withJobLeaseGuard({ id: "A" }, () => heldA, async () => {
      await wait;
      db.db.prepare("INSERT INTO fence_concurrent VALUES ('A')").run();
    });
    const rejected = expect(a).rejects.toMatchObject({ name: "JobLeaseLostError", jobId: "A" });
    withJobLeaseGuard({ id: "B" }, () => true, () => {
      db.db.prepare("INSERT INTO fence_concurrent VALUES ('B')").run();
    });
    heldA = false;
    release();
    await rejected;
    let checks = 0;
    expect(() => withJobLeaseGuard({ id: "rollback" }, () => ++checks < 3, () => {
      db.db.transaction(() => {
        db.db.prepare("INSERT INTO fence_concurrent VALUES ('first')").run();
        db.db.prepare("INSERT INTO fence_concurrent VALUES ('second')").run();
      })();
    })).toThrow(JobLeaseLostError);
    expect(db.db.prepare("SELECT value FROM fence_concurrent").all()).toEqual([{ value: "B" }]);
    // The rejected worker's context must not leak into the test/foreground task.
    expect(() => assertCurrentJobLease()).not.toThrow();
  });

  it("does not persist a delayed imported summary or enqueue its embedding after another lease takes over", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let entered!: () => void;
    const enteredModel = new Promise<void>((done) => { entered = done; });
    const llm = createBatchReflectionLlm([], "obsolete summary must never be saved");
    const original = llm.completeJson.bind(llm);
    llm.completeJson = async (messages, options) => {
      entered();
      await gate;
      return original(messages, options);
    };
    const { db, service } = fixture.createTestService({ llm });
    const repos = new Repositories(db.db);
    const added = addAgentSourceImport(service, {
      source: "codex", profileId: "fencing-test", userId: "fencing-user"
    }, "retain the real user turn", "delayed-summary");
    const processor = (service as unknown as { embeddingJobs: EmbeddingJobProcessor }).embeddingJobs;
    const [old] = repos.runtime.leaseQueuedJobs(1, 60, [added.id], false, ["import_summary"]);
    expect(old).toBeDefined();
    const pending = withJobLeaseGuard(old!, () => repos.runtime.isJobLeaseHeld(old!),
      () => processor.summarizeImportedTrace(old!));
    const rejected = expect(pending).rejects.toBeInstanceOf(JobLeaseLostError);
    await enteredModel;
    db.db.prepare("UPDATE evolution_jobs SET leased_until = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", old!.id);
    const [replacement] = repos.runtime.leaseQueuedJobs(1, 60, [added.id], false, ["import_summary"]);
    expect(replacement!.leaseToken).not.toBe(old!.leaseToken);
    const before = repos.memories.get(added.id);
    const jobCount = db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs").get();
    release();
    await rejected;
    expect(repos.memories.get(added.id)).toEqual(before);
    expect(repos.runtime.getPendingJob(added.id, "embedding")).toBeUndefined();
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs").get()).toEqual(jobCount);
    expect(repos.runtime.getJob(old!.id)).toMatchObject({ status: "leased", leaseToken: replacement!.leaseToken });
  });

  it("does not persist a delayed embedding vector or processing state after another lease takes over", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let entered!: () => void;
    const enteredModel = new Promise<void>((done) => { entered = done; });
    const embedder = createCapturingEmbedder([]);
    const original = embedder.embed.bind(embedder);
    embedder.embed = async (texts, role) => {
      entered();
      await gate;
      return original(texts, role);
    };
    const { db, service } = fixture.createTestService({
      llm: createBatchReflectionLlm([], "valid imported summary"), embedder
    });
    const repos = new Repositories(db.db);
    const added = addAgentSourceImport(service, {
      source: "codex", profileId: "fencing-vector-test", userId: "fencing-vector-user"
    }, "retain the real user turn and vector state", "delayed-vector");
    const processor = (service as unknown as { embeddingJobs: EmbeddingJobProcessor }).embeddingJobs;
    const [summary] = repos.runtime.leaseQueuedJobs(1, 60, [added.id], false, ["import_summary"]);
    await processor.summarizeImportedTrace(summary!);
    const [old] = repos.runtime.leaseQueuedJobs(1, 60, [added.id], false, ["embedding"]);
    expect(old).toBeDefined();
    const pending = withJobLeaseGuard(old!, () => repos.runtime.isJobLeaseHeld(old!),
      () => processor.embedMemory(old!));
    const rejected = expect(pending).rejects.toBeInstanceOf(JobLeaseLostError);
    await enteredModel;
    db.db.prepare("UPDATE evolution_jobs SET leased_until = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", old!.id);
    const [replacement] = repos.runtime.leaseQueuedJobs(1, 60, [added.id], false, ["embedding"]);
    expect(replacement!.leaseToken).not.toBe(old!.leaseToken);
    const before = repos.memories.get(added.id);
    const processing = repos.processing.get(added.id);
    release();
    await rejected;
    expect(repos.memories.get(added.id)).toEqual(before);
    expect(repos.processing.get(added.id)).toEqual(processing);
    expect(repos.memories.hasVector(added.id, "vec_summary")).toBe(false);
    expect(repos.runtime.countEmbeddingRetriesByStatus("pending")).toBe(0);
    expect(repos.runtime.getJob(old!.id)).toMatchObject({ status: "leased", leaseToken: replacement!.leaseToken });
  });
});
