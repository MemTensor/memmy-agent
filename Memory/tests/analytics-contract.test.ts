import { describe, expect, it, vi } from "vitest";
import {
  postAnalyticsEvents,
  resolveCliAnalyticsParams,
  resolveCommandIdentity,
} from "../src/cli/analytics.js";

describe("CLI analytics event contract", () => {
  it("posts the installation id alongside the existing GA-style event contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await postAnalyticsEvents({
      events: [{
        eventName: "memmy_cli_completed",
        eventTimeMillis: 1_700_000_000_000,
        params: { success: true },
      }],
      installationId: "install-1",
      clientId: "ga-client-1",
      userId: null,
      userMode: "byok",
      appEnv: "prod",
      baseUrl: "https://cloud.example.com",
      fetchImpl,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      clientId: "ga-client-1",
      installationId: "install-1",
    });
    expect(body.userId).toBeUndefined();
    expect(body.events).toEqual([
      expect.objectContaining({
        eventName: "memmy_cli_completed",
        params: expect.objectContaining({
          engagement_time_msec: 100,
          success: 1,
          user_mode: "byok",
          source: "memmy-memory",
          app_env: "prod",
          app_version: expect.any(String),
          timestamp_micros: 1_700_000_000_000_000,
        }),
      }),
    ]);
    expect(body.events[0]?.params).not.toHaveProperty("user_id");
  });
});

describe("CLI analytics command identity", () => {
  it.each([
    ["search", "some private query"],
    ["add", "<memory text>"],
    ["get", "mem_123"],
    ["delete", "mem_123"],
  ])("does not report the %s argument as a command action", (group, argument) => {
    expect(resolveCommandIdentity([group, argument])).toEqual({
      command_group: group,
      has_session_id: false,
      has_turn_id: false,
    });
  });

  it("reports only known subcommands as command actions", () => {
    expect(resolveCommandIdentity(["session", "close", "session-1"])).toEqual({
      command_group: "session",
      command_action: "close",
      has_session_id: true,
      has_turn_id: false,
    });
    expect(resolveCommandIdentity(["turn", "complete", "turn-1"])).toEqual({
      command_group: "turn",
      command_action: "complete",
      has_session_id: false,
      has_turn_id: true,
    });
    expect(resolveCommandIdentity(["service", "start"])).toMatchObject({ command_action: "start" });
    expect(resolveCommandIdentity(["raw", "GET", "/api/v1/health"])).toMatchObject({ command_action: "GET" });
    expect(resolveCommandIdentity(["raw", "get", "/api/v1/health"])).toMatchObject({ command_action: "get" });
    expect(resolveCommandIdentity(["session", "whatever-text"])).toEqual({
      command_group: "session",
      has_session_id: false,
      has_turn_id: false,
    });
  });

  it("does not report an unknown command verbatim", () => {
    expect(resolveCommandIdentity(["some free text"])).toEqual({
      command_group: "unknown",
      has_session_id: false,
      has_turn_id: false,
    });
  });

  it("keeps CLI arguments out of the event params", () => {
    const params = resolveCliAnalyticsParams(
      ["search", "some private query", "--url", "http://memmy.test"],
      { env: {} },
    );

    expect(params).toMatchObject({ command_group: "search" });
    expect(params).not.toHaveProperty("command_action");
    expect(JSON.stringify(params)).not.toContain("some private query");
  });
});
