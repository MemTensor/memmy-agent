import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { AgentSourceExecutor } from "../src/agent-source/runtime.js";
import { assertLocalAgentSourceRequest, routeAgentSourceScan } from "../src/server/agent-source-api.js";

const request = (remote = "127.0.0.1", headers = {}) => ({ socket: { remoteAddress: remote }, headers: { host: "127.0.0.1:18960", ...headers } }) as IncomingMessage;
describe("local Agent source controls", () => {
  it("requires local service identity and loopback, rejecting cloud/scoped/anonymous tokens", () => {
    expect(() => assertLocalAgentSourceRequest(request(), "local")).not.toThrow();
    for (const kind of ["cloud", "scoped", "anonymous"]) expect(() => assertLocalAgentSourceRequest(request(), kind)).toThrow(/local service token/);
    expect(() => assertLocalAgentSourceRequest(request("192.0.2.4"), "local")).toThrow();
    expect(() => assertLocalAgentSourceRequest(request("127.0.0.1", { origin: "https://example.com" }), "local")).toThrow();
  });
  it("routes all starts through the same executor without a second scanner", async () => {
    const startScan = vi.fn(async () => ({ accepted: true, jobId: "one" }));
    const executor = { startScan } as unknown as AgentSourceExecutor;
    for (const input of [{ sourceId: "all", mode: "initial_subset" }, { sourceId: "codex" }, { sourceId: "all", mode: "full" }]) {
      expect(await routeAgentSourceScan(executor, "POST", new URL("http://localhost/api/v1/agent-sources/scan"), input)).toMatchObject({ status: 202, body: { jobId: "one" } });
      expect(startScan).toHaveBeenLastCalledWith(input);
    }
  });
  it("rejects traversal and invalid result pagination before touching the store", async () => {
    const scanResults = vi.fn();
    const executor = { scanResults } as unknown as AgentSourceExecutor;
    for (const suffix of ["bad%2Fpath/results", "valid/results?limit=NaN", "valid/results?limit=501"]) {
      await expect(routeAgentSourceScan(executor, "GET", new URL(`http://localhost/api/v1/agent-sources/scan/jobs/${suffix}`), {})).rejects.toThrow();
    }
    expect(scanResults).not.toHaveBeenCalled();
  });
});

it("enforces local-token authorization at the actual HTTP boundary while retaining Viewer access", async () => {
  const { createMemoryServiceFixture } = await import("./fixtures/memory-service-fixture.js");
  const { createMemoryHttpServer, closeMemoryHttpServer } = await import("../src/server/http.js");
  const fixture = createMemoryServiceFixture();
  const { service } = fixture.createTestService();
  const startScan = vi.fn(async () => ({ accepted: true, jobId: "shared-job" }));
  const executor = { startScan, scanStatus: () => ({ running: true, jobId: "shared-job" }), startAutomation() {}, dispose() {} } as unknown as AgentSourceExecutor;
  const server = createMemoryHttpServer({ service, agentSourceExecutor: executor, auth: { mode: "dev", localServiceToken: "local-test-token", cloudAccessTokens: { "cloud-test-token": { userId: "cloud-user", source: "codex", profileId: "default" } } } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const url = `http://127.0.0.1:${address.port}/api/v1/agent-sources/scan`;
  const submit = (headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ sourceId: "codex" }) });
  try {
    expect((await submit()).status).toBe(401);
    expect((await submit({ authorization: "Bearer cloud-test-token" })).status).toBe(403);
    expect(startScan).not.toHaveBeenCalled();
    expect((await submit({ authorization: "Bearer local-test-token" })).status).toBe(202);
    expect((await submit({ "x-memmy-viewer": "1" })).status).toBe(202);
    expect(startScan).toHaveBeenCalledTimes(2);
  } finally { await closeMemoryHttpServer(server); fixture.cleanup(); }
});
