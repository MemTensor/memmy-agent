import { readFileSync } from "node:fs";
import { createServer, type Server, type RequestListener } from "node:http";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopComputerHistoryBeforeExit } from "../src/main/computer-history-exit.js";

const servers: Server[] = [];
async function gateway(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, bootstrapSecret: "fixture-bootstrap-secret" };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("authenticated Computer History exit drain", () => {
  it("authenticates and waits for the stop response to finish", async () => {
    const requests: string[] = [];
    let finishStop!: () => void;
    const testGateway = await gateway((request, response) => {
      requests.push(request.url!);
      if (request.url === "/webui/bootstrap") {
        expect(request.headers["x-memmy-agent-auth"]).toBe("fixture-bootstrap-secret");
        response.end(JSON.stringify({ token: "fixture-session-token" }));
      } else {
        expect(request.method).toBe("POST");
        expect(request.headers.authorization).toBe("Bearer fixture-session-token");
        expect(request.headers["x-memmy-agent-auth"]).toBeUndefined();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
        finishStop = () => response.end('{"status":"stopped"}');
      }
    });
    let complete = false;
    const drain = stopComputerHistoryBeforeExit(testGateway).then(() => { complete = true; });
    await vi.waitFor(() => expect(finishStop).toBeTypeOf("function"));
    expect(complete).toBe(false);
    finishStop();
    await drain;
    expect(requests).toEqual(["/webui/bootstrap", "/api/computer-history/observation/stop"]);
  });

  it("accepts the already-stopped response on idle quit", async () => {
    const testGateway = await gateway((request, response) => {
      if (request.url === "/webui/bootstrap") response.end('{"token":"fixture-token"}');
      else { response.writeHead(409); response.end('{"error":"already stopped"}'); }
    });
    await expect(stopComputerHistoryBeforeExit(testGateway)).resolves.toBeUndefined();
  });

  it("does not send a stop request after rejected authentication", async () => {
    const requests: string[] = [];
    const testGateway = await gateway((request, response) => {
      requests.push(request.url!);
      response.writeHead(403); response.end("fixture-private-response");
    });
    await expect(stopComputerHistoryBeforeExit(testGateway)).rejects.toThrow("authentication failed (403)");
    expect(requests).toEqual(["/webui/bootstrap"]);
  });

  it("rejects a bootstrap response without a session token", async () => {
    const testGateway = await gateway((_request, response) => response.end('{}'));
    await expect(stopComputerHistoryBeforeExit(testGateway)).rejects.toThrow("returned no token");
  });

  it("reports a failed stop instead of declaring the recorder drained", async () => {
    const testGateway = await gateway((request, response) => {
      if (request.url === "/webui/bootstrap") response.end('{"token":"fixture-token"}');
      else { response.writeHead(500); response.end("fixture-private-response"); }
    });
    await expect(stopComputerHistoryBeforeExit(testGateway)).rejects.toThrow("stop failed (500)");
  });

  it("bounds an unfinished stop response body by the shared deadline", async () => {
    const testGateway = await gateway((request, response) => {
      if (request.url === "/webui/bootstrap") response.end('{"token":"fixture-token"}');
      else { response.writeHead(200); response.flushHeaders(); }
    });
    await expect(stopComputerHistoryBeforeExit(testGateway, 100)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("also bounds an unfinished authentication body without sending stop", async () => {
    const requests: string[] = [];
    const testGateway = await gateway((request, response) => {
      requests.push(request.url!);
      response.writeHead(200); response.flushHeaders();
    });
    await expect(stopComputerHistoryBeforeExit(testGateway, 100)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requests).toEqual(["/webui/bootstrap"]);
  });
});

// Execute the real cleanup tail without importing Electron or starting user services.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const cleanup = source.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "cleanupBeforeQuit") as ts.FunctionDeclaration;
const statements = cleanup.body!.statements;
const tailIndex = statements.findIndex(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === "quit"));
if (tailIndex < 0) throw new Error("missing production cleanup tail");
const runtimeCleanup = source.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "closeRuntimeForQuit")!;
const cleanupCode = ts.transpileModule(`${runtimeCleanup.getText(source)}\nglobalThis.cleanup = async () => { ${statements.slice(tailIndex).map(statement => statement.getText(source)).join("\n")} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function setupCleanup(platform: string, drain: () => Promise<void>) {
  const calls: string[] = [];
  const agentGateway = { baseUrl: "http://fixture.invalid", bootstrapSecret: "fixture-secret" };
  const stop = vi.fn(drain);
  const services = { agentGateway, close: async () => { calls.push("services"); } };
  const diagnostic = vi.fn();
  const context = createContext({
    process: { platform, env: {} }, app: { isPackaged: false },
    runtimeServices: services,
    quitCleanupContext: { services, stopMemory: false, outcome: "pending", servicesClose: null },
    recordQuitDiagnostic: diagnostic,
    memoryServiceControl: {},
    localBackend: { close: async () => { calls.push("backend"); } },
    stopMemoryServiceForCurrentQuit: false,
    browserWebviewDownloads: null, disposeBrowserWebviewPermissions: null,
    stopTaskRecordingBeforeExit: async () => {},
    stopComputerUseAgentForPermissionRestart: async () => {},
    browserSidebarBridge: null, embeddedBrowserDriver: { dispose: vi.fn() }, computerUseSurfaceWindows: null,
    pipScreenPermissionGuide: null,
    stopComputerHistoryBeforeExit: stop,
    stopPackagedRendererServer: async () => { calls.push("renderer"); },
    sendAppExitEventBeforeQuit: async () => { calls.push("analytics"); },
    console: { info: vi.fn(), warn: vi.fn() }
  });
  runInContext(cleanupCode, context);
  return { calls, stop, context, agentGateway, diagnostic, cleanup: () => context.cleanup() as Promise<void> };
}

describe("production Desktop cleanup ordering", () => {
  it("keeps the Agent alive until the Windows recorder drain completes", async () => {
    let finish!: () => void;
    const test = setupCleanup("win32", () => new Promise<void>(resolve => { finish = resolve; }));
    const cleanup = test.cleanup();
    await vi.waitFor(() => expect(test.stop).toHaveBeenCalledWith(test.agentGateway));
    expect(test.calls).toEqual([]);
    finish(); await cleanup;
    expect(test.calls).toEqual(["services", "backend", "renderer", "analytics"]);
    expect(test.context.runtimeServices).toBeNull();
  });

  it("continues process cleanup when the drain fails", async () => {
    const test = setupCleanup("win32", async () => { throw new Error("fixture gateway unavailable"); });
    await test.cleanup();
    expect(test.calls).toEqual(["services", "backend", "renderer", "analytics"]);
    expect(test.diagnostic).toHaveBeenCalledWith(test.context.quitCleanupContext, "history-stop-failed");
  });

  it.each(["darwin", "linux"])("preserves %s cleanup without the Windows API drain", async platform => {
    const test = setupCleanup(platform, async () => {});
    await test.cleanup();
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.calls).toEqual(["services", "backend", "renderer", "analytics"]);
  });
});
