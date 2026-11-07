import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retrievalDocumentSourceHash } from "../../../src/algorithm/plugin-algorithms.js";
import { stableHash } from "../../../src/utils/id.js";
import { ModelHttpError } from "../../../src/model/http.js";
import { embeddingTextForMemory, traceSummaryEmbeddingText } from "../../../src/service/embedding/embedding-pipeline.js";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { MemoryRepository, Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import {
  createCapturingEmbedder,
  createFailingLlm,
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const namespace = { source: "claude_code", profileId: "default", userId: "skill-embedding-concurrency" };
const marker = "INFLIGHT_IMPORTED_SKILL_BODY_780";

function skill(name = "concurrency-skill", description = `Handle ${marker} safely.`): AgentSkillReconcileSkill {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nFull guide ${description}.`;
  return {
    sourceSkillId: name,
    sourceSkillPath: `/fixture/skills/${name}/SKILL.md`,
    title: name,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    modifiedAt: "2026-10-01T00:00:00.000Z",
    description
  };
}

function gatedEmbedder() {
  let enter!: () => void;
  let release!: (failure: boolean | Error) => void;
  let armed = false;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const result = new Promise<boolean | Error>((resolve) => { release = resolve; });
  const inputs: string[] = [];
  const batches: string[][] = [];
  const base = createCapturingEmbedder(inputs);
  const embed = async (texts: string[]): Promise<number[][]> => {
    inputs.push(...texts);
    batches.push([...texts]);
    if (armed) {
      armed = false;
      enter();
      const failure = await result;
      if (failure instanceof Error) throw failure;
      if (failure) throw new Error("fixture embedding request failed");
    }
    return texts.map(() => [1, 0, 0]);
  };
  return {
    embedder: {
      ...base,
      embed,
      async embedOne(text: string): Promise<number[]> { return (await embed([text]))[0]!; }
    },
    inputs,
    batches,
    entered,
    arm() { armed = true; },
    finish(failure: boolean | Error) { release(failure); }
  };
}

type TestService = ReturnType<typeof createTestService>;
type Transition = "delete" | "user_archive" | "source_missing" | "superseded" | "manual" | "disconnect";

function restrictTarget(service: TestService["service"], id: string, sourceSkill: AgentSkillReconcileSkill, transition: Transition,
  otherSkills: AgentSkillReconcileSkill[] = []): void {
  if (transition === "delete") {
    service.deleteMemory(id, { namespace });
  } else if (transition === "user_archive") {
    service.archiveMemory(id, { namespace });
  } else {
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: transition !== "disconnect",
      disconnected: transition === "disconnect",
      skills: [...(transition === "manual" ? [{ ...sourceSkill, disableModelInvocation: true }]
        : transition === "superseded" ? [skill(sourceSkill.title, "The source now uses a newer guide.")]
          : []), ...otherSkills]
    });
  }
}

function currentChangeSequence(db: TestService["db"]): number {
  return (db.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_change_log").get() as { seq: number }).seq;
}

function replaceRetrievalText(repos: Repositories, id: string, description: string): MemoryRow {
  const memory = repos.memories.get(id)!;
  const internal = memory.properties.internal_info;
  const previousSkill = internal.skill as Record<string, unknown>;
  return repos.memories.updateMaintenance({
    ...memory,
    // The source body is canonical after the real-query short-text gate failed.
    memoryValue: memory.memoryValue.replace(/^description:.*$/m, `description: ${description}`)
      .replace(/^Full guide .*$/m, `Full guide ${description}.`),
    properties: {
      ...memory.properties,
      internal_info: {
        ...internal,
        skill_description: description,
        procedure_json: { ...(internal.procedure_json as Record<string, unknown>), retrievalBlurb: description },
        skill: { ...previousSkill, procedure_json: { ...(previousSkill.procedure_json as Record<string, unknown>), retrievalBlurb: description } }
      }
    }
  });
}

const isolationFailures = [
  [400, "20015", "The parameter is invalid."],
  [413, "payload_too_large", "Request too large"],
  [422, "invalid_input", "Invalid input"]
] as const;

describe("imported Skill embedding asynchronous completion", () => {
  for (const queue of ["ordinary", "retry"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      it.each<Transition>(["delete", "user_archive", "source_missing", "superseded", "manual", "disconnect"])(
        `${queue} ${outcome} cannot restore a target restricted by %s while embedding`,
        async (transition) => {
          const gate = gatedEmbedder();
          const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
          const sourceSkill = skill();
          const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [sourceSkill] })
            .skills[0]!.memoryId!;
          if (queue === "retry") {
            await runWorkerRounds(service, 2, 50);
            await service.rebuildEmbeddings();
          }
          gate.arm();
          const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
          await gate.entered;
          let afterRestriction = 0;
          try {
            restrictTarget(service, id, sourceSkill, transition);
            afterRestriction = currentChangeSequence(db);
          } finally {
            gate.finish(outcome === "failure");
          }
          const result = await run;

          expect(result.failed).toBe(0);
          expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_vector_entries WHERE memory_id = ?").get(id))
            .toEqual({ n: 0 });
          expect(db.db.prepare("SELECT COUNT(*) AS n FROM embedding_retry_queue WHERE target_id = ?").get(id))
            .toEqual({ n: 0 });
          expect(db.db.prepare(
            "SELECT COUNT(*) AS n FROM memory_change_log WHERE seq > ? AND (before_json LIKE ? OR after_json LIKE ?)"
          ).get(afterRestriction, `%${marker}%`, `%${marker}%`)).toEqual({ n: 0 });
        }
      );
    }
  }

  for (const queue of ["ordinary", "retry"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      it(`${queue} ${outcome} replaces stale active text with the current retrieval text`, async () => {
        const gate = gatedEmbedder();
        const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
        const repos = new Repositories(db.db);
        const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill()] })
          .skills[0]!.memoryId!;
        if (queue === "retry") {
          await runWorkerRounds(service, 2, 50);
          await service.rebuildEmbeddings();
        }
        gate.arm();
        const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
        await gate.entered;
        const description = "The current active retrieval description.";
        const current = replaceRetrievalText(repos, id, description);
        gate.finish(outcome === "failure");
        await run;

        const retry = repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec");
        expect(retry).toMatchObject({ status: "pending", sourceText: embeddingTextForMemory(current) });
        expect(retry!.sourceText).not.toContain(marker);
        await runWorkerRounds(service, 2, 50);
        expect(repos.memories.hasVector(id, "vec")).toBe(true);
      });
    }
  }

  it("hashes the complete imported retrieval document while retaining short-document compatibility", () => {
    const { db, service } = createTestService(); const repos = new Repositories(db.db);
    const prefix = "Long description prefix ".repeat(1_100);
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true,
      skills: [skill("long-description", prefix + "FIRST")] }).skills[0]!.memoryId!;
    const first = repos.memories.get(id)!;
    const second = replaceRetrievalText(repos, id, prefix + "OTHER");
    expect(stableHash(embeddingTextForMemory(first))).toBe(stableHash(embeddingTextForMemory(second)));
    expect(retrievalDocumentSourceHash(first)).not.toBe(retrievalDocumentSourceHash(second));
    const short = replaceRetrievalText(repos, id, "A short description.");
    expect(retrievalDocumentSourceHash(short)).toBe(stableHash(embeddingTextForMemory(short)));
    const generated = { ...second, properties: { ...second.properties,
      internal_info: { ...second.properties.internal_info, read_only: false } } };
    expect(retrievalDocumentSourceHash(generated)).toBe(stableHash(embeddingTextForMemory(generated)));
  });

  it.each(["ordinary", "retry"] as const)("%s completion rejects a changed suffix beyond 20k in the current retrieval document", async queue => {
    const gate = gatedEmbedder(); const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
    const repos = new Repositories(db.db); const prefix = "Long description prefix ".repeat(1_100);
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true,
      skills: [skill("long-description", prefix + "FIRST")] }).skills[0]!.memoryId!;
    if (queue === "retry") { await runWorkerRounds(service, 2, 50); await service.rebuildEmbeddings(); }
    gate.arm(); const run = service.runWorkerOnce(1, { targetMemoryIds: [id] }); await gate.entered;
    const current = replaceRetrievalText(repos, id, prefix + "OTHER");
    gate.finish(false); await run;
    expect(repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec")).toMatchObject({
      status: "pending", sourceText: embeddingTextForMemory(current)
    });
    await runWorkerRounds(service, 2, 50);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
  });

  it("retains normal retry behavior for an unchanged active imported Skill", async () => {
    const gate = gatedEmbedder();
    const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
    const repos = new Repositories(db.db);
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill()] })
      .skills[0]!.memoryId!;
    const text = embeddingTextForMemory(repos.memories.get(id)!);
    gate.arm();
    const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
    await gate.entered;
    gate.finish(true);
    await run;
    expect(repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec")).toMatchObject({ status: "pending", sourceText: text });
    await runWorkerRounds(service, 2, 50);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
  });

  it("settles an ordinary failure after its worker job was deleted without recreating retry work", async () => {
    const gate = gatedEmbedder();
    const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill()] })
      .skills[0]!.memoryId!;
    gate.arm();
    const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
    await gate.entered;
    db.db.prepare("DELETE FROM evolution_jobs WHERE target_memory_id = ?").run(id);
    gate.finish(true);
    await expect(run).resolves.toMatchObject({ failed: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM embedding_retry_queue WHERE target_id = ?").get(id)).toEqual({ n: 0 });
  });

  for (const queue of ["ordinary", "retry"] as const) {
    it.each(["success", "failure"] as const)(`${queue} %s checks current eligibility inside its write transaction`, async (outcome) => {
      const gate = gatedEmbedder();
      const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
      const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill()] })
        .skills[0]!.memoryId!;
      if (queue === "retry") {
        await runWorkerRounds(service, 2, 50);
        await service.rebuildEmbeddings();
      }
      gate.arm();
      const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
      await gate.entered;
      const readsInTransaction: boolean[] = [];
      const get = MemoryRepository.prototype.get;
      const getIncludingDeleted = MemoryRepository.prototype.getIncludingDeleted;
      vi.spyOn(MemoryRepository.prototype, "get").mockImplementation(function (this: MemoryRepository, memoryId) {
        if (queue === "ordinary" && memoryId === id) readsInTransaction.push(db.db.inTransaction);
        return get.call(this, memoryId);
      });
      vi.spyOn(MemoryRepository.prototype, "getIncludingDeleted").mockImplementation(function (this: MemoryRepository, memoryId) {
        if (queue === "retry" && memoryId === id) readsInTransaction.push(db.db.inTransaction);
        return getIncludingDeleted.call(this, memoryId);
      });
      gate.finish(outcome === "failure");
      await run;
      expect(readsInTransaction.length).toBeGreaterThan(0);
      expect(readsInTransaction.every(Boolean)).toBe(true);
    });
  }

  for (const layer of ["L1", "L3", "Skill"] as const) {
    it.each(["success", "failure"] as const)(`preserves ${layer} non-imported embedding behavior after archive on %s`, async (outcome) => {
      const gate = gatedEmbedder();
      const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
      const repos = new Repositories(db.db);
      const at = "2026-10-01T00:00:00.000Z";
      const row: MemoryRow = {
        id: `non_imported_${layer}`, timeline: at, userId: namespace.userId,
        memoryType: layer === "Skill" ? "SkillMemory" : "LongTermMemory", status: "activated", visibility: "private",
        memoryKey: `fixture:${layer}`, memoryValue: "An existing non-imported memory guide.", tags: [],
        info: { title: "existing memory", summary: "Existing memory summary." },
        properties: {
          status: "activated",
          internal_info: {
            memory_layer: layer,
            memory_kind: layer === "L1" ? "trace" : layer === "L3" ? "world_model" : "skill",
            read_only: false,
            ...(layer === "L1" ? { trace: { summary: "Existing memory summary.", userText: "Original request.", agentText: "Original response." } } : {}),
            ...(layer === "Skill" ? { skill: { name: "generated-memory", status: "active", eta: 0.6, invocation_guide: "An existing non-imported memory guide." } } : {})
          }
        },
        memoryLayer: layer, version: 1, createdAt: at, updatedAt: at
      };
      const memory = repos.memories.insert(row);
      repos.runtime.enqueueJob({
        id: `job_non_imported_${layer}`, jobType: "embedding", status: "queued", targetMemoryId: memory.id,
        userId: namespace.userId, payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
      });
      gate.arm();
      const run = service.runWorkerOnce(1, { targetMemoryIds: [memory.id] });
      await gate.entered;
      service.archiveMemory(memory.id, { namespace });
      gate.finish(outcome === "failure");
      await run;
      const field = layer === "L1" ? "vec_summary" : "vec";
      if (outcome === "success") {
        expect(repos.memories.hasVector(memory.id, field)).toBe(true);
      } else {
        const kind = layer === "L1" ? "trace" : layer === "L3" ? "world_model" : "skill";
        const text = layer === "L1" ? traceSummaryEmbeddingText(memory) : embeddingTextForMemory(memory);
        expect(repos.runtime.getEmbeddingRetryByTarget(kind, memory.id, field)).toMatchObject({ sourceText: text, status: "pending" });
      }
    });
  }

  for (const queue of ["ordinary", "retry"] as const) {
    for (const [status, code, message] of isolationFailures) {
      it.each<Transition>(["delete", "user_archive", "source_missing", "superseded", "manual", "disconnect"])(
        `${queue} HTTP ${status} isolation skips a target restricted by %s during the first batch`,
        async (transition) => {
          const gate = gatedEmbedder();
          const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
          const repos = new Repositories(db.db);
          const sourceSkill = skill();
          const siblingSkill = skill("stable-sibling", "A valid sibling guide.");
          const [target, sibling] = service.reconcileAgentSkills({
            namespace, sourceAgentId: "codex", complete: true,
            skills: [sourceSkill, siblingSkill]
          }).skills.map((item) => item.memoryId!);
          if (queue === "retry") {
            await runWorkerRounds(service, 2, 50);
            await service.rebuildEmbeddings();
          }
          gate.inputs.length = 0;
          gate.batches.length = 0;
          gate.arm();
          const run = service.runWorkerOnce(2, { targetMemoryIds: [target!, sibling!] });
          await gate.entered;
          try {
            expect(gate.batches[0]).toHaveLength(2);
            restrictTarget(service, target!, sourceSkill, transition, [siblingSkill]);
          } finally {
            gate.finish(new ModelHttpError(message, "openai_compatible", status, code, message));
          }
          const result = await run;

          expect(result.failed).toBe(0);
          expect(gate.batches.slice(1).flat().some((text) => text.includes(marker))).toBe(false);
          if (transition !== "disconnect") {
            expect(repos.memories.hasVector(sibling!, "vec")).toBe(true);
          }
          expect(repos.memories.hasVector(target!, "vec")).toBe(false);
          expect(repos.runtime.getEmbeddingRetryByTarget("skill", target!, "vec")).toBeUndefined();
        }
      );

      it(`${queue} HTTP ${status} isolation uses the current active retrieval text`, async () => {
        const gate = gatedEmbedder();
        const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
        const repos = new Repositories(db.db);
        const [target, sibling] = service.reconcileAgentSkills({
          namespace, sourceAgentId: "codex", complete: true,
          skills: [skill(), skill("stable-sibling", "A valid sibling guide.")]
        }).skills.map((item) => item.memoryId!);
        if (queue === "retry") {
          await runWorkerRounds(service, 2, 50);
          await service.rebuildEmbeddings();
        }
        gate.inputs.length = 0;
        gate.batches.length = 0;
        gate.arm();
        const run = service.runWorkerOnce(2, { targetMemoryIds: [target!, sibling!] });
        await gate.entered;
        expect(gate.batches[0]).toHaveLength(2);
        const current = replaceRetrievalText(repos, target!, "A changed active description for isolation.");
        gate.finish(new ModelHttpError(message, "openai_compatible", status, code, message));
        await run;

        expect(gate.batches.slice(1).flat().some((text) => text.includes(marker))).toBe(false);
        await runWorkerRounds(service, 2, 50);
        expect(gate.inputs).toContain(embeddingTextForMemory(current));
        expect(repos.memories.hasVector(target!, "vec")).toBe(true);
        expect(repos.memories.hasVector(sibling!, "vec")).toBe(true);
      });
    }
  }

  for (const status of [400, 401] as const) {
    it.each<Transition>(["delete", "user_archive", "manual", "disconnect"])(
      `ordinary terminal HTTP ${status} quietly settles a target restricted by %s during the request`,
      async (transition) => {
        const gate = gatedEmbedder();
        const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
        const sourceSkill = skill();
        const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [sourceSkill] })
          .skills[0]!.memoryId!;
        gate.arm();
        const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
        await gate.entered;
        restrictTarget(service, id, sourceSkill, transition);
        gate.finish(new ModelHttpError("Invalid model configuration", "openai_compatible", status, "invalid_api_key", "Invalid model configuration"));
        const result = await run;

        expect(result.failed).toBe(0);
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE target_memory_id = ? AND status = 'failed'").get(id))
          .toEqual({ n: 0 });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM embedding_retry_queue WHERE target_id = ?").get(id)).toEqual({ n: 0 });
      }
    );

    it(`ordinary terminal HTTP ${status} retains the failure for an unchanged active target`, async () => {
      const gate = gatedEmbedder();
      const { db, service } = createTestService({ llm: createFailingLlm(), embedder: gate.embedder });
      const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill()] })
        .skills[0]!.memoryId!;
      gate.arm();
      const run = service.runWorkerOnce(1, { targetMemoryIds: [id] });
      await gate.entered;
      gate.finish(new ModelHttpError("Invalid model configuration", "openai_compatible", status, "invalid_api_key", "Invalid model configuration"));
      expect((await run).failed).toBe(1);
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM embedding_retry_queue WHERE target_id = ?").get(id)).toEqual({ n: 0 });
    });
  }

  it("repairs retrieval vectors beyond the first startup page without duplicate jobs", () => {
    const { db, service } = createTestService({ llm: createFailingLlm() });
    const ids = service.reconcileAgentSkills({
      namespace, sourceAgentId: "codex", complete: true,
      skills: [skill("startup-one"), skill("startup-two"), skill("startup-three")]
    }).skills.map((item) => item.memoryId!);
    db.db.prepare("DELETE FROM evolution_jobs WHERE job_type = 'embedding'").run();

    expect(service.reconcileWorkerStartup(1).enqueuedRetrievalReindexes).toBe(3);
    expect(service.reconcileWorkerStartup(1).enqueuedRetrievalReindexes).toBe(0);
    const repos = new Repositories(db.db);
    for (const id of ids) expect(repos.runtime.hasPendingJob(id, "embedding")).toBe(true);
  });

  it("migrates all authorized imported Skills across pages without expanding ordinary Skill/L3 beyond limit, while keeping future writes and failed-job recovery intact", async () => {
    const embeddedTexts: string[] = [];
    const { db, service } = createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(embeddedTexts) });
    const repos = new Repositories(db.db);

    // Seed 4 ordinary non-imported Skills and 4 L3 memories (8 ordinary total > limit=2)
    const ordinaryIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const ordinarySkill = service.addMemory({
        namespace,
        layer: "Skill",
        title: `ordinary-skill-${i}`,
        content: `Ordinary generated skill ${i} instructions.`
      });
      const ordinaryL3 = service.addMemory({
        namespace,
        layer: "L3",
        title: `ordinary-l3-${i}`,
        content: `Ordinary L3 world model fact ${i}.`
      });
      ordinaryIds.push(ordinarySkill.id, ordinaryL3.id);
    }

    // Seed 5 authorized imported Skills (> limit=2, spanning 3 pages) + 1 user-archived + 1 disconnected imported Skill
    const authorizedImportedIds = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      connectionState: "connected",
      connectionKind: "plugin",
      skills: [1, 2, 3, 4, 5].map((n) => skill(`authorized-imported-${n}`))
    }).skills.map((entry) => entry.memoryId!);

    const archivedImportedId = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "cursor",
      complete: true,
      connectionState: "connected",
      connectionKind: "plugin",
      skills: [skill("archived-imported")]
    }).skills[0]!.memoryId!;
    service.archiveMemory(archivedImportedId, namespace);

    const disconnectedImportedId = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "hermes",
      complete: true,
      connectionState: "disconnected",
      connectionKind: "plugin",
      disconnected: true,
      skills: [skill("disconnected-imported")]
    }).skills[0]!.memoryId!;

    // Simulate pre-upgrade historical state: clear retrieval_index metadata, FTS rows, and pending jobs
    for (const id of [...ordinaryIds, ...authorizedImportedIds]) {
      const row = repos.memories.get(id)!;
      const internal = { ...row.properties.internal_info };
      delete internal.retrieval_index;
      repos.memories.updateMaintenance({
        ...row,
        properties: { ...row.properties, internal_info: internal }
      });
      db.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
      repos.memories.deleteVector(id, "vec");
    }
    // Also preserve one already-queued failed embedding job on an ordinary record beyond the first 2 newest rows
    const oldestOrdinaryId = ordinaryIds[0]!;
    db.db.prepare("DELETE FROM evolution_jobs WHERE target_memory_id != ?").run(oldestOrdinaryId);
    db.db.prepare("DELETE FROM memory_processing_state WHERE memory_id != ?").run(oldestOrdinaryId);
    const existingFailedCount = db.db.prepare(
      "UPDATE evolution_jobs SET status = 'failed', attempts = 1, last_error = 'transient network error' WHERE target_memory_id = ? AND job_type = 'embedding'"
    ).run(oldestOrdinaryId).changes;
    expect(existingFailedCount).toBe(1);

    // Startup pass with small limit = 2
    const firstStartup = service.reconcileWorkerStartup(2);
    // 5 authorized imported Skills + at most 2 ordinary Skill/L3 records
    expect(firstStartup.enqueuedRetrievalReindexes).toBe(7);
    expect(firstStartup.requeuedJobs).toBeGreaterThanOrEqual(1);

    // Every authorized imported Skill (all 5 across pages) must be queued and FTS-repaired
    for (const id of authorizedImportedIds) {
      expect(repos.runtime.hasPendingJob(id, "embedding")).toBe(true);
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(id)).toEqual({ n: 1 });
    }
    // Ineligible imported Skills must NOT be queued or FTS-indexed as active candidates
    expect(repos.runtime.hasPendingJob(archivedImportedId, "embedding")).toBe(false);
    expect(repos.runtime.hasPendingJob(disconnectedImportedId, "embedding")).toBe(false);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(disconnectedImportedId)).toEqual({ n: 0 });

    // Ordinary Skill/L3 records beyond limit=2 must NOT be enqueued for startup.retrieval_document_v2 or FTS-rebuilt
    const startupReindexOrdinaryJobs = db.db.prepare(
      `SELECT target_memory_id FROM evolution_jobs
       WHERE job_type = 'embedding'
         AND json_extract(payload_json, '$.reason') = 'startup.retrieval_document_v2'
         AND target_memory_id IN (${ordinaryIds.map(() => "?").join(", ")})`
    ).all(...ordinaryIds) as Array<{ target_memory_id: string }>;
    expect(startupReindexOrdinaryJobs).toHaveLength(2);
    const ftsOrdinaryCount = db.db.prepare(
      `SELECT COUNT(*) AS n FROM memories_fts WHERE id IN (${ordinaryIds.map(() => "?").join(", ")})`
    ).get(...ordinaryIds) as { n: number };
    expect(ftsOrdinaryCount.n).toBe(2);

    // Already-queued failed job on oldestOrdinaryId WAS requeued
    expect(
      db.db.prepare("SELECT status FROM evolution_jobs WHERE target_memory_id = ? AND job_type = 'embedding'").get(oldestOrdinaryId)
    ).toEqual({ status: "queued" });

    // Drain all queued jobs and verify idempotency on subsequent startup
    await runWorkerRounds(service, 2, 50);
    for (const id of authorizedImportedIds) {
      expect(repos.memories.hasVector(id, "vec")).toBe(true);
    }
    expect(repos.memories.hasVector(oldestOrdinaryId, "vec")).toBe(true);

    // Second startup with limit=2: 0 imported Skills re-enqueued (complete & idempotent!)
    const secondStartup = service.reconcileWorkerStartup(2);
    const secondImportedJobs = db.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_jobs
       WHERE job_type = 'embedding'
         AND status IN ('queued', 'leased')
         AND target_memory_id IN (${authorizedImportedIds.map(() => "?").join(", ")})`
    ).get(...authorizedImportedIds) as { n: number };
    expect(secondImportedJobs.n).toBe(0);
    // Repeated startup still inspects only the top limit=2 newest ordinary rows (already migrated), never backfilling older history
    expect(secondStartup.enqueuedRetrievalReindexes).toBe(0);

    // Future new ordinary Skill & L3 records continue to enqueue and embed normally
    const futureSkill = service.addMemory({
      namespace,
      layer: "Skill",
      title: "future-generated-skill",
      content: "Future generated skill body."
    });
    const futureL3 = service.addMemory({
      namespace,
      layer: "L3",
      title: "future-l3-record",
      content: "Future L3 world model summary."
    });
    await runWorkerRounds(service, 2, 50);
    expect(repos.memories.hasVector(futureSkill.id, "vec")).toBe(true);
    expect(repos.memories.hasVector(futureL3.id, "vec")).toBe(true);
  });
});
