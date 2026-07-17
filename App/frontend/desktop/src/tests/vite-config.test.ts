/** Vite config tests. */
import { fileURLToPath } from "node:url";
import type { AliasOptions, UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config.js";

type AliasEntry = {
  /** Find. */
  find: string | RegExp;
  /** Replacement. */
  replacement: string;
};

describe("vite workspace resolution", () => {
  it("loads local API contracts from source instead of generated dist", () => {
    const config = resolveConfig();
    const aliases = normalizeAliasEntries(config.resolve?.alias);

    expect(aliases).toContainEqual({
      find: "@memmy/local-api-contracts",
      replacement: fileURLToPath(new URL("../../../../backend/local-api-contracts/src/index.ts", import.meta.url))
    });
  });
});

/** Handles resolve config. */
function resolveConfig(): UserConfig {
  if (typeof viteConfig !== "function") {
    return viteConfig;
  }

  const config = viteConfig({
    command: "serve",
    mode: "development",
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
