import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpLocalDataClient } from "../local-data-client.js";

const runtimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "local-token"
};

describe("local data client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets, reveals, and clears local memory data with runtime token", async () => {
    const dataPath = "C:\\Users\\test\\.memmy\\memory-service";
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === "/api/local-data" && init.method === "GET") {
        return jsonResponse({ ok: true, dataPath });
      }
      if (url.pathname === "/api/local-data/reveal") {
        return jsonResponse({ ok: true, dataPath });
      }
      return jsonResponse({ ok: true, clearedAt: "2026-06-02T10:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpLocalDataClient(runtimeConfig);
    await expect(client.getPath()).resolves.toEqual({ ok: true, dataPath });
    await expect(client.reveal()).resolves.toEqual({ ok: true, dataPath });
    await expect(client.clear({ confirm: true })).resolves.toEqual({ ok: true, clearedAt: "2026-06-02T10:00:00.000Z" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("/api/local-data", runtimeConfig.baseUrl),
      expect.objectContaining({
        method: "GET",
        body: undefined,
        headers: expect.objectContaining({ "x-memmy-local-token": "local-token" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("/api/local-data/reveal", runtimeConfig.baseUrl),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
        headers: expect.objectContaining({ "x-memmy-local-token": "local-token" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      new URL("/api/local-data", runtimeConfig.baseUrl),
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
        headers: expect.objectContaining({ "x-memmy-local-token": "local-token" })
      })
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
