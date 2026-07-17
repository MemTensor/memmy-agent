import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/cli/commands.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const baseUrl = "http://memmy.test";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memmy CLI command map", () => {
  it("prints a complete help page", async () => {
    const help = await runCommand({ argv: ["--help"] });

    expect(help).toContain("memmy-memory 0.0.1-beta.1");
    expect(help).toContain("Usage:");
    expect(help).toContain("init --agent codex");
    expect(help).toContain("init --skip-agent-skills");
    expect(help).toContain("--skip-agent-skills");
    expect(help).toContain("Supported agents:");
    expect(help).toContain("Default URL:");
  });

  it("prints the CLI version", async () => {
    await expect(runCommand({ argv: ["--version"] })).resolves.toBe("memmy-memory 0.0.1-beta.1");
    await expect(runCommand({ argv: ["-v"] })).resolves.toBe("memmy-memory 0.0.1-beta.1");
  });

  const minimalCases: Array<{
    name: string;
    argv: string[];
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  }> = [
    {
      name: "health",
      argv: ["health"],
      method: "GET",
      path: "/api/v1/health"
    },
    {
      name: "reload-config",
      argv: ["reload-config", "--reason", "profile_switched"],
      method: "POST",
      path: "/api/v1/admin/reload-config",
      body: {
        reason: "profile_switched"
      }
    },
    {
      name: "open",
      argv: ["session", "open"],
      method: "POST",
      path: "/api/v1/sessions/open",
      body: {}
    },
    {
      name: "close",
      argv: ["session", "close", "se_123"],
      method: "POST",
      path: "/api/v1/sessions/se_123/close"
    },
    {
      name: "start",
      argv: ["turn", "start", "test failures", "--session-id", "se_123"],
      method: "POST",
      path: "/api/v1/turns/start",
      body: {
        sessionId: "se_123",
        query: "test failures"
      }
    },
    {
      name: "complete",
      argv: ["turn", "complete", "turn_1", "fixed", "--session-id", "se_123", "--query", "test failures"],
      method: "POST",
      path: "/api/v1/turns/turn_1/complete",
      body: {
        sessionId: "se_123",
        query: "test failures",
        answer: "fixed"
      }
    },
    {
      name: "search",
      argv: ["search", "test failures"],
      method: "POST",
      path: "/api/v1/memory/search",
      body: {
        query: "test failures"
      }
    },
    {
      name: "add",
      argv: ["add", "remember this", "--source", "manual"],
      method: "POST",
      path: "/api/v1/memory/add",
      body: {
        content: "remember this",
        source: "manual"
      }
    },
    {
      name: "get",
      argv: ["get", "mem_l1_1"],
      method: "GET",
      path: "/api/v1/memory/mem_l1_1"
    },
    {
      name: "delete",
      argv: ["delete", "mem_l1_1"],
      method: "DELETE",
      path: "/api/v1/memory/mem_l1_1"
    },
    {
      name: "raw panel overview",
      argv: ["raw", "GET", "/panel/overview"],
      method: "GET",
      path: "/api/v1/panel/overview"
    },
    {
      name: "raw panel items",
      argv: ["raw", "GET", "/panel/items?page=1"],
      method: "GET",
      path: "/api/v1/panel/items",
      query: {
        page: "1"
      }
    },
    {
      name: "raw",
      argv: ["raw", "POST", "/some/endpoint", "--body", "{\"requestId\":\"req_1\"}"],
      method: "POST",
      path: "/api/v1/some/endpoint",
      body: {
        requestId: "req_1"
      }
    }
  ];

  it.each(minimalCases)("$name maps minimal user input to the expected HTTP request", async (item) => {
    const { response, requests } = await runMappedCommand(item.argv);

    expect(response).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const url = new URL(request.url);
    expect(request.method).toBe(item.method);
    expect(url.pathname).toBe(item.path);
    expect(querySubset(url, item.query ?? {})).toEqual(item.query ?? {});
    if (item.body !== undefined) {
      expect(request.body).toEqual(item.body);
    } else {
      expect(request.body).toBeUndefined();
    }
  });

  it("normalizes turn complete status when the user provides a short alias", async () => {
    const { requests } = await runMappedCommand([
      "turn", "complete", "turn_1",
      "--session-id", "se_123",
      "--query", "what changed",
      "--answer", "fixed",
      "--status", "ok"
    ]);

    expect(requests[0]?.body).toEqual({
      sessionId: "se_123",
      query: "what changed",
      answer: "fixed",
      status: "succeeded"
    });
  });

  it("parses simple search filters from user options", async () => {
    const { requests } = await runMappedCommand([
      "search", "test failures",
      "--session-id", "se_123",
      "--layers", "L1,L2"
    ]);

    expect(requests[0]?.body).toEqual({
      query: "test failures",
      sessionId: "se_123",
      layers: ["L1", "L2"]
    });
  });

  it("passes explicit search verbose mode", async () => {
    const { requests } = await runMappedCommand([
      "search", "test failures",
      "--verbose"
    ]);

    expect(requests[0]?.body).toEqual({
      query: "test failures",
      verbose: true
    });
  });

  it("formats memory get responses for direct agent injection by default", async () => {
    const response = await runCommand({
      argv: ["get", "trace_1", "--url", baseUrl],
      fetch: mockFetchResponse({
        id: "trace_1",
        kind: "trace",
        memoryLayer: "L1",
        title: "Recorded CLI turn",
        summary: "CLI stored a useful trace",
        body: "User asked for the memory CLI behavior. Assistant fixed the compact get output.",
        metadata: {
          properties: {
            embedding: [1, 0, 0]
          }
        }
      })
    });

    expect(response).toBe([
      "id: trace_1",
      "kind: trace",
      "layer: L1",
      "title: Recorded CLI turn",
      "",
      "User asked for the memory CLI behavior. Assistant fixed the compact get output."
    ].join("\n"));
    expect(response).not.toContain("embedding");
  });

  it("includes compact raw turn tool inputs and outputs in memory get responses", async () => {
    const response = await runCommand({
      argv: ["get", "trace_1", "--url", baseUrl],
      fetch: mockFetchResponse({
        id: "trace_1",
        kind: "trace",
        memoryLayer: "L1",
        title: "Checked machine memory",
        body: [
          "Summary: Checked machine memory",
          "RawTurn: raw_1",
          "TraceStep: 0",
          "User:",
          "check memory",
          "Tool calls:",
          "- exec",
          "Agent:",
          "16 GB",
          "Alpha: 0",
          "Value: 0",
          "Priority: 0.5"
        ].join("\n"),
        refs: {
          rawTurn: {
            userText: "check memory",
            assistantText: "16 GB",
            toolCalls: [
              {
                id: "call_exec",
                name: "exec",
                input: {
                  command: "sysctl hw.memsize"
                }
              }
            ],
            toolResults: [
              {
                toolCallId: "call_exec",
                name: "exec",
                output: "hw.memsize: 17179869184\n\nExit code: 0"
              }
            ]
          }
        },
        metadata: {
          properties: {
            embedding: [1, 0, 0]
          }
        }
      })
    });

    expect(response).toContain("User:\ncheck memory");
    expect(response).toContain("Tool calls:");
    expect(response).toContain("- exec");
    expect(response).toContain('input: {"command":"sysctl hw.memsize"}');
    expect(response).toContain("output:\n    hw.memsize: 17179869184");
    expect(response).toContain("Assistant:\n16 GB");
    expect(response).not.toContain("RawTurn:");
    expect(response).not.toContain("TraceStep:");
    expect(response).not.toContain("Alpha:");
    expect(response).not.toContain("Value:");
    expect(response).not.toContain("Priority:");
    expect(response).not.toContain("embedding");
  });

  it("keeps full memory get responses behind verbose mode", async () => {
    const response = await runCommand({
      argv: ["get", "trace_1", "--url", baseUrl, "--verbose"],
      fetch: mockFetchResponse({
        id: "trace_1",
        kind: "trace",
        memoryLayer: "L1",
        title: "Recorded CLI turn",
        body: "Compact default output.",
        metadata: {
          properties: {
            embedding: [1, 0, 0]
          }
        }
      })
    });

    expect(response).toMatchObject({
      id: "trace_1",
      metadata: {
        properties: {
          embedding: [1, 0, 0]
        }
      }
    });
  });

  it("sends an explicit user_id as the Memory namespace header", async () => {
    const { requests } = await runMappedCommand([
      "search", "test failures",
      "--user_id", "user_cli_1"
    ]);

    expect(requests[0]?.headers["x-memmy-user-id"]).toBe("user_cli_1");
  });

  it("sends source in the request body for CLI memory commands", async () => {
    const { requests } = await runMappedCommand([
      "turn", "start", "test failures",
      "--session-id", "se_123",
      "--source", "codex"
    ]);

    expect(requests[0]?.body).toMatchObject({ source: "codex" });
  });

  it("uses memmyMemory.userId from config when user id is not passed explicitly", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-cli-map-"));
    roots.push(root);
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      [
        "app:",
        "  userId: user_from_config",
        "memmyMemory:",
        "  version: 1",
        "  userId: user_from_memory",
        "  storage:",
        "    endpoint: http://config.test",
        ""
      ].join("\n")
    );
    const requests: CapturedRequest[] = [];

    await runCommand({
      argv: ["search", "test failures", "--config", configPath, "--url", baseUrl],
      fetch: mockFetch(requests)
    });

    expect(requests[0]?.headers["x-memmy-user-id"]).toBe("user_from_memory");
  });

  it("uses active memory profile userId from config when profiles are configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-cli-map-"));
    roots.push(root);
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      [
        "app:",
        "  userId: user_from_app",
        "memmyMemory:",
        "  activeProfile: byok",
        "  userId: user_from_flat_memory",
        "  profiles:",
        "    byok:",
        "      userId: user_from_byok_profile",
        ""
      ].join("\n")
    );
    const requests: CapturedRequest[] = [];

    await runCommand({
      argv: ["search", "test failures", "--config", configPath, "--url", baseUrl],
      fetch: mockFetch(requests)
    });

    expect(requests[0]?.headers["x-memmy-user-id"]).toBe("user_from_byok_profile");
  });

  it("lets explicit user-id override memmyMemory.userId from config", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-cli-map-"));
    roots.push(root);
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, "memmyMemory:\n  userId: user_from_config\n");
    const requests: CapturedRequest[] = [];

    await runCommand({
      argv: ["search", "test failures", "--config", configPath, "--url", baseUrl, "--user-id", "user_explicit"],
      fetch: mockFetch(requests)
    });

    expect(requests[0]?.headers["x-memmy-user-id"]).toBe("user_explicit");
  });

  it("rejects unknown commands", async () => {
    await expect(
      runCommand({
        argv: ["unknown-command", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: unknown-command");
  });

  it("does not keep old recall commands", async () => {
    await expect(
      runCommand({
        argv: ["recall", "top query", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: recall top query");

    await expect(
      runCommand({
        argv: ["memory", "search", "alias query", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: memory search alias query");
  });

  it("does not keep old compatibility command aliases", async () => {
    await expect(
      runCommand({
        argv: ["memory", "session", "open", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: memory session open");

    await expect(
      runCommand({
        argv: ["memory", "skill", "list", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: memory skill list");

    await expect(
      runCommand({
        argv: ["memory", "subagent", "complete", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: memory subagent complete");
  });

  it("does not register auth helper commands", async () => {
    await expect(
      runCommand({
        argv: ["auth", "session", "--url", baseUrl],
        fetch: mockFetch([])
      })
    ).rejects.toThrow("unknown command: auth session");
  });
});

async function runMappedCommand(argv: string[]): Promise<{
  response: unknown;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const response = await runCommand({
    argv: [...argv, "--url", baseUrl],
    fetch: mockFetch(requests)
  });
  return { response, requests };
}

function mockFetch(requests: CapturedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" && init.body
      ? JSON.parse(init.body) as unknown
      : undefined;
    requests.push({ method, url, headers, body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  }) as typeof fetch;
}

function mockFetchResponse(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  })) as typeof fetch;
}

function querySubset(url: URL, expected: Record<string, string>): Record<string, string> {
  const subset: Record<string, string> = {};
  for (const key of Object.keys(expected)) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      subset[key] = value;
    }
  }
  return subset;
}
