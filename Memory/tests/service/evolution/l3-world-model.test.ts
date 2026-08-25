import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import type { MemoryService } from "../../../src/service/memory-service.js";
import {
  isTerminalL3WorldModelError,
  L3WorldModelTraceFieldPipeline
} from "../../../src/service/evolution/l3-world-model-pipeline.js";
import {
  completeStrictJson
} from "../../../src/service/l3-world-model/strict-json-completion.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("L3 World Model trace field pipeline", () => {
  it("updates project contract and domain knowledge independently from one immutable batch", async () => {
    const llm = fieldLlm();
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      workspaceUri: "file:///tmp/l3-world-model-project",
      workspaceHostId: "a".repeat(64),
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "l3-world-model-project-session",
        userId: "l3-world-model-user"
      }
    });
    const completed = service.completeTurn("l3-world-model-turn", {
      sessionId: opened.sessionId,
      query: "这个项目必须先运行测试；在 Alpine 中加载 glibc wheel 失败了。",
      answer: "已记录测试约束和 Alpine 动态链接错误。",
      reasoningSummary: "PRIVATE_REASONING_TOP",
      status: "succeeded",
      toolCalls: [{
        id: "call-1",
        name: "exec",
        input: { command: "npm test" },
        success: false,
        thinkingBefore: "PRIVATE_REASONING_TOOL",
        assistantTextBefore: "VISIBLE_ASSISTANT_PROGRESS"
      }],
      toolResults: [{ name: "exec", output: "dynamic linker error", exitCode: 1 }]
    });
    service.closeSession(opened.sessionId);

    const repos = new Repositories(db.db);
    const captured = repos.runtime.getRawTurn(completed.rawTurnId)!;
    const capturedToolCall = captured.toolCalls[0] as Record<string, unknown>;
    db.db.prepare(`UPDATE raw_turns SET tool_calls_json = ? WHERE id = ?`).run(
      JSON.stringify([{
        ...capturedToolCall,
        thinking_before: "PRIVATE_REASONING_TOOL_LEGACY"
      }]),
      completed.rawTurnId
    );
    const persisted = repos.runtime.getRawTurn(completed.rawTurnId)!;
    expect(persisted.reasoningSummary).toBe("PRIVATE_REASONING_TOP");
    expect(persisted.toolCalls[0]).toEqual(expect.objectContaining({
      thinkingBefore: "PRIVATE_REASONING_TOOL",
      thinking_before: "PRIVATE_REASONING_TOOL_LEGACY",
      assistantTextBefore: "VISIBLE_ASSISTANT_PROGRESS"
    }));

    const jobs = (db.db.prepare(
      `SELECT id FROM evolution_jobs
       WHERE job_type = 'l3_world_model_update'
       ORDER BY json_extract(payload_json, '$.targetField')`
    ).all() as Array<{ id: string }>)
      .map(({ id }) => repos.runtime.getJob(id))
      .filter((job): job is NonNullable<typeof job> => Boolean(job));
    const pipeline = new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm });
    await Promise.all(jobs.map((job) => pipeline.updateField(job)));
    jobs.forEach((job) => repos.runtime.completeJob(job.id));

    expect(repos.l3WorldModels.fields("l3-world-model-user", opened.projectId)).toEqual({
      generalRulesAndSafetyConstraints: null,
      projectEnvironmentProfile: null,
      projectContract: "- 提交前必须运行项目测试。",
      domainKnowledge: "- Alpine 使用 musl libc -> 加载依赖 glibc 的 wheel 会产生动态链接错误。"
    });
    expect(db.db.prepare(
      `SELECT target_field, status, no_change
       FROM l3_world_model_batch_targets ORDER BY target_field`
    ).all()).toEqual([
      { target_field: "domain_knowledge", status: "applied", no_change: 0 },
      { target_field: "project_contract", status: "applied", no_change: 0 }
    ]);
    expect(db.db.prepare(
      `SELECT terminal_outcome FROM l3_world_model_evidence_batches`
    ).get()).toEqual({ terminal_outcome: "applied" });
    expect(repos.l3WorldModels.getMemory("l3-world-model-user", opened.projectId)?.memoryValue)
      .not.toContain("DECISION_REASON_NOT_STORED");
    const calls = vi.mocked(llm.complete).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [messages, options] of calls) {
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toContain("valid JSON object");
      if (messages[0]?.content.includes("Project Contract")) {
        expect(messages[0].content).toContain("may be retained after a single statement");
        expect(messages[0].content).toContain("Do not require repetition, a previous violation");
        expect(messages[0].content).toContain("can reasonably apply to later tasks in this project");
        expect(messages[0].content).toContain("collaboration and delivery conventions");
        expect(messages[0].content).toContain("when a table can explain the result clearly, use a table");
        expect(messages[0].content).toContain("already belongs to the current project Session");
        expect(messages[0].content).toContain("scoped to the current project by default");
        expect(messages[0].content).toContain('Phrases such as "以后", "后续", "以后也是"');
        expect(messages[0].content).toContain('provide a brief, concrete "reason"');
        expect(messages[0].content).toContain("it is not part of the Project Contract and will not be stored");
      }
      expect(messages[1]?.role).toBe("user");
      expect(JSON.parse(messages[1]!.content)).toEqual(expect.objectContaining({
        current_field: "",
        project_environment_profile: "",
        raw_turns: expect.any(Array)
      }));
      const input = JSON.parse(messages[1]!.content) as {
        raw_turns: Array<Record<string, unknown>>;
      };
      const rawTurn = input.raw_turns[0]!;
      expect(Object.keys(rawTurn).sort()).toEqual([
        "assistant_text",
        "feedback",
        "raw_turn_id",
        "status",
        "tool_calls",
        "tool_results",
        "user_text"
      ]);
      expect(rawTurn).toEqual(expect.objectContaining({
        raw_turn_id: completed.rawTurnId,
        status: "succeeded",
        user_text: "这个项目必须先运行测试；在 Alpine 中加载 glibc wheel 失败了。",
        assistant_text: "已记录测试约束和 Alpine 动态链接错误。",
        feedback: []
      }));
      const toolCall = (rawTurn.tool_calls as Array<Record<string, unknown>>)[0]!;
      expect(toolCall).toEqual(expect.objectContaining({
        id: "call-1",
        name: "exec",
        input: { command: "npm test" },
        output: "dynamic linker error",
        success: false,
        assistantTextBefore: "VISIBLE_ASSISTANT_PROGRESS"
      }));
      expect(toolCall).not.toHaveProperty("thinkingBefore");
      expect(toolCall).not.toHaveProperty("thinking_before");
      expect(options).toEqual(expect.objectContaining({
        temperature: 0,
        maxTokens: 65_536,
        jsonMode: true
      }));
    }

    db.close();
  });

  it("removes reasoning from no-project generation and repair input", async () => {
    const complete = vi.fn<LlmClient["complete"]>()
      .mockResolvedValueOnce("{}")
      .mockResolvedValueOnce(JSON.stringify({
        op: "create",
        general_rules_and_safety_constraints: "- Ask before destructive actions."
      }));
    const llm = strictCompletionLlm(complete);
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "l3-world-model-repair-session",
        userId: "l3-world-model-repair-user"
      }
    });
    service.completeTurn("l3-world-model-repair-turn", {
      sessionId: opened.sessionId,
      query: "Always ask before destructive actions.",
      answer: "Understood.",
      reasoningSummary: "PRIVATE_REPAIR_REASONING_TOP",
      status: "succeeded",
      toolCalls: [{
        name: "delete_file",
        input: { path: "important.txt" },
        thinkingBefore: "PRIVATE_REPAIR_REASONING_TOOL",
        assistantTextBefore: "VISIBLE_REPAIR_PROGRESS"
      }],
      toolResults: [{ name: "delete_file", output: "confirmation required", exitCode: 1 }]
    });
    service.closeSession(opened.sessionId);

    const repos = new Repositories(db.db);
    const job = repos.runtime.listJobs("queued", 100).find(
      (candidate) => candidate.jobType === "l3_world_model_update" &&
        candidate.payload.targetField === "general_rules_and_safety_constraints"
    )!;
    await new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm }).updateField(job);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]?.[0]?.content).toContain("valid JSON object");
    const firstInput = JSON.parse(complete.mock.calls[0]![0][1]!.content) as {
      raw_turns: Array<Record<string, unknown>>;
    };
    const repairEnvelope = JSON.parse(complete.mock.calls[1]![0][1]!.content) as {
      original_input: { raw_turns: Array<Record<string, unknown>> };
    };
    for (const input of [firstInput, repairEnvelope.original_input]) {
      const rawTurn = input.raw_turns[0]!;
      expect(rawTurn).not.toHaveProperty("reasoning_summary");
      expect(rawTurn).toEqual(expect.objectContaining({
        user_text: "Always ask before destructive actions.",
        assistant_text: "Understood."
      }));
      const toolCall = (rawTurn.tool_calls as Array<Record<string, unknown>>)[0]!;
      expect(toolCall).not.toHaveProperty("thinkingBefore");
      expect(toolCall).not.toHaveProperty("thinking_before");
      expect(toolCall).toEqual(expect.objectContaining({
        name: "delete_file",
        input: { path: "important.txt" },
        output: "confirmation required",
        assistantTextBefore: "VISIBLE_REPAIR_PROGRESS"
      }));
    }
    expect(complete.mock.calls[0]![0][1]!.content).not.toContain("PRIVATE_REPAIR_REASONING");
    expect(complete.mock.calls[1]![0][1]!.content).not.toContain("PRIVATE_REPAIR_REASONING");
    expect(repos.l3WorldModels.fields(
      "l3-world-model-repair-user",
      null
    ).generalRulesAndSafetyConstraints).toBe("- Ask before destructive actions.");

    db.close();
  });

  it("applies no-change without calling the model after all RawTurns are redacted", async () => {
    const llm = fieldLlm();
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "resume_only",
      namespace: {
        source: "codex",
        profileId: "default",
        sessionKey: "l3-world-model-general-session",
        userId: "l3-world-model-general-user"
      }
    });
    const completed = service.completeTurn("l3-world-model-general-turn", {
      sessionId: opened.sessionId,
      query: "Never delete files without confirmation.",
      answer: "Understood.",
      toolCalls: [{ name: "delete_file", input: { path: "important.txt" } }],
      toolResults: [{ name: "delete_file", output: "confirmation required", exitCode: 1 }]
    });
    service.closeSession(opened.sessionId);
    db.db.prepare(`UPDATE raw_turns SET redacted_at = ? WHERE id = ?`)
      .run("2026-01-01T00:00:00.000Z", completed.rawTurnId);

    const repos = new Repositories(db.db);
    const row = db.db.prepare(
      `SELECT id FROM evolution_jobs WHERE job_type = 'l3_world_model_update'`
    ).get() as { id: string };
    const job = repos.runtime.getJob(row.id)!;
    await new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm }).updateField(job);

    expect(llm.complete).not.toHaveBeenCalled();
    expect(db.db.prepare(
      `SELECT status, no_change FROM l3_world_model_batch_targets`
    ).get()).toEqual({ status: "applied", no_change: 1 });
    expect(repos.l3WorldModels.getMemory("l3-world-model-general-user", null)).toBeUndefined();

    db.close();
  });

  it("archives a cleared record and later reactivates the same scoped Memory", async () => {
    const complete = vi.fn<LlmClient["complete"]>()
      .mockResolvedValueOnce(JSON.stringify({
        op: "create",
        general_rules_and_safety_constraints: "- Ask before destructive actions."
      }))
      .mockResolvedValueOnce(JSON.stringify({
        op: "update",
        general_rules_and_safety_constraints: ""
      }))
      .mockResolvedValueOnce(JSON.stringify({
        op: "create",
        general_rules_and_safety_constraints: "- Confirm irreversible operations."
      }));
    const llm = strictCompletionLlm(complete);
    const { db, service } = createTestService({ skillLlm: llm });
    const repos = new Repositories(db.db);

    await captureAndApplyGeneral(service, repos, llm, "general-reactivate-user", "one");
    const created = repos.l3WorldModels.getMemory("general-reactivate-user", null)!;
    expect(created.status).toBe("activated");

    await captureAndApplyGeneral(service, repos, llm, "general-reactivate-user", "two");
    const archived = repos.l3WorldModels.getMemory("general-reactivate-user", null)!;
    expect(archived.id).toBe(created.id);
    expect(archived.status).toBe("archived");
    expect(archived.memoryValue).toBe("");

    await captureAndApplyGeneral(service, repos, llm, "general-reactivate-user", "three");
    const reactivated = repos.l3WorldModels.getMemory("general-reactivate-user", null)!;
    expect(reactivated.id).toBe(created.id);
    expect(reactivated.status).toBe("activated");
    expect(reactivated.memoryValue).toContain("Confirm irreversible operations");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls.map((call) => call[1]?.maxTokens)).toEqual([65_536, 65_536, 65_536]);

    db.close();
  });

  it("keeps source IDs in evidence order and caps them at the latest 256 across opposite field completion orders", async () => {
    const complete = vi.fn<LlmClient["complete"]>(async (messages) => {
      const system = messages[0]?.content ?? "";
      const input = JSON.parse(messages[1]!.content) as {
        current_field: string;
        raw_turns: Array<{ raw_turn_id: string }>;
      };
      const field = system.includes("Project Contract") ? "project_contract" : "domain_knowledge";
      return JSON.stringify({
        ...(field === "project_contract"
          ? { reason: "The latest reusable project rule determines the contract." }
          : {}),
        op: input.current_field ? "update" : "create",
        [field]: `${field}:${input.raw_turns.at(-1)!.raw_turn_id}`
      });
    });
    const llm = strictCompletionLlm(complete);
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = openProject(service, "source-order-user", "source-order-session");
    for (let index = 0; index < 257; index += 1) {
      service.completeTurn(`source-order-turn-${index}`, {
        sessionId: opened.sessionId,
        query: `Requirement ${index}`,
        answer: `Observed result ${index}`,
        status: "succeeded"
      });
    }
    service.closeSession(opened.sessionId);

    const repos = new Repositories(db.db);
    const jobs = repos.runtime.listJobs("queued", 1_000)
      .filter((job) => job.jobType === "l3_world_model_update");
    const contractJobs = jobs
      .filter((job) => job.payload.targetField === "project_contract")
      .sort((left, right) => (right.scopeSeq ?? 0) - (left.scopeSeq ?? 0));
    const knowledgeJobs = jobs
      .filter((job) => job.payload.targetField === "domain_knowledge")
      .sort((left, right) => (left.scopeSeq ?? 0) - (right.scopeSeq ?? 0));
    const pipeline = new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm });
    for (const job of contractJobs) await pipeline.updateField(job);
    for (const job of knowledgeJobs) await pipeline.updateField(job);

    const traceIds = (db.db.prepare(
      `SELECT l1_memory_id FROM l3_world_model_input_traces
       WHERE session_id = ? ORDER BY trace_seq ASC`
    ).all(opened.sessionId) as Array<{ l1_memory_id: string }>).map((row) => row.l1_memory_id);
    const memory = repos.l3WorldModels.getMemory("source-order-user", opened.projectId)!;
    expect(memory.properties.internal_info.source_memory_ids).toEqual(traceIds.slice(-256));
    expect(memory.info.source_memory_ids).toEqual(traceIds.slice(-256));
    expect(traceIds).toHaveLength(257);

    db.close();
  }, 20_000);

  it.each(["owner field", "read-only profile"] as const)(
    "rejects a stale %s result and reruns from the same immutable batch",
    async (changedBase) => {
      let release: ((value: string) => void) | undefined;
      const complete = vi.fn<LlmClient["complete"]>(() => new Promise((resolve) => {
        release = resolve;
      }));
      const firstLlm = strictCompletionLlm(complete);
      const { db, service } = createTestService({ skillLlm: firstLlm });
      const opened = openProject(service, `stale-${changedBase}`, `stale-${changedBase}-session`);
      const repos = new Repositories(db.db);
      repos.l3WorldModels.upsertField({
        userId: `stale-${changedBase}`,
        projectId: opened.projectId,
        targetField: "project_environment_profile",
        value: "profile-v1"
      });
      if (changedBase === "owner field") {
        repos.l3WorldModels.upsertField({
          userId: `stale-${changedBase}`,
          projectId: opened.projectId,
          targetField: "project_contract",
          value: "contract-v1"
        });
      }
      service.completeTurn(`stale-${changedBase}-turn`, {
        sessionId: opened.sessionId,
        query: "Keep the confirmed project boundary.",
        answer: "The boundary was checked.",
        status: "succeeded"
      });
      service.closeSession(opened.sessionId);
      const job = repos.runtime.listJobs("queued", 100).find(
        (candidate) => candidate.jobType === "l3_world_model_update" &&
          candidate.payload.targetField === "project_contract"
      )!;
      const pending = new L3WorldModelTraceFieldPipeline({ repos, skillLlm: firstLlm }).updateField(job);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

      repos.l3WorldModels.upsertField({
        userId: `stale-${changedBase}`,
        projectId: opened.projectId,
        targetField: changedBase === "owner field" ? "project_contract" : "project_environment_profile",
        value: changedBase === "owner field" ? "concurrent-contract" : "profile-v2"
      });
      release!(JSON.stringify({
        reason: "The project rule changes the current contract.",
        op: changedBase === "owner field" ? "update" : "create",
        project_contract: "stale-result"
      }));
      await expect(pending).rejects.toThrow("stale_l3_base");
      expect(repos.l3WorldModels.getTarget(
        String(job.payload.batchId),
        "project_contract"
      )?.status).toBe("queued");

      const retryComplete = vi.fn<LlmClient["complete"]>().mockResolvedValue(JSON.stringify({
        reason: "The latest project rule must be retained.",
        op: changedBase === "owner field" ? "update" : "create",
        project_contract: "retry-final"
      }));
      await new L3WorldModelTraceFieldPipeline({
        repos,
        skillLlm: strictCompletionLlm(retryComplete)
      }).updateField(job);
      const retryInput = JSON.parse(retryComplete.mock.calls[0]![0][1]!.content);
      expect(retryInput.project_environment_profile).toBe(
        changedBase === "read-only profile" ? "profile-v2" : "profile-v1"
      );
      expect(retryInput.current_field).toBe(
        changedBase === "owner field" ? "concurrent-contract" : ""
      );
      expect(repos.l3WorldModels.fields(`stale-${changedBase}`, opened.projectId).projectContract)
        .toBe("retry-final");

      db.close();
    }
  );

  it("rejects unknown output fields after one repair and leaves the target queued", async () => {
    const complete = vi.fn<LlmClient["complete"]>().mockResolvedValue(JSON.stringify({
      reason: "A reusable project constraint was found.",
      op: "create",
      project_contract: "valid-looking content",
      domain_knowledge: "not owned by this target"
    }));
    const llm = strictCompletionLlm(complete);
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = openProject(service, "invalid-output-user", "invalid-output-session");
    service.completeTurn("invalid-output-turn", {
      sessionId: opened.sessionId,
      query: "Follow this project constraint.",
      answer: "Acknowledged.",
      status: "succeeded"
    });
    service.closeSession(opened.sessionId);
    const repos = new Repositories(db.db);
    const job = repos.runtime.listJobs("queued", 100).find(
      (candidate) => candidate.jobType === "l3_world_model_update" &&
        candidate.payload.targetField === "project_contract"
    )!;
    await expect(new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm }).updateField(job))
      .rejects.toThrow("exactly op, project_contract, reason");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(repos.l3WorldModels.getTarget(String(job.payload.batchId), "project_contract")?.status)
      .toBe("queued");
    db.close();
  });

  it("requires a non-empty project contract reason", async () => {
    const complete = vi.fn<LlmClient["complete"]>().mockResolvedValue(JSON.stringify({
      reason: "",
      op: "create",
      project_contract: "Keep the reusable project rule."
    }));
    const llm = strictCompletionLlm(complete);
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = openProject(service, "missing-reason-user", "missing-reason-session");
    service.completeTurn("missing-reason-turn", {
      sessionId: opened.sessionId,
      query: "Follow this project constraint.",
      answer: "Acknowledged.",
      status: "succeeded"
    });
    service.closeSession(opened.sessionId);
    const repos = new Repositories(db.db);
    const job = repos.runtime.listJobs("queued", 100).find(
      (candidate) => candidate.jobType === "l3_world_model_update" &&
        candidate.payload.targetField === "project_contract"
    )!;

    await expect(new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm }).updateField(job))
      .rejects.toThrow("project contract reason must be a non-empty string");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(repos.l3WorldModels.getTarget(String(job.payload.batchId), "project_contract")?.status)
      .toBe("queued");
    db.close();
  });

  it("treats cross-scope RawTurn evidence as terminal and never calls the model", async () => {
    const llm = fieldLlm();
    const { db, service } = createTestService({ skillLlm: llm });
    const opened = openProject(service, "terminal-user", "terminal-session");
    const completed = service.completeTurn("terminal-turn", {
      sessionId: opened.sessionId,
      query: "Record a project rule.",
      answer: "Recorded.",
      status: "succeeded"
    });
    service.closeSession(opened.sessionId);
    db.db.prepare(`UPDATE raw_turns SET user_id = 'another-user' WHERE id = ?`)
      .run(completed.rawTurnId);
    const repos = new Repositories(db.db);
    const job = repos.runtime.listJobs("queued", 100).find(
      (candidate) => candidate.jobType === "l3_world_model_update"
    )!;
    const error = await new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm })
      .updateField(job).then(() => null, (caught: unknown) => caught);
    expect(isTerminalL3WorldModelError(error)).toBe(true);
    expect(llm.complete).not.toHaveBeenCalled();
    db.close();
  });
});

