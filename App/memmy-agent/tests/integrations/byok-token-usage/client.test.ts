import { describe, expect, it, vi } from "vitest";
import { HttpByokTokenUsageClient } from "../../../src/integrations/byok-token-usage/client.js";
import type { ByokTokenUsageEvent } from "../../../src/integrations/byok-token-usage/types.js";

describe("HttpByokTokenUsageClient", () => {
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
