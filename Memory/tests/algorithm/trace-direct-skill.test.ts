import { describe, expect, it } from "vitest";
import {
  canJoinCluster,
  classifySkillOutcome,
  clusterHasUsableSkill,
  decideClusterAssignment,
  clipSkillGuide,
  decideEvolveBranch,
  extractArtifactTypes,
  extractEpisodeSkillFeatures,
  coerceDirectSkillProcedure,
  MAX_DIRECT_SKILL_ANTI_PATTERN,
  MAX_DIRECT_SKILL_PRECONDITIONS,
  mergeProcedureByScope,
  packRawTurnEvidence,
  selectTop6Members,
  verifyDirectSkillDraft,
  type DirectSkillProcedureJson
} from "../../src/algorithm/trace-direct-skill.js";

const thresholds = { success: 0.5, failure: -0.15 };

function episodeFeatures(overrides: {
  episodeId?: string;
  userId?: string;
  tools?: string[];
  artifacts?: string[];
  toolBigrams?: string[];
  queryText?: string;
  queryVec?: number[] | null;
  outcome?: "success" | "failure" | "unknown";
} = {}) {
  return {
    episodeId: overrides.episodeId ?? "e1",
    userId: overrides.userId ?? "u1",
    tools: overrides.tools ?? ["bash"],
    artifacts: overrides.artifacts ?? ["xlsx"],
    toolBigrams: overrides.toolBigrams ?? [],
    queryText: overrides.queryText ?? "edit report.xlsx",
    queryVec: overrides.queryVec === undefined ? [1, 0] : overrides.queryVec,
    outcome: overrides.outcome ?? "success" as const
  };
}

function clusterFeatures(overrides: {
  id?: string;
  userId?: string;
  tools?: string[];
  artifacts?: string[];
  toolBigrams?: string[];
  centroid?: number[] | null;
} = {}) {
  return {
    id: overrides.id ?? "c1",
    userId: overrides.userId ?? "u1",
    tools: overrides.tools ?? ["bash"],
    artifacts: overrides.artifacts ?? ["xlsx"],
    toolBigrams: overrides.toolBigrams ?? [],
    centroid: overrides.centroid === undefined ? [1, 0] : overrides.centroid
  };
}

function procedure(overrides: Partial<DirectSkillProcedureJson> = {}): DirectSkillProcedureJson {
  return {
    retrievalBlurb: "when the user asks to edit an xlsx with python",
    triggerContext: "Spreadsheet transform via python",
    summary: "Load the workbook, edit the sheet, write the xlsx.",
    parameters: [],
    preconditions: [],
    steps: [
      { title: "Load workbook", body: "Open report.xlsx with openpyxl and read headers." },
      { title: "Write output", body: "Save the modified workbook to output.xlsx." }
    ],
    examples: [],
    decisionGuidance: { preference: [], antiPattern: [] },
    tags: ["xlsx"],
    tools: ["python"],
    ...overrides
  };
}

