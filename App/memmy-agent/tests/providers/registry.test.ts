import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REGISTRY_MODULE = "../../src/providers/registry.js";

describe("registry MEMMY_CLOUD_SERVICE lazy resolution", () => {
  const originalEnv = process.env.MEMMY_CLOUD_SERVICE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MEMMY_CLOUD_SERVICE;
    else process.env.MEMMY_CLOUD_SERVICE = originalEnv;
    vi.resetModules();
  });

  it("imports without throwing when MEMMY_CLOUD_SERVICE is unset", async () => {
    delete process.env.MEMMY_CLOUD_SERVICE;
    await expect(import(REGISTRY_MODULE)).resolves.toBeDefined();
  });

  it("memmyAccountApiBase throws a clear error when MEMMY_CLOUD_SERVICE is unset", async () => {
    delete process.env.MEMMY_CLOUD_SERVICE;
    const { memmyAccountApiBase } = await import(REGISTRY_MODULE);
    expect(() => memmyAccountApiBase()).toThrow(/MEMMY_CLOUD_SERVICE 未配置/);
  });

  it("memmyAccountApiBase returns the resolved gateway URL when MEMMY_CLOUD_SERVICE is set", async () => {
    process.env.MEMMY_CLOUD_SERVICE = "https://example.memmy.test";
    const { memmyAccountApiBase } = await import(REGISTRY_MODULE);
    expect(memmyAccountApiBase()).toBe("https://example.memmy.test/api/agentExternal/v1");
  });

  it("memmy_account provider spec defaultApiBase stays safe (empty) when unset, without throwing", async () => {
    delete process.env.MEMMY_CLOUD_SERVICE;
    const { findByName } = await import(REGISTRY_MODULE);
    expect(() => findByName("memmy_account")?.defaultApiBase).not.toThrow();
    expect(findByName("memmy_account")?.defaultApiBase).toBe("");
  });

  it("memmy_account provider spec defaultApiBase matches the configured gateway when MEMMY_CLOUD_SERVICE is set", async () => {
    process.env.MEMMY_CLOUD_SERVICE = "https://example.memmy.test";
    const { findByName } = await import(REGISTRY_MODULE);
    expect(findByName("memmy_account")?.defaultApiBase).toBe(
      "https://example.memmy.test/api/agentExternal/v1",
    );
  });
});
