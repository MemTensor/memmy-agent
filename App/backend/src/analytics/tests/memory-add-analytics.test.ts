import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS,
  MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
  buildMemoryDesktopScanAddParams,
  createMemoryDesktopAddAnalytics,
  hashAnalyticsId,
} from "../memory-add-analytics.js";

describe("memory-add-analytics", () => {
  it("hashes ids and builds scan add params with agent_source_scan mode and scan_mode", () => {
    expect(hashAnalyticsId("conv-1")).toHaveLength(16);
    expect(buildMemoryDesktopScanAddParams({
      adapterId: "agent-source:cursor",
      scanMode: "initial_subset",
      conversationId: "conv-1",
      turnId: "cursor:abc",
    })).toEqual({
      entrypoint: "memmy-desktop",
      adapter_id: "agent-source:cursor",
      storage_backend: "memmy-memory",
      mode: MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
      scan_mode: "initial_subset",
      layer: "L1",
      session_id_hash: hashAnalyticsId("conv-1"),
      turn_id_hash: hashAnalyticsId("cursor:abc"),
    });
  });

  it("tracks started/succeeded/failed desktop add events", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const analytics = createMemoryDesktopAddAnalytics({
      getClientId: () => "client-1",
      getUserId: () => "user-1",
      getUserMode: () => "account",
      appEnv: "dev",
      appEdition: "cn",
      debugMode: false,
      baseUrl: "https://example.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    analytics.trackAddStarted({
      adapterId: "agent-source:cursor",
      scanMode: "full",
      conversationId: "conv-1",
      turnId: "turn-1",
    });
    analytics.trackAddSucceeded({
      adapterId: "agent-source:cursor",
      scanMode: "full",
      conversationId: "conv-1",
      turnId: "turn-1",
      durationMs: 12,
      storedCount: 1,
    });
    analytics.trackAddFailed({
      adapterId: "agent-source:cursor",
      scanMode: "incremental",
      conversationId: "conv-1",
      turnId: "turn-2",
      durationMs: 3,
      error: new Error("boom"),
    });
    await analytics.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const names = body.events.map((event: { eventName: string }) => event.eventName);
    expect(names).toEqual([
      MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addStarted,
      MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addSucceeded,
      MEMORY_DESKTOP_ADD_ANALYTICS_EVENTS.addFailed,
    ]);
    expect(body.events[0]?.params).toMatchObject({
      mode: MEMORY_DESKTOP_ADD_MODE_AGENT_SOURCE_SCAN,
      scan_mode: "full",
      adapter_id: "agent-source:cursor",
      source: "memmy-agent",
    });
    expect(body.events[1]?.params).toMatchObject({
      success: true,
      stored_count: 1,
      duration_ms: 12,
      scan_mode: "full",
    });
    expect(body.events[2]?.params).toMatchObject({
      success: false,
      error_code: "boom",
      duration_ms: 3,
      scan_mode: "incremental",
    });
  });
});
