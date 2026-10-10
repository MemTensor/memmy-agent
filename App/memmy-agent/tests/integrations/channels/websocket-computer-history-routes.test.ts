import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import { ComputerHistoryDemoService, type ComputerHistorySnapshot } from "../../../src/tools/computer-history/mac/computer-history-api.js";

const history = vi.hoisted(() => ({ snapshot: vi.fn(), setLlmRuntime: vi.fn(), clearHistories: vi.fn(), pinSegment: vi.fn(), checkPermissions: vi.fn(), openPermission: vi.fn(), startObservationWithPermissions: vi.fn(), applicationIcon: vi.fn(), deleteHistory: vi.fn(), importMarkdown: vi.fn(), pauseObservation: vi.fn(), stopObservation: vi.fn(), createWorkflow: vi.fn() }));

// Keep routing, authentication and clientSnapshot real without constructing a
// service that can read or remove the user's Computer History files.
vi.mock("../../../src/tools/computer-history/mac/computer-history-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/tools/computer-history/mac/computer-history-api.js")>(),
  getComputerHistoryDemoService: () => history,
}));

// Existing route behavior is the macOS contract, independent of the CI host.
beforeEach(() => { vi.spyOn(process, "platform", "get").mockReturnValue("darwin"); });
afterEach(() => {
  for (const method of Object.values(history)) method.mockReset();
  vi.unstubAllEnvs();
});

describe("Computer History pin HTTP boundary", () => {
  it("rejects traversal through the authenticated route without touching external markers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-pin-http-"));
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const marker = path.join(outside, ".pinned");
    fs.writeFileSync(marker, "must survive");
    const service = new ComputerHistoryDemoService({ historyDirectory: path.join(root, "histories"),
      recordingDirectory: path.join(root, "recordings"), workflowDirectory: path.join(root, "workflows"),
      observationSettingsFile: path.join(root, "settings.json"),
    });
    history.pinSegment.mockImplementation(service.pinSegment.bind(service));
    try {
      for (const pinned of [true, false]) {
        const response = await channel().dispatchHttp({}, request({ path: "/api/computer-history/pin",
          body: JSON.stringify({ history_id: "../../outside-10min-summary", pinned }),
        }));
        expect(response?.status).toBe(422);
        expect(fs.readFileSync(marker, "utf8")).toBe("must survive");
      }
    } finally {
      await service.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function channel(): WebSocketChannel {
  const instance = new WebSocketChannel(
    { enabled: true, allowFrom: ["*"], host: "127.0.0.1", port: 0, path: "/", websocketRequiresToken: false },
    new MessageBus(),
    { workspacePath: "/tmp" },
  );
  instance.apiTokens.set("history-route-test", Date.now() / 1000 + 60);
  return instance;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    path: "/api/computer-history/clear",
    method: "POST",
    headers: { Authorization: "Bearer history-route-test" },
    body: JSON.stringify({ scope: "all" }),
    ...overrides,
  };
}

function snapshot(): ComputerHistorySnapshot {
  return {
    observation: { state: "stopped", startedAt: null, segmentId: null, segmentStartedAt: null, error: null, narrationError: null },
    histories: [{
      id: "2026-09-13T00-00-00Z-6h-summary",
      title: "Retained window",
      description: "A retained summary.",
      applications: [],
      summaryWindow: "6h",
      coveredHistoryIds: ["2026-09-13T00-10-00Z-10min-summary"],
      pinned: false,
      eventStreamPath: null,
      sourceType: "rollup",
      createdAt: "2026-09-13T00:00:00.000Z",
      markdown: "Full history body stays in the service.",
      filePath: "/tmp/stub-history.md",
    }],
    workflows: [],
    privacy: { screenshots: false, audio: false, rawRetentionHours: 48, markdownDirectory: "/tmp/stub-histories", eventStreamDirectory: "/tmp/stub-segments" },
  };
}

describe.each(["win32", "linux"] as const)("Computer History unsupported platform %s", (platform) => {
  it.each([undefined, "1"])("blocks all HTTP entry points even with MEMMY_COMPUTER_HISTORY=%s", async (enabled) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubEnv("MEMMY_COMPUTER_HISTORY", enabled);
    const instance = channel();
    instance.modelSelectionResolver = vi.fn();
    const routes = [
      ["GET", "/api/computer-history"],
      ["GET", "/api/computer-history/app-icon?bundle_id=com.example.app"],
      ...["permissions/check", "permissions/open", "model", "delete", "clear", "pin", "import",
        "observation/start", "observation/pause", "observation/resume", "observation/stop", "workflows/create"]
        .map((suffix) => ["POST", `/api/computer-history/${suffix}`]),
    ];

    for (const [method, route] of routes) {
      const response = await instance.dispatchHttp({}, request({ method, path: route, body: "{}" }));
      expect(response?.status, route).toBe(400);
      expect(String(response?.body), route).toContain("available only on macOS");
    }
    for (const method of Object.values(history)) expect(method).not.toHaveBeenCalled();
    expect(instance.modelSelectionResolver).not.toHaveBeenCalled();
  });

  it("still checks authentication before the platform restriction", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const response = await channel().dispatchHttp({}, request({ headers: {} }));
    expect(response?.status).toBe(401);
    for (const method of Object.values(history)) expect(method).not.toHaveBeenCalled();
  });
});