describe("strict L3 World Model JSON completion", () => {
  it("uses a fixed system message and canonical JSON user input", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"noop","value":""}');
    const largeInput = "x".repeat(200_001);
    const result = await completeStrictJson({
      llm: strictCompletionLlm(complete),
      operation: "l3_world_model.general",
      systemPrompt: "fixed prompt",
      dynamicInput: { z: 1, a: "two", blob: largeInput },
      expectedSchema: { op: "noop|create|update", value: "string" },
      validate: validateStrictOutput
    });

    expect(result).toEqual({ op: "noop", value: "" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]?.[0]).toEqual({ role: "system", content: "fixed prompt" });
    expect(JSON.parse(complete.mock.calls[0]![0][1]!.content)).toEqual({
      a: "two",
      blob: largeInput,
      z: 1
    });
    expect(complete.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      temperature: 0,
      maxTokens: 65_536,
      jsonMode: true
    }));
  });

  it("allows exactly one strict repair without using completeJson", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("```json\n{}\n```")
      .mockResolvedValueOnce('{"op":"create","value":"规则"}');
    const llm = strictCompletionLlm(complete);
    const result = await completeStrictJson({
      llm,
      operation: "l3_world_model.general",
      systemPrompt: "fixed prompt",
      dynamicInput: { current_field: "" },
      expectedSchema: { op: "noop|create|update", value: "string" },
      validate: validateStrictOutput
    });

    expect(result).toEqual({ op: "create", value: "规则" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ maxTokens: 65_536 }));
    expect(complete.mock.calls[1]?.[0]?.[0]?.content).toContain("exactly matches the expected JSON schema");
    expect(complete.mock.calls[1]?.[0]?.[1]?.content).toContain("candidate_output");
    expect(llm.completeJson).not.toHaveBeenCalled();
  });

  it("fails after one invalid repair", async () => {
    const complete = vi.fn().mockResolvedValue("{}");
    await expect(completeStrictJson({
      llm: strictCompletionLlm(complete),
      operation: "l3_world_model.general",
      systemPrompt: "fixed prompt",
      dynamicInput: {},
      expectedSchema: { op: "noop|create|update", value: "string" },
      validate: validateStrictOutput
    })).rejects.toThrow("exactly op and value");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

function fieldLlm(): LlmClient {
  const complete = vi.fn<LlmClient["complete"]>(async (messages) => {
    const system = messages[0]?.content ?? "";
    if (system.includes("Project Contract")) {
      return JSON.stringify({
        reason: "DECISION_REASON_NOT_STORED: 用户提出了可复用的项目测试规则。",
        op: "create",
        project_contract: "- 提交前必须运行项目测试。"
      });
    }
    if (system.includes("Domain Knowledge")) {
      return JSON.stringify({
        op: "create",
        domain_knowledge: "- Alpine 使用 musl libc -> 加载依赖 glibc 的 wheel 会产生动态链接错误。"
      });
    }
    return JSON.stringify({
      op: "create",
      general_rules_and_safety_constraints: "- Never delete files without confirmation."
    });
  });
  return {
    config: {
      provider: "host",
      endpoint: "http://localhost/unused",
      model: "l3-world-model-test",
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
    status: () => ({ provider: "host", model: "test", configured: true, remote: false })
  };
}

function validateStrictOutput(value: unknown): { op: string; value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("output must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "op,value") {
    throw new TypeError("output must contain exactly op and value");
  }
  if (typeof record.op !== "string" || typeof record.value !== "string") {
    throw new TypeError("op and value must be strings");
  }
  return { op: record.op, value: record.value };
}

function strictCompletionLlm(complete: LlmClient["complete"]): LlmClient {
  return {
    config: {} as LlmClient["config"],
    isConfigured: () => true,
    complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "test", configured: true, remote: false })
  };
}

function openProject(service: MemoryService, userId: string, sessionKey: string) {
  return service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    workspaceUri: `file:///tmp/${encodeURIComponent(sessionKey)}`,
    workspaceHostId: "b".repeat(64),
    namespace: {
      source: "codex",
      profileId: "default",
      sessionKey,
      userId
    }
  });
}

async function captureAndApplyGeneral(
  service: MemoryService,
  repos: Repositories,
  llm: LlmClient,
  userId: string,
  suffix: string
): Promise<void> {
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "resume_only",
    namespace: {
      source: "codex",
      profileId: "default",
      sessionKey: `general-reactivate-${suffix}`,
      userId
    }
  });
  service.completeTurn(`general-reactivate-turn-${suffix}`, {
    sessionId: opened.sessionId,
    query: `General safety evidence ${suffix}`,
    answer: `Observed result ${suffix}`,
    status: "succeeded"
  });
  service.closeSession(opened.sessionId);
  const job = repos.runtime.listJobs("queued", 100).find(
    (candidate) => candidate.jobType === "l3_world_model_update"
  );
  if (!job) throw new Error("expected queued L3 World Model job");
  await new L3WorldModelTraceFieldPipeline({ repos, skillLlm: llm }).updateField(job);
  repos.runtime.completeJob(job.id);
}