describe("trace-direct-skill algorithm", () => {
  it("classifies outcomes with the existing rTask thresholds", () => {
    expect(classifySkillOutcome(0.5, thresholds)).toBe("success");
    expect(classifySkillOutcome(-0.15, thresholds)).toBe("failure");
    expect(classifySkillOutcome(0, thresholds)).toBe("unknown");
    expect(classifySkillOutcome(undefined, thresholds)).toBe("unknown");
  });

  it("extracts artifact types from paths and mentions", () => {
    expect(extractArtifactTypes("please edit report.xlsx and dump.csv")).toEqual(["csv", "xlsx"]);
  });

  it("builds episode features from RawTurns, not summaries", () => {
    const features = extractEpisodeSkillFeatures({
      episodeId: "e1",
      userId: "u1",
      rTask: 1,
      thresholds,
      turns: [{
        userText: "fill totals in report.xlsx",
        assistantText: "done",
        toolCalls: [{ name: "python", input: { command: "openpyxl.load_workbook" } }]
      }]
    });
    expect(features.tools).toEqual(["python"]);
    expect(features.artifacts).toEqual(["xlsx"]);
    expect(features.outcome).toBe("success");
  });

  it("refuses to join a no-tool episode into a tool cluster", () => {
    const gate = canJoinCluster(
      { tools: [], artifacts: ["xlsx"], queryVec: [1, 0] },
      { tools: ["python"], artifacts: ["xlsx"], centroid: [1, 0] }
    );
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("episode_empty_cluster_has_tools");
  });

  it("refuses to join a tool episode into a chat-only cluster", () => {
    const gate = canJoinCluster(
      { tools: ["python"], artifacts: ["xlsx"], queryVec: [1, 0] },
      { tools: [], artifacts: [], centroid: [1, 0] }
    );
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("episode_has_tools_cluster_empty");
  });

  it("creates a new cluster when both sides are empty and there is no query_vec", () => {
    const decision = decideClusterAssignment(
      {
        episodeId: "e1",
        userId: "u1",
        tools: [],
        artifacts: [],
        toolBigrams: [],
        queryText: "hi",
        queryVec: null,
        outcome: "success"
      },
      [{
        id: "c1",
        userId: "u1",
        tools: [],
        artifacts: [],
        toolBigrams: [],
        centroid: null
      }]
    );
    expect(decision.action).toBe("create");
  });

  it("joins the same tool/artifact family when query vectors are similar", () => {
    const decision = decideClusterAssignment(
      episodeFeatures({
        episodeId: "e2",
        queryVec: [0.96, 0.28],
        queryText: "fix INDEX MATCH in report.xlsx"
      }),
      [clusterFeatures({ id: "c1", centroid: [1, 0] })]
    );
    expect(decision).toMatchObject({
      action: "join",
      clusterId: "c1",
      stage: "fine",
      reason: "joined_by_fine_vec"
    });
  });

  it("opens a new fine cluster when the same family has a dissimilar query vector", () => {
    const decision = decideClusterAssignment(
      episodeFeatures({
        episodeId: "e2",
        queryVec: [0, 1],
        queryText: "delete filtered rows from report.xlsx"
      }),
      [clusterFeatures({ id: "c1", centroid: [1, 0] })]
    );
    expect(decision.action).toBe("create");
    expect(decision.reason).toBe("no_cluster_above_fine_threshold");
  });

  it("stays on the coarse family when there is no query vector", () => {
    const decision = decideClusterAssignment(
      episodeFeatures({
        episodeId: "e2",
        queryVec: null,
        queryText: "another spreadsheet edit"
      }),
      [clusterFeatures({ id: "c1", centroid: [1, 0] })]
    );
    expect(decision).toMatchObject({
      action: "join",
      clusterId: "c1",
      stage: "coarse",
      reason: "joined_by_coarse_family"
    });
  });

  it("selects the newest 3 successes and 3 failures", () => {
    const selected = selectTop6Members([
      { episodeId: "s1", outcome: "success", updatedAt: "2026-01-01T00:00:00.000Z" },
      { episodeId: "s2", outcome: "success", updatedAt: "2026-01-02T00:00:00.000Z" },
      { episodeId: "s3", outcome: "success", updatedAt: "2026-01-03T00:00:00.000Z" },
      { episodeId: "s4", outcome: "success", updatedAt: "2026-01-04T00:00:00.000Z" },
      { episodeId: "f1", outcome: "failure", updatedAt: "2026-01-01T00:00:00.000Z" },
      { episodeId: "f2", outcome: "failure", updatedAt: "2026-01-05T00:00:00.000Z" },
      { episodeId: "u1", outcome: "unknown", updatedAt: "2026-01-06T00:00:00.000Z" }
    ]);
    expect(selected.map((item) => item.episodeId)).toEqual(["s4", "s3", "s2", "f2", "f1", "s1"]);
  });

  it("does not crystallize when the batch has only failures", () => {
    expect(decideEvolveBranch({
      hasSkill: false,
      batch: [{ episodeId: "f1", outcome: "failure" }],
      newEpisodeIds: ["f1"]
    })).toMatchObject({ action: "skip_no_success_anchor" });
  });

  it("rebuilds constraints for a new failure on an existing skill", () => {
    expect(decideEvolveBranch({
      hasSkill: true,
      batch: [
        { episodeId: "s1", outcome: "success" },
        { episodeId: "f1", outcome: "failure" }
      ],
      newEpisodeIds: ["f1"]
    })).toMatchObject({ action: "rebuild", rebuildScope: "constraints" });
  });

  it("reads packed evidence episode_id so new failures are not treated as empty", () => {
    expect(decideEvolveBranch({
      hasSkill: true,
      batch: [
        { episode_id: "s1", outcome: "success" },
        { episode_id: "f1", outcome: "failure" }
      ],
      newEpisodeIds: ["f1"]
    })).toMatchObject({
      action: "rebuild",
      rebuildScope: "constraints",
      reason: "new_failures_only"
    });
  });

  it("rebuilds workflow for a new success even when tools are unchanged", () => {
    expect(decideEvolveBranch({
      hasSkill: true,
      batch: [
        { episode_id: "s1", outcome: "success" },
        { episode_id: "s2", outcome: "success" }
      ],
      newEpisodeIds: ["s2"],
      existingTools: ["bash"],
      newSuccessTools: ["bash"]
    })).toMatchObject({
      action: "rebuild",
      rebuildScope: "workflow",
      reason: "new_success"
    });
  });

  it("keeps procedure ahead of long preconditions when clipping a full skill", () => {
    const preconditions = Array.from({ length: 80 }, (_, index) => `- footnote ${index + 1} ${"x".repeat(80)}`).join("\n");
    const guide = [
      "# xlsx_section_merge_sort_total",
      "",
      "Generic Excel blurb.",
      "",
      "**Preconditions**",
      preconditions,
      "",
      "**Procedure**",
      "1. **Parse sections** - detect headers and write the graded range",
      "",
      "**Examples**",
      "- Input: `combine RANGES into LISTS`"
    ].join("\n");
    const clipped = clipSkillGuide(guide, 2048);
    expect(clipped).toContain("**Procedure**");
    expect(clipped).toContain("Parse sections");
    expect(clipped.indexOf("**Procedure**")).toBeLessThan(clipped.indexOf("**Preconditions**"));
    expect(clipped.length).toBeLessThanOrEqual(2048);
  });

  it("keeps existing anti_pattern when merging a workflow rebuild, newest first", () => {
    const merged = mergeProcedureByScope(
      procedure({
        decisionGuidance: { preference: ["keep formulas"], antiPattern: ["do not drop rows"] },
        steps: [{ title: "Old", body: "old step" }]
      }),
      procedure({
        decisionGuidance: { preference: ["write values"], antiPattern: ["do not invent headers"] },
        steps: [{ title: "New", body: "new step with openpyxl" }]
      }),
      "workflow"
    );
    expect(merged.steps[0]?.title).toBe("New");
    expect(merged.decisionGuidance.antiPattern).toEqual(["do not invent headers", "do not drop rows"]);
  });

  it("replaces preconditions on a constraints rebuild instead of unioning", () => {
    const existing = Array.from({ length: 20 }, (_, index) => `old precondition ${index + 1}`);
    const merged = mergeProcedureByScope(
      procedure({ preconditions: existing, steps: [{ title: "Old", body: "keep this step" }] }),
      procedure({
        preconditions: [
          "Dates may be datetime or string; normalize before compare",
          "Only edit the graded answer_position"
        ],
        steps: [{ title: "Should not land", body: "failure commands" }]
      }),
      "constraints"
    );
    expect(merged.preconditions).toEqual([
      "Dates may be datetime or string; normalize before compare",
      "Only edit the graded answer_position"
    ]);
    expect(merged.steps[0]?.title).toBe("Old");
  });

  it("caps constraint lists and keeps the existing list when the draft is empty", () => {
    const existing = Array.from({ length: 20 }, (_, index) => `old precondition ${index + 1}`);
    const merged = mergeProcedureByScope(
      procedure({
        preconditions: existing,
        decisionGuidance: { preference: [], antiPattern: ["old avoid"] }
      }),
      procedure({
        preconditions: [],
        decisionGuidance: { preference: [], antiPattern: [] }
      }),
      "constraints"
    );
    expect(merged.preconditions).toEqual(existing.slice(0, MAX_DIRECT_SKILL_PRECONDITIONS));
    expect(merged.decisionGuidance.antiPattern).toEqual(["old avoid"]);
  });

  it("caps a workflow union so preconditions cannot grow without bound", () => {
    const existing = Array.from({ length: 10 }, (_, index) => `old ${index + 1}`);
    const draft = Array.from({ length: 8 }, (_, index) => `new ${index + 1}`);
    const merged = mergeProcedureByScope(
      procedure({ preconditions: existing }),
      procedure({ preconditions: draft }),
      "workflow"
    );
    expect(merged.preconditions).toEqual([
      ...draft,
      ...existing.slice(0, MAX_DIRECT_SKILL_PRECONDITIONS - draft.length)
    ]);
    expect(merged.preconditions).toHaveLength(MAX_DIRECT_SKILL_PRECONDITIONS);
  });

  it("truncates model preconditions at coerce time", () => {
    const procedureJson = coerceDirectSkillProcedure({
      preconditions: Array.from({ length: 20 }, (_, index) => `item ${index + 1}`),
      decision_guidance: {
        anti_pattern: Array.from({ length: 8 }, (_, index) => `avoid ${index + 1}`)
      }
    });
    expect(procedureJson.preconditions).toHaveLength(MAX_DIRECT_SKILL_PRECONDITIONS);
    expect(procedureJson.decisionGuidance.antiPattern).toHaveLength(MAX_DIRECT_SKILL_ANTI_PATTERN);
  });

  it("rejects fluff steps and tools that never appeared in RawTurns", () => {
    const batch = [{
      episode_id: "e1",
      r_task: 1,
      outcome: "success" as const,
      turns: packRawTurnEvidence([{
        userText: "fill totals in report.xlsx",
        assistantText: "opened report.xlsx with openpyxl",
        toolCalls: [{ name: "python", input: "openpyxl.load_workbook('report.xlsx')" }]
      }])
    }];
    expect(verifyDirectSkillDraft({
      name: "xlsx_python_transform",
      procedure: procedure({ tools: ["python", "imaginary_tool"] }),
      batch
    }).reasons).toContain("tools_outside_evidence:imaginary_tool");
    expect(verifyDirectSkillDraft({
      name: "xlsx_python_transform",
      procedure: procedure({
        steps: [{ title: "Check", body: "carefully check the result" }]
      }),
      batch
    }).reasons).toContain("fluff_step");
  });

  it("rejects steps that copy a failure-only process", () => {
    const batch = [
      {
        episode_id: "ok",
        r_task: 1,
        outcome: "success" as const,
        turns: packRawTurnEvidence([{
          userText: "fill totals in report.xlsx",
          assistantText: "used openpyxl to write totals",
          toolCalls: [{ name: "python", input: "openpyxl load workbook totals" }]
        }])
      },
      {
        episode_id: "bad",
        r_task: -1,
        outcome: "failure" as const,
        turns: packRawTurnEvidence([{
          userText: "fill totals in report.xlsx",
          assistantText: "deleted the sheet by accident",
          toolCalls: [{ name: "python", input: "worksheet.delete_rows(1, 9999) wipe_sheet_completely" }]
        }])
      }
    ];
    const result = verifyDirectSkillDraft({
      name: "xlsx_python_transform",
      procedure: procedure({
        steps: [{
          title: "Wipe sheet",
          body: "Call worksheet.delete_rows and wipe_sheet_completely before saving."
        }]
      }),
      batch
    });
    expect(result.reasons).toContain("failure_process_in_steps");
  });

  it("treats only cluster.skill_memory_id as an existing skill, not an L2 crystallization", () => {
    expect(clusterHasUsableSkill({ skillMemoryId: undefined })).toBe(false);
    expect(clusterHasUsableSkill({ skillMemoryId: "skill_l2", layer: "L2" })).toBe(false);
    expect(clusterHasUsableSkill({ skillMemoryId: "skill_old", layer: "Skill", status: "archived" })).toBe(false);
    expect(clusterHasUsableSkill({ skillMemoryId: "skill_ok", layer: "Skill", status: "activated" })).toBe(true);
  });
});
