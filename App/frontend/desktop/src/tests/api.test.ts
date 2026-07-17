/** Api tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../api/runtime-config.js";

describe("runtime config loading", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates config returned by the Electron preload bridge", async () => {
    vi.stubGlobal("window", {
      memmy: {
        async getRuntimeConfig() {
          return {
            baseUrl: undefined,
            localToken: undefined
          };
        }
      }
    });

    await expect(getRuntimeConfig()).rejects.toThrow(/baseUrl/);
  });

  it("reports when neither Electron bridge nor Vite env config is available", async () => {
    vi.stubGlobal("window", {});

    await expect(getRuntimeConfig()).rejects.toThrow("Memmy runtime config is unavailable");
  });
});
