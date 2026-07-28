/** Vite config tests. */
import { fileURLToPath } from "node:url";
import type { AliasOptions, UserConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import viteConfig from "../../vite.config.js";

type AliasEntry = {
  /** Find. */
  find: string | RegExp;
  /** Replacement. */
  replacement: string;
};

describe("vite workspace resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads local API contracts from source instead of generated dist", () => {
    const config = resolveConfig("test");
    const aliases = normalizeAliasEntries(config.resolve?.alias);

    expect(aliases).toContainEqual({
      find: "@memmy/local-api-contracts",
      replacement: fileURLToPath(new URL("../../../../backend/local-api-contracts/src/index.ts", import.meta.url))
    });
  });

  it("isolates test validation without mutating process env", () => {
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "http://invalid.test");
    vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://invalid.test/path");

    expect(() => resolveConfig("test")).not.toThrow();
    expect(process.env.MEMMY_LEGAL_CN_BASE_URL).toBe("http://invalid.test");
    expect(process.env.MEMMY_LEGAL_INTL_BASE_URL).toBe("https://invalid.test/path");
  });

  it("keeps development validation strict", () => {
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "http://invalid.test");
    vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://valid.test");

    expect(() => resolveConfig("development")).toThrow(/MEMMY_LEGAL_CN_BASE_URL/);
  });
});

/** Handles resolve config. */
function resolveConfig(mode: string): UserConfig {
  if (typeof viteConfig !== "function") {
    return viteConfig;
  }

  const config = viteConfig({
    command: "serve",
    mode,
    isSsrBuild: false,
    isPreview: false
  });

  if (config instanceof Promise) {
    throw new Error("Expected frontend desktop Vite config to be synchronous.");
  }

  return config;
}

/** Normalizes normalize alias entries. */
function normalizeAliasEntries(alias: AliasOptions | undefined): AliasEntry[] {
  if (!alias) {
    return [];
  }

  if (Array.isArray(alias)) {
    return alias.map((entry) => ({
      find: entry.find,
      replacement: entry.replacement
    }));
  }

  return Object.entries(alias).map(([find, replacement]) => ({
    find,
    replacement
  }));
}
