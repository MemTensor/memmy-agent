import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeModelCapabilityCatalog,
  ModelCapabilityCatalogUnavailableError,
  readRuntimeModelCapabilityCatalog,
  resolveRuntimeModelCapabilityCatalogPath,
} from "../../src/providers/model-capability-catalog.js";

const catalog = {
  catalogVersion: 21,
  models: {
    "gpt-4o": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 16384 },
    "gpt-6-astra": {
      inputModalities: ["text", "image"], contextWindowTokens: 1050000, maxTokens: 128000,
      thinking: { switchable: false, defaultEnabled: true, levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" },
    },
  },
};

describe("Runtime model capability catalog", () => {
  let directory: string;
  let catalogPath: string;
  let runtimeConfigPath: string;
  let server: Server | undefined;
  const fetchImpl = vi.fn<typeof fetch>();
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-runtime-catalog-"));
    catalogPath = path.join(directory, "models.json");
    runtimeConfigPath = path.join(directory, "runtime.json");
    fs.writeFileSync(runtimeConfigPath, JSON.stringify({ baseUrl: "http://127.0.0.1:18999", localToken: "test-local-token" }));
    fetchImpl.mockReset();
  });
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const client = () => createRuntimeModelCapabilityCatalog({ catalogPath, runtimeConfigPath, fetchImpl });
  const save = (value: unknown) => fs.writeFileSync(catalogPath, JSON.stringify(value));

  it("resolves the agreed models.json path", () => {
    expect(resolveRuntimeModelCapabilityCatalogPath(directory)).toBe(path.join(directory, ".memmy", "models.json"));
  });

  it("uses a valid local catalog without requesting synchronization, including models without thinking", async () => {
    save(catalog);
    expect(await client().load()).toEqual({ mode: "catalog", catalog });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readRuntimeModelCapabilityCatalog(catalogPath)?.models["gpt-4o"]).not.toHaveProperty("thinking");
  });

  it.each(["", "{", JSON.stringify({ ...catalog, catalogVersion: 0 }), JSON.stringify({
    ...catalog, models: { ...catalog.models, invalid: { ...catalog.models["gpt-4o"], thinking: null } },
  }), JSON.stringify({
    ...catalog, models: { invalid: { ...catalog.models["gpt-6-astra"], thinking: { ...catalog.models["gpt-6-astra"].thinking, defaultLevel: null } } },
  })])("rejects the whole invalid local catalog and preserves the file", (content) => {
    fs.writeFileSync(catalogPath, content);
    expect(readRuntimeModelCapabilityCatalog(catalogPath)).toBeNull();
    expect(fs.readFileSync(catalogPath, "utf8")).toBe(content);
  });

  it("keeps the current snapshot immutable and uses the new version on the next load", async () => {
    save(catalog);
    const runtime = client();
    const first = await runtime.load();
    save({ ...catalog, catalogVersion: 22, models: { "gpt-4o": { ...catalog.models["gpt-4o"], maxTokens: 8192 } } });
    const next = await runtime.load();
    expect(first).toEqual({ mode: "catalog", catalog });
    expect(next.catalog?.catalogVersion).toBe(22);
    expect(next.catalog?.models).not.toHaveProperty("gpt-6-astra");
    expect(() => { first.catalog!.models["gpt-6-astra"].thinking!.levels.push("low"); }).toThrow(TypeError);
    expect(Object.isFrozen(first.catalog!.models["gpt-4o"])).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requests only the authenticated local Backend and rereads the file after synchronization", async () => {
    fetchImpl.mockImplementationOnce(async () => {
      save(catalog);
      return Response.json({ status: "synced", hasValidCatalog: true, catalogVersion: 21 });
    });
    expect(await client().load()).toEqual({ mode: "catalog", catalog });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(new URL("http://127.0.0.1:18999/api/app/model-catalog/refresh"), expect.objectContaining({
      method: "POST", headers: { "x-memmy-local-token": "test-local-token" }, redirect: "error", signal: expect.any(AbortSignal),
    }));
  });

  it("permits Provider fallback only after explicit retry exhaustion and no valid local catalog", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ status: "retries-exhausted", hasValidCatalog: false }));
    expect(await client().load()).toEqual({ mode: "provider-fallback", catalog: null });
    expect(fs.existsSync(catalogPath)).toBe(false);
  });

  it("continues with a valid file even if the synchronization result reports retry exhaustion", async () => {
    fetchImpl.mockImplementationOnce(async () => {
      save(catalog);
      return Response.json({ status: "retries-exhausted", hasValidCatalog: false });
    });
    expect(await client().load()).toEqual({ mode: "catalog", catalog });
  });

  it.each([
    { status: "synced", hasValidCatalog: true, catalogVersion: 21 },
    { status: "unauthenticated", hasValidCatalog: false },
    { status: "stopped", hasValidCatalog: false },
    { status: "synced", hasValidCatalog: false },
  ])("does not infer retry exhaustion from an unsuccessful coordination state: %j", async (result) => {
    fetchImpl.mockResolvedValueOnce(Response.json(result));
    await expect(client().load()).rejects.toBeInstanceOf(ModelCapabilityCatalogUnavailableError);
  });

  it.each([new TypeError("Network unavailable"), new DOMException("Timed out", "TimeoutError")])("does not infer fallback from a transport failure", async (error) => {
    fetchImpl.mockRejectedValueOnce(error);
    await expect(client().load()).rejects.toMatchObject({ code: "model_catalog_unavailable", cause: error });
  });

  it("accepts a newly valid file even when the local request fails", async () => {
    fetchImpl.mockImplementationOnce(async () => { save(catalog); throw new Error("Connection lost"); });
    expect(await client().load()).toEqual({ mode: "catalog", catalog });
  });

  it.each([new Response(null, { status: 401 }), new Response("{"), Response.json({ status: "unknown" })])("rejects HTTP or response errors without entering fallback", async (response) => {
    fetchImpl.mockResolvedValueOnce(response);
    await expect(client().load()).rejects.toBeInstanceOf(ModelCapabilityCatalogUnavailableError);
  });

  it.each(["https://api.memmy.cn", "http://example.test", "http://127.0.0.1:18999/path", "http://user:pass@127.0.0.1:18999"]) ("rejects a non-local or malformed Backend origin before sending the local token: %s", async (baseUrl) => {
    fs.writeFileSync(runtimeConfigPath, JSON.stringify({ baseUrl, localToken: "test-local-token" }));
    await expect(client().load()).rejects.toBeInstanceOf(ModelCapabilityCatalogUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates cancellation instead of treating it as retry exhaustion", async () => {
    const controller = new AbortController();
    fetchImpl.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = client().load(controller.signal);
    const reason = new Error("Turn cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("coordinates through a real loopback HTTP connection", async () => {
    const requests: Array<{ url: string | undefined; token: string | string[] | undefined }> = [];
    server = createServer((request, response) => {
      requests.push({ url: request.url, token: request.headers["x-memmy-local-token"] });
      save(catalog);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "synced", hasValidCatalog: true, catalogVersion: 21 }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address");
    fs.writeFileSync(runtimeConfigPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, localToken: "test-local-token" }));
    const runtime = createRuntimeModelCapabilityCatalog({ catalogPath, runtimeConfigPath });
    expect(await runtime.load()).toEqual({ mode: "catalog", catalog });
    expect(requests).toEqual([{ url: "/api/app/model-catalog/refresh", token: "test-local-token" }]);
  });
});
