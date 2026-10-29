import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { setMcpRuntimeForTest } from "../../../src/core/agent-runtime/tools/mcp.js";

const roots: string[] = [];
const loops: AgentLoop[] = [];

function makeLoop(mcpServers: Record<string, any> = {}): AgentLoop {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-core-readiness-"));
  roots.push(workspace);
  const loop = new AgentLoop({
    config: new Config({
      tools: { mcpServers, browser: { enabled: false } },
      fileMemory: { enabled: false },
      memmyMemory: { enabled: false },
      sessionDag: { enabled: false },
      contextCompaction: { summaryMode: "text" },
    }),
    provider: { generation: {}, getDefaultModel: () => "test-model" },
    workspace,
  });
  loops.push(loop);
  vi.spyOn(loop.autoCompact, "checkExpired").mockImplementation(() => undefined);
  return loop;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  for (const loop of loops.splice(0)) {
    loop.stop();
    await loop.closeRuntimeTools();
  }
  setMcpRuntimeForTest(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop core readiness", () => {
  it("withholds readiness and inbound reads until tools, queue recovery, and goal recovery finish", async () => {
    const loop = makeLoop();
    const tools = deferred();
    const queue = deferred();
    const goals = deferred();
    const initialize = vi.spyOn(loop, "initializeRuntimeTools").mockImplementation(() => tools.promise);
    const recoverQueue = vi.spyOn(loop as any, "recoverQueueSteerTransfers").mockImplementation(() => queue.promise);
    const recoverGoals = vi.spyOn(loop as any, "recoverGoalWork").mockImplementation(() => goals.promise);
    const readInbound = vi.spyOn(loop.bus.inbound, "getNowait");
    const running = loop.run();
    try {
      expect(initialize).toHaveBeenCalledOnce();
      expect(loop.isReady).toBe(false);
      tools.resolve();
      await vi.waitFor(() => expect(recoverQueue).toHaveBeenCalledOnce());
      expect(recoverGoals).not.toHaveBeenCalled();
      expect(loop.isReady).toBe(false);
      queue.resolve();
      await vi.waitFor(() => expect(recoverGoals).toHaveBeenCalledOnce());
      expect(loop.isReady).toBe(false);
      expect(readInbound).not.toHaveBeenCalled();
      goals.resolve();
      await vi.waitFor(() => expect(loop.isReady).toBe(true));
      expect(readInbound).toHaveBeenCalled();
      loop.stop();
      expect(loop.isReady).toBe(false);
    } finally {
      loop.stop();
      tools.resolve(); queue.resolve(); goals.resolve();
      await running;
    }
    expect(loop.isReady).toBe(false);
  });

  it.each(["tools", "queue", "goals"])("does not become ready after stopping during %s", async (stage) => {
    const loop = makeLoop();
    const pending = deferred();
    const initialize = vi.spyOn(loop, "initializeRuntimeTools").mockResolvedValue();
    const recoverQueue = vi.spyOn(loop as any, "recoverQueueSteerTransfers").mockResolvedValue(undefined);
    const recoverGoals = vi.spyOn(loop as any, "recoverGoalWork").mockResolvedValue(undefined);
    const target = stage === "tools" ? initialize : stage === "queue" ? recoverQueue : recoverGoals;
    target.mockImplementation(() => pending.promise);
    const readInbound = vi.spyOn(loop.bus.inbound, "getNowait");
    const running = loop.run();
    await vi.waitFor(() => expect(target).toHaveBeenCalledOnce());
    loop.stop();
    pending.resolve();
    await running;
    expect(loop.isReady).toBe(false);
    expect(readInbound).not.toHaveBeenCalled();
    if (stage === "tools") expect(recoverQueue).not.toHaveBeenCalled();
    if (stage !== "goals") expect(recoverGoals).not.toHaveBeenCalled();
  });

  it.each(["tools", "queue", "goals", "inbound"])("clears readiness when %s fails", async (stage) => {
    const loop = makeLoop();
    const initialize = vi.spyOn(loop, "initializeRuntimeTools").mockResolvedValue();
    const recoverQueue = vi.spyOn(loop as any, "recoverQueueSteerTransfers").mockResolvedValue(undefined);
    const recoverGoals = vi.spyOn(loop as any, "recoverGoalWork").mockResolvedValue(undefined);
    const readInbound = vi.spyOn(loop.bus.inbound, "getNowait");
    const error = new Error("runtime fixture failed");
    if (stage === "inbound") readInbound.mockImplementation(() => { throw error; });
    else (stage === "tools" ? initialize : stage === "queue" ? recoverQueue : recoverGoals).mockRejectedValue(error);
    await expect(loop.run()).rejects.toBe(error);
    expect(loop.isReady).toBe(false);
    expect(loop.running).toBe(false);
  });

  it("does not reopen readiness after runtime tools are closed during initialization", async () => {
    const loop = makeLoop();
    const pending = deferred();
    vi.spyOn(loop, "initializeRuntimeTools").mockImplementation(() => pending.promise);
    const readInbound = vi.spyOn(loop.bus.inbound, "getNowait");
    const running = loop.run();
    await loop.closeRuntimeTools();
    pending.resolve();
    await running;
    expect(loop.isReady).toBe(false);
    expect(readInbound).not.toHaveBeenCalled();
  });

  it.each([false, true])("can become ready with existing sessions when optional MCP fails: %s", async (optionalFailure) => {
    if (optionalFailure) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      setMcpRuntimeForTest({
        ClientSession: class { async initialize() { throw new Error("optional MCP unavailable"); } },
        StdioServerParameters: class { constructor(_init: any) {} },
        stdioClient: () => [{}, {}],
        sseClient: () => [{}, {}],
        streamableHttpClient: () => [{}, {}],
      });
    }
    const loop = makeLoop(optionalFailure ? { legacyOptional: { type: "stdio", command: "fixture" } } : {});
    const historical = loop.sessions.getOrCreate("websocket:legacy");
    historical.addMessage("user", "historical message");
    loop.sessions.save(historical);
    const originalBytes = fs.readFileSync(loop.sessions.pathFor(historical.key));
    const running = loop.run();
    try {
      await vi.waitFor(() => expect(loop.isReady).toBe(true));
      expect(loop.mcpConnected).toBe(false);
      expect(fs.readFileSync(loop.sessions.pathFor(historical.key))).toEqual(originalBytes);
    } finally {
      loop.stop();
      await running;
    }
  });

  it("logs only fixed stage names and elapsed milliseconds during managed startup", async () => {
    const loop = makeLoop();
    vi.stubEnv("MEMMY_DESKTOP_MANAGED_GATEWAY", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(loop, "initializeRuntimeTools").mockResolvedValue();
    const running = loop.run();
    try {
      await vi.waitFor(() => expect(loop.isReady).toBe(true));
      const stages = log.mock.calls.map(([line]) => JSON.parse(String(line).replace(/^\[agent-startup\] /, "")));
      expect(stages.map(({ stage }) => stage)).toEqual([
        "runtime-tools-ready", "queue-steer-recovered", "goals-recovered", "message-loop-ready",
      ]);
      for (const stage of stages) {
        expect(Object.keys(stage)).toEqual(["stage", "elapsedMs"]);
        expect(stage.elapsedMs).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(stages)).not.toContain(loop.workspace);
    } finally {
      loop.stop();
      await running;
    }
  });
});
