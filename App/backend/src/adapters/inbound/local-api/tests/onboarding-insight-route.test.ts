import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import { createLocalApiServer } from "../server.js";
import type { OnboardingInsightReportStreamEvent } from "@memmy/local-api-contracts";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("onboarding insight local api routes", () => {
  it("skips the first-login report when scan permission is not granted", async () => {
    const generateReport = vi.fn();
    app = createServer({
      permissionManager: createPermissionManager("none"),
      onboardingInsight: {
        generateReport,
        async *streamReport() {
          throw new Error("streamReport not used");
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/insight-report",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { locale: "zh-CN" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "skipped",
      reportMarkdown: "",
      secondaryActions: [],
      diagnostics: {
        discoveredAgentCount: 0,
        sampledQueryCount: 0,
        usedLlm: false,
        elapsedMs: 0,
        agents: []
      }
    });
    expect(generateReport).not.toHaveBeenCalled();
  });

  it("streams first-login report chunks and final actions when scan permission is granted", async () => {
    app = createServer({
      permissionManager: createPermissionManager("scan_only"),
      onboardingInsight: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield { type: "chunk", delta: "你好" } satisfies OnboardingInsightReportStreamEvent;
          yield {
            type: "done",
            response: {
              status: "ready",
              reportMarkdown: "你好",
              primaryAction: {
                type: "continue_task",
                buttonLabel: "继续",
                description: "继续任务",
                contextSummary: "上下文",
                relatedAgents: ["Codex"],
                topicKeywords: ["Memory"],
                suggestedPrompt: "继续任务"
              },
              secondaryActions: [],
              diagnostics: {
                discoveredAgentCount: 1,
                sampledQueryCount: 1,
                usedLlm: true,
                elapsedMs: 12,
                agents: [{
                  sourceId: "codex",
                  displayName: "Codex",
                  recentSessionCount: 1,
                  queryCount: 1,
                  latestActivityAt: "2026-06-01T10:00:00.000Z"
                }]
              }
            }
          } satisfies OnboardingInsightReportStreamEvent;
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/insight-report/stream",
      headers: {
        origin: "http://127.0.0.1:19000",
        "x-memmy-local-token": "test-token"
      },
      payload: { locale: "zh-CN", stream: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:19000");
    expect(response.headers.vary).toBe("Origin");
    expect(response.payload).toContain('event: chunk\ndata: {"type":"chunk","delta":"你好"}');
    expect(response.payload).toContain('event: done\ndata: {"type":"done","response":{"status":"ready","reportMarkdown":"你好"');
  });
});

function createServer(input: {
  permissionManager: PermissionManager;
  onboardingInsight: Pick<BackendServices["onboardingInsight"], "generateReport" | "streamReport">;
}): FastifyInstance {
  return createLocalApiServer({
    permissionManager: input.permissionManager,
    services: {
      progressBus: createProgressBus(),
      onboardingInsight: input.onboardingInsight
    } as unknown as BackendServices,
    heartbeatIntervalMs: 20
  });
}

function createPermissionManager(scanPermission: Awaited<ReturnType<PermissionManager["getScanPermission"]>>): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return scanPermission;
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return scanPermission === "scan_only" || scanPermission === "scan_and_write_skill";
    },
    async canWriteAgentSkill() {
      return scanPermission === "scan_and_write_skill";
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}
