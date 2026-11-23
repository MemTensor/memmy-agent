import net from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeHttpUrl, connectMcpServers, setMcpRuntimeForTest } from "../../../../src/core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

function runtimeThatShouldNotDial() {
  return {
    ClientSession: class {},
    StdioServerParameters: class {
      constructor(init: any) {
        Object.assign(this, init);
      }
    },
    stdioClient: async () => {
      throw new Error("stdio attempted");
    },
    sseClient: async () => {
      throw new Error("sse attempted");
    },
    streamableHttpClient: async () => {
      throw new Error("http attempted");
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setMcpRuntimeForTest(null);
});

describe("MCP HTTP probe", () => {
  it("returns true for an open port", async () => {
    const destroy = vi.fn();
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = new EventEmitter() as net.Socket;
      socket.end = vi.fn(() => socket) as any;
      socket.destroy = vi.fn(() => {
        destroy();
        return socket;
      }) as any;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });

    expect(await probeHttpUrl("http://127.0.0.1:12345/mcp")).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("returns false for a closed port", async () => {
    expect(await probeHttpUrl("http://127.0.0.1:19999/mcp", 0.05)).toBe(false);
  });

  it("uses the default HTTP port when URL has no port", async () => {
    expect(await probeHttpUrl("http://unreachable-host.test/mcp", 0.05)).toBe(false);
  });
});

describe("connectMcpServers HTTP probe guard", () => {
  it("skips unreachable streamableHttp servers", async () => {
    setMcpRuntimeForTest(runtimeThatShouldNotDial() as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ dead: { type: "streamableHttp", url: "http://127.0.0.1:19999/mcp" } }, registry);

    expect(stacks).toEqual({});
    expect(registry.size).toBe(0);
  });

  it("skips unreachable SSE servers", async () => {
    setMcpRuntimeForTest(runtimeThatShouldNotDial() as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ dead: { type: "sse", url: "http://127.0.0.1:19999/sse" } }, registry);

    expect(stacks).toEqual({});
    expect(registry.size).toBe(0);
  });

  it("does not probe stdio servers", async () => {
    let stdioCalled = false;
    setMcpRuntimeForTest({
      ...runtimeThatShouldNotDial(),
      stdioClient: async () => {
        stdioCalled = true;
        throw new Error("spawn failed");
      },
    } as any);

    await connectMcpServers({ s: { type: "stdio", command: "nonexistent-command-xyz" } }, new ToolRegistry());

    expect(stdioCalled).toBe(true);
  });
});
