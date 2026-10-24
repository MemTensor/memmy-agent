import { describe, expect, it, vi } from "vitest";
import { HttpByokTokenUsageClient } from "../../../src/integrations/byok-token-usage/client.js";
import type { ByokTokenUsageEvent } from "../../../src/integrations/byok-token-usage/types.js";

describe("HttpByokTokenUsageClient", () => {
  it("requires a runtime for durable History uploads and budget checks", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new HttpByokTokenUsageClient({ runtimeConfigProvider: () => null, fetchImpl });
    await expect(client.recordEvent(eventFixture(), { requireRuntime: true })).rejects.toThrow("runtime is unavailable");
    await expect(client.getMemoryBudget()).rejects.toThrow("runtime is unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads and validates the Memory budget with the local runtime token", async () => {
    const budget = { dailyLimitM: 10, totalLimitM: 500, dailyUsed: 120, lifetimeUsed: 240,
      paused: false, trigger: null, nextLocalMidnightAt: "2026-10-14T00:00:00.000Z" };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(budget), { status: 200 }));
    const client = new HttpByokTokenUsageClient({ baseUrl: "http://localhost:62934", runtimeToken: "local-only", fetchImpl });
    await expect(client.getMemoryBudget()).resolves.toEqual(budget);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("http://localhost:62934/api/app/byok-token-usage/memory-budget");
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ "x-memmy-local-token": "local-only" });
    fetchImpl.mockImplementation(async () => new Response("{}", { status: 200 }));
    await expect(client.getMemoryBudget()).rejects.toThrow();
    fetchImpl.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    await expect(client.getMemoryBudget()).rejects.toThrow("budget read failed: 503");
  });

  it.each(["https://remote.example", "http://127.0.0.1:62934?redirect=x", "http://user:secret@127.0.0.1:62934", "http://127.0.0.1:62934/path"])(
    "rejects a non-local or decorated backend URL without sending credentials: %s", (baseUrl) => {
      const fetchImpl = vi.fn<typeof fetch>();
      expect(() => new HttpByokTokenUsageClient({ baseUrl, runtimeToken: "local-only", fetchImpl })).toThrow("local backend");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("posts BYOK token usage events to the local backend with the runtime token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new HttpByokTokenUsageClient({
      baseUrl: "http://127.0.0.1:62934/",
      runtimeToken: "runtime-token",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const event = eventFixture();

    await client.recordEvent(event);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:62934/api/app/byok-token-usage/events");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-memmy-local-token": "runtime-token",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      id: "event-1",
      kind: "agent_chat",
      source: "agent",
      operationId: "turn-1",
      totalTokens: 30,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws when the local backend returns a non-2xx response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500, statusText: "Internal Server Error" }));
    const client = new HttpByokTokenUsageClient({
      baseUrl: "http://127.0.0.1:62934",
      runtimeToken: "runtime-token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.recordEvent(eventFixture())).rejects.toThrow("BYOK token usage upload failed: 500");
  });

  it("resolves runtime config lazily for each event", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    let runtimeConfig: { baseUrl: string; localToken: string } | null = null;
    const client = new HttpByokTokenUsageClient({
      runtimeConfigProvider: () => runtimeConfig,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.recordEvent(eventFixture());
    expect(fetchImpl).not.toHaveBeenCalled();

    runtimeConfig = {
      baseUrl: "http://127.0.0.1:62934",
      localToken: "runtime-token-a",
    };
    await client.recordEvent(eventFixture());

    runtimeConfig = {
      baseUrl: "http://127.0.0.1:63000",
      localToken: "runtime-token-b",
    };
    await client.recordEvent(eventFixture());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:62934/api/app/byok-token-usage/events");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-memmy-local-token": "runtime-token-a",
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://127.0.0.1:63000/api/app/byok-token-usage/events");
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-memmy-local-token": "runtime-token-b",
    });
  });
});

function eventFixture(): ByokTokenUsageEvent {
  return {
    id: "event-1",
    kind: "agent_chat",
    source: "agent",
    operationId: "turn-1",
    presetId: "byok-agent",
    provider: "openai",
    model: "gpt-4.1-mini",
    capability: "agent",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    metadata: {
      sessionKey: "cli:direct",
      provider: "openai",
      modelId: "gpt-4.1-mini",
    },
    rawUsage: { prompt_tokens: 10, completion_tokens: 20 },
    createdAt: "2026-06-11T10:00:00.000Z",
  };
}
