import { describe, expect, it } from "vitest";
import { syncMemoryModelCatalog } from "../src/config/model-catalog.js";

describe("Memory model catalog inheritance", () => {
  it("syncs follow routing as summary -> evolution -> Agent Chat", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" },
          memorySummary: "old-summary",
          memoryEvolution: "old-evolution"
        }
      }
    };
    const memory = {
      roleRouting: { summary: "follow", evolution: "follow" }
    };

    syncMemoryModelCatalog(root, memory, { roleRouting: memory.roleRouting });

    expect((root.modelAssignments as any).byok).toMatchObject({
      memorySummary: "agent-chat",
      memoryEvolution: "agent-chat"
    });
  });

  it("makes a following summary reuse a fixed evolution model", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" }
        }
      }
    };
    const memory = {
      roleRouting: { summary: "follow", evolution: "fixed" },
      evolution: {
        provider: "openai_compatible",
        endpoint: "https://evolution.example/v1",
        model: "strong-evolution",
        apiKey: "sk-evolution"
      }
    };

    syncMemoryModelCatalog(root, memory, {
      roleRouting: memory.roleRouting,
      evolution: memory.evolution
    });

    const assignment = (root.modelAssignments as any).byok;
    expect(assignment.memoryEvolution).toEqual(expect.any(String));
    expect(assignment.memorySummary).toBe(assignment.memoryEvolution);
  });

  it("never makes evolution inherit a fixed summary model", () => {
    const root: Record<string, unknown> = {
      app: { userMode: "byok" },
      modelAssignments: {
        byok: {
          agent: { candidates: ["agent-chat"], default: "agent-chat" }
        }
      }
    };
    const memory = {
      roleRouting: { summary: "fixed", evolution: "follow" },
      summary: {
        provider: "openai_compatible",
        endpoint: "https://summary.example/v1",
        model: "fast-summary",
        apiKey: "sk-summary"
      }
    };

    syncMemoryModelCatalog(root, memory, {
      roleRouting: memory.roleRouting,
      summary: memory.summary
    });

    const assignment = (root.modelAssignments as any).byok;
    expect(assignment.memoryEvolution).toBe("agent-chat");
    expect(assignment.memorySummary).not.toBe("agent-chat");
    expect(assignment.memorySummary).not.toBe(assignment.memoryEvolution);
  });
});
