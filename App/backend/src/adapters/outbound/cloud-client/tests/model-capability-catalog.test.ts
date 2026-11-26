import { describe, expect, it, vi } from "vitest";
import { createHttpCloudClient } from "../index.js";

const catalog = {
  catalogVersion: 21,
  models: {
    "gpt-4o": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 16384 },
    "gpt-6-astra": {
      inputModalities: ["text", "image"], contextWindowTokens: 1050000, maxTokens: 128000,
      thinking: { switchable: false, defaultEnabled: true, levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" }
    }
  }
};

function clientFor(response: Response) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetchImpl, client: createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl }) };
}

describe("cloud model capability catalog", () => {
  it("requests the full raw catalog using the existing account credential and preserves omissions", async () => {
    const { client, fetchImpl } = clientFor(Response.json(catalog));
    const result = await client.getModelCapabilityCatalog({ uuid: "test-account-credential" });
    expect(result).toEqual({ status: "updated", catalog });
    expect(fetchImpl).toHaveBeenCalledWith("https://cloud.test/api/agent/model-config", expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ authorization: "Bearer test-account-credential" }),
      signal: expect.any(AbortSignal)
    }));
    if (result.status === "updated") expect(result.catalog.models["gpt-4o"]).not.toHaveProperty("thinking");
  });

  it("handles an empty 304 without reading its body", async () => {
    const response = new Response(null, { status: 304 });
    const json = vi.spyOn(response, "json");
    const { client, fetchImpl } = clientFor(response);
    await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential", catalogVersion: 21 }))
      .resolves.toEqual({ status: "not-modified" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://cloud.test/api/agent/model-config?catalogVersion=21");
    expect(json).not.toHaveBeenCalled();
  });

  it("accepts a changed version as a complete catalog", async () => {
    const { client } = clientFor(Response.json(catalog));
    await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential", catalogVersion: 20 }))
      .resolves.toEqual({ status: "updated", catalog });
  });

  it("rejects a 304 when no local version was supplied", async () => {
    const { client } = clientFor(new Response(null, { status: 304 }));
    await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential" })).rejects.toThrow("304");
  });

  it.each([
    { ...catalog, models: { ...catalog.models, invalid: { ...catalog.models["gpt-4o"], thinking: null } } },
    { ...catalog, models: { ...catalog.models, invalid: { ...catalog.models["gpt-4o"], maxTokens: "16384" } } },
    { code: 0, data: catalog },
    { ...catalog, catalogVersion: 1.5 }
  ])("rejects invalid whole packages instead of partially returning models", async (body) => {
    const { client } = clientFor(Response.json(body));
    await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential" })).rejects.toThrow();
  });

  it.each([401, 403, 500])("preserves the error message for HTTP %s", async (status) => {
    const { client } = clientFor(Response.json({ code: status, message: "Catalog unavailable", data: null }, { status }));
    await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential" })).rejects.toThrow("Catalog unavailable");
  });

  it("rejects malformed JSON and unexpected successful statuses", async () => {
    for (const response of [new Response("{"), new Response(null, { status: 204 })]) {
      const { client } = clientFor(response);
      await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential" })).rejects.toThrow();
    }
  });

  it("propagates network errors and timeouts without reporting not-modified", async () => {
    for (const error of [new TypeError("Network unavailable"), new DOMException("Timed out", "TimeoutError")]) {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(error);
      const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl });
      await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential" })).rejects.toBe(error);
    }
  });

  it("aborts an outstanding request at the configured timeout", async () => {
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl, timeoutMs: 20 });
    await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential" }))
      .rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("rejects invalid credentials and versions before sending a request", async () => {
    const { client, fetchImpl } = clientFor(Response.json(catalog));
    await expect(client.getModelCapabilityCatalog({ uuid: "" })).rejects.toThrow();
    for (const catalogVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(client.getModelCapabilityCatalog({ uuid: "test-account-credential", catalogVersion })).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
