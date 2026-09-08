import { describe, expect, it, vi } from "vitest";
import { ComputerHistoryTool } from "../../../../src/core/agent-runtime/tools/computer-history.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";

const history = {
  id: "history-iphone",
  title: "配置 iPhone",
  sourceType: "captured" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  markdown: "# 配置 iPhone\n\n## Reusable operation experience",
  filePath: "/tmp/history-iphone.md",
};

describe("ComputerHistoryTool", () => {
  it("is discoverable as a core Agent tool with explicit replay semantics", () => {
    const registry = new ToolLoader({ testClasses: [ComputerHistoryTool] }).loadRegistry();
    const tool = registry.get("computer_history");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("mcp_open_computer_use_");
    expect(tool?.description).toContain("built-in computer_*");
    expect(tool?.description).toContain("never start CUA");
  });

  it("returns matching human-operation History without starting desktop control", async () => {
    const service = {
      searchHistories: vi.fn(() => [{ history, score: 12, matchedTerms: ["iphone"] }]),
      prepareReplayUserRequest: vi.fn(),
    };
    const result = JSON.parse(await new ComputerHistoryTool(service as any).execute({
      action: "search",
      query: "继续配置 iPhone",
    }));

    expect(result.matches[0]).toMatchObject({ id: history.id, title: history.title });
    expect(service.prepareReplayUserRequest).not.toHaveBeenCalled();
  });

  it("hands an explicit chat replay request to Open Computer Use with a built-in fallback", async () => {
    const workflow = {
      id: "workflow-iphone",
      title: "复现 iPhone 配置",
      createdAt: "2026-09-01T00:01:00.000Z",
      markdown: "# Workflow",
      filePath: "/tmp/workflow-iphone.md",
      sourceHistoryId: history.id,
    };
    const prepareReplayUserRequest = vi.fn(() => ({
      history,
      workflow,
      snapshot: { cuaRun: { status: "idle", startedAt: null } },
      steps: ["Open https://www.apple.com/", "Select Silver"],
    }));
    const tool = new ComputerHistoryTool({ searchHistories: vi.fn(), prepareReplayUserRequest } as any);

    const result = JSON.parse(await tool.execute({
      action: "replay",
      query: "帮我复现刚才配置 iPhone 的操作",
      history_id: history.id,
    }));

    expect(prepareReplayUserRequest).toHaveBeenCalledWith({
      userRequest: "帮我复现刚才配置 iPhone 的操作",
      historyId: history.id,
    });
    expect(result).toMatchObject({
      status: "ready_for_open_computer_use",
      executor: "open_computer_use_mcp",
      fallback_executor: "builtin_computer_use",
      history: { id: history.id },
      workflow: { id: workflow.id },
      steps: ["Open https://www.apple.com/", "Select Silver"],
    });
    expect(result.next_action).toContain("mcp_open_computer_use_get_app_state");
    expect(result.next_action).toContain("latest returned state");
    expect(result.safety_note).toContain("Do not call mcp_cua");
    expect(result.safety_note).toContain("stale element indexes");
  });
});
