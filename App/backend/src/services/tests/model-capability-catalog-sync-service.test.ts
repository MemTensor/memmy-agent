import type { ModelCapabilityCatalog } from "@memmy/local-api-contracts";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudClient } from "../../adapters/outbound/cloud-client/index.js";
import { readModelCapabilityCatalog, writeModelCapabilityCatalog } from "../../infrastructure/model-capability-catalog/index.js";
import { createModelCapabilityCatalogSyncService, type ModelCapabilityCatalogSyncService } from "../model-capability-catalog-sync-service.js";

const catalog: ModelCapabilityCatalog = {
  catalogVersion: 21,
  models: { "gpt-4o": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 16384 } }
};

describe("model capability catalog synchronization", () => {
  let directory: string;
  let filePath: string;
  const getModelCapabilityCatalog = vi.fn<CloudClient["getModelCapabilityCatalog"]>();
  let credential: string | null;
  let services: ModelCapabilityCatalogSyncService[];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memmy-catalog-sync-"));
    filePath = join(directory, "models.json");
    credential = "test-account-credential";
    services = [];
    getModelCapabilityCatalog.mockReset().mockResolvedValue({ status: "updated", catalog });
  });
  afterEach(async () => {
    await Promise.all(services.map((sync) => sync.stop()));
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const service = () => {
    const sync = createModelCapabilityCatalogSyncService({
      cloudClient: { getModelCapabilityCatalog }, getCloudUuid: () => credential, filePath
    });
    services.push(sync);
    return sync;
  };

  async function exhaustRetries(sync: ModelCapabilityCatalogSyncService) {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const result = sync.sync();
    for (const delay of [5_000, 10_000, 30_000]) {
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      expect(timers).toHaveBeenLastCalledWith(expect.any(Function), delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    return result;
  }

  it("requests and persists a full catalog when the file is missing", async () => {
    expect(await service().sync()).toEqual({ status: "updated", catalog });
    expect(getModelCapabilityCatalog).toHaveBeenCalledExactlyOnceWith({ uuid: credential });
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
  });

  it("notifies model views only after a valid catalog is committed, not for 304", async () => {
    const onUpdated = vi.fn(() => {
      expect(getModelCapabilityCatalog).toHaveBeenCalledOnce();
    });
    const sync = createModelCapabilityCatalogSyncService({
      cloudClient: { getModelCapabilityCatalog }, getCloudUuid: () => credential, filePath, onUpdated
    });
    services.push(sync);
    await sync.sync();
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(catalog);
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
    getModelCapabilityCatalog.mockResolvedValueOnce({ status: "not-modified" });
    await sync.sync();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it.each(["{", JSON.stringify({ ...catalog, catalogVersion: 0 })])("requests a full catalog when the local file is invalid", async (content) => {
    await writeFile(filePath, content);
    expect((await service().sync()).status).toBe("updated");
    expect(getModelCapabilityCatalog).toHaveBeenCalledExactlyOnceWith({ uuid: credential });
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
  });

  it("sends a valid local version and leaves the file untouched for a 304", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    const before = await stat(filePath);
    getModelCapabilityCatalog.mockResolvedValueOnce({ status: "not-modified" });
    expect(await service().sync()).toEqual({ status: "not-modified", catalog });
    expect(getModelCapabilityCatalog).toHaveBeenCalledExactlyOnceWith({ uuid: credential, catalogVersion: 21 });
    const after = await stat(filePath);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  it("replaces the whole catalog after a version change", async () => {
    await writeModelCapabilityCatalog({ ...catalog, catalogVersion: 20, models: {} }, filePath);
    expect(await service().sync()).toEqual({ status: "updated", catalog });
    expect(getModelCapabilityCatalog).toHaveBeenCalledExactlyOnceWith({ uuid: credential, catalogVersion: 20 });
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
  });

  it("preserves a valid local catalog and the actual error when refresh fails", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    const content = await readFile(filePath, "utf8");
    const error = new Error("Cloud unavailable");
    getModelCapabilityCatalog.mockRejectedValue(error);
    expect(await exhaustRetries(service())).toEqual({ status: "failed", reason: "retries-exhausted", catalog, error });
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(4);
    expect(await readFile(filePath, "utf8")).toBe(content);
  });

  it("reports failure without a valid catalog while keeping the corrupted file intact", async () => {
    await writeFile(filePath, "{");
    const error = new Error("Cloud unavailable");
    getModelCapabilityCatalog.mockRejectedValue(error);
    expect(await exhaustRetries(service())).toEqual({ status: "failed", reason: "retries-exhausted", catalog: null, error });
    expect(await readFile(filePath, "utf8")).toBe("{");
  });

  it("does not overwrite a valid catalog with an invalid full response", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    getModelCapabilityCatalog.mockResolvedValue({ status: "updated", catalog: {
      ...catalog, catalogVersion: 22, models: { ...catalog.models, invalid: { ...catalog.models["gpt-4o"]!, maxTokens: 0 } }
    } });
    expect(await exhaustRetries(service())).toMatchObject({ status: "failed", reason: "retries-exhausted", catalog });
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
  });

  it("retries with a full request if the local file disappeared during a 304", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    getModelCapabilityCatalog.mockImplementationOnce(async () => {
      await rm(filePath);
      return { status: "not-modified" };
    });
    vi.useFakeTimers();
    const result = service().sync();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual({ status: "updated", catalog });
    expect(getModelCapabilityCatalog).toHaveBeenNthCalledWith(2, { uuid: credential });
  });

  it("requires a credential without sending an anonymous request and can synchronize after login", async () => {
    credential = null;
    const sync = service();
    expect(await sync.sync()).toMatchObject({ status: "failed", reason: "unauthenticated", catalog: null });
    expect(getModelCapabilityCatalog).not.toHaveBeenCalled();
    credential = "new-account-credential";
    expect((await sync.sync()).status).toBe("updated");
    expect(getModelCapabilityCatalog).toHaveBeenCalledExactlyOnceWith({ uuid: credential });
  });

  it("merges simultaneous synchronization requests and permits a later refresh", async () => {
    let complete!: (value: Awaited<ReturnType<CloudClient["getModelCapabilityCatalog"]>>) => void;
    getModelCapabilityCatalog.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const sync = service();
    const first = sync.sync();
    const second = sync.sync();
    expect(first).toBe(second);
    complete({ status: "updated", catalog });
    expect(await first).toEqual({ status: "updated", catalog });
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(1);
    await sync.sync();
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(2);
  });

  it("uses the fixed retry delays, merges callers during a retry and stops on success", async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    getModelCapabilityCatalog.mockRejectedValueOnce(new Error("Offline")).mockRejectedValueOnce(new Error("Offline"));
    const sync = service();
    const first = sync.sync();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(timers).toHaveBeenLastCalledWith(expect.any(Function), 5_000);
    expect(sync.sync()).toBe(first);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(timers).toHaveBeenLastCalledWith(expect.any(Function), 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toEqual({ status: "updated", catalog });
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])("starts once, refreshes after five minutes plus jitter and stops timers (random=%s)", async (random) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(random === 1 ? 0.999999 : 0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const sync = service();
    sync.start();
    sync.start();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    const interval = random === 1 ? 360_000 : 300_000;
    expect(timers).toHaveBeenLastCalledWith(expect.any(Function), interval);
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(interval);
    await vi.waitFor(() => expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(2));
    await sync.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(2);
  });

  it("cancels pending retries on shutdown and rejects new synchronization work", async () => {
    vi.useFakeTimers();
    getModelCapabilityCatalog.mockRejectedValue(new Error("Offline"));
    const sync = service();
    const result = sync.sync();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await sync.stop();
    expect(await result).toMatchObject({ status: "failed", reason: "stopped" });
    expect(vi.getTimerCount()).toBe(0);
    expect(await sync.sync()).toMatchObject({ status: "failed", reason: "stopped" });
    expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not write a response arriving after shutdown begins", async () => {
    let complete!: (value: Awaited<ReturnType<CloudClient["getModelCapabilityCatalog"]>>) => void;
    getModelCapabilityCatalog.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const sync = service();
    const result = sync.sync();
    await vi.waitFor(() => expect(getModelCapabilityCatalog).toHaveBeenCalledTimes(1));
    const stopping = sync.stop();
    complete({ status: "updated", catalog });
    await stopping;
    expect(await result).toMatchObject({ status: "failed", reason: "stopped" });
    expect(await readModelCapabilityCatalog(filePath)).toBeNull();
  });
});
