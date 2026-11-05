import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { ModelHttpError } from "../../../src/model/http.js";
import type { LlmClient } from "../../../src/model/types.js";
import { L3UnitUpdatePipeline } from "../../../src/service/l3-field/unit-update-pipeline.js";
import { validateL3UnitOps, type L3UpdateGroup } from "../../../src/service/l3-field/unit-ops.js";
import type { EvidenceFragment, L3ItemRecord, L3UnitRecord } from "../../../src/service/l3-field/types.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

const MACHINE_ID = "d".repeat(64);
type Reply = (input: ModelInput, call: number) => unknown;

interface ModelInput {
  evidence: Array<{ id: string; type: string; candidate_units: string[]; paths: string[] }>;
  machine: { items: Array<{ id: string; content: string }> };
  projects: Array<{ unit_key: string; name: string; items: Array<{ id: string }> }>;
  retry?: string;
}

function setup(options: { enabled?: boolean; reply?: Reply } = {}) {
  const root = fixture.createTestRoot("l3-unit-update-");
  const home = join(root, "home");
  const project = join(home, "code", "demo");
  const other = join(home, "code", "other-repo");
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l3FieldCognition.enabled = options.enabled ?? true;
  const environment = () => ({ machineId: MACHINE_ID, homeDir: home, tempRoots: [] });
  const service = fixture.createTestMemoryService({
    db,
    mode: "dev",
    config,
    l3FieldEnvironment: environment,
    l3MachineProbe: () => new Promise(() => undefined)
  });
  const repos = new Repositories(db.db);
  const inputs: ModelInput[] = [];
  const reply = options.reply ?? defaultReply;
  const complete = vi.fn<LlmClient["complete"]>(async (messages) => {
    const input = JSON.parse(messages[1]!.content) as ModelInput;
    inputs.push(input);
    return JSON.stringify(reply(input, inputs.length));
  });
  const pipeline = new L3UnitUpdatePipeline({ repos, llm: testLlm(complete), environment });
  return { db, service, repos, pipeline, complete, inputs, home, project, other };
}

/** A tool error becomes a project fact; the user's words become a project rule. */
const defaultReply: Reply = (input) => {
  const tool = input.evidence.find((fragment) => fragment.type === "tool");
  const user = input.evidence.find((fragment) => fragment.type === "user_text");
  const ops = [];
  if (input.projects.length && tool) {
    ops.push({ op: "add", unit: "project", kind: "env_fact", content: "npm test 需要先 npm ci -> 否则找不到 vitest", evidence: [tool.id] });
  }
  if (input.projects.length && user) {
    ops.push({ op: "add", unit: "project", kind: "project_constraint", content: "改完代码要跑 npm test", evidence: [user.id] });
  }
  return { reason: "test", ops };
};

async function captureTurn(
  service: ReturnType<typeof setup>["service"],
  sessionKey: string,
  cwd: string,
  turns: Array<{ query: string; workdir?: string }> = [{ query: "以后改完代码都要跑 npm test" }]
) {
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    workspaceUri: pathToFileURL(cwd).href,
    workspaceHostId: "b".repeat(64),
    namespace: { source: "codex", profileId: "default", sessionKey, userId: "u1" }
  });
  for (const [index, turn] of turns.entries()) {
    await service.completeTurn(`${sessionKey}-turn-${index}`, {
      sessionId: opened.sessionId,
      query: turn.query,
      answer: "好的",
      status: "succeeded",
      toolCalls: [{ id: `call-${index}`, name: "exec_command", input: { cmd: "npm test", workdir: turn.workdir ?? cwd }, success: false }],
      toolResults: [{ id: `call-${index}`, name: "exec_command", output: "sh: vitest: command not found", exitCode: 127 }]
    });
  }
  service.closeSession(opened.sessionId);
  return opened;
}

function queuedUnitJob(repos: Repositories): EvolutionJobRecord {
  const job = repos.runtime.listJobs("queued", 100).find((candidate) => candidate.jobType === "l3_unit_update");
  if (!job) throw new Error("expected a queued l3_unit_update job");
  return job;
}

function projectUnitKey(repos: Repositories, name = "demo"): string {
  return (repos.db.prepare(`SELECT unit_key FROM l3_units WHERE kind = 'project' AND display_name = ?`).get(name) as { unit_key: string }).unit_key;
}