describe("Computer History clear HTTP route", () => {
  it.each([{}, { Authorization: "Bearer invalid-token" }])("requires a valid API token before clearing", async (headers) => {
    const response = await channel().dispatchHttp({}, request({ headers }));
    expect(response?.status).toBe(401);
    expect(history.clearHistories).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "PATCH", "DELETE"])("rejects %s without calling the service", async (method) => {
    const response = await channel().dispatchHttp({}, request({ method }));
    expect(response?.status).toBe(405);
    expect(history.clearHistories).not.toHaveBeenCalled();
  });

  it.each([{}, { scope: "yesterday" }, { scope: null }, { scope: ["all"] }])("rejects an invalid clear scope: %j", async (body) => {
    const response = await channel().dispatchHttp({}, request({ body: JSON.stringify(body) }));
    expect(response?.status).toBe(400);
    expect(String(response?.body)).toContain("scope must be today or all");
    expect(history.clearHistories).not.toHaveBeenCalled();
  });

  it.each(["today", "all"] as const)("clears %s and returns the client snapshot with coverage intact", async (scope) => {
    const serviceSnapshot = snapshot();
    history.clearHistories.mockResolvedValue(serviceSnapshot);
    const response = await channel().dispatchHttp({}, request({ body: JSON.stringify({ scope }) }));
    expect(response?.status).toBe(200);
    expect(history.clearHistories).toHaveBeenCalledExactlyOnceWith(scope);
    const sent = JSON.parse(String(response?.body)) as ComputerHistorySnapshot;
    expect(sent.histories[0]).not.toHaveProperty("markdown");
    expect(sent.histories[0]?.coveredHistoryIds).toEqual(serviceSnapshot.histories[0]?.coveredHistoryIds);
    expect(sent.observation).toEqual(serviceSnapshot.observation);
    // Trimming the HTTP payload must not strip the service's in-process body.
    expect(serviceSnapshot.histories[0]?.markdown).toBe("Full history body stays in the service.");
  });
});

