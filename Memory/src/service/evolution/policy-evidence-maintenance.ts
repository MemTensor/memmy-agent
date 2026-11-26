import { policyMetaFromMemory, skillMetaFromMemory, worldModelMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { Repositories } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";
import { namespaceIdFromMemory } from "../external-evidence-source.js";
import { enqueueJob } from "../worker/job-handlers.js";
import { l2SupportRelation } from "./l2-content-revision.js";
import { PolicyInductionEngine, type PolicyEvidenceDeps } from "./policy-induction.js";
import { SkillPipeline, type SkillPolicyDeps } from "./skill-pipeline.js";
import { traceMetaWithSource } from "./trace-meta-with-source.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaWithSource>>;
export type PolicyMaintenanceAlgorithm = Pick<MemmyConfig["algorithm"], "l2Induction" | "negativeExperience" | "skill" | "capture">;

export interface PolicyEvidencePreflightReport {
  orphanPolicyIds: string[];
  affectedWorldModelIds: string[];
  affectedSkillIds: string[];
  restorablePolicyIds: string[];
}

export interface PolicyEvidenceRecovery {
  policyEvidencePreflight: PolicyEvidencePreflightReport;
  reconciledOrphanPolicies: number;
}

export class PolicyEvidenceMaintenance {
  private readonly skills: SkillPipeline<SkillPolicyDeps>;
  private readonly policy: PolicyInductionEngine<PolicyEvidenceDeps>;

  constructor(private readonly repos: Repositories, private readonly algorithm: () => PolicyMaintenanceAlgorithm) {
    const config = { get algorithm() { return algorithm(); } };
    const deps = {
      repos, namespaceIdFromMemory, config,
      enqueueJob: (input: Parameters<typeof enqueueJob>[1]) => enqueueJob({ repos, nowIso }, input)
    };
    this.skills = new SkillPipeline<SkillPolicyDeps>(deps);
    this.policy = new PolicyInductionEngine<PolicyEvidenceDeps>({
      ...deps,
      traceMeta: memory => traceMetaWithSource(repos, memory),
      enqueueChange: change => repos.runtime.appendChange(change),
      onSkillRewardDrift: (policy, at) => this.skills.applySkillRewardDriftForPolicy(policy, at)
    });
  }

  *preview(limit: number): Generator<void, PolicyEvidencePreflightReport> {
    const report: PolicyEvidencePreflightReport = {
      orphanPolicyIds: [], restorablePolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: []
    };
    for (const id of this.repos.memories.listIds({ memoryLayer: "L2", status: "activated" }, limit)) {
      yield;
      const state = this.repos.transaction(() => this.evidenceState(id));
      if (!state) continue;
      if (!state.validTraces.length) report.orphanPolicyIds.push(id);
      else if (state.validTraces.some(trace => !state.linkedTraceIds.has(trace.id))) report.restorablePolicyIds.push(id);
    }
    const orphanIds = new Set(report.orphanPolicyIds);
    if (orphanIds.size) {
      for (const layer of ["L3", "Skill"] as const) {
        const ids = this.repos.memories.listIds({ memoryLayer: layer, status: ["activated", "resolving"] }, limit);
        for (let offset = 0; offset < ids.length; offset += 32) {
          yield;
          for (const memory of this.repos.memories.getMany(ids.slice(offset, offset + 32))) {
            if (layer === "L3" && worldModelMetaFromMemory(memory)?.policyIds.some(id => orphanIds.has(id))) {
              report.affectedWorldModelIds.push(memory.id);
            } else if (layer === "Skill" && skillMetaFromMemory(memory)?.sourcePolicyIds.some(id => orphanIds.has(id))) {
              report.affectedSkillIds.push(memory.id);
            }
          }
        }
      }
    }
    report.orphanPolicyIds.sort();
    report.affectedWorldModelIds.sort();
    report.affectedSkillIds.sort();
    report.restorablePolicyIds.sort();
    return report;
  }

  *repair(at: string, report: PolicyEvidencePreflightReport, limit: number, enabled = () => true): Generator<void, number> {
    let reconciled = 0;
    const candidates = new Set([...report.orphanPolicyIds, ...report.restorablePolicyIds]);
    if (!candidates.size) return 0;
    for (const id of this.repos.memories.listIds({ memoryLayer: "L2", status: "activated" }, limit)) {
      if (!candidates.has(id)) continue;
      yield;
      if (!enabled()) break;
      // Evidence can change after preflight. Re-read inside the same transaction as all dependent writes.
      if (this.repos.transaction(() => this.repairPolicy(id, at))) reconciled++;
    }
    return reconciled;
  }

  *steps(at: string, limit: number, enabled = () => true): Generator<void, PolicyEvidenceRecovery> {
    const policyEvidencePreflight = yield* this.preview(limit);
    const reconciledOrphanPolicies = yield* this.repair(at, policyEvidencePreflight, limit, enabled);
    return { policyEvidencePreflight, reconciledOrphanPolicies };
  }

  private evidenceState(id: string) {
    const memory = this.repos.memories.get(id);
    if (!memory || memory.memoryLayer !== "L2" || memory.status !== "activated" || memory.deletedAt) return;
    const policy = policyMetaFromMemory(memory);
    if (policy?.status !== "active") return;
    const unifiedEvidence = this.algorithm().l2Induction.mode === "unified" || policy.schemaVersion === 2;
    const linkedTraceIds = new Set(this.repos.runtime.listTracePolicyLinks({
      l2MemoryId: policy.id,
      limit: 1000
    }).filter((link) => !unifiedEvidence || link.relation === l2SupportRelation(memory)).map((link) => link.l1MemoryId));
    const candidateTraceIds = Array.from(new Set([
      ...policy.sourceTraceIds,
      ...linkedTraceIds
    ]));
    const validTraces = this.repos.memories
      .getMany(candidateTraceIds)
      .map((candidate) => traceMetaWithSource(this.repos, candidate))
      .filter((trace): trace is TraceMeta => Boolean(
        trace && (unifiedEvidence
          ? trace.userId === memory.userId && this.policy.isPolicyEvidenceValid(trace, policy)
          : this.policy.isTraceEligibleForL2(trace))
      ));
    return { memory, policy, linkedTraceIds, validTraces };
  }

  private repairPolicy(id: string, at: string): boolean {
    const state = this.evidenceState(id);
    if (!state) return false;
    const { memory, policy, linkedTraceIds, validTraces } = state;
    if (validTraces.length === 0) {
      const updated = this.policy.recomputePolicyStats(policy.id, at);
      if (updated && policyMetaFromMemory(updated)?.status !== "active") {
        this.skills.invalidatePolicySource(policy.id, at);
        return true;
      }
      return false;
    }

    let restored = false;
    for (const trace of validTraces) {
      if (linkedTraceIds.has(trace.id)) continue;
      this.repos.runtime.insertTracePolicyLink({
        userId: memory.userId,
        l1MemoryId: trace.id,
        l2MemoryId: policy.id,
        relation: l2SupportRelation(memory),
        strength: 1,
        createdAt: at
      });
      restored = true;
    }
    if (!restored) return false;
    this.repos.runtime.appendChange({
      memoryId: memory.id,
      namespaceId: namespaceIdFromMemory(memory),
      kind: "policy",
      op: "updated",
      entityId: memory.id,
      userId: memory.userId,
      changeType: "policy_evidence_links_restored",
      before: { linkedTraceIds: Array.from(linkedTraceIds) },
      after: { linkedTraceIds: validTraces.map((trace) => trace.id) },
      source: "startup.policy_evidence_reconciliation",
      createdAt: at
    });
    return true;
  }
}
