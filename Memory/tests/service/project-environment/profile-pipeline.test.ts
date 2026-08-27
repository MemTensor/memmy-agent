import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import {
  CODE_PROFILE_PROMPT,
  FOLDER_PROFILE_PROMPT,
  ProjectEnvironmentProfilePipeline,
  validateProjectEnvironmentProfileOutput
} from "../../../src/service/project-environment/profile-pipeline.js";
import type { ProjectEnvironmentDerivedEvidence } from "../../../src/service/project-environment/types.js";
import type { EvolutionJobRecord, Repositories } from "../../../src/storage/repositories.js";

describe("project environment profile pipeline", () => {
  it.each([
    ["code", CODE_PROFILE_PROMPT, "project_environment_code_profile"],
    ["folder", FOLDER_PROFILE_PROMPT, "project_environment_folder_profile"]
  ] as const)("generates a complete %s profile and applies scan provenance", async (kind, prompt, operation) => {
    const complete = vi.fn().mockResolvedValue('{"op":"create","profile":"Complete profile"}');
    const { applyProfile, pipeline } = fixture(complete);
    const evidence = derived(kind);

    await pipeline.process(job(), evidence);

    expect(prompt).toContain("valid JSON object");
    expect(complete.mock.calls[0]?.[0]?.[0]).toEqual({ role: "system", content: prompt });
    expect(complete.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ operation, maxTokens: 65_536 }));
    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      scanId: "scan-1",
      projectKind: kind,
      fingerprint: "fingerprint-1",
      expectedCurrentProfile: null,
      operation: "create",
      profile: "Complete profile"
    }));
  });

  it("passes the current profile and applies noop without repeating it", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"noop","profile":""}');
    const { applyProfile, pipeline } = fixture(complete, "Existing profile");
    await pipeline.process(job(), derived("folder"));
    const dynamicInput = JSON.parse(complete.mock.calls[0]![0][1]!.content);
    expect(dynamicInput.current_profile).toBe("Existing profile");
    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({ operation: "noop", profile: "" }));
  });

  it("repairs a first-scan noop when useful evidence supports a profile", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{"op":"noop","profile":""}')
      .mockResolvedValueOnce('{"op":"create","profile":"Complete repaired profile"}');
    const { applyProfile, pipeline } = fixture(complete);

    await pipeline.process(job(), derived("code"));

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      operation: "project_environment_code_profile.repair"
    }));
    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      operation: "create",
      profile: "Complete repaired profile"
    }));
  });

  it("allows first-scan noop when an empty folder has no useful evidence", async () => {
    const complete = vi.fn().mockResolvedValue('{"op":"noop","profile":""}');
    const { applyProfile, pipeline } = fixture(complete);

    await pipeline.process(job(), emptyFolderEvidence());

    expect(complete).toHaveBeenCalledTimes(1);
    expect(applyProfile).toHaveBeenCalledWith(expect.objectContaining({
      operation: "noop",
      profile: ""
    }));
  });

  it("drops a stale scan before calling the model", async () => {
    const complete = vi.fn();
    const { pipeline } = fixture(complete, null, "scan-new");
    await pipeline.process(job(), derived("code"));
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not retry a failed model call after a newer scan supersedes it", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { pipeline, getState } = fixture(complete);
    getState.mockReturnValueOnce({ currentScanId: "scan-1" }).mockReturnValue({ currentScanId: "scan-new" });
    await expect(pipeline.process(job(), derived("code"))).resolves.toBeUndefined();
  });

  it("strictly validates noop, create, update and clear operations", () => {
    expect(validateProjectEnvironmentProfileOutput({ op: "noop", profile: "" }, null)).toEqual({ op: "noop", profile: "" });
    expect(() => validateProjectEnvironmentProfileOutput(
      { op: "noop", profile: "" },
      null,
      true
    )).toThrow("first-scan evidence");
    expect(validateProjectEnvironmentProfileOutput({ op: "create", profile: "new" }, null)).toEqual({ op: "create", profile: "new" });
    expect(validateProjectEnvironmentProfileOutput({ op: "update", profile: "" }, "old")).toEqual({ op: "update", profile: "" });
    expect(() => validateProjectEnvironmentProfileOutput({ op: "noop", profile: "old" }, "old")).toThrow();
    expect(() => validateProjectEnvironmentProfileOutput({ op: "update", profile: "old" }, "old")).toThrow();
    expect(() => validateProjectEnvironmentProfileOutput({ op: "create", profile: "new", extra: true }, null)).toThrow();
  });
});

function fixture(complete: LlmClient["complete"], currentProfile: string | null = null, scanId = "scan-1") {
  const applyProfile = vi.fn().mockReturnValue({ stale: false });
  const getState = vi.fn().mockReturnValue({ currentScanId: scanId });
  const repos = {
    projectEnvironments: { getState, applyProfile },
    l3WorldModels: {
      fields: vi.fn().mockReturnValue({
        generalRulesAndSafetyConstraints: null,
        projectEnvironmentProfile: currentProfile,
        projectContract: null,
        domainKnowledge: null
      })
    }
  } as unknown as Repositories;
  return {
    applyProfile,
    getState,
    pipeline: new ProjectEnvironmentProfilePipeline({
      repos,
      llm: { complete, status: () => ({ provider: "test", model: "test" }) } as LlmClient
    })
  };
}

function job(): EvolutionJobRecord {
  return {
    id: "job-1",
    jobType: "project_environment_profile",
    status: "queued",
    dedupeKey: "dedupe",
    userId: "user-1",
    sessionId: "session-1",
    payload: {
      userId: "user-1",
      projectId: "project-1",
      scanId: "scan-1",
      trigger: "session_start"
    },
    attempts: 0,
    maxAttempts: 3,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z"
  };
}

function derived(projectKind: "code" | "folder"): ProjectEnvironmentDerivedEvidence {
  return {
    projectKind,
    fingerprint: "fingerprint-1",
    compactFileTree: "package.json\nsrc/\n  index.ts",
    omittedCount: 2,
    deterministicFacts: {
      languageCounts: { ".ts": 1 },
      manifestLanguages: [sourcedFact("Node.js/JavaScript")],
      runtimeDeclarations: [sourcedFact("node >=22")],
      runtimeProbes: [{ probe: "node_version", value: "v22.23.1" }],
      toolchains: [sourcedFact("pnpm@10")],
      buildEntries: [sourcedFact("npm run build")],
      testEntries: [sourcedFact("npm run test")],
      checkEntries: [sourcedFact("npm run typecheck")]
    }
  };
}

function emptyFolderEvidence(): ProjectEnvironmentDerivedEvidence {
  return {
    projectKind: "folder",
    fingerprint: "empty-fingerprint",
    compactFileTree: ".git/",
    omittedCount: 0,
    deterministicFacts: {
      languageCounts: {},
      manifestLanguages: [],
      runtimeDeclarations: [],
      runtimeProbes: [],
      toolchains: [],
      buildEntries: [],
      testEntries: [],
      checkEntries: []
    }
  };
}

function sourcedFact(value: string) {
  return { value, sourceRelativePath: "package.json", sourceSha256: "a".repeat(64) };
}