describe("Computer History permissions HTTP boundary", () => {
  it.each(["check", "open"])("authenticates permissions/%s before accessing native permissions", async (action) => {
    const response = await channel().dispatchHttp({}, request({ path: `/api/computer-history/permissions/${action}`, headers: {} }));
    expect(response?.status).toBe(401);
    expect(history.checkPermissions).not.toHaveBeenCalled(); expect(history.openPermission).not.toHaveBeenCalled();
  });
  it("returns native permission statuses", async () => {
    const status = { supported: true, accessibility: false, inputMonitoring: true };
    history.checkPermissions.mockResolvedValue(status);
    const response = await channel().dispatchHttp({}, request({ path: "/api/computer-history/permissions/check", body: "{}" }));
    expect(response?.status).toBe(200); expect(JSON.parse(String(response?.body))).toEqual(status);
  });
  it.each(["screenRecording", "arbitrary-url", null])("rejects an unsupported permission: %s", async (permission) => {
    const response = await channel().dispatchHttp({}, request({ path: "/api/computer-history/permissions/open", body: JSON.stringify({ permission }) }));
    expect(response?.status).toBe(422); expect(history.openPermission).not.toHaveBeenCalled();
  });
  it.each(["accessibility", "inputMonitoring"])("opens only the requested %s settings", async (permission) => {
    history.openPermission.mockResolvedValue({ supported: true, accessibility: false, inputMonitoring: false });
    const response = await channel().dispatchHttp({}, request({ path: "/api/computer-history/permissions/open", body: JSON.stringify({ permission }) }));
    expect(response?.status).toBe(200); expect(history.openPermission).toHaveBeenCalledExactlyOnceWith(permission, "settings");
  });
  it("dispatches explicit settings navigation separately from native authorization", async () => {
    history.openPermission.mockResolvedValue({ supported: true, accessibility: false, inputMonitoring: false });
    const response = await channel().dispatchHttp({}, request({ path: "/api/computer-history/permissions/open", body: JSON.stringify({ permission: "accessibility", mode: "settings" }) }));
    expect(response?.status).toBe(200);
    expect(history.openPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "settings");
  });
  it("rejects unsupported permission navigation modes", async () => {
    const response = await channel().dispatchHttp({}, request({ path: "/api/computer-history/permissions/open", body: JSON.stringify({ permission: "accessibility", mode: "both" }) }));
    expect(response?.status).toBe(422); expect(history.openPermission).not.toHaveBeenCalled();
  });
  it.each(["start", "resume"])("routes %s through preflight, returning missing permissions without an error", async (action) => {
    const result = snapshot(); result.observation.permissions = { supported: true, accessibility: false, inputMonitoring: false };
    history.startObservationWithPermissions.mockResolvedValue(result);
    const response = await channel().dispatchHttp({}, request({ path: `/api/computer-history/observation/${action}`, body: "{}" }));
    expect(response?.status).toBe(200);
    expect(history.startObservationWithPermissions).toHaveBeenCalledWith(...(action === "resume" ? [true] : []));
    expect(JSON.parse(String(response?.body)).observation.permissions).toEqual(result.observation.permissions);
  });
});


describe("Computer History model selection", () => {
  it("resolves the explicitly selected BYOK model and only refreshes when its config changes", async () => {
    const instance = channel();
    const provider = { chatWithRetry: vi.fn() };
    let revision = "key-1";
    instance.modelSelectionResolver = vi.fn(() => ({
      presetId: "custom-model", source: "byok", ownerAccountId: null,
      snapshot: { provider, model: "custom-model", signature: [revision] },
    }) as any);
    history.snapshot.mockReturnValue(snapshot());
    const input = request({ path: "/api/computer-history/model", body: JSON.stringify({ model_preset: "custom-model" }) });
    expect((await instance.dispatchHttp({}, input))?.status).toBe(200);
    expect(instance.modelSelectionResolver).toHaveBeenCalledWith({ requestedPreset: "custom-model" });
    expect(history.setLlmRuntime).toHaveBeenCalledOnce();
    expect(history.setLlmRuntime.mock.calls[0][1]).toBe("byok");
    expect(history.setLlmRuntime.mock.calls[0][0]()).toMatchObject({ provider, model: "custom-model" });
    await instance.dispatchHttp({}, input);
    expect(history.setLlmRuntime).toHaveBeenCalledOnce();
    revision = "key-2";
    await instance.dispatchHttp({}, input);
    expect(history.setLlmRuntime).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", 42, {}])("rejects an invalid preset %j", async (model_preset) => {
    const result = await channel().dispatchHttp({}, request({ path: "/api/computer-history/model", body: JSON.stringify({ model_preset }) }));
    expect(result?.status).toBe(422);
    expect(history.setLlmRuntime).not.toHaveBeenCalled();
  });

  it("requires authentication and refuses unavailable selections", async () => {
    const instance = channel();
    instance.modelSelectionResolver = vi.fn(() => null);
    const input = request({ path: "/api/computer-history/model", body: JSON.stringify({ model_preset: "removed" }) });
    expect((await instance.dispatchHttp({}, { ...input, headers: {} }))?.status).toBe(401);
    expect(instance.modelSelectionResolver).not.toHaveBeenCalled();
    expect((await instance.dispatchHttp({}, input))?.status).toBe(422);
    expect(history.setLlmRuntime).not.toHaveBeenCalled();
  });
});
