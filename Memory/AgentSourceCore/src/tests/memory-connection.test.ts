import { describe, expect, it } from "vitest";
import { MEMORY_CONNECTION_ENV_ALIASES, resolveMemoryConnection } from "../memory-connection.js";

describe("Memory credential origins", () => {
  const file = "http://memory.test:18080";
  it.each([
    ["different port", "http://memory.test:18081"],
    ["different host", "http://other.test:18080"],
    ["different scheme", "https://memory.test:18080"]
  ])("does not borrow a legacy token from a %s", (_name, old) => {
    expect(resolveMemoryConnection(file, "file-token", {
      MEMMY_MEMORY_URL: file, MEMORY_SERVICE_URL: old, MEMORY_SERVICE_TOKEN: "old-token"
    })).toEqual({ endpoint: file, token: "file-token" });
    expect(resolveMemoryConnection(old, "old-file-token", {
      MEMMY_MEMORY_URL: file, MEMORY_SERVICE_TOKEN: "unpaired-token"
    })).toEqual({ endpoint: file, token: undefined });
  });

  it("accepts equivalent origins and explicit matching environment pairs", () => {
    expect(resolveMemoryConnection("https://MEMORY.test:443/base", "file-token", {
      MEMMY_MEMORY_URL: "https://memory.test/", MEMORY_SERVICE_TOKEN: "file-origin-token"
    }).token).toBe("file-origin-token");
    expect(resolveMemoryConnection(file, "file-token", {
      MEMMY_MEMORY_URL: "https://other.test", MEMMY_MEMORY_TOKEN: "explicit-token",
      MEMORY_SERVICE_URL: file, MEMORY_SERVICE_TOKEN: "old-token"
    }).token).toBe("explicit-token");
  });

  it("continues searching after a mismatched higher-priority credential", () => {
    expect(resolveMemoryConnection(file, "file-token", {
      MEMMY_MEMORY_URL: "https://other.test", MEMMY_MEMORY_TOKEN: "other-token",
      MEMORY_SERVICE_URL: file, MEMORY_SERVICE_TOKEN: "matching-token"
    }, file).token).toBe("matching-token");
  });

  it("binds every Backend alias to its own URL, or to the file when unpaired", () => {
    const aliases = [["MEMMY_MEMORY_LAYER_URL", "MEMMY_MEMORY_LAYER_TOKEN"], ...MEMORY_CONNECTION_ENV_ALIASES] as const;
    expect(resolveMemoryConnection(file, "file-token", {
      MEMMY_MEMORY_LAYER_URL: file, MEMMY_MEMORY_URL: "https://other.test", MEMMY_MEMORY_TOKEN: "other-token"
    }, undefined, aliases).token).toBe("file-token");
    expect(resolveMemoryConnection(file, "file-token", {
      MEMMY_MEMORY_LAYER_TOKEN: "unpaired-file-token", MEMMY_MEMORY_URL: "https://other.test",
      MEMMY_MEMORY_TOKEN: "matching-token"
    }, undefined, aliases).token).toBe("matching-token");
  });
});
