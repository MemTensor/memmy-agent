/** Integration service tests. */
import { describe, expect, it, vi } from "vitest";
import type { ToolConnectionAnalytics, ToolConnectionTrackInput } from "../../analytics/tool-connection-analytics.js";
import { createIntegrationService } from "../integration-service.js";

describe("integration service analytics", () => {
  it("tracks disconnected on deleteConnection and resolves toolkit from the connection list", async () => {
    const tracked: ToolConnectionTrackInput[] = [];
    const toolConnectionAnalytics = createAnalyticsRecorder(tracked);
    const cloudClient = {
      listIntegrationCapabilities: vi.fn(),
      authorizeIntegration: vi.fn(),
      listIntegrationConnections: vi.fn(async () => ({
        connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE" }],
      })),
      deleteIntegrationConnection: vi.fn(async () => ({ ok: true as const })),
      executeIntegrationRouterTool: vi.fn(),
    };
    const service = createIntegrationService({
      cloudClient,
      composioMachineTokenRepository: { getOrCreateToken: () => "machine-token" },
      toolConnectionAnalytics,
    });

    await expect(service.deleteConnection("conn-github")).resolves.toEqual({ ok: true });
    expect(tracked).toEqual([
      { surface: "integration", toolkit: "github", event: "disconnected" },
    ]);
  });

  it("tracks failed when deleteConnection throws", async () => {
    const tracked: ToolConnectionTrackInput[] = [];
    const toolConnectionAnalytics = createAnalyticsRecorder(tracked);
    const boom = new Error("delete failed");
    const cloudClient = {
      listIntegrationCapabilities: vi.fn(),
      authorizeIntegration: vi.fn(),
      listIntegrationConnections: vi.fn(async () => ({
        connections: [{ id: "conn-gmail", toolkit: "gmail", status: "ACTIVE" }],
      })),
      deleteIntegrationConnection: vi.fn(async () => {
        throw boom;
      }),
      executeIntegrationRouterTool: vi.fn(),
    };
    const service = createIntegrationService({
      cloudClient,
      composioMachineTokenRepository: { getOrCreateToken: () => "machine-token" },
      toolConnectionAnalytics,
    });

    await expect(service.deleteConnection("conn-gmail")).rejects.toThrow("delete failed");
    expect(tracked).toEqual([
      { surface: "integration", toolkit: "gmail", event: "failed", error: boom },
    ]);
  });

  it("reportConnectionEvent forwards connected/failed analytics without changing connections", async () => {
    const tracked: ToolConnectionTrackInput[] = [];
    const toolConnectionAnalytics = createAnalyticsRecorder(tracked);
    const cloudClient = {
      listIntegrationCapabilities: vi.fn(),
      authorizeIntegration: vi.fn(),
      listIntegrationConnections: vi.fn(),
      deleteIntegrationConnection: vi.fn(),
      executeIntegrationRouterTool: vi.fn(),
    };
    const service = createIntegrationService({
      cloudClient,
      composioMachineTokenRepository: { getOrCreateToken: () => "machine-token" },
      toolConnectionAnalytics,
    });

    await expect(
      service.reportConnectionEvent({
        surface: "integration",
        toolkit: "github",
        event: "connected",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      service.reportConnectionEvent({
        surface: "integration",
        toolkit: "github",
        event: "failed",
        errorCode: "timeout",
      }),
    ).resolves.toEqual({ ok: true });

    expect(cloudClient.deleteIntegrationConnection).not.toHaveBeenCalled();
    expect(tracked).toEqual([
      { surface: "integration", toolkit: "github", event: "connected" },
      { surface: "integration", toolkit: "github", event: "failed", errorCode: "timeout" },
    ]);
  });
});

function createAnalyticsRecorder(tracked: ToolConnectionTrackInput[]): ToolConnectionAnalytics {
  return {
    trackConnection(input) {
      tracked.push(input);
    },
    flush: async () => undefined,
  };
}
