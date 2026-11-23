import { get, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { closeMemoryHttpServer, createMemoryHttpServer, type MemoryHttpAuthOptions } from "../src/server/http.js";
import type { MemoryService } from "../src/service/memory-service.js";

const marker = "synthetic-private-log";
const apiLogs = vi.fn(() => ({ logs: [{ inputJson: marker, outputJson: marker }] }));
const ns = { source: "test", profileId: "test", projectId: "one-project" };
const auth: MemoryHttpAuthOptions = {
  localServiceToken: "local",
  cloudAccessTokens: { cloud: ns },
  scopedApiKeys: Object.fromEntries(["memory:read", "memory:write", "panel:*", "admin:read", "admin:write", "admin:*", "*"]
    .map(scope => [scope, { namespace: ns, scopes: [scope] }]))
};
let server: Server;
async function start(options: MemoryHttpAuthOptions) {
  const service = { apiLogs, setAppBudgetReconcileListener() {}, setCapturePendingListener() {}, setPersistRecoveredListener() {} };
  server = createMemoryHttpServer({ auth: options, service: service as unknown as MemoryService, workerStartupFallbackMs: 600_000 });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("missing test port");
  // node:http preserves the exact Host and Fetch Metadata headers supplied.
  return (headers: Record<string, string> = {}, path = "/api/v1/memory/logs") =>
    new Promise<{ status: number; exposed: boolean; cors: string | undefined }>((resolve, reject) => {
      get({ hostname: "127.0.0.1", port: addr.port, path, headers }, res => {
        let body = "";
        res.setEncoding("utf8").on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, exposed: body.includes(marker), cors: res.headers["access-control-allow-origin"] }));
        res.on("error", reject);
      }).on("error", reject);
    });
}
afterEach(async () => { if (server) await closeMemoryHttpServer(server); apiLogs.mockClear(); });

it("does not read device logs for legacy anonymous requests, even with an invalid token", async () => {
  const read = await start({ allowAnonymous: true });
  for (const token of ["", "Bearer wrong"]) {
    expect(await read(token ? { authorization: token } : {})).toEqual({ status: 403, exposed: false, cors: undefined });
  }
  expect(apiLogs).not.toHaveBeenCalled();
});

it("requires a local credential or explicit admin scope, not a project's implicit wildcard", async () => {
  const read = await start(auth);
  for (const token of ["wrong", "cloud", "memory:read", "memory:write", "panel:*"]) {
    expect(await read({ authorization: "Bearer " + token })).toMatchObject({ status: token === "wrong" ? 401 : 403, exposed: false });
  }
  expect(apiLogs).not.toHaveBeenCalled();
  for (const token of ["local", "admin:read", "admin:write", "admin:*", "*"]) {
    expect(await read({ authorization: "Bearer " + token })).toMatchObject({ status: 200, exposed: true });
  }
});

it("rejects untrusted browser origins and rebinding without blocking authenticated Node fetch", async () => {
  const read = await start(auth);
  const credential = { authorization: "Bearer local" };
  for (const headers of [
    { ...credential, origin: "https://external.invalid" },
    { ...credential, host: "external.invalid", "sec-fetch-site": "same-origin" },
    { ...credential, "sec-fetch-site": "cross-site" }
  ]) expect(await read(headers as Record<string, string>)).toEqual({ status: 403, exposed: false, cors: undefined });
  expect(apiLogs).not.toHaveBeenCalled();
  expect(await read({ ...credential, host: "memory.example.test", "sec-fetch-mode": "cors" })).toMatchObject({ status: 200, exposed: true });
  for (const path of ["/api/v1/api-logs", "/api/v1/memory/logs"]) {
    expect(await read({ "x-memmy-viewer": "1", origin: "https://external.invalid" }, path)).toMatchObject({ status: 403, exposed: false });
    expect(await read({ "x-memmy-viewer": "1" }, path)).toMatchObject({ status: 200, exposed: true });
  }
});
