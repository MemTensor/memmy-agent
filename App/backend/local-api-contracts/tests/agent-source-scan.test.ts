import { expect, it } from "vitest";
import { AgentSkillReconcileInputSchema, MemoryAgentSourceScanStateSchema, AgentSourceScanProgressPayloadSchema, AgentSourceScanJobResponseSchema, ScanCompletedSseEventSchema, AgentSourceScanControlResponseSchema, MemoryScanControlResponseSchema, AgentSourceScanInputSchema } from "../src/index.js";

it.each(["discover", "read", "redact", "emit", "scan", "prepare", "add", "summarize", "done", "stopped"])("accepts Memory phase %s without expanding desktop phases", (phase) => {
  expect(MemoryAgentSourceScanStateSchema.parse({ running: true, jobId: "job", attemptId: "round", sourceId: "codex", mode: "full",
    startedAt: null, completedAt: null, error: null, progress: { phase, sourceId: "codex", current: 1, total: 2 } }).progress?.phase).toBe(phase);
  if (["discover", "read", "redact", "emit", "prepare"].includes(phase)) {
    expect(AgentSourceScanProgressPayloadSchema.safeParse({ jobId: "job", phase, sourceId: "codex", current: 1, total: 2 }).success).toBe(false);
  }
});
it("keeps optional attempt identity and authoritative outcome while accepting old peers", () => {
  expect(AgentSourceScanJobResponseSchema.parse({ jobId: "job" })).toEqual({ jobId: "job" });
  const payload = { jobId: "job", attemptId: "retry", succeeded: false, results: [], sourceId: "all" };
  expect(ScanCompletedSseEventSchema.parse({ id: "event", type: "agent_source.scan_completed", timestamp: new Date().toISOString(), payload }).payload).toEqual(payload);
});

it("retains ordered terminal snapshots across both control boundaries", () => {
  const version = { generation: 4, sequence: 12 };
  const execution = { jobId: "job", attemptId: "attempt", attemptStartedAt: "2026-10-21" };
  const desktop = { ok: true, outcome: "conflict", snapshot: { version, status: "cancelled", execution, active: false, progress: null } };
  expect(AgentSourceScanControlResponseSchema.parse(desktop)).toEqual(desktop);
  const memory = { ok: true, outcome: "applied", snapshot: { version, status: "cancelled", jobId: execution.jobId, attemptId: execution.attemptId, running: false, sourceId: "all", mode: null, progress: null, startedAt: null, completedAt: null, error: null } };
  expect(MemoryScanControlResponseSchema.parse(memory)).toEqual(memory);
  const input = { sourceId: "all", expectedVersion: version, expectedExecution: { jobId: "job", attemptId: "attempt" } };
  expect(AgentSourceScanInputSchema.parse(input)).toEqual(input);
});

it("retains unknown invocation metadata and explicit source connection events", () => {
  const input = { sourceAgentId: "codex", complete: false, connectionState: "disconnected", disconnected: true,
    skills: [{ sourceSkillId: "private", sourceSkillPath: "/isolated/private/SKILL.md", title: "private",
      content: "Body", contentHash: "hash", modifiedAt: "2026-11-04T00:00:00.000Z",
      policyError: "permission denied", frontmatterError: "unclosed frontmatter" }] };
  expect(AgentSkillReconcileInputSchema.parse(input)).toEqual(input);
});

it("preserves empty content in mixed reconciliation batches and rejects non-string content", () => {
  const skill = { sourceSkillId: "empty", sourceSkillPath: "/isolated/empty/SKILL.md", title: "empty",
    content: "", contentHash: "empty-hash", modifiedAt: "2026-11-04T00:00:00.000Z" };
  const input = { sourceAgentId: "hermes", complete: true, skills: [skill, { ...skill, sourceSkillId: "regular", content: "Body" }] };
  expect(AgentSkillReconcileInputSchema.parse(input)).toEqual(input);
  for (const content of [undefined, null, 42, {}, []]) {
    expect(AgentSkillReconcileInputSchema.safeParse({ ...input, skills: [{ ...skill, content }] }).success).toBe(false);
  }
});