describe("new L3 update pipeline", () => {
  it("freezes a session into a new-L3 batch whose job writes items the next session sees", async () => {
    const { service, repos, pipeline, project } = setup();
    await captureTurn(service, "e2e", project);
    expect(repos.runtime.listJobs("queued", 100).some((job) => job.jobType === "l3_world_model_update")).toBe(false);
    const job = queuedUnitJob(repos);
    expect(job.scopeKey).toBe(repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID }).unitKey);

    await pipeline.process(job);
    const items = repos.l3Field.activeItems(projectUnitKey(repos));
    expect(items.map((item) => [item.kind, item.content]).sort()).toEqual([
      ["env_fact", "npm test 需要先 npm ci -> 否则找不到 vitest"],
      ["project_constraint", "改完代码要跑 npm test"]
    ]);
    expect(repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("applied");

    const next = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: pathToFileURL(project).href,
      workspaceHostId: "b".repeat(64),
      namespace: { source: "codex", profileId: "default", sessionKey: "e2e-next", userId: "u1" }
    });
    const context = service.l3WorldModelContext(next.sessionId, {
      requestId: "9353298b-4d3d-46f0-9178-27c27e81543e",
      adapterId: "codex-memory",
      source: "codex",
      namespace: { source: "codex", profileId: "default", sessionKey: "e2e-next", userId: "u1", projectId: next.projectId! }
    });
    expect(context.renderedContext).toContain("当前项目：demo（文件夹）");
    expect(context.renderedContext).toContain("## 项目约束\n- 改完代码要跑 npm test");
  });

  it("keeps the old batches and jobs when the switch is off", async () => {
    const { service, repos, project } = setup({ enabled: false });
    await captureTurn(service, "flag-off", project);
    expect(repos.runtime.listJobs("queued", 100).some((job) => job.jobType === "l3_world_model_update")).toBe(true);
    expect(repos.runtime.listJobs("queued", 100).some((job) => job.jobType === "l3_unit_update")).toBe(false);
    expect((repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches`).get() as { n: number }).n).toBe(0);
  });

  it("writes a batch only once even if its job runs again", async () => {
    const { service, repos, pipeline, project, complete } = setup();
    await captureTurn(service, "twice", project);
    const job = queuedUnitJob(repos);
    await pipeline.process(job);
    await pipeline.process(job);
    expect(repos.l3Field.activeItems(projectUnitKey(repos))).toHaveLength(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("regenerates once with the reasons, and fails without writing when rejected twice", async () => {
    const userFact: Reply = (input) => ({
      reason: "bad",
      ops: [{ op: "add", unit: "project", kind: "env_fact", content: "没有工具输出的事实", evidence: [input.evidence.find((f) => f.type === "user_text")!.id] }]
    });
    const fixed = setup({ reply: (input, call) => (call === 1 ? userFact(input, call) : defaultReply(input, call)) });
    await captureTurn(fixed.service, "retry-ok", fixed.project);
    await fixed.pipeline.process(queuedUnitJob(fixed.repos));
    expect(fixed.inputs[1]!.retry).toContain("env_fact needs a cited tool output or error");
    expect(fixed.repos.l3Field.activeItems(projectUnitKey(fixed.repos))).toHaveLength(2);

    const broken = setup({ reply: userFact });
    await captureTurn(broken.service, "retry-bad", broken.project);
    const job = queuedUnitJob(broken.repos);
    await expect(broken.pipeline.process(job)).rejects.toThrow("rejected twice");
    expect(broken.repos.l3Field.activeItems(projectUnitKey(broken.repos))).toHaveLength(0);
    expect(broken.repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("queued");
  });

  it("drops results for a unit reset after the batch was frozen", async () => {
    const { service, repos, pipeline, project } = setup();
    await captureTurn(service, "reset", project);
    const job = queuedUnitJob(repos);
    repos.l3Field.markUnitDeleted(projectUnitKey(repos), new Date(Date.now() + 1000).toISOString());
    await pipeline.process(job);
    expect(repos.l3Field.activeItems(projectUnitKey(repos))).toHaveLength(0);
    expect(repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("applied");
  });

  it("does not let what was said before a unit reset refill it, even when frozen after the reset", async () => {
    const { service, repos, pipeline, project } = setup();
    await captureTurn(service, "late-freeze", project);
    const job = queuedUnitJob(repos);
    repos.l3Field.markUnitDeleted(projectUnitKey(repos), new Date(Date.now() + 1000).toISOString());
    repos.db.prepare(`UPDATE l3_unit_batches SET created_at = ?`).run(new Date(Date.now() + 2000).toISOString());
    await pipeline.process(job);
    expect(repos.l3Field.activeItems(projectUnitKey(repos))).toHaveLength(0);
  });

  it("does not let older evidence replace or delete an item newer evidence wrote, as a late rerun would", async () => {
    const reply: Reply = (input) => {
      const tool = input.evidence.find((fragment) => fragment.type === "tool")!;
      const [first, second] = input.projects[0]!.items;
      return { reason: "old", ops: [
        { op: "replace", ids: [first!.id], content: "Node 18", evidence: [tool.id] },
        { op: "delete", id: second!.id, evidence: [tool.id] }
      ] };
    };
    const { service, repos, pipeline, project } = setup({ reply });
    await captureTurn(service, "rerun", project, [{ query: "看看" }]);
    const job = queuedUnitJob(repos);
    const unitKey = projectUnitKey(repos);
    const newer = (content: string) => repos.l3Field.insertItem({
      unitKey, kind: "env_fact", content, evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2099-01-01T00:00:00.000Z"
    });
    const kept = [newer("Node 20"), newer("用 pnpm")];
    await pipeline.process(job);
    expect(kept.map((item) => repos.l3Field.getItem(item.id)!.status)).toEqual(["active", "active"]);
    expect(repos.l3Field.activeItems(unitKey).map((item) => item.content)).not.toContain("Node 18");
  });

  it("drops the result of a run that outlived its lease once another run dead-lettered the batch", async () => {
    let db: ReturnType<typeof setup>["db"] | undefined;
    const reply: Reply = (input, call) => {
      // While this run waits on the model, a newer run of the same job fails and dead-letters the batch.
      if (call === 1) db!.db.prepare(`UPDATE l3_unit_batches SET status = 'failed'`).run();
      return defaultReply(input, call);
    };
    const env = setup({ reply });
    db = env.db;
    await captureTurn(env.service, "late-run", env.project);
    const job = queuedUnitJob(env.repos);
    await expect(env.pipeline.process(job)).rejects.toThrow(/result dropped/);
    expect(env.repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("failed");
    expect(env.repos.l3Field.activeItems(projectUnitKey(env.repos))).toEqual([]);
  });

  it("lets only the run that holds the lease write: a run that outlived it leaves job and batch alone", async () => {
    let db: ReturnType<typeof setup>["db"] | undefined;
    const reply: Reply = (input, call) => {
      // While this run waits on the model its lease runs out, the job is leased again and later put back
      // in the queue by a rerun: the batch is "queued" again, but this run no longer holds the job.
      if (call === 1) db!.db.prepare(`UPDATE evolution_jobs SET status = 'queued', leased_until = NULL,
        lease_owner = NULL, lease_token = NULL WHERE job_type = 'l3_unit_update'`).run();
      return defaultReply(input, call);
    };
    const env = setup({ reply });
    db = env.db;
    await captureTurn(env.service, "lease-lost", env.project);
    env.db.db.prepare(`UPDATE memory_processing_state SET state = 'ready'`).run();
    const [job] = env.repos.runtime.leaseQueuedJobs(10, 60, undefined, false, ["l3_unit_update"]);
    expect(typeof job!.leaseToken).toBe("string");
    await expect(env.pipeline.process(job!)).rejects.toThrow(/leased again/);
    expect(env.repos.l3Field.getBatch(job!.payload.batchId as string)!.status).toBe("queued");
    expect(env.repos.l3Field.activeItems(projectUnitKey(env.repos))).toEqual([]);
    expect(env.repos.runtime.getJob(job!.id)!.status).toBe("queued");
  });

  it("drops ops citing a turn whose L1 the user deleted while the model was answering", async () => {
    let db: ReturnType<typeof setup>["db"] | undefined;
    const reply: Reply = (input, call) => {
      if (call === 1) db!.db.prepare(`UPDATE memories SET deleted_at = ?, status = 'deleted' WHERE memory_layer = 'L1'`).run(new Date().toISOString());
      return defaultReply(input, call);
    };
    const env = setup({ reply });
    db = env.db;
    await captureTurn(env.service, "deleted-l1", env.project);
    const job = queuedUnitJob(env.repos);
    await env.pipeline.process(job);
    expect(env.repos.l3Field.activeItems(projectUnitKey(env.repos))).toEqual([]);
    expect(env.repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("applied");
  });

  it("does not replace or delete an item that is already gone when the batch is written", async () => {
    let gone: string | undefined;
    let db: ReturnType<typeof setup>["db"] | undefined;
    const reply: Reply = (input) => {
      const tool = input.evidence.find((fragment) => fragment.type === "tool")!;
      const [first, second] = input.projects[0]!.items;
      // Another writer removes the first item while the model is answering.
      db!.db.prepare(`UPDATE l3_items SET status = 'inactive', inactive_at = ? WHERE id = ?`).run(new Date().toISOString(), first!.id);
      gone = first!.id;
      return { reason: "x", ops: [
        { op: "replace", ids: [first!.id], content: "改写后的规则", evidence: [tool.id] },
        { op: "delete", id: second!.id, evidence: [tool.id] }
      ] };
    };
    const env = setup({ reply });
    db = env.db;
    await captureTurn(env.service, "gone", env.project, [{ query: "看看" }]);
    const job = queuedUnitJob(env.repos);
    const unitKey = projectUnitKey(env.repos);
    for (const content of ["规则一", "规则二"]) {
      env.repos.l3Field.insertItem({ unitKey, kind: "project_constraint", content, evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2026-01-01T00:00:00.000Z" });
    }
    await env.pipeline.process(job);
    expect(env.repos.l3Field.activeItems(unitKey).map((item) => item.content)).toEqual([]);
    expect(env.repos.l3Field.getItem(gone!)!.replacedBy).toBeUndefined();
  });

  it("shows a batch what was removed on evidence newer than some of its own: late or spanning yes, behind a backlog no", async () => {
    const late = setup();
    await captureTurn(late.service, "late", late.project);
    const job = queuedUnitJob(late.repos);
    const unitKey = projectUnitKey(late.repos);
    const removed = late.repos.l3Field.insertItem({
      unitKey, kind: "project_constraint", content: "提交信息用英文", evidence: { fragmentIds: ["f"], l1MemoryIds: [] },
      evidenceAt: "2099-01-01T00:00:00.000Z"
    });
    // A newer conversation, applied while this batch sat in dead letter (or before this old history was
    // scanned), deleted the rule.
    late.repos.l3Field.inactivateItem(removed.id, { removedEvidenceAt: new Date(Date.now() + 60_000).toISOString() });
    await late.pipeline.process(job);
    expect(late.inputs[0]).toMatchObject({ removed_by_newer_evidence: [{ kind: "project_constraint", content: "提交信息用英文" }] });

    // Batches in order behind a backlog: the rule was removed on older evidence than this batch's,
    // so this batch is free to bring it back.
    const inOrder = setup();
    await captureTurn(inOrder.service, "in-order", inOrder.project);
    const olderRemoval = inOrder.repos.l3Field.insertItem({
      unitKey: projectUnitKey(inOrder.repos), kind: "project_constraint", content: "提交信息用中文",
      evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2026-01-01T00:00:00.000Z"
    });
    inOrder.repos.l3Field.inactivateItem(olderRemoval.id, { removedEvidenceAt: "2026-01-02T00:00:00.000Z", at: new Date(Date.now() + 60_000).toISOString() });
    await inOrder.pipeline.process(queuedUnitJob(inOrder.repos));
    expect(inOrder.inputs[0]).not.toHaveProperty("removed_by_newer_evidence");

    // One batch spanning the removal: its older turn must not bring the rule back, so it is shown.
    const spanning = setup();
    await captureTurn(spanning.service, "spanning", spanning.project, [{ query: "提交信息用英文" }, { query: "再跑一次测试" }]);
    const turns = spanning.db.db.prepare(`SELECT id FROM raw_turns ORDER BY created_at, id`).all() as Array<{ id: string }>;
    spanning.db.db.prepare(`UPDATE raw_turns SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(turns[0]!.id);
    const removedBetween = spanning.repos.l3Field.insertItem({
      unitKey: projectUnitKey(spanning.repos), kind: "project_constraint", content: "提交信息用英文",
      evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2025-12-01T00:00:00.000Z"
    });
    spanning.repos.l3Field.inactivateItem(removedBetween.id, { removedEvidenceAt: "2026-06-01T00:00:00.000Z" });
    await spanning.pipeline.process(queuedUnitJob(spanning.repos));
    expect(spanning.inputs[0]).toMatchObject({
      removed_by_newer_evidence: [{ content: "提交信息用英文", removed_at: "2026-06-01T00:00:00.000Z" }]
    });
  });

  it("evicts the item confirmed longest ago when a kind goes over 10", async () => {
    const { service, repos, pipeline, project } = setup();
    await captureTurn(service, "evict-seed", project, [{ query: "看看" }]);
    const seedJob = queuedUnitJob(repos);
    const unitKey = projectUnitKey(repos);
    for (let i = 0; i < 10; i += 1) {
      repos.l3Field.insertItem({
        unitKey, kind: "project_constraint", content: `规则 ${i}`,
        evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: `2026-01-${String(10 + i)}T00:00:00.000Z`
      });
    }
    await pipeline.process(seedJob);
    const constraints = repos.l3Field.activeItems(unitKey).filter((item) => item.kind === "project_constraint");
    expect(constraints).toHaveLength(10);
    expect(constraints.map((item) => item.content)).not.toContain("规则 0");
  });

  it("keeps only the first group's change when two groups change the same machine item", async () => {
    const reply: Reply = (input) => {
      const machineItem = input.machine.items[0]!;
      const tool = input.evidence.find((fragment) => fragment.type === "tool")!;
      return input.projects[0]?.name === "demo"
        ? { reason: "a", ops: [{ op: "replace", ids: [machineItem.id], content: "本机 zsh 展开 = 参数 -> 要加引号", evidence: [tool.id] }] }
        : { reason: "b", ops: [{ op: "delete", id: machineItem.id, evidence: [tool.id] }] };
    };
    const { service, repos, pipeline, project, other } = setup({ reply });
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    const old = repos.l3Field.insertItem({
      unitKey: machine.unitKey, kind: "env_fact", content: "旧的本机事实",
      evidence: { fragmentIds: ["f"], l1MemoryIds: [] }, evidenceAt: "2026-01-01T00:00:00.000Z"
    });
    await captureTurn(service, "conflict", project, [{ query: "跑一下", workdir: project }, { query: "那边也跑", workdir: other }]);
    await pipeline.process(queuedUnitJob(repos));
    const replaced = repos.l3Field.getItem(old.id)!;
    expect(replaced.status).toBe("inactive");
    expect(replaced.replacedBy).toBeTruthy();
    expect(repos.l3Field.getItem(replaced.replacedBy!)!.content).toBe("本机 zsh 展开 = 参数 -> 要加引号");
  });

  it("marks a batch done when the model changes nothing, and merges several items with one replace", async () => {
    const empty = setup({ reply: () => ({ reason: "nothing worth keeping", ops: [] }) });
    await captureTurn(empty.service, "empty", empty.project);
    const job = queuedUnitJob(empty.repos);
    await empty.pipeline.process(job);
    expect(empty.repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("applied");

    const merge = setup({
      reply: (input) => ({
        reason: "merge",
        ops: [{ op: "replace", ids: input.projects[0]!.items.map((entry) => entry.id), content: "合并后的规则", evidence: [input.evidence[0]!.id] }]
      })
    });
    await captureTurn(merge.service, "merge", merge.project);
    const unitKey = projectUnitKey(merge.repos);
    const a = merge.repos.l3Field.insertItem({ unitKey, kind: "project_constraint", content: "规则 a", evidence: { fragmentIds: [], l1MemoryIds: [] }, evidenceAt: "2026-01-01T00:00:00.000Z" });
    const b = merge.repos.l3Field.insertItem({ unitKey, kind: "project_constraint", content: "规则 b", evidence: { fragmentIds: [], l1MemoryIds: [] }, evidenceAt: "2026-01-01T00:00:00.000Z" });
    await merge.pipeline.process(queuedUnitJob(merge.repos));
    const active = merge.repos.l3Field.activeItems(unitKey);
    expect(active.map((entry) => entry.content)).toEqual(["合并后的规则"]);
    expect(merge.repos.l3Field.getItem(a.id)!.replacedBy).toBe(active[0]!.id);
    expect(merge.repos.l3Field.getItem(b.id)!.replacedBy).toBe(active[0]!.id);
  });

  it("writes the probed machine profile at session start", async () => {
    const root = fixture.createTestRoot("l3-machine-profile-");
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.l3FieldCognition.enabled = true;
    const probe = vi.fn(async () => ({
      os: "darwin", osVersion: "26.1", arch: "arm64", shell: "zsh",
      tools: { node: "22.11.0", python3: null, git: "2.50.1", npm: null, brew: null, pnpm: null, yarn: null, uv: null, conda: null, docker: null, java: null, go: null, rustc: null }
    }));
    const service = fixture.createTestMemoryService({
      db, mode: "dev", config,
      l3FieldEnvironment: () => ({ machineId: MACHINE_ID, homeDir: join(root, "home"), tempRoots: [] }),
      l3MachineProbe: probe
    });
    service.openSession({
      l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
      namespace: { source: "codex", profileId: "default", sessionKey: "probe-1", userId: "u1" }
    });
    service.openSession({
      l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
      namespace: { source: "codex", profileId: "default", sessionKey: "probe-2", userId: "u1" }
    });
    await vi.waitFor(() => {
      const machine = new Repositories(db.db).l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
      expect(machine.profileText).toContain("node 22.11.0，git 2.50.1");
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("shows later groups the machine items earlier groups of the batch added, so they are not written twice", async () => {
    const reply: Reply = (input) => {
      const tool = input.evidence.find((fragment) => fragment.type === "tool")!;
      const added = (input.machine.items as Array<{ id: string; added_in_this_batch?: boolean }>)
        .find((entry) => entry.added_in_this_batch);
      return added
        ? { reason: "already there", ops: [{ op: "confirm", id: added.id, evidence: [tool.id] }] }
        : { reason: "new", ops: [{ op: "add", unit: "machine", kind: "env_fact", content: "本机 git 会打印 xcrun_db 警告 -> 结果仍正常", evidence: [tool.id] }] };
    };
    const { service, repos, pipeline, project, other, complete, inputs } = setup({ reply });
    await captureTurn(service, "dedupe", project, [{ query: "跑一下", workdir: project }, { query: "那边也跑", workdir: other }]);
    await pipeline.process(queuedUnitJob(repos));
    const machine = repos.l3Field.ensureMachineUnit({ userId: "u1", machineId: MACHINE_ID });
    expect(repos.l3Field.activeItems(machine.unitKey).map((entry) => entry.content)).toEqual(["本机 git 会打印 xcrun_db 警告 -> 结果仍正常"]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(inputs[1]!.machine.items)).toContain("\"added_in_this_batch\":true");
  });

  it("drops old tool calls before the user's own words when the input is too long", async () => {
    const { service, repos, pipeline, project, inputs } = setup({ reply: () => ({ reason: "none", ops: [] }) });
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: pathToFileURL(project).href,
      workspaceHostId: "b".repeat(64),
      namespace: { source: "codex", profileId: "default", sessionKey: "long", userId: "u1" }
    });
    for (let index = 0; index < 20; index += 1) {
      await service.completeTurn(`long-turn-${index}`, {
        sessionId: opened.sessionId,
        query: index === 0 ? "这个项目以后提交信息都用中文写" : `继续第 ${index} 步`,
        answer: "好的",
        status: "succeeded",
        toolCalls: [{ id: `call-${index}`, name: "exec_command", input: { cmd: "npm test", workdir: project }, success: false }],
        toolResults: [{ id: `call-${index}`, name: "exec_command", output: Array.from({ length: 50 }, () => `error: ${"y".repeat(400)}`).join("\n"), exitCode: 1 }]
      });
    }
    service.closeSession(opened.sessionId);
    const job = repos.runtime.listJobs("queued", 500).find((candidate) => candidate.jobType === "l3_unit_update")!;
    vi.stubEnv("MEMMY_LOG_LEVEL", "debug");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await pipeline.process(job);
    } finally {
      vi.unstubAllEnvs();
    }
    const truncated = stdout.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("input.truncated"));
    stdout.mockRestore();
    const evidence = inputs[0]!.evidence as Array<{ type: string; text?: string }>;
    expect(evidence.filter((fragment) => fragment.type === "tool").length).toBeLessThan(20);
    expect(evidence.some((fragment) => fragment.text === "这个项目以后提交信息都用中文写")).toBe(true);
    expect(truncated).toHaveLength(1);
    expect(JSON.parse(truncated[0]!).level).toBe("debug");
    expect(truncated[0]).toContain("maxChars=65536");
    expect(truncated[0]).toContain("droppedUserTextFragments=0");
  });

  it("asks once more with a smaller input when the model rejects the input as too long", async () => {
    const sizes: number[] = [];
    const reply: Reply = (input) => {
      const size = JSON.stringify(input).length;
      sizes.push(size);
      if (size > 20_000) {
        throw new ModelHttpError("model request failed", "host", 400, undefined, "This model's maximum context length is 8192 tokens");
      }
      return { reason: "none", ops: [] };
    };
    const { service, repos, pipeline, project, complete } = setup({ reply });
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: pathToFileURL(project).href,
      workspaceHostId: "b".repeat(64),
      namespace: { source: "codex", profileId: "default", sessionKey: "too-long", userId: "u1" }
    });
    for (let index = 0; index < 20; index += 1) {
      await service.completeTurn(`too-long-turn-${index}`, {
        sessionId: opened.sessionId,
        query: `第 ${index} 步`,
        answer: "好的",
        status: "succeeded",
        toolCalls: [{ id: `call-${index}`, name: "exec_command", input: { cmd: "npm test", workdir: project }, success: false }],
        toolResults: [{ id: `call-${index}`, name: "exec_command", output: Array.from({ length: 50 }, () => `error: ${"y".repeat(400)}`).join("\n"), exitCode: 1 }]
      });
    }
    service.closeSession(opened.sessionId);
    const job = repos.runtime.listJobs("queued", 500).find((candidate) => candidate.jobType === "l3_unit_update")!;
    await pipeline.process(job);
    expect(sizes).toHaveLength(2);
    expect(sizes[1]!).toBeLessThan(20_000);
    expect(repos.l3Field.getBatch(job.payload.batchId as string)!.status).toBe("applied");
    expect(complete.mock.calls.every(([, options]) => options?.maxTokens === 16_384)).toBe(true);
  });

  it("does not let a deleted L1 whose summary never finished hold its batch back", async () => {
    const { service, repos, project } = setup();
    await captureTurn(service, "deleted-l1", project);
    const job = queuedUnitJob(repos);
    const l1 = repos.l3Field.getBatch(job.payload.batchId as string)!.l1MemoryIds[0]!;
    repos.db.prepare(
      `INSERT INTO memory_processing_state (memory_id, state, updated_at) VALUES (?, 'summary_pending', ?)
       ON CONFLICT(memory_id) DO UPDATE SET state = 'summary_pending'`
    ).run(l1, new Date().toISOString());
    repos.memories.softDelete(l1, new Date().toISOString());
    const leased = repos.runtime.leaseQueuedJobs(50, 60, undefined, false, ["l3_unit_update"]);
    expect(leased.map((entry) => entry.id)).toContain(job.id);
  });

  it("does not wake the worker for new-L3 jobs it would not lease while the switch is off", async () => {
    const { service, repos, project } = setup({ enabled: false });
    await captureTurn(service, "wake-off", project);
    const now = new Date().toISOString();
    repos.db.prepare(
      `INSERT INTO evolution_jobs (id, job_type, status, user_id, payload_json, attempts, max_attempts, created_at, updated_at)
       VALUES ('held-unit', 'l3_unit_update', 'queued', 'u1', json_object('batchId', 'x', 'runAfter', '2000-01-01T00:00:00.000Z'), 0, 6, ?, ?),
              ('held-profile', 'project_environment_profile', 'queued', 'u1',
               json_object('mode', 'l3_field', 'runAfter', '2000-01-01T00:00:00.000Z'), 0, 3, ?, ?)`
    ).run(now, now, now, now);
    repos.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE id NOT IN ('held-unit', 'held-profile')`).run();
    // Their runAfter is long past; other wake-ups (budget reconcile) may still be scheduled ahead.
    expect(service.nextWorkerRunAt() ?? Number.POSITIVE_INFINITY).toBeGreaterThan(Date.parse(now));
  });

  it("does not lease a batch while its L1 summary is pending, and leaves jobs queued while the switch is off", async () => {
    const { service, repos, project } = setup();
    await captureTurn(service, "lease", project);
    const job = queuedUnitJob(repos);
    const l1 = (repos.l3Field.getBatch(job.payload.batchId as string)!.l1MemoryIds)[0]!;
    const now = new Date().toISOString();
    repos.db.prepare(
      `INSERT INTO memory_processing_state (memory_id, state, updated_at) VALUES (?, 'summary_pending', ?)
       ON CONFLICT(memory_id) DO UPDATE SET state = 'summary_pending'`
    ).run(l1, now);
    const leasedIds = () => repos.runtime.leaseQueuedJobs(50, 60, undefined, false, ["l3_unit_update"]).map((leased) => leased.id);
    expect(leasedIds()).not.toContain(job.id);

    repos.db.prepare(`UPDATE memory_processing_state SET state = 'ready' WHERE memory_id = ?`).run(l1);
    const offLeased = repos.runtime.leaseQueuedJobs(50, 60, undefined, false, undefined, ["l3_unit_update"]);
    expect(offLeased.some((leased) => leased.jobType === "l3_unit_update")).toBe(false);
    expect(offLeased.some((leased) => leased.payload.mode === "l3_field")).toBe(false);
    expect(leasedIds()).toContain(job.id);
  });
});

describe("new L3 op validation", () => {
  const machine = unit("machine", "m");
  const demo = unit("project", "p", { displayName: "demo-app", checkoutRoot: "/Users/x/code/demo-app" });
  const fragment = (id: string, over: Partial<EvidenceFragment> = {}): EvidenceFragment => ({
    id, rawTurnId: "r", l1MemoryId: "l1", toolName: "exec_command", input: null, output: "error: boom",
    isError: true, paths: [], candidateUnitKeys: ["p"], at: "2026-10-01T00:00:00.000Z", ...over
  });
  const group: L3UpdateGroup = {
    machine,
    project: demo,
    fragments: [
      fragment("tool-p"),
      fragment("tool-other", { candidateUnitKeys: ["other"] }),
      fragment("user", { toolName: null, output: "以后都这样", isError: false })
    ],
    l1: []
  };
  const items = new Map<string, L3ItemRecord>([
    ["mi", item("mi", "m", "env_fact")],
    ["pi", item("pi", "p", "project_constraint")],
    ["pf", item("pf", "p", "env_fact")],
    ["xi", item("xi", "elsewhere", "env_fact")]
  ]);
  const problems = (ops: unknown[]) => validateL3UnitOps(ops as never, group, items).problems;

  it("rejects ids of other units, inactive ids and an id changed twice", () => {
    expect(problems([{ op: "delete", id: "xi", evidence: ["tool-p"] }])[0]).toContain("not an active item");
    expect(problems([{ op: "confirm", id: "gone", evidence: ["tool-p"] }])[0]).toContain("not an active item");
    expect(problems([
      { op: "confirm", id: "pi", evidence: ["user"] },
      { op: "delete", id: "pi", evidence: ["user"] }
    ])[0]).toContain("already changed");
  });

  it("rejects replace across units or kinds, and evidence from outside the input", () => {
    expect(problems([{ op: "replace", ids: ["mi", "pf"], content: "x", evidence: ["tool-p"] }])[0]).toContain("one unit and kind");
    expect(problems([{ op: "replace", ids: ["pi", "pf"], content: "x", evidence: ["tool-p"] }])[0]).toContain("one unit and kind");
    expect(problems([{ op: "confirm", id: "pi", evidence: ["nope"] }])[0]).toContain("not a fragment");
  });

  it("needs a tool output from this project for a project fact", () => {
    expect(problems([{ op: "add", unit: "project", kind: "env_fact", content: "x", evidence: ["tool-other"] }])[0]).toContain("touched this unit");
    expect(problems([{ op: "add", unit: "project", kind: "env_fact", content: "x", evidence: ["user"] }])[0]).toContain("touched this unit");
    expect(problems([{ op: "add", unit: "project", kind: "env_fact", content: "x", evidence: ["tool-p"] }])).toEqual([]);
    expect(problems([{ op: "add", unit: "machine", kind: "env_fact", content: "brew 无写权限", evidence: ["tool-other"] }])).toEqual([]);
  });

  it("keeps machine items about the machine only", () => {
    expect(problems([{ op: "add", unit: "machine", kind: "project_constraint", content: "x", evidence: ["user"] }])[0]).toContain("env_fact");
    expect(problems([{ op: "add", unit: "machine", kind: "env_fact", content: "/Users/x/code/demo-app 里 npm 报错", evidence: ["tool-p"] }])[0]).toContain("must not mention");
    expect(problems([{ op: "add", unit: "machine", kind: "env_fact", content: "demo-app 的测试很慢", evidence: ["tool-p"] }])[0]).toContain("must not mention");
    const goGroup = { ...group, project: { ...demo, displayName: "go", checkoutRoot: "/Users/x/go" } };
    expect(validateL3UnitOps([{ op: "add", unit: "machine", kind: "env_fact", content: "go 1.22 编译报错", evidence: ["tool-p"] }] as never, goGroup, items).problems).toEqual([]);
  });

  it("asks for unit machine when no project is listed, and rejects an unknown unit_key", () => {
    const noProject = { ...group, project: null };
    expect(validateL3UnitOps([{ op: "add", unit: "project", kind: "project_constraint", content: "x", evidence: ["user"] }] as never, noProject, items).problems[0]).toContain("unit must be machine");
    expect(problems([{ op: "add", unit: "project", unit_key: "zzz", kind: "project_constraint", content: "x", evidence: ["user"] }])[0]).toContain("not a listed project");
  });
});

function unit(kind: "machine" | "project", unitKey: string, over: Partial<L3UnitRecord> = {}): L3UnitRecord {
  return { unitKey, userId: "u1", machineId: MACHINE_ID, kind, nextSeq: 1, createdAt: "", updatedAt: "", ...over } as L3UnitRecord;
}

function item(id: string, unitKey: string, kind: L3ItemRecord["kind"]): L3ItemRecord {
  return {
    id, unitKey, kind, content: id, evidence: { fragmentIds: [], l1MemoryIds: [] },
    evidenceAt: "", lastConfirmedAt: "", status: "active", createdAt: "", updatedAt: ""
  };
}

function testLlm(complete: LlmClient["complete"]): LlmClient {
  return {
    config: {
      provider: "host", endpoint: "http://localhost/unused", model: "l3-unit-update-test", apiKey: "",
      temperature: 0, maxTokens: 4096, timeoutMs: 30_000, maxRetries: 0, malformedRetries: 0, enableThinking: false
    },
    isConfigured: () => true,
    complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "host", model: "l3-unit-update-test", configured: true, remote: false })
  };
}
